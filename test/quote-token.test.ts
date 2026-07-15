// E-1 (quote-pin) — surface PURE du jeton de devis (aucun HTTP) : émission/décodage
// signés, rejets d'altération/expiration, digests canoniques, strip du jeton, et le
// CŒUR DU CONTRAT (checkPinnedQuote pour un appel simple, checkPinnedProgramStage pour
// un étage de programme). Le wiring /v1/plan + chat + x402 est verrouillé ailleurs.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'

const {
  issueQuoteToken, decodeQuoteToken, canonicalJson,
  chatQuoteDigest, stripQuoteToken, checkPinnedQuote, checkPinnedProgramStage,
} = await import('../src/quote-token.ts')
import type { ChatRequest } from '../src/types.ts'
import type { QuoteTokenClaims } from '../src/quote-token.ts'

const SECRET = 'test-quote-secret'
const baseInput = {
  kind: 'chat' as const,
  digest: 'd-abc',
  candidates: ['a/1', 'b/2'],
  caps: [512],
  margin: 1.2,
  table: 'tablev1',
  usd: 0.5,
  ttlMs: 60_000,
}

// ── Émission / décodage ──────────────────────────────────────────────────────────

test('aller-retour : claims signés restitués', () => {
  const now = 1_000_000
  const token = issueQuoteToken(baseInput, SECRET, now)
  const v = decodeQuoteToken(token, SECRET, now + 1000)
  assert.equal(v.valid, true)
  if (!v.valid) return
  assert.equal(v.claims.kind, 'chat')
  assert.equal(v.claims.digest, 'd-abc')
  assert.deepEqual(v.claims.candidates, ['a/1', 'b/2'])
  assert.equal(v.claims.usd, 0.5)
  assert.equal(v.claims.exp, now + 60_000)
  assert.ok(v.claims.nonce)
})

test('refus d\'émettre sans secret (jamais un HMAC sur "")', () => {
  assert.throws(() => issueQuoteToken(baseInput, ''))
})

test('deux devis identiques -> jetons distincts (nonce)', () => {
  const a = issueQuoteToken(baseInput, SECRET, 1)
  const b = issueQuoteToken(baseInput, SECRET, 1)
  assert.notEqual(a, b)
})

test('altération rejetée : payload gonflé, autre secret, difforme, expiré', () => {
  const token = issueQuoteToken(baseInput, SECRET, 0)
  const [payload, mac] = token.split('.')
  // payload modifié (montant gonflé) sans re-signer -> bad_signature
  const forged = Buffer.from(JSON.stringify({ ...baseInput, usd: 999, v: 1, exp: 1e15, nonce: 'x' })).toString('base64url')
  assert.equal(decodeQuoteToken(`${forged}.${mac}`, SECRET, 0).valid, false)
  // signé d'un autre secret
  assert.deepEqual(decodeQuoteToken(token, 'autre-secret', 0), { valid: false, reason: 'bad_signature' })
  // difforme (pas de séparateur)
  assert.deepEqual(decodeQuoteToken('pasdepoint', SECRET, 0), { valid: false, reason: 'malformed' })
  // expiré
  assert.deepEqual(decodeQuoteToken(token, SECRET, 60_001), { valid: false, reason: 'expired' })
  // secret vide au décodage -> jamais valide
  assert.equal(decodeQuoteToken(`${payload}.${mac}`, '', 0).valid, false)
})

// ── Digests canoniques ───────────────────────────────────────────────────────────

test('canonicalJson : clés triées récursivement, undefined omis, non-ASCII brut', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(canonicalJson({ a: undefined, b: 2 }), '{"b":2}')
  assert.equal(canonicalJson([3, { y: 1, x: 2 }]), '[3,{"x":2,"y":1}]')
  assert.equal(canonicalJson({ s: 'é😀' }), '{"s":"é😀"}')
})

test('chatQuoteDigest : stable à l\'ordre des clés, sensible à l\'enveloppe de coût', () => {
  const r1: ChatRequest = { model: 'auto', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100, openmulti: { tier: 'balanced' } }
  const r2: ChatRequest = { messages: [{ role: 'user', content: 'hi' }], openmulti: { tier: 'balanced' }, max_tokens: 100, model: 'auto' }
  assert.equal(chatQuoteDigest(r1), chatQuoteDigest(r2)) // ordre des clés indifférent
  // un max_tokens différent (levier de coût) change le digest
  assert.notEqual(chatQuoteDigest(r1), chatQuoteDigest({ ...r1, max_tokens: 200 }))
  // le jeton lui-même n'entre PAS dans le digest
  const withTok: ChatRequest = { ...r1, openmulti: { ...r1.openmulti, quote_token: 'zzz' } }
  assert.equal(chatQuoteDigest(withTok), chatQuoteDigest(r1))
})

test('stripQuoteToken : retire quote_token/quote_stage, redevient nu si le bloc ne portait que le contrat', () => {
  const withOnly: ChatRequest = { model: 'auto', messages: [], openmulti: { quote_token: 't', quote_stage: 0 } }
  assert.equal(stripQuoteToken(withOnly).openmulti, undefined) // bloc entièrement retiré
  const withMore: ChatRequest = { model: 'auto', messages: [], openmulti: { tier: 'balanced', quote_token: 't' } }
  const s = stripQuoteToken(withMore)
  assert.equal(s.openmulti?.quote_token, undefined)
  assert.equal(s.openmulti?.tier, 'balanced')
})

// ── Le contrat : checkPinnedQuote (appel simple) ─────────────────────────────────

