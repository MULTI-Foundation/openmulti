// E-1 tranche 3 — ENFORCEMENT : un jeton présenté à /v1/chat/completions fait du devis
// un CONTRAT vérifié AVANT tout appel upstream. Round-trip plan->token->run accepté ;
// rejets structurés (digest, expiration) ; jeton jamais transmis au provider ; contrat
// programme étagé (quote_stage requis, garde pré-spend E-8 par borne octets).

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_enforce_test'
process.env.OPENMULTI_QUOTE_TOKEN_SECRET = 'enforce-secret'
process.env.OPENMULTI_MODEL_BALANCED = 'moonshotai/kimi-k2.6'
process.env.OPENMULTI_MODEL_ECONOMY = 'deepseek/deepseek-chat'

const KEY = 'sk_enforce_test'
const { app } = await import('../src/app.ts')
const { issueQuoteToken, chatQuoteDigest } = await import('../src/quote-token.ts')

let lastUpstreamBody: any = null
beforeEach(() => {
  lastUpstreamBody = null
  globalThis.fetch = (async (_url: any, init: any) => {
    lastUpstreamBody = init?.body ? JSON.parse(init.body) : null
    return new Response(
      JSON.stringify({ id: 'g', model: 'x', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.001 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as never
})

const plan = (body: unknown) =>
  app.fetch(new Request('http://test/v1/plan', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) }))
const chat = (body: unknown) =>
  app.fetch(new Request('http://test/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) }))

test('round-trip : devis /v1/plan rejoué tel quel -> 200, jeton JAMAIS transmis upstream', async () => {
  const body = { model: 'auto', messages: [{ role: 'user', content: 'résume' }], max_tokens: 200, openmulti: { tier: 'balanced' } }
  const p = await (await plan(body)).json()
  assert.ok(p.quote_token)
  const res = await chat({ ...body, openmulti: { ...body.openmulti, quote_token: p.quote_token } })
  assert.equal(res.status, 200)
  // le provider ne voit ni le jeton ni le bloc openmulti
  assert.ok(lastUpstreamBody, 'upstream non appelé')
  assert.equal(JSON.stringify(lastUpstreamBody).includes('quote_token'), false)
  assert.equal(lastUpstreamBody.openmulti, undefined)
})

test('digest_mismatch : le jeton ne se transfère pas à une requête plus grosse -> 409', async () => {
  const body = { model: 'auto', messages: [{ role: 'user', content: 'court' }], max_tokens: 200, openmulti: { tier: 'balanced' } }
  const p = await (await plan(body)).json()
  const res = await chat({ model: 'auto', messages: [{ role: 'user', content: 'x'.repeat(5000) }], max_tokens: 200, openmulti: { tier: 'balanced', quote_token: p.quote_token } })
  assert.equal(res.status, 409)
  const j = await res.json()
  assert.equal(j.error.type, 'quote_conflict')
  assert.equal(j.error.code, 'digest_mismatch')
  assert.equal(lastUpstreamBody, null, 'aucun appel upstream sur un contrat rejeté')
})

test('jeton expiré / difforme -> 422 structuré, aucune dépense', async () => {
  const expired = issueQuoteToken({ kind: 'chat', digest: 'd', candidates: ['moonshotai/kimi-k2.6'], caps: [1], margin: 1, table: 'T', usd: 1, ttlMs: 1 }, 'enforce-secret', 0)
  const res = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10, openmulti: { tier: 'balanced', quote_token: expired } })
  assert.equal(res.status, 422)
  assert.equal((await res.json()).error.type, 'invalid_quote_token')
  // difforme
  const bad = await chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], openmulti: { quote_token: 'pas-un-jeton' } })
  assert.equal(bad.status, 422)
  assert.equal(lastUpstreamBody, null)
})

test('contrat programme : rejeu par étage avec quote_stage -> 200 ; index absent -> 422 stage_required', async () => {
  const program = { statements: [
    { source: null, stages: [{ target: 'moonshotai/kimi-k2.6', prompt: 'étape A' }], sink: null },
    { source: null, stages: [{ target: 'deepseek/deepseek-chat', prompt: 'étape B' }], sink: null },
  ] }
  const p = await (await plan({ openmulti: { program, stdin_bytes: 50 }, max_tokens: 300 })).json()
  assert.ok(p.quote_token)
  // étage 0 rejoué (petit input) -> accepté
  const ok = await chat({ model: 'moonshotai/kimi-k2.6', messages: [{ role: 'user', content: 'étape A\n\npetit' }], max_tokens: 300, openmulti: { quote_token: p.quote_token, quote_stage: 0 } })
  assert.equal(ok.status, 200)
  // même jeton sans quote_stage -> 422 stage_required
  const noStage = await chat({ model: 'moonshotai/kimi-k2.6', messages: [{ role: 'user', content: 'x' }], max_tokens: 300, openmulti: { quote_token: p.quote_token } })
  assert.equal(noStage.status, 422)
  assert.equal((await noStage.json()).error.code, 'stage_required')
})

test('contrat programme E-8 : une entrée d\'étage qui dépasse ι est refusée AVANT dépense (409)', async () => {
  const program = { statements: [{ source: null, stages: [{ target: 'moonshotai/kimi-k2.6', prompt: 'court' }], sink: null }] }
  const p = await (await plan({ openmulti: { program, stdin_bytes: 10 }, max_tokens: 300 })).json()
  // exécute l'étage 0 avec une entrée ÉNORME (dépasse la borne d'entrée ι épinglée)
  const res = await chat({ model: 'moonshotai/kimi-k2.6', messages: [{ role: 'user', content: 'court\n\n' + 'z'.repeat(20000) }], max_tokens: 300, openmulti: { quote_token: p.quote_token, quote_stage: 0 } })
  assert.equal(res.status, 409)
  assert.equal((await res.json()).error.code, 'stage_input_exceeds_bound')
  assert.equal(lastUpstreamBody, null, 'zéro appel upstream sur un étage hors-borne')
})
