// Gate x402 (B4, câblage). Verrouille : passe-plat strict (clé présente, autre route),
// 402-devis sans paiement (montant = devis, jeton lié), refus honnête sans borne,
// parcours payé complet (couverture, anti-rejeu, verify+settle fakés, crédit wallet,
// exécution comme le projet xw-, reçu X-PAYMENT-RESPONSE), et chaque refus d'argent :
// paiement difforme, trop petit, rejoué, invalide, règlement échoué (nonce relâché).
// Facilitateur et store fakés — aucun réseau, aucune chaîne.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_trusted_static'
process.env.OPENMULTI_X402 = '1'
process.env.OPENMULTI_X402_PAY_TO = '0x' + 'a'.repeat(40)
process.env.OPENMULTI_X402_NETWORK = 'base-sepolia'
process.env.OPENMULTI_X402_QUOTE_SECRET = 'test-x402-secret'
// tier balanced sans plafond env : la borne vient du max_tokens de la requête
process.env.OPENMULTI_MODEL_BALANCED = 'moonshotai/kimi-k2.6' // tarifé dans pricing.ts

const { app } = await import('../src/app.ts')
const { _setStoreClientForTests } = await import('../src/store.ts')
const { _resetKeysForTests } = await import('../src/keys.ts')
const { _setFacilitatorForTest, walletProject, decodePaymentHeader } = await import('../src/x402-gate.ts')

// ── Fakes ───────────────────────────────────────────────────────────────────────
function fakeStore() {
  const hashes = new Map<string, Map<string, string>>()
  const counters = new Map<string, number>()
  const kv = new Map<string, string>()
  const hash = (k: string) => {
    let h = hashes.get(k)
    if (!h) { h = new Map(); hashes.set(k, h) }
    return h
  }
  return {
    hashes, counters, kv,
    async hIncrBy(k: string, f: string, n: number) { hash(k).set(f, String(Number(hash(k).get(f) ?? 0) + n)) },
    async hIncrByFloat(k: string, f: string, n: number) { hash(k).set(f, String(Number(hash(k).get(f) ?? 0) + n)) },
    async expire() {},
    async hGetAll(k: string) { return Object.fromEntries(hashes.get(k) ?? new Map()) },
    async hSet(k: string, f: string, v: string) { const h = hash(k); const fresh = !h.has(f); h.set(f, v); return fresh ? 1 : 0 },
    async hDel(k: string, f: string) { hash(k).delete(f) },
    async incr(k: string) { const n = (counters.get(k) ?? 0) + 1; counters.set(k, n); return n },
    async get(k: string) { return kv.get(k) ?? null },
    async set(k: string, v: string) { kv.set(k, v) },
    async del(k: string) { kv.delete(k); counters.delete(k) },
    async eval(_s: string, opts: { keys: string[]; arguments: string[] }) {
      const [refsKey, creditsKey] = opts.keys as [string, string]
      const [refField, usd, project] = opts.arguments as [string, string, string]
      const refs = hash(refsKey)
      if (refs.has(refField)) return null
      refs.set(refField, usd)
      const h = hash(creditsKey)
      const total = Number(h.get(project) ?? 0) + Number(usd)
      h.set(project, String(total))
      return String(total)
    },
  }
}

interface FacilCall { kind: 'verify' | 'settle' }
let facil: { verifyOk: boolean; settleOk: boolean; calls: FacilCall[] }
let store: ReturnType<typeof fakeStore>

beforeEach(() => {
  _resetKeysForTests()
  store = fakeStore()
  _setStoreClientForTests(store)
  facil = { verifyOk: true, settleOk: true, calls: [] }
  _setFacilitatorForTest({
    name: 'fake',
    async verify() {
      facil.calls.push({ kind: 'verify' })
      return facil.verifyOk ? { isValid: true, payer: '0xPayerAddr' } : { isValid: false, invalidReason: 'bad_signature' }
    },
    async settle() {
      facil.calls.push({ kind: 'settle' })
      return facil.settleOk ? { success: true, transaction: '0xTxHash', network: 'base-sepolia', payer: '0xPayerAddr' } : { success: false, errorReason: 'broadcast_failed' }
    },
  })
  // upstream mocké : réponse OpenAI avec un coût brut de 0.01 $
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: 'x', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.01 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
})

