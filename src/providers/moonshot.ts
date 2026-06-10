// Chemin d'accès direct Moonshot/Kimi (étape 3 de docs/MULTI-PROVIDER-SPEC.md).
//
// API OpenAI-compatible, vérifiée le 2026-06-10 sur platform.kimi.ai/docs/api/chat :
//   - POST {base}/chat/completions, auth Bearer (MOONSHOT_API_KEY)
//   - ids de modèle SANS préfixe vendor : 'kimi-k2.6' (le catalogue parle en
//     'moonshotai/kimi-k2.6', l'id OpenRouter — on retire le préfixe)
//   - stream_options.include_usage=true → bloc usage dans le dernier chunk avant
//     [DONE] (convention OpenAI, supportée)
// Moonshot ne fournit PAS usage.cost (c'est un service OpenRouter). Or usage.cost est
// le point de couplage #1 du contrat MyMULTI et le signal du bandit → il est synthétisé
// depuis pricing.ts : normalizeResponse en non-stream, injection dans le chunk usage
// via adaptStream en stream. Modèle non tarifé = cost absent + warning + métrique,
// jamais un faux zéro.

import { config } from '../config.js'
import { computeCostUsd } from '../pricing.js'
import { injectCostIntoSseData } from '../sse.js'
import { log } from '../log.js'
import { recordPricingMiss } from '../metrics.js'
import { isRetryableStatus } from './shared.js'
import type { ChatRequest } from '../types.js'
import type { Provider, UpstreamCall } from './types.js'

/** 'moonshotai/kimi-k2.6' (id catalogue/OpenRouter) -> 'kimi-k2.6' (id Moonshot). */
export function moonshotModelId(model: string): string {
  return model.replace(/^moonshotai\//, '')
}

export function buildMoonshotBody(
  req: ChatRequest,
  resolvedModel: string,
  maxTokensCeiling?: number,
): Record<string, unknown> {
  // `usage` (usage.include) et `provider` (sort/order/only…) sont des extensions de
  // requête OpenRouter : elles ne doivent pas fuiter chez Moonshot.
  const { openmulti: _omit, usage: _usage, provider: _provider, ...rest } = req
  const body: Record<string, unknown> = { ...rest, model: moonshotModelId(resolvedModel) }

  // Même règle que sur le chemin OpenRouter, pour la même raison : le défaut Moonshot
  // (8192) tronque les longues générations agent. Floor quand l'appelant n'a rien mis.
  if (!body.max_tokens && resolvedModel.startsWith('moonshotai/kimi-k2')) {
    body.max_tokens = 32000
  }

  // OM-01: clamp max_tokens to the tier ceiling when set (bounds unit cost).
  if (maxTokensCeiling && maxTokensCeiling > 0) {
    const current = typeof body.max_tokens === 'number' ? body.max_tokens : Infinity
    if (current > maxTokensCeiling) body.max_tokens = maxTokensCeiling
  }

  // En stream, demander le bloc usage dans le dernier chunk (l'équivalent direct de
  // l'usage.include d'OpenRouter) — sans lui, ni MyMULTI ni nos métriques ne voient
  // les tokens.
  if (body.stream === true) {
    const opts = (typeof body.stream_options === 'object' && body.stream_options !== null)
      ? (body.stream_options as Record<string, unknown>)
      : {}
    body.stream_options = { ...opts, include_usage: true }
  }

  return body
}

async function callMoonshot(body: Record<string, unknown>): Promise<UpstreamCall> {
  const abort = new AbortController()
  const connectTimer = setTimeout(() => abort.abort(), 30_000)

  let response: Response
  try {
    response = await fetch(`${config.moonshot.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.moonshot.apiKey}`,
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

/** Coût synthétisé pour `model`, ou undefined + trace du trou de tarif. */
function costOrMiss(model: string, promptTokens: number, completionTokens: number): number | undefined {
  const cost = computeCostUsd(model, promptTokens, completionTokens)
  if (cost === undefined) {
    recordPricingMiss(model)
    log.warn('pricing_miss', { provider: 'moonshot', model })
  }
  return cost
}

export function normalizeMoonshotResponse(
  data: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const u = data.usage as { prompt_tokens?: number; completion_tokens?: number; cost?: unknown } | undefined
  if (!u || typeof u !== 'object' || typeof u.cost === 'number') return data
  const cost = costOrMiss(model, u.prompt_tokens ?? 0, u.completion_tokens ?? 0)
  if (cost === undefined) return data
  return { ...data, usage: { ...u, cost } }
}

/** Réécrit le flux SSE ligne à ligne : tout passe tel quel, sauf l'événement qui porte
 * le bloc usage sans cost, où le coût synthétisé est injecté. Le découpage en lignes
 * tolère un événement coupé entre deux chunks (même précaution que SseUsageScanner). */
export function adaptMoonshotStream(
  upstream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // garde la ligne (potentiellement) partielle
      for (const line of lines) {
        const injected = injectCostIntoSseData(line, (pt, ct) => costOrMiss(model, pt, ct))
        controller.enqueue(encoder.encode(`${injected ?? line}\n`))
      }
    },
    flush(controller) {
      buffer += decoder.decode()
      if (buffer) controller.enqueue(encoder.encode(buffer))
    },
  })

  return upstream.pipeThrough(transform)
}

export const moonshotProvider: Provider = {
  name: 'moonshot',
  buildBody: buildMoonshotBody,
  call: callMoonshot,
  isRetryable: isRetryableStatus,
  normalizeResponse: normalizeMoonshotResponse,
  adaptStream: adaptMoonshotStream,
}
