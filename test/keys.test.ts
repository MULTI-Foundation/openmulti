// Tests du cycle de vie des clés + plafonds de dépense (incrément C). Store fake en
// mémoire (aucun Redis réel). Verrouille : création (secret retourné une seule fois),
// liste rédigée, auth via le registre, révocation effective, plafond par projet
// (429 + Retry-After), fail-open sans plafond et sans store.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_envproj_static'
process.env.OPENMULTI_METRICS_TOKEN = 'ops-token-test'

const { _setStoreClientForTests } = await import('../src/store.ts')
const { noteLocalSpend, checkSpendCap, secondsToUtcMidnight, _resetKeysForTests, refreshKeys } =
  await import('../src/keys.ts')
const { _resetMetrics } = await import('../src/metrics.ts')
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
    async hIncrBy(k: string, f: string, n: number) {
      hash(k).set(f, String(Number(hash(k).get(f) ?? 0) + n))
    },
    async hIncrByFloat(k: string, f: string, n: number) {
      hash(k).set(f, String(Number(hash(k).get(f) ?? 0) + n))
    },
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
  }
}

beforeEach(() => {
  _resetMetrics()
  _resetKeysForTests()
  _setStoreClientForTests(fakeClient())
  // Mock upstream pour les requêtes qui passent le plafond.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: 'gen-1', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as any
})

const OPS = { authorization: 'Bearer ops-token-test', 'content-type': 'application/json' }

const adminPost = (path: string, body: unknown) =>
  app.fetch(new Request(`http://test${path}`, { method: 'POST', headers: OPS, body: JSON.stringify(body) }))
const adminPut = (path: string, body: unknown) =>
  app.fetch(new Request(`http://test${path}`, { method: 'PUT', headers: OPS, body: JSON.stringify(body) }))
const adminGet = (path: string) => app.fetch(new Request(`http://test${path}`, { headers: OPS }))
const adminDelete = (path: string) => app.fetch(new Request(`http://test${path}`, { method: 'DELETE', headers: OPS }))
const callerGet = (key: string) =>
  app.fetch(new Request('http://test/v1/models', { headers: { authorization: `Bearer ${key}` } }))
const callerChat = (key: string) =>
  app.fetch(new Request('http://test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
  }))

test('cycle de vie : creation (secret une fois), liste redigee, auth, revocation', async () => {
  const created = await adminPost('/admin/keys', { project: 'acme' })
  assert.equal(created.status, 201)
  const { key, id } = await created.json()
  assert.match(key, /^sk_acme_[0-9a-f]{48}$/)

  // la liste ne re-expose JAMAIS le secret
  const list = await (await adminGet('/admin/keys')).json()
  assert.equal(list.keys.length, 1)
  assert.equal(list.keys[0].id, id)
  assert.equal(list.keys[0].project, 'acme')
  assert.equal(JSON.stringify(list).includes(key), false)

  // la cle du registre authentifie un appel /v1
  assert.equal((await callerGet(key)).status, 200)
  // la cle env continue de marcher (union)
  assert.equal((await callerGet('sk_envproj_static')).status, 200)
  // une cle inconnue est refusee
  assert.equal((await callerGet('sk_acme_forged')).status, 401)

  // revocation -> 401 immediat (refresh local post-mutation)
  assert.equal((await adminDelete(`/admin/keys/${id}`)).status, 200)
  assert.equal((await callerGet(key)).status, 401)
  assert.equal((await adminDelete('/admin/keys/unknown')).status, 404)
})

test('projet invalide ou registre coupe -> erreurs propres', async () => {
  assert.equal((await adminPost('/admin/keys', { project: 'Bad Project!' })).status, 400)
  assert.equal((await adminPost('/admin/keys', {})).status, 400)
  _setStoreClientForTests(null)
  assert.equal((await adminPost('/admin/keys', { project: 'acme' })).status, 503)
})

test('plafond par projet : 429 + Retry-After au-dela, passe en-deca, fail-open sans plafond', async () => {
  const { key } = await (await adminPost('/admin/keys', { project: 'capped', capUsdPerDay: 1 })).json()

  // sous le plafond : la requete passe (et son cout s'accumule localement)
  assert.equal((await callerChat(key)).status, 200)

  // depense locale au-dela du plafond -> 429 explicite avec Retry-After jusqu'a minuit UTC
  noteLocalSpend('capped', 1.5)
  const blocked = await callerChat(key)
  assert.equal(blocked.status, 429)
  const body = await blocked.json()
  assert.equal(body.error.type, 'spend_cap_exceeded')
  const retryAfter = Number(blocked.headers.get('retry-after'))
  assert.ok(retryAfter >= 1 && retryAfter <= 86400)

  // un projet sans plafond n'est jamais bloque
  assert.equal(checkSpendCap('envproj').blocked, false)
})

test('le plafond se nourrit aussi du metering durable au refresh', async () => {
  await adminPut('/admin/caps/billed', { usdPerDay: 0.5 })
  // depense deja ecrite dans le store (par un autre pod, ou avant restart)
  const day = new Date().toISOString().slice(0, 10)
  const c = fakeClient()
  _setStoreClientForTests(c)
  await c.hSet('caps:usd_per_day', 'billed', '0.5')
  await c.hSet(`meter:billed:${day}`, 'a/1|openrouter|cost_usd', '0.75')
  await refreshKeys()
  const verdict = checkSpendCap('billed')
  assert.equal(verdict.blocked, true)
  assert.equal(verdict.spentUsd, 0.75)
})

test('secondsToUtcMidnight : bornes saines', () => {
  const s = secondsToUtcMidnight(new Date('2026-06-11T23:59:30Z'))
  assert.ok(s >= 29 && s <= 31, String(s))
  assert.equal(secondsToUtcMidnight(new Date('2026-06-11T00:00:00Z')), 86400)
})