const BODY = JSON.stringify({ model: 'auto', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] })

const post = (headers: Record<string, string> = {}, body = BODY) =>
  app.fetch(new Request('http://test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  }))

function paymentHeader(value: string, nonce = '0xnonce1', from = '0x' + 'b'.repeat(40)): string {
  return Buffer.from(JSON.stringify({
    x402Version: 1, scheme: 'exact', network: 'base-sepolia',
    payload: { signature: '0xsig', authorization: { from, to: process.env.OPENMULTI_X402_PAY_TO, value, validAfter: '0', validBefore: '9999999999', nonce } },
  })).toString('base64')
}

/** Récupère le devis (montant atomique + jeton) via un premier 402. */
async function getQuote(): Promise<{ atomic: string; token: string }> {
  const res = await post()
  assert.equal(res.status, 402)
  const j = await res.json()
  const a = j.accepts[0]
  return { atomic: a.maxAmountRequired, token: a.extra.quoteToken }
}

// ── Passe-plat ────────────────────────────────────────────────────────────────────

test('clé Bearer présente : la gate ne touche à rien (chemin historique)', async () => {
  const res = await post({ authorization: 'Bearer sk_trusted_static' })
  assert.equal(res.status, 200)
  assert.equal(facil.calls.length, 0)
})

test('x402 désactivé : 401 historique sans Authorization', async (t) => {
  const { config } = await import('../src/config.ts')
  ;(config.x402 as { enabled: boolean }).enabled = false
  t.after(() => { (config.x402 as { enabled: boolean }).enabled = true })
  assert.equal((await post()).status, 401)
})

test('autre route /v1 sans clé : 401 historique (la surface payante est chat seulement)', async () => {
  const res = await app.fetch(new Request('http://test/v1/models'))
  assert.equal(res.status, 401)
})

// ── Le 402-devis ──────────────────────────────────────────────────────────────────

test('sans paiement : 402 x402 v1 — montant = devis, USDC sepolia, jeton lié présent', async () => {
  const res = await post()
  assert.equal(res.status, 402)
  const j = await res.json()
  assert.equal(j.x402Version, 1)
  const a = j.accepts[0]
  assert.equal(a.scheme, 'exact')
  assert.equal(a.network, 'base-sepolia')
  assert.equal(a.payTo, process.env.OPENMULTI_X402_PAY_TO)
  assert.ok(Number(a.maxAmountRequired) > 0)
  assert.ok(a.extra.quoteToken.includes('.'))
})

test('requête non bornable (pas de max_tokens ni plafond) : 402 explicatif SANS accepts', async () => {
  const res = await post({}, JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(res.status, 402)
  const j = await res.json()
  assert.deepEqual(j.accepts, [])
  assert.match(j.error.message, /max_tokens/)
})

// ── Parcours payé ─────────────────────────────────────────────────────────────────

test('parcours payé complet : verify+settle, crédit wallet, exécution, reçu, solde = payé - facturé', async () => {
  const { atomic, token } = await getQuote()
  const res = await post({ 'x-payment': paymentHeader(atomic), 'x-openmulti-quote': token })
  assert.equal(res.status, 200)
  assert.deepEqual(facil.calls.map((c) => c.kind), ['verify', 'settle'])
  // reçu de règlement
  const receipt = JSON.parse(Buffer.from(res.headers.get('x-payment-response')!, 'base64').toString())
  assert.equal(receipt.success, true)
  assert.equal(receipt.transaction, '0xTxHash')
  // crédit du projet wallet = montant payé, ref idempotente au tx hash
  const project = walletProject('0xPayerAddr')
  const credited = Number(store.hashes.get('credits:usd')?.get(project))
  assert.equal(credited, Number(atomic) / 1e6)
  assert.ok(store.hashes.get('credits:refs')?.has(`${project}|x402:0xTxHash`))
  // le corps de réponse est l'upstream, inchangé
  const body = await res.json()
  assert.equal(body.choices[0].message.content, 'ok')
})

test('sans jeton de devis (client x402 vanilla) : couverture par devis recalculé', async () => {
  const { atomic } = await getQuote()
  const res = await post({ 'x-payment': paymentHeader(atomic, '0xnonceV') })
  assert.equal(res.status, 200)
})

// ── Les refus d\'argent ───────────────────────────────────────────────────────────

test('paiement difforme, trop petit, ou jeton altéré : 402 sans toucher au facilitateur', async () => {
  const { atomic, token } = await getQuote()
  // difforme
  assert.equal((await post({ 'x-payment': 'pas-du-base64-json' })).status, 402)
  // trop petit (1 unité de moins que le devis)
  const small = String(BigInt(atomic) - 1n)
  const rSmall = await post({ 'x-payment': paymentHeader(small, '0xnonceS'), 'x-openmulti-quote': token })
  assert.equal(rSmall.status, 402)
  assert.match((await rSmall.json()).error.message, /too small/)
  // jeton pour un AUTRE corps
  const rBad = await post(
    { 'x-payment': paymentHeader(atomic, '0xnonceB'), 'x-openmulti-quote': token },
    JSON.stringify({ model: 'auto', max_tokens: 100, messages: [{ role: 'user', content: 'AUTRE' }] }),
  )
  assert.equal(rBad.status, 402)
  assert.match((await rBad.json()).error.message, /quote token/)
  assert.equal(facil.calls.length, 0, 'le facilitateur ne doit jamais être appelé sur un refus local')
})

test('anti-rejeu : le même nonce ne finance pas deux exécutions', async () => {
  const { atomic, token } = await getQuote()
  assert.equal((await post({ 'x-payment': paymentHeader(atomic, '0xsame'), 'x-openmulti-quote': token })).status, 200)
  const replay = await post({ 'x-payment': paymentHeader(atomic, '0xsame'), 'x-openmulti-quote': token })
  assert.equal(replay.status, 402)
  assert.match((await replay.json()).error.message, /already used/)
})

test('verify invalide : 402, nonce relâché (une retentative honnête reste possible)', async () => {
  const { atomic, token } = await getQuote()
  facil.verifyOk = false
  assert.equal((await post({ 'x-payment': paymentHeader(atomic, '0xn2'), 'x-openmulti-quote': token })).status, 402)
  facil.verifyOk = true
  assert.equal((await post({ 'x-payment': paymentHeader(atomic, '0xn2'), 'x-openmulti-quote': token })).status, 200)
})

test('settle échoué : 402, nonce relâché, rien crédité', async () => {
  const { atomic, token } = await getQuote()
  facil.settleOk = false
  const res = await post({ 'x-payment': paymentHeader(atomic, '0xn3'), 'x-openmulti-quote': token })
  assert.equal(res.status, 402)
  assert.match((await res.json()).error.message, /settlement failed/)
  assert.equal(store.hashes.get('credits:usd'), undefined)
  facil.settleOk = true
  assert.equal((await post({ 'x-payment': paymentHeader(atomic, '0xn3'), 'x-openmulti-quote': token })).status, 200)
})

test('store down : 503 AVANT tout règlement (fail-closed, rien ne bouge)', async () => {
  const { atomic, token } = await getQuote()
  _setStoreClientForTests(store, false)
  const res = await post({ 'x-payment': paymentHeader(atomic, '0xn4'), 'x-openmulti-quote': token })
  assert.equal(res.status, 503)
  assert.equal(facil.calls.length, 0)
})

// ── Unités ────────────────────────────────────────────────────────────────────────

test('decodePaymentHeader : bornes et formes refusées', () => {
  assert.equal(decodePaymentHeader('x'.repeat(9000)), null)
  assert.equal(decodePaymentHeader(Buffer.from('[]').toString('base64')), null)
  assert.equal(decodePaymentHeader(Buffer.from('{"payload":{}}').toString('base64')), null)
  const bad = Buffer.from(JSON.stringify({ payload: { authorization: { from: 'pas-une-adresse', value: '10', nonce: 'n' } } })).toString('base64')
  assert.equal(decodePaymentHeader(bad), null)
})

test('walletProject : stable, insensible à la casse, jamais l\'adresse en clair', () => {
  const p = walletProject('0xAbCd' + 'e'.repeat(36))
  assert.equal(p, walletProject('0xabcd' + 'E'.repeat(36).toLowerCase()))
  assert.match(p, /^xw-[0-9a-f]{10}$/)
  assert.equal(p.includes('abcd'), false)
})
