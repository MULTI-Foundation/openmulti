// R-1 / R-2 : vue bandit partagée entre pods (bandit.ts) et décote à portée bornée.
// Store fake en mémoire qui ENREGISTRE les appels Lua (le script lui-même est vérifié
// contre un vrai Redis par test/bandit-redis.test.ts, gated). Verrouille : la portée de
// la décote (candidats connus = seuls ces modèles s'amortissent ; inconnus = global),
// la purge des bras négligeables, l'horodatage de dernière erreur, le push fire-and-forget
// (arguments, store down = pas de push, échec = compteur de pertes), le refresh qui
// remplace la vue locale par l'état partagé, et le câblage route -> candidats.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_shared_test'
process.env.OPENMULTI_METRICS_TOKEN = 'ops-token-test'
process.env.OPENMULTI_MODELS_ECONOMY = 'a/1,b/2'
process.env.OPENMULTI_MODELS_BALANCED = 'c/3,d/4'
process.env.OPENMULTI_SMART_MIN_SAMPLES = '2'
process.env.OPENMULTI_SMART_DECAY_WINDOW = '20' // rho = 0.95

const { _setStoreClientForTests } = await import('../src/store.ts')
const { observe, modelAggregate, pathAggregate, refreshBanditFromStore, _resetBandit, _BANDIT_HASH_KEY_FOR_TESTS: HASH } =
  await import('../src/bandit.ts')
const { recordRequest, renderProm, _resetMetrics, _setKnownModelsForTest } = await import('../src/metrics.ts')
const { app } = await import('../src/app.ts')

type EvalCall = { keys: string[]; arguments: string[] }

function fakeClient(opts: { failEval?: boolean } = {}) {
  const store = new Map<string, Map<string, string>>()
  const evals: EvalCall[] = []
  const hash = (k: string) => {
    let h = store.get(k)
    if (!h) {
      h = new Map()
      store.set(k, h)
    }
    return h
  }
  return {
    store,
    evals,
    async hIncrBy() {},
    async hIncrByFloat() {},
    async expire() {},
    async hGetAll(k: string) {
      return Object.fromEntries(store.get(k) ?? new Map())
    },
    async hSet(k: string, f: string, v: string) {
      hash(k).set(f, v)
    },
    async hDel(k: string, f: string) {
      hash(k).delete(f)
    },
    async incr() {
      return 1
    },
    async eval(_script: string, o: EvalCall) {
      if (opts.failEval) throw new Error('READONLY You can\'t write against a read only replica.')
      evals.push(o)
      return 1
    },
  }
}

let client: ReturnType<typeof fakeClient>
const tick = () => new Promise((r) => setImmediate(r))

beforeEach(() => {
  _resetMetrics()
  _resetBandit()
  client = fakeClient()
  _setStoreClientForTests(client)
})

test('R-2 : avec candidats, seuls les bras de CES modèles sont amortis (tous chemins)', () => {
  observe({ provider: 'openrouter', model: 'a/1', error: false, costUsd: 1 })
  observe({ provider: 'moonshot', model: 'a/1', error: false, costUsd: 1 })
  observe({ provider: 'openrouter', model: 'c/3', error: false, costUsd: 1 })
  // Observation dans le tier economy {a/1, b/2} : a/1 (les deux chemins) s'amortit, c/3 non.
  const before = { a: modelAggregate('a/1'), c: modelAggregate('c/3') }
  observe({ provider: 'openrouter', model: 'b/2', error: false, costUsd: 1, candidates: ['a/1', 'b/2'] })
  const after = { a: modelAggregate('a/1'), c: modelAggregate('c/3') }
  assert.ok(Math.abs(after.a.requests - before.a.requests * 0.95) < 1e-12, `a/1 amorti : ${after.a.requests}`)
  assert.ok(pathAggregate('moonshot', 'a/1').requests < 1, 'le chemin moonshot de a/1 est amorti aussi')
  assert.equal(after.c.requests, before.c.requests, 'c/3 (autre tier) ne doit PAS s\'amortir')
})

test('R-2 : sans candidats (legacy), la décote reste globale', () => {
  observe({ provider: 'openrouter', model: 'a/1', error: false, costUsd: 1 })
  observe({ provider: 'openrouter', model: 'c/3', error: false, costUsd: 1 })
  observe({ provider: 'openrouter', model: 'b/2', error: false, costUsd: 1 })
  assert.ok(modelAggregate('a/1').requests < 1)
  assert.ok(modelAggregate('c/3').requests < 1)
})

test('purge : un bras amorti sous 1e-4 disparaît de la vue (bornage, identique au store)', () => {
  observe({ provider: 'openrouter', model: 'a/1', error: false, costUsd: 0 })
  // 0.95^n < 1e-4 pour n >= 180
  for (let i = 0; i < 200; i++) observe({ provider: 'openrouter', model: 'b/2', error: false, costUsd: 0 })
  assert.equal(modelAggregate('a/1').requests, 0)
  assert.equal(pathAggregate('openrouter', 'a/1').requests, 0)
})

