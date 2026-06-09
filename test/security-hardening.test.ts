// Tests for the security hardening fixes OM-01/02/03. All gates are opt-in via env;
// here we configure them and assert they activate. Own file so it owns the env
// (config reads it at import). Upstream is mocked — no network.

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_test_proj'
process.env.OPENMULTI_MAX_BODY_BYTES = '100000' // OM-02: big enough for normal bodies
process.env.OPENMULTI_RATE_LIMIT_PER_MIN = '2' // OM-01
process.env.OPENMULTI_METRICS_TOKEN = 'ops_secret' // OM-03
process.env.OPENMULTI_MAX_TOKENS_BALANCED = '1000' // OM-01 ceiling

const KEY = 'sk_test_proj'
let app: { fetch: (req: Request) => Promise<Response> }
let lastBody: any
let resetRateLimit: () => void

before(async () => {
  ;({ app } = await import('../src/app.ts'))
  ;({ _resetRateLimit: resetRateLimit } = await import('../src/ratelimit.ts'))
})

beforeEach(() => {
  resetRateLimit() // each test starts with a fresh rate window
  globalThis.fetch = (async (_url: any, init: any) => {
    lastBody = JSON.parse(init.body)
    return new Response(
      JSON.stringify({ id: 'g', model: lastBody.model, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as any
})

function post(body: any, key: string | null = KEY) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (key) headers.authorization = `Bearer ${key}`
  return app.fetch(new Request('http://test/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) }))
}

test('OM-02: un corps au-dessus de la limite -> 413', async () => {
  const big = 'x'.repeat(150_000) // > 100000 octets de Content-Length
  const res = await post({ model: 'auto', messages: [{ role: 'user', content: big }] })
  assert.equal(res.status, 413)
})

test('OM-02: un corps normal passe', async () => {
  const res = await post({ model: 'auto', openmulti: { tier: 'balanced' }, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 200)
})

test('OM-01: la 3e requete dans la fenetre (limite=2) -> 429 + Retry-After', async () => {
  assert.equal((await post({ model: 'auto', messages: [{ role: 'user', content: 'a' }] })).status, 200)
  assert.equal((await post({ model: 'auto', messages: [{ role: 'user', content: 'b' }] })).status, 200)
  const third = await post({ model: 'auto', messages: [{ role: 'user', content: 'c' }] })
  assert.equal(third.status, 429)
  assert.ok(third.headers.get('retry-after'))
})

test('OM-01: max_tokens est clampe au plafond du tier', async () => {
  await post({ model: 'auto', openmulti: { tier: 'balanced' }, max_tokens: 5000, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(lastBody.max_tokens, 1000)
})

test('OM-03: /metrics rejette une cle appelante quand un token ops est configure', async () => {
  const res = await app.fetch(new Request('http://test/metrics', { headers: { authorization: `Bearer ${KEY}` } }))
  assert.equal(res.status, 401)
})

test('OM-03: /metrics accepte le token ops', async () => {
  const res = await app.fetch(new Request('http://test/metrics', { headers: { authorization: 'Bearer ops_secret' } }))
  assert.equal(res.status, 200)
  assert.match(await res.text(), /openmulti_requests_total/)
})
