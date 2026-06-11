// Tests du metering durable (incrément B, docs/PRODUCT-V1.md). Aucun Redis réel :
// un client fake en mémoire est injecté (_setMeterClientForTests) — on verrouille le
// schéma d'écriture (clé par jour UTC, champs model|provider|metric, TTL NX), la
// lecture agrégée, le no-op sans client, et la résilience (panne Redis = drop compté,
// jamais une exception sur le chemin de la réponse).

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_METRICS_TOKEN = 'ops-token-test'

const { meterUsage, readUsage, meterDay, _setMeterClientForTests } = await import('../src/meter.ts')
const { renderProm, _resetMetrics } = await import('../src/metrics.ts')
const { app } = await import('../src/app.ts')

// Client fake : hash map en mémoire, mêmes signatures que le sous-ensemble utilisé.
function fakeClient() {
  const store = new Map<string, Map<string, number>>()
  const expires: Record<string, number> = {}
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
    expires,
    async hIncrBy(k: string, f: string, n: number) {
      hash(k).set(f, (hash(k).get(f) ?? 0) + n)
    },
    async hIncrByFloat(k: string, f: string, n: number) {
      hash(k).set(f, (hash(k).get(f) ?? 0) + n)
    },
    async expire(k: string, s: number, mode?: 'NX') {
      if (mode === 'NX' && k in expires) return
      expires[k] = s
    },
    async hGetAll(k: string) {
      return Object.fromEntries([...(store.get(k) ?? new Map())].map(([f, v]) => [f, String(v)]))
    },
  }
}

let client: ReturnType<typeof fakeClient>

beforeEach(() => {
  _resetMetrics()
  client = fakeClient()
  _setMeterClientForTests(client)
})

// Laisse les écritures fire-and-forget se poser (elles sont async mais immédiates).
const settle = () => new Promise((r) => setImmediate(r))

test('ecrit un hash par cle x jour UTC, champs model|provider|metric, TTL pose en NX', async () => {
  meterUsage({ key: 'mymulti', model: 'a/1', provider: 'openrouter', promptTokens: 100, completionTokens: 50, costUsd: 0.01 })
  meterUsage({ key: 'mymulti', model: 'a/1', provider: 'openrouter', promptTokens: 100, completionTokens: 50, costUsd: 0.01 })
  await settle()
  const k = `meter:mymulti:${meterDay()}`
  const h = client.store.get(k)
  assert.ok(h, 'hash absent')
  assert.equal(h.get('a/1|openrouter|requests'), 2)
  assert.equal(h.get('a/1|openrouter|prompt_tokens'), 200)
  assert.equal(h.get('a/1|openrouter|completion_tokens'), 100)
  assert.ok(Math.abs(h.get('a/1|openrouter|cost_usd')! - 0.02) < 1e-12)
  assert.equal(h.get('a/1|openrouter|errors'), undefined, 'pas d\'erreur comptee sans error')
  assert.equal(client.expires[k], 400 * 24 * 3600)
})

test('les chemins d\'acces du meme modele sont des series distinctes', async () => {
  meterUsage({ key: 'k', model: 'm/1', provider: 'openrouter', costUsd: 0.01 })
  meterUsage({ key: 'k', model: 'm/1', provider: 'moonshot', costUsd: 0.008 })
  await settle()
  const h = client.store.get(`meter:k:${meterDay()}`)!
  assert.equal(h.get('m/1|openrouter|requests'), 1)
  assert.equal(h.get('m/1|moonshot|requests'), 1)
})

test('readUsage: agrege totaux, par serie et par jour sur la fenetre', async () => {
  meterUsage({ key: 'k', model: 'a/1', provider: 'openrouter', promptTokens: 10, costUsd: 0.5, error: true })
  meterUsage({ key: 'k', model: 'b/2', provider: 'moonshot', completionTokens: 20, costUsd: 0.25 })
  await settle()
  const report = (await readUsage('k', 30))!
  assert.equal(report.totals.requests, 2)
  assert.equal(report.totals.errors, 1)
  assert.equal(report.totals.promptTokens, 10)
  assert.equal(report.totals.completionTokens, 20)
  assert.ok(Math.abs(report.totals.costUsd - 0.75) < 1e-12)
  assert.equal(report.byModel['a/1|openrouter']!.errors, 1)
  assert.equal(report.byModel['b/2|moonshot']!.requests, 1)
  assert.equal(report.byDay[meterDay()]!.requests, 2)
})

test('sans client (REDIS_URL absent) : no-op total, readUsage null', async () => {
  _setMeterClientForTests(null)
  meterUsage({ key: 'k', model: 'a/1', costUsd: 1 }) // ne doit pas jeter
  assert.equal(await readUsage('k', 7), null)
})

test('Redis down : drop compte dans openmulti_meter_dropped_total, jamais d\'exception', async () => {
  _setMeterClientForTests(client, /* ready */ false)
  meterUsage({ key: 'k', model: 'a/1', costUsd: 1 })
  await settle()
  assert.equal(client.store.size, 0, 'rien ne doit etre ecrit')
  assert.match(renderProm(), /openmulti_meter_dropped_total\{\} 1\b/)
})

test('admin/usage: token ops strict requis, rapport servi avec', async () => {
  meterUsage({ key: 'proj', model: 'a/1', provider: 'openrouter', costUsd: 0.1 })
  await settle()

  const get = (token?: string, qs = 'key=proj&days=7') =>
    app.fetch(new Request(`http://test/admin/usage?${qs}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }))

  assert.equal((await get(undefined)).status, 401)
  assert.equal((await get('sk_caller_key')).status, 401, 'une cle appelante ne suffit pas')

  const ok = await get('ops-token-test')
  assert.equal(ok.status, 200)
  const report = await ok.json()
  assert.equal(report.key, 'proj')
  assert.ok(Math.abs(report.totals.costUsd - 0.1) < 1e-12)

  assert.equal((await get('ops-token-test', 'days=7')).status, 400, 'key obligatoire')
})
