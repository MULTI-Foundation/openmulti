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
// Auto-marquage cache_control opt-in pour les appels agent (auto-cache.ts) — n'affecte
// que les requêtes `openmulti.purpose: 'agent'` ci-dessous.
process.env.OPENMULTI_ANTHROPIC_AUTO_CACHE = 'agent'

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

// ── Prompt caching : ventilation cache_read/cache_creation + tarifs cache, cache_control ──

test('anthropicTokens: prompt = input + cache_read + cache_creation, ventilation exposee en graphie OpenAI', () => {
  assert.deepEqual(T.anthropicTokens({ input_tokens: 500, cache_read_input_tokens: 400, cache_creation_input_tokens: 100, output_tokens: 20 }), {
    prompt_tokens: 1000,
    completion_tokens: 20,
    total_tokens: 1020,
    prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 },
  })
  // sans cache : ventilation a zero, pas absente (forme stable pour l'appelant)
  assert.deepEqual(T.anthropicTokens({ input_tokens: 10, output_tokens: 20 }).prompt_tokens_details, { cached_tokens: 0, cache_write_tokens: 0 })
})

test('e2e non-stream: cache_read a 0.3 $/M (hit), cache_creation a 3.75 $/M (ecriture 5m), le reste a 3', async () => {
  mockResponse = () =>
    new Response(
      JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn',
        usage: { input_tokens: 500_000, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 100_000, output_tokens: 500_000 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  const res = await post({ model: 'anthropic/claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] })
  const j = await res.json()
  assert.equal(res.status, 200)
  // 0.5M*3 + 0.4M*0.3 + 0.1M*3.75 + 0.5M*15 = 1.5 + 0.12 + 0.375 + 7.5 = 9.495
  // (avant : 1M*3 + 7.5 = 10.5 — borne haute sur le read, borne BASSE sur l'ecriture)
  assert.equal(j.usage.cost, 9.495)
  assert.equal(j.usage.prompt_tokens, 1_000_000)
  assert.deepEqual(j.usage.prompt_tokens_details, { cached_tokens: 400_000, cache_write_tokens: 100_000 })
})

test('e2e stream: cache_read/cache_creation de message_start entrent dans le cost du dernier chunk', async () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":500000,"cache_read_input_tokens":400000,"cache_creation_input_tokens":100000,"output_tokens":0}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}',
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
          controller.enqueue(new TextEncoder().encode(sse))
          controller.close()
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  const res = await post({ model: 'anthropic/claude-sonnet-4-6', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 200)
  const text = await res.text()
  const usageLine = text.split('\n').find((l) => l.includes('"usage"') && l.includes('"cost"'))
  assert.ok(usageLine, 'chunk usage absent')
  const usage = JSON.parse(usageLine.slice(6)).usage
  assert.equal(usage.cost, 9.495)
  assert.deepEqual(usage.prompt_tokens_details, { cached_tokens: 400_000, cache_write_tokens: 100_000 })
})

test('splitMessages: cache_control passe tel quel sur les parts texte (user) et bascule system en blocs', () => {
  const cc = { type: 'ephemeral' }
  const { system, messages } = T.splitMessages([
    { role: 'system', content: [{ type: 'text', text: 'Long preamble', cache_control: cc }] },
    { role: 'system', content: 'Tail' },
    { role: 'user', content: [{ type: 'text', text: 'Doc', cache_control: cc }, { type: 'text', text: 'Q?' }] },
  ])
  assert.deepEqual(system, [{ type: 'text', text: 'Long preamble', cache_control: cc }, { type: 'text', text: 'Tail' }])
  assert.deepEqual(messages[0], { role: 'user', content: [{ type: 'text', text: 'Doc', cache_control: cc }, { type: 'text', text: 'Q?' }] })
})

test('splitMessages: sans cache_control, system reste une string concatenee (comportement historique)', () => {
  const { system } = T.splitMessages([
    { role: 'system', content: 'A' },
    { role: 'system', content: [{ type: 'text', text: 'B' }] },
  ])
  assert.equal(system, 'A\n\nB')
  const body = T.toAnthropicBody({ messages: [{ role: 'user', content: 'hi' }] }, 'anthropic/claude-sonnet-4-6', { defaultMaxTokens: 10 })
  assert.equal(body.system, undefined, 'pas de system vide')
})

test('e2e: cache_control du system arrive a Anthropic sous forme de blocs (pas aplati en string)', async () => {
  const cc = { type: 'ephemeral' }
  await post({
    model: 'anthropic/claude-sonnet-4-6',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'Preamble', cache_control: cc }] },
      { role: 'user', content: 'hi' },
    ],
  })
  const sent = JSON.parse(lastInit.body)
  assert.deepEqual(sent.system, [{ type: 'text', text: 'Preamble', cache_control: cc }])
})