test('lastErrorAt : posé à l\'erreur, pas au succès ; la vue modèle prend le plus récent des chemins', () => {
  observe({ provider: 'openrouter', model: 'a/1', error: false, costUsd: 0, now: 1_000 })
  assert.equal(modelAggregate('a/1').lastErrorAt, undefined)
  observe({ provider: 'openrouter', model: 'a/1', error: true, costUsd: 0, now: 2_000 })
  observe({ provider: 'moonshot', model: 'a/1', error: true, costUsd: 0, now: 5_000 })
  observe({ provider: 'openrouter', model: 'a/1', error: false, costUsd: 0, now: 9_000 })
  assert.equal(pathAggregate('openrouter', 'a/1').lastErrorAt, 2_000, 'un succès ne touche pas l\'horodatage')
  assert.equal(modelAggregate('a/1').lastErrorAt, 5_000)
})

test('push : chaque observation part au store en un EVAL (bras, erreur, coût, portée)', async () => {
  observe({ provider: 'moonshot', model: 'a/1', error: true, costUsd: 0.25, candidates: ['a/1', 'b/2'], now: 42 })
  observe({ provider: 'openrouter', model: 'c/3', error: false, costUsd: 0 })
  await tick()
  assert.equal(client.evals.length, 2)
  const [first, second] = client.evals as [EvalCall, EvalCall]
  assert.deepEqual(first.keys, [HASH])
  assert.equal(first.arguments[0], '0.95') // rho
  assert.equal(first.arguments[1], 'moonshot|a/1')
  assert.equal(first.arguments[2], '1')
  assert.equal(first.arguments[3], '0.25')
  assert.equal(first.arguments[4], '42')
  assert.equal(first.arguments[5], 'a/1,b/2')
  assert.equal(second.arguments[1], 'openrouter|c/3')
  assert.equal(second.arguments[2], '0')
  assert.equal(second.arguments[5], '*', 'sans candidats : portée globale')
})

test('push : store absent ou malade -> aucun push, la vue locale apprend quand même', async () => {
  _setStoreClientForTests(client, false) // client présent mais pas prêt
  observe({ provider: 'openrouter', model: 'a/1', error: false, costUsd: 1 })
  _setStoreClientForTests(null)
  observe({ provider: 'openrouter', model: 'a/1', error: false, costUsd: 1 })
  await tick()
  assert.equal(client.evals.length, 0)
  assert.ok(modelAggregate('a/1').requests > 1.9)
  await refreshBanditFromStore() // no-op sans store : la vue locale survit
  assert.ok(modelAggregate('a/1').requests > 1.9)
})

test('push en échec : observation gardée localement, perte comptée sur /metrics', async () => {
  _setStoreClientForTests(fakeClient({ failEval: true }))
  observe({ provider: 'openrouter', model: 'a/1', error: false, costUsd: 1 })
  await tick()
  assert.equal(modelAggregate('a/1').requests, 1)
  assert.match(renderProm(), /openmulti_bandit_store_drops_total\{\} 1\b/)
})

test('refresh : l\'état partagé REMPLACE la vue locale (reprise après rollout, convergence multi-pod)', async () => {
  observe({ provider: 'openrouter', model: 'a/1', error: false, costUsd: 1 }) // vue locale : 1 requête
  // Ce qu'un autre pod a écrit (format `requests|errors|costUsd|lastErrorAt`).
  client.store.set(HASH, new Map([
    ['openrouter|a/1', '7.5|1.5|0.75|1700000000000'],
    ['moonshot|a/1', '2|0|0.1|'],
    ['openrouter|b/2', 'garbage'],
  ]))
  await refreshBanditFromStore()
  const a = modelAggregate('a/1')
  assert.ok(Math.abs(a.requests - 9.5) < 1e-12)
  assert.ok(Math.abs(a.errors - 1.5) < 1e-12)
  assert.ok(Math.abs(a.costUsd - 0.85) < 1e-12)
  assert.equal(a.lastErrorAt, 1700000000000)
  assert.equal(pathAggregate('moonshot', 'a/1').lastErrorAt, undefined)
  assert.equal(modelAggregate('b/2').requests, 0, 'une entrée corrompue est ignorée, pas un NaN')
})

test('refresh : store en panne -> la vue locale est conservée', async () => {
  observe({ provider: 'openrouter', model: 'a/1', error: false, costUsd: 1 })
  client.hGetAll = async () => { throw new Error('ECONNRESET') }
  await refreshBanditFromStore()
  assert.equal(modelAggregate('a/1').requests, 1)
})

test('câblage : une requête routée par tier pousse ses candidats comme portée de décote', async () => {
  _setKnownModelsForTest(['a/1', 'b/2', 'c/3', 'd/4'])
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: 'g', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.01 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as any
  const res = await app.fetch(new Request('http://test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer sk_shared_test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'light', messages: [{ role: 'user', content: 'hi' }] }),
  }))
  assert.equal(res.status, 200)
  await tick()
  assert.equal(client.evals.length, 1)
  assert.equal(client.evals[0]!.arguments[1], 'openrouter|a/1')
  assert.equal(client.evals[0]!.arguments[5], 'a/1,b/2', 'portée = les candidats du tier economy')
  // recordRequest borne les candidats au même titre que le modèle (cardinalité).
  recordRequest({ key: 'k', model: 'a/1', candidates: ['a/1', 'evil/unknown-model'] })
  await tick()
  assert.equal(client.evals[1]!.arguments[5], 'a/1,other')
})
