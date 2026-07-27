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
const { renderProm, _resetMetrics, _setKnownModelsForTest } = await import('../src/metrics.ts')
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
    // Utilisés par keys.ts (registre/plafonds), pas par meter — présents pour
    // satisfaire l'interface StoreClient partagée.
    async hSet(k: string, f: string, v: string) {
      hash(k).set(f, v as unknown as number)
    },
    async hDel(k: string, f: string) {
      hash(k).delete(f)
    },
    async incr(k: string) {
      const h = hash('__counters__')
      const v = Number(h.get(k) ?? 0) + 1
      h.set(k, v as any)
      return v
    },
  }
}

let client: ReturnType<typeof fakeClient>

beforeEach(() => {
  _resetMetrics()
  // F8 : meterUsage borne désormais le model à l'allowlist connue (repli 'other') avant
  // d'en faire un champ de hash. Les ids synthétiques de ces tests de schéma sont déclarés
  // connus ici pour qu'ils gardent leur id (l'intention = verrouiller le schéma d'écriture) ;
  // le collapse d'un id INCONNU (le cas d'abus) a son propre test dédié plus bas.
  _setKnownModelsForTest(['a/1', 'b/2', 'm/1', 'free/model'])
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
  // E-4 : le coût s'écrit en micro-USD entiers (2 × 0.01 $ = 20_000 µ$), pas en float.
  assert.equal(h.get('a/1|openrouter|cost_microusd'), 20000)
  assert.equal(h.get('a/1|openrouter|cost_usd'), undefined, 'plus de champ float legacy écrit')
  assert.equal(h.get('a/1|openrouter|errors'), undefined, 'pas d\'erreur comptee sans error')
  assert.equal(client.expires[k], 400 * 24 * 3600)
})

test('P0-6 : un cout/facture legitime de 0 est metre (serie a 0), pas escamote', async () => {
  // Modele gratuit ou reponse a cout nul : la requete DOIT etre facturee 0, pas traitee
  // comme si le cout etait absent. Avant le fix, `if (r.costUsd)`/`if (r.billedUsd)`
  // sautaient les ecritures -> aucune serie cost_usd/billed_usd (0 escamote).
  meterUsage({ key: 'freeproj', model: 'free/model', provider: 'openrouter', costUsd: 0, billedUsd: 0 })
  await settle()
  const h = client.store.get(`meter:freeproj:${meterDay()}`)!
  assert.ok(h, 'hash absent')
  assert.equal(h.get('free/model|openrouter|requests'), 1)
  // E-4 + P0-6 : champs micro-USD entiers écrits à 0 (mesuré), pas escamotés.
  assert.equal(h.get('free/model|openrouter|cost_microusd'), 0, 'cost_microusd=0 doit etre ecrit')
  assert.equal(h.get('free/model|openrouter|billed_microusd'), 0, 'billed_microusd=0 doit etre ecrit')
  // le ledger spent:microusd (base du solde prepaye) recoit aussi l'entree a 0
  assert.equal(client.store.get('spent:microusd')?.get('freeproj'), 0)
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

  // sans `key` : vue multi-projets (le batch de sync console)
  const all = await get('ops-token-test', 'days=7')
  assert.equal(all.status, 200)
  const report2 = await all.json()
  assert.ok(report2.projects.proj, 'le projet doit apparaitre dans la vue globale')
})

test('F8: un model INCONNU epingle par l\'appelant est collapse sur "other" (pas de | injecte, pas de champs sans limite)', async () => {
  // Un abuseur épingle des ids uniques porteurs de '|' : sans borne, chaque requête crée
  // un champ durable (TTL ~400 j) dans le store partagé et le '|' casserait le split de
  // readUsage. Le model est borné à 'other' AVANT de construire le champ.
  meterUsage({ key: 'proj', model: 'x/y|billed_microusd', provider: 'openrouter', costUsd: 0.001 })
  for (let i = 0; i < 50; i++) meterUsage({ key: 'proj', model: `x/uuid-${i}`, provider: 'openrouter', costUsd: 0.001 })
  await settle()
  const h = client.store.get(`meter:proj:${meterDay()}`)!
  // Tous collapsent sur la MÊME série 'other|openrouter' : cardinalité bornée.
  assert.equal(h.get('other|openrouter|requests'), 51)
  // Aucun champ ne porte un id d'attaque ni un '|' injecté par l'appelant.
  for (const field of h.keys()) {
    assert.ok(!field.includes('uuid-'), `un id inconnu a fui dans un champ meter: ${field}`)
    assert.ok(field.split('|').length === 3, `un '|' injecte a corrompu le schema du champ: ${field}`)
  }
  // La compta projet (base du solde prépayé) reste juste : keyée par projet, pas par modèle.
  assert.equal(client.store.get('spent:microusd')?.get('proj'), undefined, 'pas de billedUsd ici, ledger intact')
})

test('F8: readUsage regroupe l\'abus sous other|provider sans corruption de serie', async () => {
  meterUsage({ key: 'proj', model: 'x/a|errors', provider: 'openrouter', costUsd: 0.002 })
  meterUsage({ key: 'proj', model: 'x/b|requests', provider: 'openrouter', costUsd: 0.003 })
  await settle()
  const report = (await readUsage('proj', 7))!
  assert.equal(report.totals.requests, 2, 'les deux requetes sont bien comptees')
  assert.ok(report.byModel['other|openrouter'], 'la serie abusive est regroupee sous other|openrouter')
  assert.equal(report.byModel['other|openrouter']!.requests, 2)
})
