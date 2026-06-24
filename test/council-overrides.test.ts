// Overrides de config council à la volée : panels par preset, chairs, preset par défaut.
// Store fake en mémoire. Verrouille : précédence override > env (effectiveCouncil +
// /v1/council/presets), cycle PUT/GET/DELETE via l'admin (token strict), validation par
// type de slot, fail-open sans store, convergence multi-pod.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_council_ovr_test'
process.env.OPENMULTI_METRICS_TOKEN = 'ops-token-test'
// env de référence (l'override doit le battre)
process.env.OPENMULTI_COUNCIL_CHAIR = 'env/chair'
process.env.OPENMULTI_COUNCIL_CHAIR_FLASH = 'env/chair-flash'
process.env.OPENMULTI_COUNCIL_DEFAULT_PRESET = 'budget'
process.env.OPENMULTI_COUNCIL_PANEL_FLASH = 'env/f1,env/f2'
process.env.OPENMULTI_COUNCIL_PANEL_BUDGET = 'env/b1,env/b2'
process.env.OPENMULTI_COUNCIL_PANEL_QUALITY = 'env/q1,env/q2'

const { _setStoreClientForTests } = await import('../src/store.ts')
const { effectiveCouncil, resolveCouncil } = await import('../src/council.ts')
const { refreshCouncilOverrides, _resetCouncilOverridesForTests } = await import('../src/council-overrides.ts')
const { app } = await import('../src/app.ts')

function fakeClient() {
  const store = new Map<string, Map<string, string>>()
  const hash = (k: string) => {
    let h = store.get(k)
    if (!h) { h = new Map(); store.set(k, h) }
    return h
  }
  return {
    store,
    async hIncrBy() {}, async hIncrByFloat() {}, async expire() {},
    async hGetAll(k: string) { return Object.fromEntries(store.get(k) ?? new Map()) },
    async hSet(k: string, f: string, v: string) { hash(k).set(f, v) },
    async hDel(k: string, f: string) { hash(k).delete(f) },
    async incr() { return 1 },
  }
}

let client: ReturnType<typeof fakeClient>

beforeEach(() => {
  _resetCouncilOverridesForTests()
  client = fakeClient()
  _setStoreClientForTests(client)
})

const OPS = { authorization: 'Bearer ops-token-test', 'content-type': 'application/json' }
const put = (slot: string, body: unknown, headers: Record<string, string> = OPS) =>
  app.fetch(new Request(`http://test/admin/council/${slot}`, { method: 'PUT', headers, body: JSON.stringify(body) }))
const del = (slot: string) =>
  app.fetch(new Request(`http://test/admin/council/${slot}`, { method: 'DELETE', headers: OPS }))
const getAdmin = () => app.fetch(new Request('http://test/admin/council', { headers: OPS }))

test('état initial : effectiveCouncil = env', () => {
  const eff = effectiveCouncil()
  assert.deepEqual(eff.panelBudget, ['env/b1', 'env/b2'])
  assert.equal(eff.chair, 'env/chair')
  assert.equal(eff.defaultPreset, 'budget')
})

test('override admin > env, sur panel + chair + defaultPreset, effet immédiat', async () => {
  assert.equal((await put('panelFlash', { value: ['ovr/f1', 'ovr/f2', 'ovr/f3'] })).status, 200)
  assert.equal((await put('chairFlash', { value: 'ovr/chair-flash' })).status, 200)
  assert.equal((await put('defaultPreset', { value: 'flash' })).status, 200)

  const eff = effectiveCouncil()
  assert.deepEqual(eff.panelFlash, ['ovr/f1', 'ovr/f2', 'ovr/f3'])
  assert.equal(eff.chairFlash, 'ovr/chair-flash')
  assert.equal(eff.defaultPreset, 'flash')
  // non touchés -> toujours env
  assert.deepEqual(eff.panelBudget, ['env/b1', 'env/b2'])

  // resolveCouncil reflète l'override : preset par défaut = flash -> panel/chair flash overridés
  const r = resolveCouncil({ messages: [], openmulti: { council: {} } } as any) as any
  assert.deepEqual(r.panel, ['ovr/f1', 'ovr/f2', 'ovr/f3'])
  assert.equal(r.chair, 'ovr/chair-flash')

  // visible dans GET /admin/council
  const j = await (await getAdmin()).json()
  assert.deepEqual(j.overrides.panelFlash, ['ovr/f1', 'ovr/f2', 'ovr/f3'])
  assert.equal(j.effective.chairFlash, 'ovr/chair-flash')
})

test('DELETE retombe sur l\'env', async () => {
  await put('chair', { value: 'ovr/chair' })
  assert.equal(effectiveCouncil().chair, 'ovr/chair')
  assert.equal((await del('chair')).status, 200)
  assert.equal(effectiveCouncil().chair, 'env/chair')
  assert.equal((await del('chair')).status, 404, 'plus d\'override à retirer')
})

test('validation par type de slot -> 400', async () => {
  assert.equal((await put('panelFlash', { value: 'pas-un-tableau' })).status, 400)
  assert.equal((await put('panelFlash', { value: [] })).status, 400)
  assert.equal((await put('panelFlash', { value: Array(9).fill('a/b') })).status, 400)
  assert.equal((await put('panelFlash', { value: ['bad id!'] })).status, 400)
  assert.equal((await put('chair', { value: ['a/b'] })).status, 400, 'chair = un seul modèle')
  assert.equal((await put('chair', { value: 'bad id!' })).status, 400)
  assert.equal((await put('defaultPreset', { value: 'turbo' })).status, 400)
  assert.equal((await put('inconnu', { value: 'a/b' })).status, 400)
  assert.equal((await put('chair', {})).status, 400, '`value` requis')
})

test('auth stricte : une clé appelante ne suffit pas', async () => {
  const res = await put('chair', { value: 'a/b' }, { authorization: 'Bearer sk_council_ovr_test', 'content-type': 'application/json' })
  assert.equal(res.status, 401)
})

test('sans store : 503 à l\'écriture, l\'env continue de servir', async () => {
  _setStoreClientForTests(null)
  assert.equal((await put('chair', { value: 'a/b' })).status, 503)
  assert.equal(effectiveCouncil().chair, 'env/chair')
})

test('multi-pod : un override posé ailleurs arrive au refresh ; entrée corrompue ignorée', async () => {
  await client.hSet('council:slots', 'panelQuality', 'other/q1,other/q2')
  await refreshCouncilOverrides()
  assert.deepEqual(effectiveCouncil().panelQuality, ['other/q1', 'other/q2'])
  await client.hSet('council:slots', 'bad slot!', 'x/y')
  await refreshCouncilOverrides()
  assert.deepEqual(effectiveCouncil().panelQuality, ['other/q1', 'other/q2'])
})
