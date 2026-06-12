// Tests des briques console (solde prépayé, usage multi-projets, nom de clé).
// Store fake en mémoire. Verrouille : top-up idempotent, balance = crédits − cumul
// facturé − local, 402 à épuisement, fail-open sans crédits posés, usage global,
// nom de clé rédigé dans la liste.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_free-project_static'
process.env.OPENMULTI_METRICS_TOKEN = 'ops-token-test'
process.env.OPENMULTI_MARGIN_PCT = '20'

const { app } = await import('../src/app.ts')
const { _setStoreClientForTests } = await import('../src/store.ts')
const { _resetKeysForTests, refreshKeys, checkBalance } = await import('../src/keys.ts')
const { _resetMetrics } = await import('../src/metrics.ts')

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
    async incr() {
      return 1
    },
  }
}

let client: ReturnType<typeof fakeClient>

beforeEach(() => {
  _resetMetrics()
  _resetKeysForTests()
  client = fakeClient()
  _setStoreClientForTests(client)
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: 'g', choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.05 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as any
})

const OPS = { authorization: 'Bearer ops-token-test', 'content-type': 'application/json' }
const admin = (method: string, path: string, body?: unknown) =>
  app.fetch(new Request(`http://test${path}`, { method, headers: OPS, ...(body ? { body: JSON.stringify(body) } : {}) }))
const chat = (key: string) =>
  app.fetch(new Request('http://test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
  }))

test('top-up idempotent : meme ref jamais double-creditee', async () => {
  let res = await admin('POST', '/admin/credits/acme', { usd: 10, ref: 'stripe_evt_1' })
  assert.equal(res.status, 201)
  assert.equal((await res.json()).creditsUsd, 10)
  // re-livraison du meme webhook -> no-op
  res = await admin('POST', '/admin/credits/acme', { usd: 10, ref: 'stripe_evt_1' })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).duplicate, true)
  // nouveau top-up -> cumul
  res = await admin('POST', '/admin/credits/acme', { usd: 5, ref: 'stripe_evt_2' })
  assert.equal((await res.json()).creditsUsd, 15)
  // validations
  assert.equal((await admin('POST', '/admin/credits/acme', { usd: -2, ref: 'x' })).status, 400)
  assert.equal((await admin('POST', '/admin/credits/acme', { usd: 1 })).status, 400)
})

test('le solde decompte le facture (x1.2) et bloque a zero avec 402', async () => {
  // credite 0.10 $, chaque appel coute 0.05 brut = 0.06 facture
  await admin('POST', '/admin/credits/payg', { usd: 0.1, ref: 'evt_1' })
  const { key } = await (await admin('POST', '/admin/keys', { project: 'payg' })).json()

  assert.equal((await chat(key)).status, 200) // solde 0.10 -> 0.04
  assert.equal((await chat(key)).status, 200) // solde 0.04 -> -0.02 (le decompte est post-reponse)
  const blocked = await chat(key) // solde <= 0 -> bloque
  assert.equal(blocked.status, 402)
  const j = await blocked.json()
  assert.equal(j.error.type, 'insufficient_credits')

  // re-crediter debloque
  await admin('POST', '/admin/credits/payg', { usd: 10, ref: 'evt_2' })
  assert.equal((await chat(key)).status, 200)
})

test('GET /admin/balance : credits, depense (store + local), solde', async () => {
  await admin('POST', '/admin/credits/acme', { usd: 10, ref: 'e1' })
  // depense deja cumulee dans le store (autre pod / historique)
  await client.hIncrByFloat('spent:usd', 'acme', 2.5)
  await refreshKeys()
  const { balances } = await (await admin('GET', '/admin/balance')).json()
  assert.equal(balances.acme.creditsUsd, 10)
  assert.equal(balances.acme.spentUsd, 2.5)
  assert.equal(balances.acme.balanceUsd, 7.5)
})

test('fail-open : un projet sans credits poses n\'est jamais bloque', async () => {
  assert.equal(checkBalance('free-project').blocked, false)
  assert.equal((await chat('sk_free-project_static')).status, 200)
})

test('usage multi-projets : GET /admin/usage sans key agrege tous les projets connus', async () => {
  const { key: k1 } = await (await admin('POST', '/admin/keys', { project: 'alpha' })).json()
  const { key: k2 } = await (await admin('POST', '/admin/keys', { project: 'beta' })).json()
  await chat(k1)
  await chat(k2)
  await new Promise((r) => setImmediate(r))
  const res = await admin('GET', '/admin/usage?days=1')
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.ok(j.projects.alpha, 'alpha absent')
  assert.ok(j.projects.beta, 'beta absent')
  assert.equal(j.projects.alpha.totals.requests, 1)
  assert.ok(Math.abs(j.projects.alpha.totals.billedUsd - 0.06) < 1e-9)
})

test('nom de cle : stocke, liste (redige), valide', async () => {
  const created = await (await admin('POST', '/admin/keys', { project: 'acme', name: 'Production backend' })).json()
  assert.ok(created.key)
  const { keys } = await (await admin('GET', '/admin/keys')).json()
  const k = keys.find((x: any) => x.id === created.id)
  assert.equal(k.name, 'Production backend')
  assert.equal(JSON.stringify(keys).includes(created.key), false, 'jamais le secret')
  assert.equal((await admin('POST', '/admin/keys', { project: 'acme', name: 'x'.repeat(65) })).status, 400)
})
