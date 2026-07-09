// E-1 tranche 2 — ÉMISSION : /v1/plan signe un jeton de devis (chat & programme) dont
// les claims lient digest / snapshot de candidats / caps / marge / table / montant. Le
// secret est configuré ici ; le fail-closed sans secret est verrouillé par la surface
// pure (issueQuoteToken refuse) et la tranche enforcement.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_emit_test'
process.env.OPENMULTI_QUOTE_TOKEN_SECRET = 'emit-secret'
process.env.OPENMULTI_MODEL_BALANCED = 'moonshotai/kimi-k2.6'
process.env.OPENMULTI_MODEL_ECONOMY = 'deepseek/deepseek-chat'

const KEY = 'sk_emit_test'
const { app } = await import('../src/app.ts')
const { decodeQuoteToken, chatQuoteDigest, programQuoteDigest } = await import('../src/quote-token.ts')
const { PRICING_TABLE_VERSION } = await import('../src/pricing.ts')
import type { ChatRequest } from '../src/types.ts'

const plan = (body: unknown) =>
  app.fetch(new Request('http://test/v1/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  }))

test('/v1/plan chat : émet un jeton dont les claims lient digest, candidats, caps, marge, table, montant', async () => {
  const reqBody: ChatRequest = { model: 'auto', messages: [{ role: 'user', content: 'résume' }], max_tokens: 200, openmulti: { tier: 'balanced' } }
  const res = await plan(reqBody)
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.ok(j.quote_token, 'jeton absent')
  const v = decodeQuoteToken(j.quote_token, 'emit-secret')
  assert.equal(v.valid, true)
  if (!v.valid) return
  assert.equal(v.claims.kind, 'chat')
  assert.equal(v.claims.digest, chatQuoteDigest(reqBody)) // couvre CETTE requête
  assert.ok(v.claims.candidates.includes(j.model), 'le modèle résolu doit être dans le snapshot')
  assert.deepEqual(v.claims.caps, [j.quote.output_tokens_max])
  assert.equal(v.claims.usd, j.quote.max_cost_usd) // le montant quoté
  assert.equal(v.claims.table, PRICING_TABLE_VERSION)
})

test('/v1/plan programme GARANTI (stdin borné) : jeton kind=program avec caps ET bornes d\'entrée ι (E-8)', async () => {
  const program = { statements: [
    { source: null, stages: [{ target: 'moonshotai/kimi-k2.6', prompt: 'étape A' }], sink: { store: 's' } },
    { source: { recall: 's' }, stages: [{ target: 'deepseek/deepseek-chat', prompt: 'étape B' }], sink: null },
  ] }
  const res = await plan({ openmulti: { program, stdin_bytes: 100 }, max_tokens: 300 })
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.model, 'program')
  assert.equal(j.guaranteed, true)
  assert.ok(j.quote_token, 'jeton programme absent malgré un devis garanti')
  const v = decodeQuoteToken(j.quote_token, 'emit-secret')
  assert.equal(v.valid, true)
  if (!v.valid) return
  assert.equal(v.claims.kind, 'program')
  assert.equal(v.claims.digest, programQuoteDigest({ statements: [
    { source: null, stages: [{ target: 'moonshotai/kimi-k2.6', prompt: 'étape A' }], sink: { store: 's' } },
    { source: { recall: 's' }, stages: [{ target: 'deepseek/deepseek-chat', prompt: 'étape B' }], sink: null },
  ] }, 100, 300))
  assert.equal(v.claims.caps.length, 2) // deux étages
  assert.ok(Array.isArray(v.claims.inputs) && v.claims.inputs.length === 2, 'bornes d\'entrée ι épinglées (E-8)')
  assert.equal(v.claims.usd, j.quote.max_cost_usd)
})

test('/v1/plan programme NON garanti (stdin non borné) : devis rendu mais AUCUN jeton (contrat interdit sur borne non garantie)', async () => {
  const program = { statements: [{ source: null, stages: [{ target: 'moonshotai/kimi-k2.6', prompt: 'lis stdin' }], sink: null }] }
  const res = await plan({ openmulti: { program }, max_tokens: 300 }) // pas de stdin_bytes
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.guaranteed, false)
  assert.ok(j.quote, 'le devis (borne) reste rendu')
  assert.equal(j.quote_token, undefined, 'pas de contrat signé sur une borne non garantie')
})

test('/v1/plan programme : un étage non tarifé refuse le programme ENTIER avec l\'index fautif', async () => {
  const program = { statements: [
    { source: null, stages: [{ target: 'moonshotai/kimi-k2.6', prompt: 'ok' }], sink: null },
    { source: null, stages: [{ target: 'unknown/model', prompt: 'boom' }], sink: null },
  ] }
  const res = await plan({ openmulti: { program, stdin_bytes: 0 }, max_tokens: 300 })
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.quote, null)
  assert.equal(j.quote_unavailable, 'pricing_unknown')
  assert.equal(j.refused_stage.statement, 1)
  assert.equal(j.quote_token, undefined)
})
