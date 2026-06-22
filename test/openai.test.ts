// Chemin d'accès direct OpenAI (spec multi-provider §3). Upstream mocké (globalThis.fetch),
// aucun réseau. Verrouille : la détection des modèles de raisonnement, la réécriture de
// corps qui en découle (max_tokens -> max_completion_tokens, strip des paramètres
// d'échantillonnage refusés), le passthrough des modèles non-raisonnement, le mapping
// d'id, la synthèse de usage.cost, et la résolution opt-in du chemin (env + clé).

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS ||= 'sk_openai_test'
process.env.OPENMULTI_PROVIDER_OPENAI = 'direct'
process.env.OPENAI_API_KEY = 'sk-openai-test'

const KEY = 'sk_openai_test'
let app: { fetch: (req: Request) => Promise<Response> }
let providerFor: (model: string) => { name: string }
let isOpenAIReasoningModel: typeof import('../src/providers/openai.ts')['isOpenAIReasoningModel']
let buildOpenAIBody: typeof import('../src/providers/openai.ts')['buildOpenAIBody']
let openaiModelId: typeof import('../src/providers/openai.ts')['openaiModelId']

let lastUrl: string
let lastInit: any
let mockResponse: () => Response

before(async () => {
  ;({ app } = await import('../src/app.ts'))
  ;({ providerFor } = await import('../src/providers/index.ts'))
  ;({ isOpenAIReasoningModel, buildOpenAIBody, openaiModelId } = await import('../src/providers/openai.ts'))
})

beforeEach(() => {
  globalThis.fetch = (async (url: any, init: any) => {
    lastUrl = String(url)
    lastInit = init
    return mockResponse()
  }) as any
  mockResponse = () =>
    new Response(
      JSON.stringify({
        id: 'cmpl-1',
        model: 'gpt-4.1',
        choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000, total_tokens: 1_500_000 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
})

function post(body: any) {
  return app.fetch(
    new Request('http://test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    }),
  )
}

// ── Détection des modèles de raisonnement ────────────────────────────────────

test('isOpenAIReasoningModel: gpt-5*/o-series = raisonnement ; gpt-4*/chat-latest = non', () => {
  for (const m of ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5', 'o3', 'o4-mini', 'o1']) {
    assert.equal(isOpenAIReasoningModel(m), true, m)
  }
  for (const m of ['gpt-4.1', 'gpt-4o-mini', 'chat-latest', 'gpt-3.5-turbo']) {
    assert.equal(isOpenAIReasoningModel(m), false, m)
  }
})

// ── Réécriture de corps ──────────────────────────────────────────────────────

test('buildBody (raisonnement): max_tokens -> max_completion_tokens, strip echantillonnage', () => {
  const body = buildOpenAIBody(
    { messages: [{ role: 'user', content: 'hi' }], max_tokens: 5000, temperature: 0.2, top_p: 0.9 } as any,
    'openai/gpt-5.4',
  )
  assert.equal(body.model, 'gpt-5.4')
  assert.equal(body.max_tokens, undefined, 'max_tokens refuse par les modeles de raisonnement')
  assert.equal(body.max_completion_tokens, 5000)
  assert.equal(body.temperature, undefined, 'temperature refusee')
  assert.equal(body.top_p, undefined, 'top_p refuse')
})

test('buildBody (raisonnement): n\'ecrase pas un max_completion_tokens deja fourni', () => {
  const body = buildOpenAIBody(
    { messages: [], max_tokens: 5000, max_completion_tokens: 1234 } as any,
    'openai/o3',
  )
  assert.equal(body.max_completion_tokens, 1234)
  assert.equal(body.max_tokens, undefined)
})

test('buildBody (raisonnement): le plafond de tier (OM-01) clampe AVANT le rename', () => {
  // max_tokens envoyé -> clampé puis renommé en max_completion_tokens.
  const a = buildOpenAIBody({ messages: [], max_tokens: 50000 } as any, 'openai/gpt-5.4', 16000)
  assert.equal(a.max_completion_tokens, 16000)
  assert.equal(a.max_tokens, undefined)
})

test('buildBody (raisonnement): max_completion_tokens direct est AUSSI clampé (pas de contournement OM-01)', () => {
  // L'appelant envoie directement max_completion_tokens : il doit quand même être plafonné.
  const b = buildOpenAIBody({ messages: [], max_completion_tokens: 50000 } as any, 'openai/o3', 16000)
  assert.equal(b.max_completion_tokens, 16000)
  assert.equal(b.max_tokens, undefined)
})

test('buildBody (raisonnement): plafond sans limite fournie -> max_completion_tokens posé au plafond', () => {
  const c = buildOpenAIBody({ messages: [] } as any, 'openai/gpt-5.4', 16000)
  assert.equal(c.max_completion_tokens, 16000)
  assert.equal(c.max_tokens, undefined)
})

test('buildBody (non-raisonnement): max_tokens et temperature passent tels quels', () => {
  const body = buildOpenAIBody(
    { messages: [], max_tokens: 5000, temperature: 0.2 } as any,
    'openai/gpt-4.1',
  )
  assert.equal(body.max_tokens, 5000)
  assert.equal(body.temperature, 0.2)
  assert.equal(body.max_completion_tokens, undefined)
})

test('buildBody: strip des OpenRouter-ismes (usage.include, provider.sort) comme tout chemin direct', () => {
  const body = buildOpenAIBody(
    { messages: [], usage: { include: true }, provider: { sort: 'throughput' }, openmulti: { tier: 'quality' } } as any,
    'openai/gpt-4.1',
  )
  assert.equal(body.usage, undefined)
  assert.equal(body.provider, undefined)
  assert.equal(body.openmulti, undefined)
})

test('openaiModelId: retire le prefixe vendor', () => {
  assert.equal(openaiModelId('openai/gpt-5.4'), 'gpt-5.4')
  assert.equal(openaiModelId('gpt-4.1'), 'gpt-4.1')
})

// ── Résolution du chemin ─────────────────────────────────────────────────────

test('providerFor: openai/* -> direct (flag+cle), le reste -> openrouter', () => {
  assert.equal(providerFor('openai/gpt-4.1').name, 'openai')
  assert.equal(providerFor('anthropic/claude-sonnet-4-5').name, 'openrouter')
})

// ── Bout en bout ─────────────────────────────────────────────────────────────

test('e2e non-stream: endpoint OpenAI, Bearer OpenAI, modele mappe, cost synthetise', async () => {
  const res = await post({
    model: 'openai/gpt-4.1',
    messages: [{ role: 'user', content: 'hi' }],
  })
  const j = await res.json()
  assert.equal(res.status, 200)
  assert.ok(lastUrl.startsWith('https://api.openai.com/v1/'), `url upstream: ${lastUrl}`)
  assert.equal(lastInit.headers.Authorization, 'Bearer sk-openai-test')
  assert.equal(JSON.parse(lastInit.body).model, 'gpt-4.1')
  // gpt-4.1 = 2/8 par MTok ; 1M in + 0.5M out = 2 + 4 = 6
  assert.equal(j.usage.cost, 6)
})

test('e2e raisonnement: le corps envoye a OpenAI utilise max_completion_tokens, sans temperature', async () => {
  await post({
    model: 'openai/gpt-5.4',
    max_tokens: 1000,
    temperature: 0.7,
    messages: [{ role: 'user', content: 'hi' }],
  })
  const sent = JSON.parse(lastInit.body)
  assert.equal(sent.model, 'gpt-5.4')
  assert.equal(sent.max_completion_tokens, 1000)
  assert.equal(sent.max_tokens, undefined)
  assert.equal(sent.temperature, undefined)
})
