// Tests du chemin d'accès direct Moonshot (étape 3 de la spec multi-provider).
// L'upstream est mocké (globalThis.fetch, comme contract.test.ts) — aucun réseau.
// Ce fichier verrouille : la résolution opt-in du chemin (env + clé), le mapping des
// ids, l'hygiène du corps (rien d'OpenRouter ne fuite), la synthèse de usage.cost en
// non-stream ET en stream (point de couplage #1 du contrat), et le trou de tarif
// (jamais un faux zéro, métrique dédiée).

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS ||= 'sk_moonshot_test'
process.env.OPENMULTI_PROVIDER_MOONSHOTAI = 'direct'
process.env.MOONSHOT_API_KEY = 'msk-test'
process.env.OPENMULTI_MODEL_AGENT_BALANCED = 'moonshotai/kimi-k2.6'

const KEY = 'sk_moonshot_test'
let app: { fetch: (req: Request) => Promise<Response> }
let providerFor: (model: string) => { name: string }
let buildMoonshotBody: typeof import('../src/providers/moonshot.ts')['buildMoonshotBody']
let moonshotModelId: typeof import('../src/providers/moonshot.ts')['moonshotModelId']
let normalizeMoonshotResponse: typeof import('../src/providers/moonshot.ts')['normalizeMoonshotResponse']
let adaptMoonshotStream: typeof import('../src/providers/moonshot.ts')['adaptMoonshotStream']
let renderProm: () => string
let _resetMetrics: () => void

let lastUrl: string
let lastInit: any
let mockResponse: () => Response

before(async () => {
  ;({ app } = await import('../src/app.ts'))
  ;({ providerFor } = await import('../src/providers/index.ts'))
  ;({ buildMoonshotBody, moonshotModelId, normalizeMoonshotResponse, adaptMoonshotStream } =
    await import('../src/providers/moonshot.ts'))
  ;({ renderProm, _resetMetrics } = await import('../src/metrics.ts'))
})

