// P0-11 — sous CONTRAT (jeton de devis présenté), au plus UN dispatch upstream : un
// échec transport post-envoi ou un statut transitoire reçu ne déclenche NI retry NI
// failover (re-facturerait le même étage et pourrait dépasser le montant signé). Sans
// contrat, les retries bornés historiques restent inchangés.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_noretry_test'
process.env.OPENMULTI_QUOTE_TOKEN_SECRET = 'noretry-secret'
process.env.OPENMULTI_MODEL_BALANCED = 'moonshotai/kimi-k2.6'
process.env.OPENMULTI_MAX_RETRIES = '2' // 3 tentatives max SANS contrat

const KEY = 'sk_noretry_test'
const { app } = await import('../src/app.ts')

let calls = 0
beforeEach(() => { calls = 0 })

const QUOTED = { model: 'auto', messages: [{ role: 'user', content: 'résume' }], max_tokens: 200, openmulti: { tier: 'balanced' } }
async function tokenFor(body: unknown): Promise<string> {
  globalThis.fetch = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as never
  const p = await (await app.fetch(new Request('http://test/v1/plan', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) }))).json()
  return p.quote_token as string
}
const chat = (body: unknown) =>
  app.fetch(new Request('http://test/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) }))

test('exception transport SOUS contrat : UN seul dispatch, 504 contract_no_retry, pas de failover', async () => {
  const token = await tokenFor(QUOTED)
  globalThis.fetch = (async () => { calls++; throw new Error('ECONNRESET') }) as never
  const res = await chat({ ...QUOTED, openmulti: { ...QUOTED.openmulti, quote_token: token } })
  assert.equal(res.status, 504)
  assert.equal((await res.json()).error.code, 'contract_no_retry')
  assert.equal(calls, 1, 'un seul dispatch sous contrat')
})

test('statut transitoire (503) SOUS contrat : UN seul dispatch, statut préservé, erreur normalisée', async () => {
  const token = await tokenFor(QUOTED)
  globalThis.fetch = (async () => { calls++; return new Response('busy', { status: 503 }) }) as never
  const res = await chat({ ...QUOTED, openmulti: { ...QUOTED.openmulti, quote_token: token } })
  assert.equal(res.status, 503) // statut conservé (OM-07)
  assert.equal(calls, 1, 'pas de retry sous contrat sur un 503 reçu')
})

test('SANS contrat : les retries bornés historiques restent en place (comportement inchangé)', async () => {
  globalThis.fetch = (async () => { calls++; throw new Error('ECONNRESET') }) as never
  const res = await chat(QUOTED) // pas de quote_token
  assert.equal(res.status, 504)
  assert.equal((await res.json()).error.code, undefined, 'pas de code contract_no_retry hors contrat')
  assert.equal(calls, 3, '1 essai + 2 retries (OPENMULTI_MAX_RETRIES=2)')
})
