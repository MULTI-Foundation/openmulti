// Fondations x402 (B4) : devis lié (S1), conversion atomique, réponse 402, anti-rejeu,
// seam facilitateur. Tout est pur ou fake — aucun réseau, aucun store réel.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'

const { mintQuoteToken, verifyQuoteToken, usdToAtomic, paymentRequired, claimNonce, KNOWN_NETWORKS } = await import('../src/x402.ts')
const { httpFacilitator } = await import('../src/x402-facilitator.ts')
const { _setStoreClientForTests } = await import('../src/store.ts')

const SECRET = 'test-quote-secret'
const HASH = 'a'.repeat(64)

// ── Devis lié (S1) ────────────────────────────────────────────────────────────────

test('devis lié : aller-retour valide, claims restitués', () => {
  const token = mintQuoteToken({ requestHash: HASH, maxUsd: 0.5, expiresAt: Date.now() + 60_000 }, SECRET)
  const v = verifyQuoteToken(token, HASH, SECRET)
  assert.equal(v.valid, true)
  if (v.valid) assert.equal(v.claims.maxUsd, 0.5)
})

test('devis lié : toute altération des claims invalide la signature', () => {
  const token = mintQuoteToken({ requestHash: HASH, maxUsd: 0.5, expiresAt: Date.now() + 60_000 }, SECRET)
  const [payload, mac] = token.split('.') as [string, string]
  // gonfle le montant dans le payload en gardant le MAC
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
  claims.maxUsd = 999
  const forged = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${mac}`
  assert.equal(verifyQuoteToken(forged, HASH, SECRET).valid, false)
})

test('devis lié : un devis ne couvre pas une AUTRE requête (request_mismatch)', () => {
  const token = mintQuoteToken({ requestHash: HASH, maxUsd: 0.5, expiresAt: Date.now() + 60_000 }, SECRET)
  const v = verifyQuoteToken(token, 'b'.repeat(64), SECRET)
  assert.deepEqual(v, { valid: false, reason: 'request_mismatch' })
})

test('devis lié : expiré après TTL, refusé avec un autre secret, difforme refusé', () => {
  const token = mintQuoteToken({ requestHash: HASH, maxUsd: 0.5, expiresAt: 1000 }, SECRET)
  assert.deepEqual(verifyQuoteToken(token, HASH, SECRET, 2000), { valid: false, reason: 'expired' })
  assert.equal(verifyQuoteToken(token, HASH, 'autre-secret').valid, false)
  assert.equal(verifyQuoteToken('nimporte-quoi', HASH, SECRET).valid, false)
  assert.throws(() => mintQuoteToken({ requestHash: HASH, maxUsd: 1, expiresAt: 1 }, ''))
})

// ── Montants et réponse 402 ───────────────────────────────────────────────────────

test('usdToAtomic : 6 décimales USDC, arrondi supérieur, jamais négatif', () => {
  assert.equal(usdToAtomic(0.5), '500000')
  assert.equal(usdToAtomic(0.0000001), '1') // plus petit que l\'unité -> 1, jamais 0 gratuit
  assert.equal(usdToAtomic(0), '0')
  assert.throws(() => usdToAtomic(-1))
  assert.throws(() => usdToAtomic(Number.NaN))
})

test('paymentRequired : forme x402 v1, montant atomique, devis dans extra', () => {
  const body = paymentRequired({
    maxUsd: 0.25,
    payTo: '0x' + '1'.repeat(40),
    network: KNOWN_NETWORKS['base']!,
    resource: 'https://api.test/v1/chat/completions',
    description: 'MULTI run',
    quoteToken: 'jeton.mac',
  })
  assert.equal(body.x402Version, 1)
  const accepts = body.accepts as Record<string, unknown>[]
  assert.equal(accepts.length, 1)
  const a = accepts[0]!
  assert.equal(a.scheme, 'exact')
  assert.equal(a.network, 'base')
  assert.equal(a.maxAmountRequired, '250000')
  assert.equal(a.asset, KNOWN_NETWORKS['base']!.usdcContract)
  assert.equal((a.extra as Record<string, unknown>).quoteToken, 'jeton.mac')
  // Le domaine EIP-712 de l'asset est REQUIS dans extra : sans lui le wallet ne peut
  // pas signer et le facilitateur rejette (invalid_exact_evm_missing_eip712_domain,
  // constaté au test réel du 2026-07-03). Les noms DIFFÈRENT entre réseaux.
  assert.equal((a.extra as Record<string, unknown>).name, 'USD Coin')
  assert.equal((a.extra as Record<string, unknown>).version, '2')
  assert.equal(KNOWN_NETWORKS['base-sepolia']!.eip712.name, 'USDC')
})

// ── Anti-rejeu ────────────────────────────────────────────────────────────────────

function fakeStore() {
  const counters = new Map<string, number>()
  return {
    counters,
    async hIncrBy() {}, async hIncrByFloat() {}, async expire() {},
    async hGetAll() { return {} }, async hSet() { return 1 }, async hDel() {},
    async incr(k: string) { const n = (counters.get(k) ?? 0) + 1; counters.set(k, n); return n },
    async get() { return null }, async set() {}, async del() {},
  }
}

beforeEach(() => _setStoreClientForTests(fakeStore()))

test('anti-rejeu : premier passage fresh, rejeu replayed, nonce difforme refusé', async () => {
  assert.equal(await claimNonce('0xabc123'), 'fresh')
  assert.equal(await claimNonce('0xabc123'), 'replayed')
  assert.equal(await claimNonce('autre-nonce-!!;drop'), 'replayed')
})

test('anti-rejeu : store indisponible = fail-closed (jamais un paiement servi au doute)', async () => {
  _setStoreClientForTests(null)
  assert.equal(await claimNonce('0xabc123'), 'store_unavailable')
})

// ── Seam facilitateur ─────────────────────────────────────────────────────────────

test('facilitateur http : verify/settle heureux, en-têtes d\'auth transmis', async () => {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const f = httpFacilitator({
    baseUrl: 'https://facil.test/',
    authHeaders: { Authorization: 'Bearer cdp-key' },
    transport: async (url, _body, headers) => {
      calls.push({ url, headers })
      return url.endsWith('/verify')
        ? { status: 200, data: { isValid: true, payer: '0xPayer' } }
        : { status: 200, data: { success: true, transaction: '0xTx', network: 'base' } }
    },
  })
  const v = await f.verify({}, {})
  assert.deepEqual(v, { isValid: true, payer: '0xPayer' })
  const s = await f.settle({}, {})
  assert.equal(s.success, true)
  assert.equal(s.transaction, '0xTx')
  assert.deepEqual(calls.map((c) => c.url), ['https://facil.test/verify', 'https://facil.test/settle'])
  assert.equal(calls[0]!.headers.Authorization, 'Bearer cdp-key')
})

test('facilitateur http : statut != 200, corps difforme ou exception = INVALIDE (fail-closed)', async () => {
  const bad = (data: { status: number; data: unknown } | Error) =>
    httpFacilitator({ baseUrl: 'https://f.test', transport: async () => { if (data instanceof Error) throw data; return data } })
  assert.equal((await bad({ status: 500, data: { isValid: true } }).verify({}, {})).isValid, false)
  assert.equal((await bad({ status: 200, data: 'pas un objet' }).verify({}, {})).isValid, false)
  assert.equal((await bad({ status: 200, data: {} }).verify({}, {})).isValid, false) // isValid absent
  assert.equal((await bad(new Error('réseau')).verify({}, {})).isValid, false)
  assert.equal((await bad(new Error('réseau')).settle({}, {})).success, false)
})

test('double vérification : tous doivent valider, settle sur le primaire seul', async () => {
  const calls: string[] = []
  const mk = (name: string, ok: boolean) => ({
    name,
    async verify() { calls.push(`${name}:verify`); return { isValid: ok, ...(ok ? {} : { invalidReason: `${name}_said_no` }) } },
    async settle() { calls.push(`${name}:settle`); return { success: true, transaction: '0xT' } },
  })
  const { crossVerifyFacilitator } = await import('../src/x402-facilitator.ts')

  // tous valides -> valide, settle appelé UNIQUEMENT sur le primaire
  const all = crossVerifyFacilitator(mk('p', true), [mk('a1', true), mk('a2', true)])
  assert.equal((await all.verify({}, {})).isValid, true)
  await all.settle({}, {})
  assert.deepEqual(calls.filter((c) => c.endsWith('settle')), ['p:settle'])

  // un auditeur refuse -> refus, avec SA raison
  calls.length = 0
  const oneNo = crossVerifyFacilitator(mk('p', true), [mk('a1', false)])
  const v = await oneNo.verify({}, {})
  assert.equal(v.isValid, false)
  assert.equal(v.invalidReason, 'a1_said_no')

  // le primaire refuse -> refus aussi
  const pNo = crossVerifyFacilitator(mk('p', false), [mk('a1', true)])
  assert.equal((await pNo.verify({}, {})).isValid, false)

  // sans auditeurs : le primaire tel quel
  const alone = crossVerifyFacilitator(mk('solo', true), [])
  assert.equal(alone.name, 'solo')
})
