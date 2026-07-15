// Chemin d'accès direct Anthropic (spec multi-provider §5 — provider NON OpenAI-shape).
// Upstream mocké (globalThis.fetch), aucun réseau. Verrouille la TRADUCTION dans les deux
// sens : requête OpenAI -> Messages Anthropic (system, tools, tool_use/tool_result,
// max_tokens requis, strip échantillonnage), réponse Anthropic -> chat.completion OpenAI
// (texte + tool_calls, finish_reason, usage+cost), et le ré-encodage du flux SSE
// (content_block_delta -> choices[].delta, usage.cost dans le dernier chunk, [DONE]).

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS ||= 'sk_anthropic_test'
process.env.OPENMULTI_PROVIDER_ANTHROPIC = 'direct'
process.env.ANTHROPIC_API_KEY = 'ak-test'

const KEY = 'sk_anthropic_test'
let app: { fetch: (req: Request) => Promise<Response> }
let providerFor: (model: string) => { name: string }
let T: typeof import('../src/providers/anthropic-translate.ts')

let lastUrl: string
let lastInit: any
let mockResponse: () => Response

before(async () => {
  ;({ app } = await import('../src/app.ts'))
  ;({ providerFor } = await import('../src/providers/index.ts'))
  T = await import('../src/providers/anthropic-translate.ts')
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
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1_000_000, output_tokens: 500_000 },
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

// ── Traduction requête (pur) ─────────────────────────────────────────────────

test('anthropicModelId: retire le prefixe vendor', () => {
  assert.equal(T.anthropicModelId('anthropic/claude-sonnet-4-6'), 'claude-sonnet-4-6')
  assert.equal(T.anthropicModelId('claude-sonnet-4-6'), 'claude-sonnet-4-6')
})

test('toAnthropicBody: extrait system, pose max_tokens par defaut (requis cote Anthropic)', () => {
  const body = T.toAnthropicBody(
    { messages: [{ role: 'system', content: 'Sys' }, { role: 'user', content: 'Hi' }] } as any,
    'anthropic/claude-sonnet-4-6',
    { defaultMaxTokens: 8192 },
  )
  assert.equal(body.system, 'Sys')
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Hi' }])
  assert.equal(body.model, 'claude-sonnet-4-6')
  assert.equal(body.max_tokens, 8192)
})

test('toAnthropicBody: le plafond de tier borne max_tokens', () => {
  const body = T.toAnthropicBody({ messages: [], max_tokens: 50000 } as any, 'anthropic/claude-sonnet-4-6', {
    defaultMaxTokens: 8192,
    maxTokensCeiling: 16000,
  })
  assert.equal(body.max_tokens, 16000)
})

test('toAnthropicBody: temperature passe sur sonnet, est retiree sur opus-4-8 (refus 400)', () => {
  const sonnet = T.toAnthropicBody({ messages: [], temperature: 0.5 } as any, 'anthropic/claude-sonnet-4-6', { defaultMaxTokens: 8192 })
  assert.equal(sonnet.temperature, 0.5)
  const opus = T.toAnthropicBody({ messages: [], temperature: 0.5, top_p: 0.9 } as any, 'anthropic/claude-opus-4-8', { defaultMaxTokens: 8192 })
  assert.equal(opus.temperature, undefined)
  assert.equal(opus.top_p, undefined)
})

test('toAnthropicBody: tools + tool_choice traduits ; stop -> stop_sequences', () => {
  const body = T.toAnthropicBody(
    {
      messages: [],
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'required',
      stop: 'END',
    } as any,
    'anthropic/claude-sonnet-4-6',
    { defaultMaxTokens: 8192 },
  )
  assert.deepEqual(body.tools, [{ name: 'f', description: 'd', input_schema: { type: 'object', properties: {} } }])
  assert.deepEqual(body.tool_choice, { type: 'any' })
  assert.deepEqual(body.stop_sequences, ['END'])
})

test('splitMessages: assistant tool_calls -> tool_use, message tool -> tool_result(user)', () => {
  const { messages } = T.splitMessages([
    { role: 'assistant', tool_calls: [{ id: 'tu_1', function: { name: 'f', arguments: '{"a":1}' } }] },
    { role: 'tool', tool_call_id: 'tu_1', content: '42' },
  ])
  assert.deepEqual(messages[0], { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'f', input: { a: 1 } }] })
  assert.deepEqual(messages[1], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '42' }] })
})

// ── Traduction réponse (pur) ─────────────────────────────────────────────────