// ── Auto-marquage cache_control (opt-in OPENMULTI_ANTHROPIC_AUTO_CACHE=agent) ──────

test('auto-cache: purpose agent -> system en blocs avec marqueur sur le dernier, + fin du dernier message user', async () => {
  await post({
    model: 'anthropic/claude-sonnet-4-6',
    openmulti: { purpose: 'agent' },
    messages: [
      { role: 'system', content: 'Preamble' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second' },
    ],
    tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }],
  })
  const sent = JSON.parse(lastInit.body)
  assert.deepEqual(sent.system, [{ type: 'text', text: 'Preamble', cache_control: { type: 'ephemeral' } }])
  assert.equal(sent.tools[0].cache_control, undefined, 'le marqueur system couvre deja les tools (prefixe)')
  assert.equal(sent.messages[0].content, 'first', 'pas de marqueur sur un ancien tour (string conservee)')
  assert.deepEqual(sent.messages[2].content, [{ type: 'text', text: 'second', cache_control: { type: 'ephemeral' } }])
})

test('auto-cache: sans system, le marqueur de prefixe va sur le dernier tool', async () => {
  await post({
    model: 'anthropic/claude-sonnet-4-6',
    openmulti: { purpose: 'agent' },
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      { type: 'function', function: { name: 'a', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'b', parameters: { type: 'object', properties: {} } } },
    ],
  })
  const sent = JSON.parse(lastInit.body)
  assert.equal(sent.system, undefined)
  assert.equal(sent.tools[0].cache_control, undefined)
  assert.deepEqual(sent.tools[1].cache_control, { type: 'ephemeral' })
})

test('auto-cache: hors objectif opt-in, rien ne change (system string, pas de marqueur)', async () => {
  for (const openmulti of [undefined, { purpose: 'generation' }]) {
    await post({ model: 'anthropic/claude-sonnet-4-6', openmulti, messages: [{ role: 'system', content: 'P' }, { role: 'user', content: 'hi' }] })
    const sent = JSON.parse(lastInit.body)
    assert.equal(sent.system, 'P')
    assert.ok(!JSON.stringify(sent).includes('cache_control'))
  }
})

test('auto-cache: un marqueur pose par l\'appelant desactive l\'auto-marquage (sa strategie prime)', async () => {
  const cc = { type: 'ephemeral' }
  await post({
    model: 'anthropic/claude-sonnet-4-6',
    openmulti: { purpose: 'agent' },
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B', cache_control: cc }] },
      { role: 'user', content: 'hi' },
    ],
  })
  const sent = JSON.parse(lastInit.body)
  assert.deepEqual(sent.system, [{ type: 'text', text: 'A' }, { type: 'text', text: 'B', cache_control: cc }])
  assert.equal(JSON.stringify(sent.messages).includes('cache_control'), false)
})

test('applyAutoCache: pur — idempotent, et sans system ni tools ni user, aucun marqueur', () => {
  const body: Record<string, unknown> = { model: 'm', messages: [{ role: 'assistant', content: 'x' }] }
  T.applyAutoCache(body)
  assert.ok(!JSON.stringify(body).includes('cache_control'))
  const b2: Record<string, unknown> = { model: 'm', system: 'S', messages: [{ role: 'user', content: 'u' }] }
  T.applyAutoCache(b2)
  const once = JSON.stringify(b2)
  T.applyAutoCache(b2)
  assert.equal(JSON.stringify(b2), once)
  assert.equal((once.match(/cache_control/g) ?? []).length, 2)
})
