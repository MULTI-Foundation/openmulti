// Devis AUDIO (chantier x402 audio, 2026-09-08) : une requête avec un content part
// `input_audio` est bornée en SECONDES (durée lue dans le conteneur x prix audio vérifié
// du modèle), les octets audio ne sont PAS comptés en tokens de texte. Verrouille : le
// devis calculé, la marge, le refus sans prix audio (pricing_unknown), le refus sur
// format illisible (unsupported_content), l'image toujours refusée, l'arrondi à la
// seconde supérieure, /v1/plan et le 402 x402 sur une requête audio.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_plan_audio'
process.env.OPENMULTI_MODEL_BALANCED = 'mistralai/voxtral-small-24b-2507' // tarifé audio (pricing.ts)
process.env.OPENMULTI_MODEL_ECONOMY = 'moonshotai/kimi-k2.6' // tarifé texte, PAS audio
process.env.OPENMULTI_AUDIO_MODELS = 'mistralai/voxtral-small-24b-2507,moonshotai/kimi-k2.6'
process.env.OPENMULTI_X402 = '1'
process.env.OPENMULTI_X402_PAY_TO = '0x' + 'a'.repeat(40)
process.env.OPENMULTI_X402_NETWORK = 'base-sepolia'
process.env.OPENMULTI_X402_QUOTE_SECRET = 'test-x402-secret'

let app: typeof import('../src/app.ts').app
let computeQuote: typeof import('../src/plan.ts').computeQuote
let priceFor: typeof import('../src/pricing.ts').priceFor

before(async () => {
  ;({ app } = await import('../src/app.ts'))
  ;({ computeQuote } = await import('../src/plan.ts'))
  ;({ priceFor } = await import('../src/pricing.ts'))
})

const fx = (name: string) => readFileSync(new URL(`./fixtures/audio/${name}`, import.meta.url)).toString('base64')
const audioMsgs = (data: string, format: string) => [{
  role: 'user',
  content: [
    { type: 'text', text: 'transcris' },
    { type: 'input_audio', input_audio: { data, format } },
  ],
}]
const VOX = 'mistralai/voxtral-small-24b-2507'

test('devis audio : secondes lues (arrondi sup) x prix audio + texte SANS les octets audio', () => {
  const data = fx('tone.ogg') // 1.5065 s -> 2 s
  const req = { model: VOX, messages: audioMsgs(data, 'ogg'), max_tokens: 100 }
  const r = computeQuote(req as never, VOX, undefined, 1)
  assert.ok(r.quote, JSON.stringify(r))
  assert.equal(r.quote.audio_seconds_max, 2)
  // Les octets base64 (8 Ko) ne sont pas dans la borne d'entrée : bien en dessous.
  assert.ok(r.quote.input_tokens_max < 500, `input_tokens_max=${r.quote.input_tokens_max}`)
  const p = priceFor(VOX)!
  const expected = (r.quote.input_tokens_max * p.inputPerMTok + 100 * p.outputPerMTok) / 1e6 + 2 * p.audioInputPerSecond!
  assert.equal(r.quote.max_cost_usd, Math.ceil(expected * 1e6) / 1e6)
  // La marge s'applique au tout (audio compris).
  const m = computeQuote(req as never, VOX, undefined, 1.5)
  assert.equal(m.quote!.max_cost_usd, Math.ceil(expected * 1.5 * 1e6) / 1e6)
})

test('deux parts audio : les durées s\'additionnent', () => {
  const req = {
    model: VOX,
    max_tokens: 10,
    messages: [{ role: 'user', content: [
      { type: 'input_audio', input_audio: { data: fx('tone.wav'), format: 'wav' } },
      { type: 'input_audio', input_audio: { data: fx('tone.mp3'), format: 'mp3' } },
    ] }],
  }
  const r = computeQuote(req as never, VOX, undefined, 1)
  assert.equal(r.quote?.audio_seconds_max, 4) // 1.5 + 1.584 -> 4
})

test('modèle sans prix audio : pricing_unknown (jamais un faux zéro)', () => {
  const req = { model: 'moonshotai/kimi-k2.6', messages: audioMsgs(fx('tone.wav'), 'wav'), max_tokens: 10 }
  const r = computeQuote(req as never, 'moonshotai/kimi-k2.6', undefined, 1)
  assert.equal(r.quote, null)
  assert.equal(r.unavailable, 'pricing_unknown')
})

test('format illisible (m4a) ou base64 sans conteneur valide : unsupported_content', () => {
  for (const [data, format] of [[fx('tone.m4a'), 'm4a'], ['AAAA', 'ogg'], [fx('tone.wav'), 'mp3']] as const) {
    const r = computeQuote({ model: VOX, messages: audioMsgs(data, format), max_tokens: 10 } as never, VOX, undefined, 1)
    assert.equal(r.unavailable, 'unsupported_content', `${format} devrait être refusé`)
  }
})

test('image : toujours unsupported_content (même avec un audio à côté)', () => {
  const req = {
    model: VOX, max_tokens: 10,
    messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } },
      { type: 'input_audio', input_audio: { data: fx('tone.wav'), format: 'wav' } },
    ] }],
  }
  assert.equal(computeQuote(req as never, VOX, undefined, 1).unavailable, 'unsupported_content')
})

test('sans audio : devis inchangé (pas de audio_seconds_max)', () => {
  const r = computeQuote({ model: VOX, messages: [{ role: 'user', content: 'bonjour' }], max_tokens: 10 } as never, VOX, undefined, 1)
  assert.ok(r.quote)
  assert.equal(r.quote.audio_seconds_max, undefined)
})

test('POST /v1/plan : requête audio en auto -> devis avec audio_seconds_max', async () => {
  const res = await app.fetch(new Request('http://test/v1/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk_plan_audio' },
    body: JSON.stringify({ model: 'auto', messages: audioMsgs(fx('tone.ogg'), 'ogg'), max_tokens: 100, openmulti: { tier: 'balanced' } }),
  }))
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.model, VOX)
  assert.equal(j.quote.audio_seconds_max, 2)
  assert.ok(j.quote.max_cost_usd > 0)
})

test('x402 sans clé : une requête audio obtient un 402 payable (devis calculé)', async () => {
  const res = await app.fetch(new Request('http://test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: VOX, messages: audioMsgs(fx('tone.ogg'), 'ogg'), max_tokens: 100 }),
  }))
  assert.equal(res.status, 402)
  const j = await res.json()
  assert.ok(Array.isArray(j.accepts) && j.accepts.length === 1, JSON.stringify(j))
  assert.ok(Number(j.accepts[0].maxAmountRequired) > 0)
})
