// Chemin d'accès direct Anthropic (spec multi-provider §5 — le seul provider NON
// OpenAI-shape). API /v1/messages, auth x-api-key + anthropic-version. Endpoint/headers/
// ids/prix vérifiés via la référence officielle (claude-api) le 2026-06-23.
//
// Pas le SDK : OpenMulti est un proxy wire-level (fetch brut), et le travail est la
// TRADUCTION OpenAI<->Anthropic (corps, réponse, SSE), que le SDK ne fait pas. Les
// fonctions de mapping pures vivent dans anthropic-translate.ts (testées isolément) ;
// ici on câble fetch + synthèse du coût (pricing.ts) + ré-encodage du flux SSE Anthropic
// (events message_start/content_block_delta/…) en chunks SSE OpenAI (choices[].delta).

import { config } from '../config.js'
import { computeCostUsd } from '../pricing.js'
import { log } from '../log.js'
import { recordPricingMiss } from '../metrics.js'
import { pickAllowedFields } from './shared.js'
import {
  toAnthropicBody,
  toOpenAIResponse,
  anthropicTokens,
  mapStopReason,
} from './anthropic-translate.js'
import type { ChatRequest } from '../types.js'
import type { Provider, UpstreamCall } from './types.js'

type Dict = Record<string, unknown>

// Statuts retryables Anthropic : 429/5xx + 529 (overloaded_error, propre à Anthropic).
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529])
function isRetryable(status: number): boolean {
  return RETRYABLE.has(status)
}

/** Coût synthétisé, ou undefined + trace du trou de tarif (jamais un faux zéro). */
function costOrMiss(model: string, promptTokens: number, completionTokens: number): number | undefined {
  const cost = computeCostUsd(model, promptTokens, completionTokens)
  if (cost === undefined) {
    recordPricingMiss(model)
    log.warn('pricing_miss', { provider: 'anthropic', model })
  }
  return cost
}

function buildBody(req: ChatRequest, resolvedModel: string, maxTokensCeiling?: number): Dict {
  // OM-06 : on ne traduit que des champs OpenAI connus (allowlist), puis mapping Anthropic.
  const clean = pickAllowedFields(req as Dict) as Dict
  return toAnthropicBody(clean, resolvedModel, {
    defaultMaxTokens: config.anthropic.defaultMaxTokens,
    maxTokensCeiling,
  })
}

async function call(body: Dict): Promise<UpstreamCall> {
  const abort = new AbortController()
  const connectTimer = setTimeout(() => abort.abort(), 30_000)
  let response: Response
  try {
    response = await fetch(`${config.anthropic.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': config.anthropic.apiKey,
        'anthropic-version': config.anthropic.version,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: abort.signal,
    })
  } finally {
    clearTimeout(connectTimer)
  }
  return { response, abort }
}

function normalizeResponse(data: Dict, model: string): Dict {
  const t = anthropicTokens(data.usage)
  const cost = costOrMiss(model, t.prompt_tokens, t.completion_tokens)
  return toOpenAIResponse(data, model, Math.floor(Date.now() / 1000), cost)
}

/** Ré-encode le flux SSE Anthropic en SSE OpenAI (chunks chat.completion.chunk), avec un
 * chunk d'usage final portant le coût synthétisé (point de couplage #1 : l'appelant lit
 * usage.cost dans le dernier chunk) puis [DONE]. Stateful : suit l'id, les tokens, et le
 * mapping bloc tool_use -> index tool_calls OpenAI. */
function adaptStream(upstream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const reader = upstream.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const created = Math.floor(Date.now() / 1000)

  let id = 'chatcmpl-anthropic'
  let buf = ''
  let roleSent = false
  let stopReason: unknown = null
  let inputTokens = 0
  let cacheRead = 0
  let cacheCreation = 0
  let outputTokens = 0
  const toolIndexByBlock: Record<number, number> = {}
  let nextToolIndex = 0

  const chunkBytes = (delta: Dict, finishReason: string | null = null): Uint8Array =>
    encoder.encode(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    )

  function handle(ev: Dict): Uint8Array[] {
    const out: Uint8Array[] = []
    switch (ev.type) {
      case 'message_start': {
        const msg = (ev.message as Dict | undefined) ?? {}
        const u = (msg.usage as Record<string, number | undefined> | undefined) ?? {}
        inputTokens = u.input_tokens ?? 0
        cacheRead = u.cache_read_input_tokens ?? 0
        cacheCreation = u.cache_creation_input_tokens ?? 0
        if (typeof msg.id === 'string') id = msg.id
        if (!roleSent) {
          out.push(chunkBytes({ role: 'assistant' }))
          roleSent = true
        }
        break
      }
      case 'content_block_start': {
        const cb = (ev.content_block as Dict | undefined) ?? {}
        if (cb.type === 'tool_use') {
          const ti = nextToolIndex++
          toolIndexByBlock[Number(ev.index)] = ti
          out.push(
            chunkBytes({
              tool_calls: [{ index: ti, id: cb.id, type: 'function', function: { name: cb.name, arguments: '' } }],
            }),
          )
        }
        break
      }
      case 'content_block_delta': {
        const d = (ev.delta as Dict | undefined) ?? {}
        if (d.type === 'text_delta') {
          out.push(chunkBytes({ content: String(d.text ?? '') }))
        } else if (d.type === 'input_json_delta') {
          const ti = toolIndexByBlock[Number(ev.index)] ?? 0
          out.push(chunkBytes({ tool_calls: [{ index: ti, function: { arguments: String(d.partial_json ?? '') } }] }))
        }
        break
      }
      case 'message_delta': {
        const d = (ev.delta as Dict | undefined) ?? {}
        if (d.stop_reason != null) stopReason = d.stop_reason
        const u = (ev.usage as Record<string, number | undefined> | undefined) ?? {}
        if (u.output_tokens != null) outputTokens = u.output_tokens
        break
      }
      // content_block_stop, message_stop, ping -> ignorés (flush final sur done)
    }
    return out
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined as Uint8Array | undefined }))
        if (done) {
          const finish = mapStopReason(stopReason, stopReason === 'tool_use')
          controller.enqueue(chunkBytes({}, finish))
          const tokens = anthropicTokens({
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: cacheCreation,
          })
          const usage: Dict = { ...tokens }
          const cost = costOrMiss(model, tokens.prompt_tokens, tokens.completion_tokens)
          if (cost !== undefined) usage.cost = cost
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`),
          )
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
          return
        }
        buf += decoder.decode(value, { stream: true })
        let emitted = false
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload) continue
          let ev: Dict
          try {
            ev = JSON.parse(payload) as Dict
          } catch {
            continue
          }
          for (const c of handle(ev)) {
            controller.enqueue(c)
            emitted = true
          }
        }
        if (emitted) return
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {})
    },
  })
}

export const anthropicProvider: Provider = {
  name: 'anthropic',
  buildBody,
  call,
  isRetryable,
  normalizeResponse,
  adaptStream,
}

// Réexports utiles aux tests.
export { anthropicModelId } from './anthropic-translate.js'
