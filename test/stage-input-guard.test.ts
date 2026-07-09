// E-8 — garde pré-spend par étage : mesure du compte de tokens d'entrée RÉEL (tokenizer
// du provider via registre in-process/pont, sinon repli borne OCTETS conservateur). Le
// verdict alimente checkPinnedProgramStage (409 stage_input_exceeds_bound avant dépense).

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_e8_test'
process.env.OPENMULTI_QUOTE_TOKEN_SECRET = 'e8-secret'
process.env.OPENMULTI_MODEL_BALANCED = 'moonshotai/kimi-k2.6'

const KEY = 'sk_e8_test'
const { app } = await import('../src/app.ts')
const { measureStageInput, providerFamilyOf, registerStageInputTokenizer, _resetStageInputTokenizersForTests } =
  await import('../src/stage-input-guard.ts')
import type { ChatRequest } from '../src/types.ts'

beforeEach(() => {
  _resetStageInputTokenizersForTests()
  globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.0001 } }), { status: 200, headers: { 'content-type': 'application/json' } })) as never
})

// ── Logique de mesure (pure, aucun subprocess) ───────────────────────────────────

test('providerFamilyOf : préfixe avant "/" en minuscules', () => {
  assert.equal(providerFamilyOf('anthropic/Claude-Haiku'), 'anthropic')
  assert.equal(providerFamilyOf('moonshotai/kimi-k2.6'), 'moonshotai')
  assert.equal(providerFamilyOf('bare'), 'bare')
})

test('measureStageInput : repli borne OCTETS par défaut (aucun tokenizer)', async () => {
  const req: ChatRequest = { messages: [{ role: 'user', content: 'salut' }] }
  const m = await measureStageInput(req, 'moonshotai/kimi-k2.6')
  assert.equal(m.method, 'byte_bound')
  assert.equal(m.tokens, Buffer.byteLength(JSON.stringify(req), 'utf8'))
})

test('measureStageInput : tokenizer enregistré -> méthode tokenizer ; undefined -> repli octets', async () => {
  const req: ChatRequest = { messages: [{ role: 'user', content: 'salut' }] }
  registerStageInputTokenizer('moonshotai', () => 7)
  const m = await measureStageInput(req, 'moonshotai/kimi-k2.6')
  assert.deepEqual(m, { tokens: 7, method: 'tokenizer' })
  // un modèle non comptable (tokenizer rend undefined) retombe sur la borne octets
  _resetStageInputTokenizersForTests()
  registerStageInputTokenizer('moonshotai', () => undefined)
  const m2 = await measureStageInput(req, 'moonshotai/kimi-k2.6')
  assert.equal(m2.method, 'byte_bound')
})

// ── Intégration : la mesure tokenizer pilote le verdict du contrat étagé ───────────

test('E-8 : un tokenizer signalant une entrée fragmentée (compte > ι) -> 409 même si peu d\'octets', async () => {
  // devis d'un programme mono-étage (stdin borné -> garanti -> jeton émis)
  const program = { statements: [{ source: null, stages: [{ target: 'moonshotai/kimi-k2.6', prompt: 'court' }], sink: null }] }
  const p = await (await app.fetch(new Request('http://test/v1/plan', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ openmulti: { program, stdin_bytes: 10 }, max_tokens: 300 }),
  }))).json()
  assert.ok(p.quote_token)

  // un tokenizer qui prétend que l'entrée (petite en octets) explose en tokens (pipe
  // cross-tokenizer fragmentant) -> dépasse ι épinglé -> refusé AVANT dépense.
  registerStageInputTokenizer('moonshotai', () => 10_000_000)
  let upstreamCalled = false
  globalThis.fetch = (async () => { upstreamCalled = true; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) }) as never
  const res = await app.fetch(new Request('http://test/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'moonshotai/kimi-k2.6', messages: [{ role: 'user', content: 'court\n\npetit' }], max_tokens: 300, openmulti: { quote_token: p.quote_token, quote_stage: 0 } }),
  }))
  assert.equal(res.status, 409)
  assert.equal((await res.json()).error.code, 'stage_input_exceeds_bound')
  assert.equal(upstreamCalled, false, 'zéro appel upstream sur un étage hors-borne (mesure tokenizer)')
})
