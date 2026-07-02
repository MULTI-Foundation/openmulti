// GET /v1/balance : la vue compte de l'appelant. Verrouille : auth exigée, le projet
// vient de la CLÉ (jamais d'un paramètre — pas de lecture cross-projet), champs solde
// seulement si prépayé, plafond seulement si cappé, topup_url templée depuis
// OPENMULTI_TOPUP_URL (et présente dans les 402 insufficient_credits).

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_acme_static,sk_free_static'
process.env.OPENMULTI_METRICS_TOKEN = 'ops-token-test'
process.env.OPENMULTI_ADMIN_TOKEN = 'ops-token-test'
process.env.OPENMULTI_TOPUP_URL = 'https://console.test/topup?project={project}'

const { app } = await import('../src/app.ts')
const { _setStoreClientForTests } = await import('../src/store.ts')
const { _resetKeysForTests, addCredits, setCap, refreshKeys } = await import('../src/keys.ts')

function fakeClient() {
  const hashes = new Map<string, Map<string, string>>()
  const hash = (k: string) => {
    let h = hashes.get(k)
    if (!h) {
      h = new Map()
      hashes.set(k, h)
    }
    return h
  }
  return {
    async hIncrBy(k: string, f: string, n: number) { hash(k).set(f, String(Number(hash(k).get(f) ?? 0) + n)) },
    async hIncrByFloat(k: string, f: string, n: number) { hash(k).set(f, String(Number(hash(k).get(f) ?? 0) + n)) },
    async expire() {},
    async hGetAll(k: string) { return Object.fromEntries(hashes.get(k) ?? new Map()) },
    async hSet(k: string, f: string, v: string) { const h = hash(k); const fresh = !h.has(f); h.set(f, v); return fresh ? 1 : 0 },
    async hDel(k: string, f: string) { hash(k).delete(f) },
    async incr() { return 1 },
    async get() { return null },
    async set() {},
    async del() {},
  }
}

beforeEach(() => {
  _resetKeysForTests()
  _setStoreClientForTests(fakeClient())
})

const balance = (key?: string) =>
  app.fetch(new Request('http://test/v1/balance', { headers: key ? { authorization: `Bearer ${key}` } : {} }))

test('401 sans cle (la route vit sous /v1/*)', async () => {
  assert.equal((await balance()).status, 401)
})

test('projet de confiance sans credits ni cap : prepaid=false, pas de champs solde', async () => {
  const res = await balance('sk_free_static')
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.project, 'free')
  assert.equal(j.prepaid, false)
  assert.equal('balance_usd' in j, false)
  assert.equal('cap_usd_per_day' in j, false)
  // le lien de recharge est là même sans solde (on peut créditer avant d'épuiser)
  assert.equal(j.topup_url, 'https://console.test/topup?project=free')
})

test('projet prepaye et cappe : solde + plafond visibles, projet = celui de la cle', async () => {
  await addCredits('acme', 10, 'evt_1')
  await setCap('acme', 5)
  await refreshKeys()
  const j = await (await balance('sk_acme_static')).json()
  assert.equal(j.project, 'acme')
  assert.equal(j.prepaid, true)
  assert.equal(j.credits_usd, 10)
  assert.equal(j.balance_usd, 10)
  assert.equal(j.cap_usd_per_day, 5)
})

test('402 insufficient_credits : le message porte le lien de recharge', async () => {
  await addCredits('acme', 0.001, 'evt_tiny')
  await refreshKeys()
  // brûle le solde : un appel coûte 0.05
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: 'x', choices: [], usage: { cost: 0.05 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
  const chat = () =>
    app.fetch(new Request('http://test/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk_acme_static', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    }))
  await chat() // consomme, solde négatif
  const blocked = await chat()
  assert.equal(blocked.status, 402)
  const j = await blocked.json()
  assert.ok(j.error.message.includes('https://console.test/topup?project=acme'), `lien absent: ${j.error.message}`)
})