beforeEach(() => {
  _resetMetrics()
  globalThis.fetch = (async (url: any, init: any) => {
    lastUrl = String(url)
    lastInit = init
    return mockResponse()
  }) as any
  mockResponse = () =>
    new Response(
      JSON.stringify({
        id: 'cmpl-1',
        model: 'kimi-k2.6',
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

// ── Résolution du chemin d'accès ─────────────────────────────────────────────

test('providerFor: moonshotai/* -> direct quand flag+cle presents, le reste -> openrouter', () => {
  assert.equal(providerFor('moonshotai/kimi-k2.6').name, 'moonshot')
  assert.equal(providerFor('anthropic/claude-sonnet-4-5').name, 'openrouter')
})

// ── Corps sortant ────────────────────────────────────────────────────────────

test('moonshotModelId: retire le prefixe vendor, ne touche pas le reste', () => {
  assert.equal(moonshotModelId('moonshotai/kimi-k2.6'), 'kimi-k2.6')
  assert.equal(moonshotModelId('kimi-k2.6'), 'kimi-k2.6')
})

test('buildBody: strip openmulti/usage/provider (extensions OpenRouter), floor Kimi, stream_options', () => {
  const body = buildMoonshotBody(
    {
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      usage: { include: true },
      provider: { sort: 'throughput' },
      openmulti: { tier: 'balanced' },
    } as any,
    'moonshotai/kimi-k2.6',
  )
  assert.equal(body.model, 'kimi-k2.6')
  assert.equal(body.openmulti, undefined)
  assert.equal(body.usage, undefined, 'usage.include est un OpenRouter-isme')
  assert.equal(body.provider, undefined, 'provider.sort est un OpenRouter-isme')
  assert.equal(body.max_tokens, 32000, 'meme floor Kimi que via OpenRouter')
  assert.deepEqual(body.stream_options, { include_usage: true })
})

test('buildBody: le plafond par tier (OM-01) s\'applique apres le floor', () => {
  const body = buildMoonshotBody(
    { messages: [] } as any,
    'moonshotai/kimi-k2.6',
    16000,
  )
  assert.equal(body.max_tokens, 16000)
})

// ── Synthèse du coût, non-stream ─────────────────────────────────────────────

test('normalizeResponse: synthetise usage.cost depuis pricing.ts (1M in + 0.5M out)', () => {
  const out = normalizeMoonshotResponse(
    { usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 } },
    'moonshotai/kimi-k2.6',
  )
  // 1M * 0.95/M + 0.5M * 4/M = 0.95 + 2 = 2.95
  assert.equal((out.usage as any).cost, 2.95)
})

test('normalizeResponse: un cost deja present n\'est jamais ecrase', () => {
  const data = { usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.5 } }
  assert.equal(normalizeMoonshotResponse(data, 'moonshotai/kimi-k2.6'), data)
})

test('normalizeResponse: modele non tarife -> pas de cost invente + metrique du trou', () => {
  const data = { usage: { prompt_tokens: 10, completion_tokens: 10 } }
  const out = normalizeMoonshotResponse(data, 'moonshotai/kimi-future')
  assert.equal((out.usage as any).cost, undefined)
  assert.match(renderProm(), /openmulti_pricing_miss_total\{model="moonshotai\/kimi-future"\} 1\b/)
})

// ── Bout en bout (app + fetch mocke) ─────────────────────────────────────────

test('e2e non-stream: endpoint Moonshot, Bearer Moonshot, modele mappe, cost synthetise', async () => {
  const res = await post({
    model: 'auto',
    openmulti: { tier: 'balanced', purpose: 'agent' },
    messages: [{ role: 'user', content: 'hi' }],
  })
  const j = await res.json()
  assert.equal(res.status, 200)
  assert.ok(lastUrl.startsWith('https://api.moonshot.ai/v1/'), `url upstream: ${lastUrl}`)
  assert.equal(lastInit.headers.Authorization, 'Bearer msk-test')
  assert.equal(JSON.parse(lastInit.body).model, 'kimi-k2.6')
  assert.equal(j.usage.cost, 2.95, 'le contrat usage.cost vaut aussi en direct')
})

test('e2e stream: le cost synthetise est injecte dans le chunk usage, le reste passe intact', async () => {
  const sse = [
    'data: {"id":"cmpl-1","choices":[{"delta":{"content":"Hel"}}]}',
    '',
    'data: {"id":"cmpl-1","choices":[{"delta":{"content":"lo"}}]}',
    '',
    'data: {"id":"cmpl-1","choices":[],"usage":{"prompt_tokens":1000000,"completion_tokens":500000}}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n')
  mockResponse = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          const bytes = new TextEncoder().encode(sse)
          // coupe au milieu du chunk usage pour exercer le buffering de ligne
          controller.enqueue(bytes.slice(0, 120))
          controller.enqueue(bytes.slice(120))
          controller.close()
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )

  const res = await post({
    model: 'moonshotai/kimi-k2.6',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(res.status, 200)
  const text = await res.text()
  const usageLine = text.split('\n').find((l) => l.includes('"usage"'))
  assert.ok(usageLine, 'chunk usage absent du flux relaye')
  assert.equal(JSON.parse(usageLine.slice(6)).usage.cost, 2.95)
  assert.ok(text.includes('data: {"id":"cmpl-1","choices":[{"delta":{"content":"Hel"}}]}'), 'les deltas passent intacts')
  assert.ok(text.includes('data: [DONE]'), '[DONE] passe intact')
})

// ── adaptStream isole : decoupage arbitraire des chunks ──────────────────────

test('adaptStream: un event usage coupe entre deux chunks est quand meme enrichi', async () => {
  const line = 'data: {"usage":{"prompt_tokens":1000000,"completion_tokens":500000}}\n\n'
  const bytes = new TextEncoder().encode(line)
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
      controller.close()
    },
  })
  const adapted = adaptMoonshotStream(upstream, 'moonshotai/kimi-k2.6')
  const text = new TextDecoder().decode(
    new Uint8Array(await new Response(adapted).arrayBuffer()),
  )
  assert.equal(JSON.parse(text.split('\n')[0]!.slice(6)).usage.cost, 2.95)
})
