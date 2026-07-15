// E-1 sur le rail x402 : un jeton de devis présenté dans le corps (openmulti.quote_token)
// fait couvrir le montant QUOTÉ par le paiement, et le CONTRAT est pré-vérifié AVANT
// tout verify/settle — un contrat mort (borne courante > montant quoté) est un 409 et
// l'argent ne bouge jamais.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_x402pin_test'
process.env.OPENMULTI_QUOTE_TOKEN_SECRET = 'x402pin-secret'
process.env.OPENMULTI_MODEL_BALANCED = 'moonshotai/kimi-k2.6'
process.env.OPENMULTI_X402 = '1'
process.env.OPENMULTI_X402_PAY_TO = '0x' + 'a'.repeat(40)
process.env.OPENMULTI_X402_NETWORK = 'base-sepolia'
process.env.OPENMULTI_X402_QUOTE_SECRET = 'x402-native-secret'

const SECRET = 'x402pin-secret'
const KIMI = 'moonshotai/kimi-k2.6'
const { app } = await import('../src/app.ts')
const { _setStoreClientForTests } = await import('../src/store.ts')
const { _resetKeysForTests } = await import('../src/keys.ts')
const { _setFacilitatorForTest } = await import('../src/x402-gate.ts')
const { decodeQuoteToken, issueQuoteToken, chatQuoteDigest } = await import('../src/quote-token.ts')
const { computeQuote } = await import('../src/plan.ts')
const { PRICING_TABLE_VERSION } = await import('../src/pricing.ts')
const { usdToAtomic } = await import('../src/x402.ts')

function fakeStore() {
  const hashes = new Map<string, Map<string, string>>()
  const counters = new Map<string, number>()
  const hash = (k: string) => { let h = hashes.get(k); if (!h) { h = new Map(); hashes.set(k, h) } return h }
  return {
    async hIncrBy(k: string, f: string, n: number) { hash(k).set(f, String(Number(hash(k).get(f) ?? 0) + n)) },
    async hIncrByFloat(k: string, f: string, n: number) { hash(k).set(f, String(Number(hash(k).get(f) ?? 0) + n)) },
    async expire() {},
    async hGetAll(k: string) { return Object.fromEntries(hashes.get(k) ?? new Map()) },
    async hSet(k: string, f: string, v: string) { const h = hash(k); const fresh = !h.has(f); h.set(f, v); return fresh ? 1 : 0 },
    async hDel(k: string, f: string) { hash(k).delete(f) },
    async incr(k: string) { const n = (counters.get(k) ?? 0) + 1; counters.set(k, n); return n },
    async get() { return null }, async set() {}, async del(k: string) { counters.delete(k) },
    async eval(_s: string, opts: { keys: string[]; arguments: string[] }) {
      const [refsKey, creditsKey] = opts.keys as [string, string]
      const [refField, usd, project, micro] = opts.arguments as [string, string, string, string]
      const refs = hash(refsKey)
      if (refs.has(refField)) return null
      refs.set(refField, usd)
      const h = hash(creditsKey); const total = Number(h.get(project) ?? 0) + Number(micro); h.set(project, String(total)); return total
    },
  }
}

let facilCalls: string[]
beforeEach(() => {
  _resetKeysForTests()
  _setStoreClientForTests(fakeStore() as never)
  facilCalls = []
  _setFacilitatorForTest({
    name: 'fake',
    async verify() { facilCalls.push('verify'); return { isValid: true, payer: '0xPayer' } },
    async settle() { facilCalls.push('settle'); return { success: true, transaction: '0xTx', network: 'base-sepolia', payer: '0xPayer' } },
  } as never)
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.0001 } }), { status: 200, headers: { 'content-type': 'application/json' } })) as never
})

const AUTH = { authorization: 'Bearer sk_x402pin_test', 'content-type': 'application/json' }
const BODY = { model: 'auto', max_tokens: 100, messages: [{ role: 'user', content: 'resume ce texte' }] }
const plan = (body: unknown) => app.fetch(new Request('http://test/v1/plan', { method: 'POST', headers: AUTH, body: JSON.stringify(body) }))
const paidChat = (body: unknown, xPayment: string) =>
  app.fetch(new Request('http://test/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-payment': xPayment }, body: JSON.stringify(body) }))
const paymentHeader = (value: string, nonce = '0xn1') =>
  Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'base-sepolia', payload: { signature: '0xsig', authorization: { from: '0x' + 'b'.repeat(40), to: process.env.OPENMULTI_X402_PAY_TO, value, validAfter: '0', validBefore: '9999999999', nonce } } })).toString('base64')

test('x402 pin : paiement couvrant le montant quoté -> réglé et servi ; trop petit -> 402 sans facilitateur', async () => {
  const j = await (await plan(BODY)).json()
  assert.ok(j.quote_token)
  const v = decodeQuoteToken(j.quote_token, SECRET)
  assert.ok(v.valid); if (!v.valid) return
  const body = { ...BODY, openmulti: { quote_token: j.quote_token } }
  // trop petit
  const small = await paidChat(body, paymentHeader('1', '0xsmall'))
  assert.equal(small.status, 402)
  assert.deepEqual(facilCalls, [], 'aucun règlement sur un paiement insuffisant')
  // couvrant le montant quoté du jeton
  const ok = await paidChat(body, paymentHeader(usdToAtomic(v.claims.usd), '0xok'))
  assert.equal(ok.status, 200)
  assert.deepEqual(facilCalls, ['verify', 'settle'])
  assert.ok(ok.headers.get('x-payment-response'))
})

test('x402 pin : contrat mort (montant quoté < borne courante) -> 409 AVANT verify/settle, l\'argent ne bouge pas', async () => {
  // jeton forgé avec un montant ridicule : la borne recalculée courante le dépasse
  const bound = computeQuote(BODY as never, KIMI, undefined, 1 + Number(process.env.OPENMULTI_MARGIN_PCT ?? 0) / 100)
  assert.ok(bound.quote && bound.quote.max_cost_usd > 0.000001)
  const dead = issueQuoteToken({
    kind: 'chat', digest: chatQuoteDigest(BODY as never), candidates: [KIMI], caps: [100],
    margin: 1, table: PRICING_TABLE_VERSION, usd: 0.000001, ttlMs: 60_000,
  }, SECRET)
  const res = await paidChat({ ...BODY, openmulti: { quote_token: dead } }, paymentHeader('1000000', '0xdead'))
  assert.equal(res.status, 409)
  assert.equal((await res.json()).error.code, 'quote_exceeded')
  assert.deepEqual(facilCalls, [], 'contrat mort : ni verify ni settle')
})