test('toOpenAIResponse: texte + tool_use -> message + tool_calls, finish_reason, usage+cost', () => {
  const out = T.toOpenAIResponse(
    {
      id: 'msg_1',
      content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 'tu_1', name: 'f', input: { a: 1 } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    'anthropic/claude-sonnet-4-6',
    0,
    0.5,
  ) as any
  assert.equal(out.choices[0].message.content, 'Hello')
  assert.deepEqual(out.choices[0].message.tool_calls, [
    { id: 'tu_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
  ])
  assert.equal(out.choices[0].finish_reason, 'tool_calls')
  assert.equal(out.usage.prompt_tokens, 10)
  assert.equal(out.usage.completion_tokens, 20)
  assert.equal(out.usage.cost, 0.5)
})

test('mapStopReason: end_turn->stop, max_tokens->length, tool_use->tool_calls', () => {
  assert.equal(T.mapStopReason('end_turn', false), 'stop')
  assert.equal(T.mapStopReason('max_tokens', false), 'length')
  assert.equal(T.mapStopReason('tool_use', false), 'tool_calls')
  assert.equal(T.mapStopReason(null, true), 'tool_calls')
})

// ── Résolution du chemin ─────────────────────────────────────────────────────

test('providerFor: anthropic/* -> anthropic (flag+cle), le reste -> openrouter', () => {
  assert.equal(providerFor('anthropic/claude-sonnet-4-6').name, 'anthropic')
  assert.equal(providerFor('openai/gpt-4.1').name, 'openrouter')
})

// ── Bout en bout ─────────────────────────────────────────────────────────────

test('e2e non-stream: endpoint /v1/messages, x-api-key, corps traduit, cost synthetise', async () => {
  const res = await post({
    model: 'anthropic/claude-sonnet-4-6',
    openmulti: {},
    messages: [{ role: 'user', content: 'hi' }],
  })
  const j = await res.json()
  assert.equal(res.status, 200)
  assert.ok(lastUrl.startsWith('https://api.anthropic.com/v1/messages'), `url: ${lastUrl}`)
  assert.equal(lastInit.headers['x-api-key'], 'ak-test')
  assert.equal(lastInit.headers['anthropic-version'], '2023-06-01')
  const sent = JSON.parse(lastInit.body)
  assert.equal(sent.model, 'claude-sonnet-4-6')
  assert.equal(sent.max_tokens, 8192) // defaut, Anthropic l'exige
  // 1M in * 3/M + 0.5M out * 15/M = 3 + 7.5 = 10.5
  assert.equal(j.usage.cost, 10.5)
  assert.equal(j.choices[0].message.content, 'OK')
  assert.equal(j.choices[0].finish_reason, 'stop')
})

test('e2e stream: SSE Anthropic re-encode en SSE OpenAI, cost dans le dernier chunk, [DONE]', async () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1000000,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":500000}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join('\n')
  mockResponse = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          const bytes = new TextEncoder().encode(sse)
          controller.enqueue(bytes.slice(0, 200))
          controller.enqueue(bytes.slice(200))
          controller.close()
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )

  const res = await post({
    model: 'anthropic/claude-sonnet-4-6',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.ok(text.includes('"content":"Hel"'), 'delta texte manquant')
  assert.ok(text.includes('"content":"lo"'))
  const usageLine = text.split('\n').find((l) => l.includes('"usage"') && l.includes('"cost"'))
  assert.ok(usageLine, 'chunk usage absent')
  assert.equal(JSON.parse(usageLine.slice(6)).usage.cost, 10.5)
  assert.ok(text.trimEnd().endsWith('data: [DONE]'), '[DONE] final manquant')
})

test('P0-8 e2e stream: une erreur de lecture mi-stream -> finish_reason error + objet error (pas une fin normale)', async () => {
  const head = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
    '',
    '',
  ].join('\n')
  mockResponse = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(head))
          controller.error(new Error('upstream reset mid-stream')) // troncature en vol
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )

  const res = await post({ model: 'anthropic/claude-sonnet-4-6', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 200)
  const text = await res.text()
  // avant le fix : le catch -> done:true rendait une fin d'apparence normale, indiscernable.
  assert.match(text, /"finish_reason":"error"/, 'finish_reason error manquant sur un stream tronque')
  const errLine = text.split('\n').find((l) => l.startsWith('data:') && l.includes('"error"'))
  assert.ok(errLine, 'objet error manquant dans le chunk final')
  assert.ok(text.trimEnd().endsWith('data: [DONE]'), '[DONE] final present')
})
