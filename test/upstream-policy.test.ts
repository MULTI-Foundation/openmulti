// Tests d'OM-06 (allowlist des champs transmis à l'upstream) et OM-07 (erreurs
// upstream normalisées) — le gate « avant exposition publique » de l'audit.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_policy_test'
// soupape : champ custom autorisé par env, lu à l'import de shared.ts
process.env.OPENMULTI_ALLOWED_EXTRA_FIELDS = 'x_custom_field'

const KEY = 'sk_policy_test'
const { app } = await import('../src/app.ts')
const { buildMoonshotBody } = await import('../src/providers/moonshot.ts')
const { renderProm, _resetMetrics } = await import('../src/metrics.ts')

let lastBody: any
let respond: () => Response

const ok = () =>
  new Response(JSON.stringify({ id: 'g', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

beforeEach(() => {
  _resetMetrics()
  respond = ok
  globalThis.fetch = (async (_url: any, init: any) => {
    lastBody = JSON.parse(init.body)
    return respond()
  }) as any
})

const chat = (extra: Record<string, unknown> = {}) =>
  app.fetch(new Request('http://test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], ...extra }),
  }))

// ── OM-06 : allowlist ───────────────────────────────────────────────────────────

test('OM-06: un champ hors allowlist est retire avant le forward (et compte)', async () => {
  await chat({ internal_debug: { hack: true }, seed: 42, transforms: ['middle-out'] })
  assert.equal(lastBody.internal_debug, undefined, 'champ inconnu strippe')
  assert.equal(lastBody.seed, 42, 'champ OpenAI standard transmis')
  assert.deepEqual(lastBody.transforms, ['middle-out'], 'extension OpenRouter supportee transmise')
  assert.match(renderProm(), /openmulti_request_fields_stripped_total\{\} [1-9]/)
})

test('OM-06: la soupape env autorise un champ supplementaire sans release', async () => {
  await chat({ x_custom_field: 'ok' })
  assert.equal(lastBody.x_custom_field, 'ok')
})

test('OM-06: le chemin direct Moonshot applique la meme allowlist', () => {
  const body = buildMoonshotBody(
    { messages: [], internal_debug: true, seed: 7 } as any,
    'moonshotai/kimi-k2.6',
  )
  assert.equal(body.internal_debug, undefined)
  assert.equal(body.seed, 7)
})

// ── OM-07 : erreurs normalisees ─────────────────────────────────────────────────

test('OM-07: le corps d\'erreur upstream n\'est jamais relaye, le statut oui', async () => {
  respond = () =>
    new Response(JSON.stringify({ error: { message: 'secret provider internals: pod-42 at 10.0.1.7' } }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })
  const res = await chat()
  assert.equal(res.status, 503)
  const text = await res.text()
  assert.doesNotMatch(text, /pod-42|10\.0\.1\.7/, 'les internals upstream ne fuient pas')
  const j = JSON.parse(text)
  assert.equal(j.error.type, 'upstream_error')
  assert.equal(j.error.code, 503)
})

test('OM-07: typage stable par classe de statut (429 / 4xx / 5xx)', async () => {
  respond = () => new Response('{"oops":1}', { status: 429, headers: { 'content-type': 'application/json' } })
  let j = await (await chat()).json()
  assert.equal(j.error.type, 'rate_limit_error')

  respond = () => new Response('{"oops":1}', { status: 422, headers: { 'content-type': 'application/json' } })
  j = await (await chat()).json()
  assert.equal(j.error.type, 'upstream_rejected')
  assert.equal(j.error.code, 422)
})
