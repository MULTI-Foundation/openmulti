// Tests du fallback de chemin d'accès (incrément D) : quand le chemin élu épuise ses
// retries sur une panne transitoire, la requête repart sur l'autre chemin du MÊME
// modèle. Upstreams mockés par URL (moonshot vs openrouter), retries à 0 pour des
// tests courts et déterministes.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_fb_test'
process.env.MOONSHOT_API_KEY = 'msk-test'
process.env.OPENMULTI_PROVIDER_MOONSHOTAI = 'direct'
process.env.OPENMULTI_MAX_RETRIES = '0'

const KEY = 'sk_fb_test'
const MODEL = 'moonshotai/kimi-k2.6'

const { app } = await import('../src/app.ts')
const { renderProm, _resetMetrics } = await import('../src/metrics.ts')

// Comportement par upstream, redéfini par test.
let onMoonshot: () => Response | never
let onOpenRouter: () => Response | never

const ok = (cost = 0.01) =>
  new Response(JSON.stringify({ id: 'gen-1', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
const status = (s: number) => new Response(JSON.stringify({ error: 'upstream says no' }), { status: s, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  _resetMetrics()
  onMoonshot = () => ok()
  onOpenRouter = () => ok()
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('moonshot')) return onMoonshot()
    return onOpenRouter()
  }) as any
})

const chat = (body: Record<string, unknown> = {}) =>
  app.fetch(new Request('http://test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], openmulti: { tier: 'balanced' }, ...body }),
  }))

test('503 sur le chemin direct -> bascule openrouter, 200, trace + metriques', async () => {
  onMoonshot = () => status(503)
  const res = await chat()
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.usage.cost, 0.01, 'reponse servie par openrouter')
  assert.match(j.openmulti.reason, /via openrouter \(fallback from moonshot\)/)
  const prom = renderProm()
  assert.match(prom, /openmulti_path_fallback_total\{model="moonshotai\/kimi-k2\.6",from="moonshot",to="openrouter"\} 1\b/)
  // l'echec du chemin direct est OBSERVE (le bandit/metering le voient)
  assert.match(prom, /openmulti_request_errors_total\{key="fb",model="moonshotai\/kimi-k2\.6",provider="moonshot"\} 1\b/)
})

test('upstream injoignable (connect error) -> meme bascule', async () => {
  onMoonshot = () => {
    throw new TypeError('fetch failed')
  }
  const res = await chat()
  assert.equal(res.status, 200)
  assert.match((await res.json()).openmulti.reason, /fallback from moonshot/)
})

test('4xx deterministe -> renvoye tel quel, AUCUN fallback (la requete est en cause)', async () => {
  onMoonshot = () => status(400)
  const res = await chat()
  assert.equal(res.status, 400)
  assert.doesNotMatch(renderProm(), /openmulti_path_fallback_total\{/)
})

test('les deux chemins en panne -> erreur du dernier chemin, une seule bascule comptee', async () => {
  onMoonshot = () => status(503)
  onOpenRouter = () => status(502)
  const res = await chat()
  assert.equal(res.status, 502)
  const prom = renderProm()
  assert.match(prom, /openmulti_path_fallback_total\{model="moonshotai\/kimi-k2\.6",from="moonshot",to="openrouter"\} 1\b/)
})

test('modele a chemin unique : comportement inchange (pas de fallback possible)', async () => {
  onOpenRouter = () => status(503)
  const res = await chat({ model: 'anthropic/claude-sonnet-4-5' })
  assert.equal(res.status, 503)
  assert.doesNotMatch(renderProm(), /openmulti_path_fallback_total\{/)
})

test('stream : la bascule arrive avant le premier octet, le flux vient du chemin de secours', async () => {
  onMoonshot = () => status(503)
  onOpenRouter = () =>
    new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  const res = await chat({ stream: true })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('x-openmulti-reason') ?? '', /fallback from moonshot/)
  assert.match(await res.text(), /data: \[DONE\]/)
})
