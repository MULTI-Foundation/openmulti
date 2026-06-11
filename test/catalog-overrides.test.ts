// Tests des overrides de catalogue à la volée (incrément G) + des nouveaux défauts.
// Store fake en mémoire. Verrouille : la précédence override > env > défauts, le
// cycle PUT/GET/DELETE via l'admin (token strict), la validation, le fail-open sans
// store, et les invariants des défauts curés (primaires iso, quality = opus-4.8).

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_cat_test'
process.env.OPENMULTI_METRICS_TOKEN = 'ops-token-test'
// env de référence pour tester la précédence (l'override doit le battre)
process.env.OPENMULTI_MODELS_ECONOMY = 'env/model-a,env/model-b'

const { _setStoreClientForTests } = await import('../src/store.ts')
const { candidatesFor } = await import('../src/catalog.ts')
const { refreshCatalogOverrides, _resetCatalogOverridesForTests } = await import('../src/catalog-overrides.ts')
const { app } = await import('../src/app.ts')

function fakeClient() {
  const store = new Map<string, Map<string, string>>()
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
  }
}

let client: ReturnType<typeof fakeClient>

beforeEach(() => {
  _resetCatalogOverridesForTests()
  client = fakeClient()
  _setStoreClientForTests(client)
})

const OPS = { authorization: 'Bearer ops-token-test', 'content-type': 'application/json' }
const put = (slot: string, body: unknown, headers: Record<string, string> = OPS) =>
  app.fetch(new Request(`http://test/admin/catalog/${slot}`, { method: 'PUT', headers, body: JSON.stringify(body) }))
const del = (slot: string) =>
  app.fetch(new Request(`http://test/admin/catalog/${slot}`, { method: 'DELETE', headers: OPS }))
const get = () => app.fetch(new Request('http://test/admin/catalog', { headers: OPS }))

test('defauts cures : primaires iso en tete, quality = opus-4.8, sets multi-candidats', () => {
  assert.equal(candidatesFor('balanced')[0], 'anthropic/claude-sonnet-4-5') // iso
  assert.equal(candidatesFor('quality')[0], 'anthropic/claude-opus-4.8') // decision du 2026-06-11
  assert.ok(candidatesFor('balanced').length >= 3, 'le bandit a besoin de candidats')
  assert.equal(candidatesFor('balanced', 'agent')[0], 'moonshotai/kimi-k2.6') // iso agent
  assert.ok(candidatesFor('balanced', 'agent').includes('qwen/qwen3-coder-plus'))
})

test('override admin > env > defauts, et DELETE retombe proprement', async () => {
  // env gagne sur les defauts (etat initial)
  assert.deepEqual(candidatesFor('economy'), ['env/model-a', 'env/model-b'])

  // l'override bat l'env, effet immediat (refresh post-mutation locale)
  const res = await put('economy', { models: ['override/model-x', 'env/model-a'] })
  assert.equal(res.status, 200)
  assert.deepEqual(candidatesFor('economy'), ['override/model-x', 'env/model-a'])

  // visible dans GET /admin/catalog (overrides + sets effectifs)
  const cat = await (await get()).json()
  assert.deepEqual(cat.overrides.economy, ['override/model-x', 'env/model-a'])
  assert.deepEqual(cat.effective.economy, ['override/model-x', 'env/model-a'])

  // DELETE -> retour a l'env
  assert.equal((await del('economy')).status, 200)
  assert.deepEqual(candidatesFor('economy'), ['env/model-a', 'env/model-b'])
  assert.equal((await del('economy')).status, 404, 'plus d\'override a retirer')
})

test('slot par purpose : agent_balanced pilotable a la volee', async () => {
  await put('agent_balanced', { models: ['z-ai/glm-5'] })
  assert.deepEqual(candidatesFor('balanced', 'agent'), ['z-ai/glm-5'])
  // le tier nu n'est pas affecte
  assert.equal(candidatesFor('balanced')[0], 'anthropic/claude-sonnet-4-5')
})

test('validation : slot inconnu, models vide/trop long/id invalide -> 400', async () => {
  assert.equal((await put('turbo', { models: ['a/b'] })).status, 400)
  assert.equal((await put('balanced', { models: [] })).status, 400)
  assert.equal((await put('balanced', {})).status, 400)
  assert.equal((await put('balanced', { models: Array(9).fill('a/b') })).status, 400)
  assert.equal((await put('balanced', { models: ['bad model id!'] })).status, 400)
})

test('auth stricte : une cle appelante ne suffit pas', async () => {
  const res = await put('balanced', { models: ['a/b'] }, { authorization: 'Bearer sk_cat_test', 'content-type': 'application/json' })
  assert.equal(res.status, 401)
})

test('sans store : 503 a l\'ecriture, le catalogue env/defauts continue de servir', async () => {
  _setStoreClientForTests(null)
  assert.equal((await put('balanced', { models: ['a/b'] })).status, 503)
  assert.equal(candidatesFor('quality')[0], 'anthropic/claude-opus-4.8')
})

test('multi-pod : un override pose par un autre pod arrive au refresh', async () => {
  await client.hSet('catalog:slots', 'quality', 'other-pod/model')
  await refreshCatalogOverrides()
  assert.deepEqual(candidatesFor('quality'), ['other-pod/model'])
  // une entree corrompue est ignoree sans casser le reste
  await client.hSet('catalog:slots', 'bad slot!', 'x/y')
  await refreshCatalogOverrides()
  assert.deepEqual(candidatesFor('quality'), ['other-pod/model'])
})

test('/v1/models reflete un override de purpose (slot dynamique decouvert)', async () => {
  await put('research_quality', { models: ['openai/o3-deep-research'] })
  const res = await app.fetch(new Request('http://test/v1/models', { headers: { authorization: 'Bearer sk_cat_test' } }))
  const j = await res.json()
  const m = j.data.find((x: any) => x.id === 'openai/o3-deep-research')
  assert.ok(m, 'modele override absent de /v1/models')
  assert.ok(m.openmulti.purposes.includes('research'))
})