const claims = (over: Partial<QuoteTokenClaims> = {}): QuoteTokenClaims => ({
  v: 1, kind: 'chat', digest: 'd', candidates: ['a/1', 'b/2'], caps: [512],
  margin: 1.2, table: 'T1', usd: 0.5, exp: 1e15, nonce: 'n', ...over,
})

test('checkPinnedQuote : OK quand digest + candidat + borne recalculée concordent', () => {
  const v = checkPinnedQuote({ claims: claims(), digest: 'd', resolvedModel: 'a/1', currentBoundUsd: 0.5, tableVersion: 'T1' })
  assert.deepEqual(v, { ok: true })
})

test('checkPinnedQuote : digest_mismatch / candidate_set_mismatch / quote_exceeded', () => {
  const bad = checkPinnedQuote({ claims: claims(), digest: 'AUTRE', resolvedModel: 'a/1', currentBoundUsd: 0.5, tableVersion: 'T1' })
  assert.equal(bad.ok, false); if (!bad.ok) { assert.equal(bad.status, 409); assert.equal(bad.code, 'digest_mismatch') }

  const out = checkPinnedQuote({ claims: claims(), digest: 'd', resolvedModel: 'z/9', currentBoundUsd: 0.5, tableVersion: 'T1' })
  assert.equal(out.ok, false); if (!out.ok) assert.equal(out.code, 'candidate_set_mismatch')

  // borne recalculée > montant quoté (dérive prix/marge/routage) -> quote_exceeded
  const over = checkPinnedQuote({ claims: claims(), digest: 'd', resolvedModel: 'a/1', currentBoundUsd: 0.6, tableVersion: 'T2' })
  assert.equal(over.ok, false); if (!over.ok) { assert.equal(over.code, 'quote_exceeded'); assert.match(over.message, /T1 -> T2/) }

  // plus quotable du tout (currentBound undefined) -> quote_exceeded
  const gone = checkPinnedQuote({ claims: claims(), digest: 'd', resolvedModel: 'a/1', currentBoundUsd: undefined, tableVersion: 'T1' })
  assert.equal(gone.ok, false); if (!gone.ok) assert.equal(gone.code, 'quote_exceeded')
})

test('checkPinnedQuote : epsilon flottant toléré (recalcul identique passe)', () => {
  const v = checkPinnedQuote({ claims: claims({ usd: 0.5 }), digest: 'd', resolvedModel: 'a/1', currentBoundUsd: 0.5 + 1e-12, tableVersion: 'T1' })
  assert.deepEqual(v, { ok: true })
})

// ── Le contrat étagé : checkPinnedProgramStage ───────────────────────────────────

const progClaims = (over: Partial<QuoteTokenClaims> = {}): QuoteTokenClaims => ({
  v: 1, kind: 'program', digest: 'dp', candidates: ['a/1', 'b/2'], caps: [512, 256],
  inputs: [1000, 800], margin: 1.2, table: 'T1', usd: 2, exp: 1e15, nonce: 'n', ...over,
})
const okStage = { resolvedModel: 'a/1', currentOutputMax: 512, marginFactor: 1.2, tableVersion: 'T1', realInput: { tokens: 500, method: 'tokenizer' as const } }

test('checkPinnedProgramStage : OK sur un étage valide', () => {
  assert.deepEqual(checkPinnedProgramStage({ claims: progClaims(), stage: 0, ...okStage }), { ok: true })
})

test('checkPinnedProgramStage : jeton chat sur un contrat programme -> digest_mismatch', () => {
  const v = checkPinnedProgramStage({ claims: claims() as QuoteTokenClaims, stage: 0, ...okStage })
  assert.equal(v.ok, false); if (!v.ok) assert.equal(v.code, 'digest_mismatch')
})

test('checkPinnedProgramStage : stage_required si index absent/négatif/hors bornes/non entier', () => {
  for (const stage of [undefined, -1, 2, 1.5, 'x']) {
    const v = checkPinnedProgramStage({ claims: progClaims(), stage, ...okStage })
    assert.equal(v.ok, false); if (!v.ok) { assert.equal(v.status, 422); assert.equal(v.code, 'stage_required') }
  }
})

test('checkPinnedProgramStage : dérive table / marge / cap de sortie -> quote_exceeded', () => {
  const drift = checkPinnedProgramStage({ claims: progClaims(), stage: 0, ...okStage, tableVersion: 'T2' })
  assert.equal(drift.ok, false); if (!drift.ok) assert.equal(drift.code, 'quote_exceeded')
  const margin = checkPinnedProgramStage({ claims: progClaims(), stage: 0, ...okStage, marginFactor: 1.5 })
  assert.equal(margin.ok, false); if (!margin.ok) assert.equal(margin.code, 'quote_exceeded')
  const cap = checkPinnedProgramStage({ claims: progClaims(), stage: 1, ...okStage, currentOutputMax: 999 })
  assert.equal(cap.ok, false); if (!cap.ok) assert.equal(cap.code, 'quote_exceeded')
})

test('checkPinnedProgramStage : E-8 garde pré-spend — entrée réelle > ι -> stage_input_exceeds_bound ; jeton sans ι -> fail-closed', () => {
  const over = checkPinnedProgramStage({ claims: progClaims(), stage: 0, ...okStage, realInput: { tokens: 1001, method: 'byte_bound' } })
  assert.equal(over.ok, false); if (!over.ok) assert.equal(over.code, 'stage_input_exceeds_bound')
  // jeton programme SANS bornes d'entrée épinglées (pré-E-8) -> refus conservateur
  const noIota = checkPinnedProgramStage({ claims: progClaims({ inputs: undefined }), stage: 0, ...okStage })
  assert.equal(noIota.ok, false); if (!noIota.ok) assert.equal(noIota.code, 'stage_input_exceeds_bound')
})
