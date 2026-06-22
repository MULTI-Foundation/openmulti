// Fabrique de providers DIRECTS OpenAI-compatibles (docs/MULTI-PROVIDER-SPEC.md §3).
//
// La plupart des fournisseurs (OpenAI, DeepSeek, Mistral, Z.ai, Moonshot…) parlent le
// MÊME wire format qu'OpenRouter : corps OpenAI, SSE OpenAI, auth Bearer. Ce qui varie
// d'un provider direct à l'autre tient en peu de choses :
//   - endpoint + clé (spec.baseUrl / spec.apiKey),
//   - le préfixe vendor à retirer de l'id catalogue (le catalogue parle en
//     'vendor/model', l'API directe veut l'id nu),
//   - quelques tweaks de corps propres au provider (floor Kimi, max_completion_tokens
//     des modèles de raisonnement OpenAI…) → hooks `steer`/`finalize`.
// Tout le reste — strip des OpenRouter-ismes (usage.include, provider.sort), plafond
// de tier (OM-01), include_usage en stream, et surtout la SYNTHÈSE de usage.cost
// depuis pricing.ts (point de couplage #1 du contrat, absent en direct) — est commun
// et vit ici une seule fois. Moonshot (le premier chemin direct) est désormais une
// instance de cette fabrique ; chaque nouveau vendor en ajoute une.

import { computeCostUsd } from '../pricing.js'
import { injectCostIntoSseData, sseLineTransform } from '../sse.js'
import { log } from '../log.js'
import { recordPricingMiss } from '../metrics.js'
import { isRetryableStatus, pickAllowedFields } from './shared.js'
import type { ChatRequest } from '../types.js'
import type { Provider, UpstreamCall } from './types.js'

export interface OpenAICompatibleSpec {
  /** Id stable du chemin d'accès (logs, métriques, sélection smart). */
  name: string
  /** Base URL SANS le suffixe /chat/completions (ex. 'https://api.openai.com/v1'). */
  baseUrl: string
  /** Clé Bearer du provider. Vide = chemin jamais élu (cf providers/index.ts). */
  apiKey: string
  /** Préfixe vendor de l'id catalogue à retirer ('openai/', 'deepseek/'…). */
  vendorPrefix: string
  /** Tweaks de corps propres au vendor, AVANT le plafond de tier (pour qu'un floor
   * puisse ensuite être rogné par le plafond). Ex. floor Kimi. */
  steer?: (body: Record<string, unknown>, resolvedModel: string) => void
  /** Tweaks APRÈS plafond + include_usage (renommages/strips qui doivent voir la
   * valeur finale des champs de tokens). Ex. max_tokens -> max_completion_tokens pour
   * les modèles de raisonnement OpenAI. */
  finalize?: (body: Record<string, unknown>, resolvedModel: string) => void
}

export interface OpenAICompatibleProvider {
  provider: Provider
  modelId: (model: string) => string
  buildBody: (req: ChatRequest, resolvedModel: string, maxTokensCeiling?: number) => Record<string, unknown>
  normalizeResponse: (data: Record<string, unknown>, model: string) => Record<string, unknown>
  adaptStream: (upstream: ReadableStream<Uint8Array>, model: string) => ReadableStream<Uint8Array>
}

export function makeOpenAICompatibleProvider(spec: OpenAICompatibleSpec): OpenAICompatibleProvider {
  /** 'openai/gpt-5' (id catalogue) -> 'gpt-5' (id provider). Sans préfixe = inchangé. */
  const modelId = (model: string): string =>
    model.startsWith(spec.vendorPrefix) ? model.slice(spec.vendorPrefix.length) : model

  const buildBody = (
    req: ChatRequest,
    resolvedModel: string,
    maxTokensCeiling?: number,
  ): Record<string, unknown> => {
    // OM-06 (allowlist, cf shared.ts) puis hygiène : `usage` (usage.include) et
    // `provider` (sort/order…) sont des extensions de REQUÊTE OpenRouter, elles ne
    // doivent jamais fuiter chez un provider direct.
    const { usage: _usage, provider: _provider, ...rest } = pickAllowedFields(req)
    const body: Record<string, unknown> = { ...rest, model: modelId(resolvedModel) }

    spec.steer?.(body, resolvedModel)

    // OM-01: plafond de tier (borne le coût unitaire), appliqué après le steer pour
    // qu'un plafond configuré gagne sur un floor. On clampe LES DEUX champs de limite
    // (max_tokens ET max_completion_tokens, ce dernier étant celui des modèles de
    // raisonnement OpenAI) : sinon un appelant qui envoie directement
    // max_completion_tokens échapperait au plafond (le rename de `finalize` perdrait la
    // valeur clampée sur max_tokens). Aucun champ posé = on cape sur max_tokens (le
    // rename éventuel s'en chargera ensuite).
    if (maxTokensCeiling && maxTokensCeiling > 0) {
      const mt = typeof body.max_tokens === 'number' ? body.max_tokens : undefined
      const mct = typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : undefined
      if (mt === undefined && mct === undefined) {
        body.max_tokens = maxTokensCeiling
      } else {
        if (mt !== undefined && mt > maxTokensCeiling) body.max_tokens = maxTokensCeiling
        if (mct !== undefined && mct > maxTokensCeiling) body.max_completion_tokens = maxTokensCeiling
      }
    }

    // En stream, demander le bloc usage dans le dernier chunk (l'équivalent direct de
    // l'usage.include d'OpenRouter) — sans lui, ni le caller ni nos métriques ne voient
    // les tokens.
    if (body.stream === true) {
      const opts =
        typeof body.stream_options === 'object' && body.stream_options !== null
          ? (body.stream_options as Record<string, unknown>)
          : {}
      body.stream_options = { ...opts, include_usage: true }
    }

    spec.finalize?.(body, resolvedModel)

    return body
  }

  const call = async (body: Record<string, unknown>): Promise<UpstreamCall> => {
    const abort = new AbortController()
    const connectTimer = setTimeout(() => abort.abort(), 30_000)

    let response: Response
    try {
      response = await fetch(`${spec.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${spec.apiKey}`,
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

  /** Coût synthétisé pour `model`, ou undefined + trace du trou de tarif (jamais un
   * faux zéro : le bandit lirait « gratuit » → biais dangereux). */
  const costOrMiss = (model: string, promptTokens: number, completionTokens: number): number | undefined => {
    const cost = computeCostUsd(model, promptTokens, completionTokens)
    if (cost === undefined) {
      recordPricingMiss(model)
      log.warn('pricing_miss', { provider: spec.name, model })
    }
    return cost
  }

  const normalizeResponse = (data: Record<string, unknown>, model: string): Record<string, unknown> => {
    const u = data.usage as { prompt_tokens?: number; completion_tokens?: number; cost?: unknown } | undefined
    if (!u || typeof u !== 'object' || typeof u.cost === 'number') return data
    const cost = costOrMiss(model, u.prompt_tokens ?? 0, u.completion_tokens ?? 0)
    if (cost === undefined) return data
    return { ...data, usage: { ...u, cost } }
  }

  const adaptStream = (upstream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> =>
    sseLineTransform(upstream, (line) => injectCostIntoSseData(line, (pt, ct) => costOrMiss(model, pt, ct)))

  const provider: Provider = {
    name: spec.name,
    buildBody,
    call,
    isRetryable: isRetryableStatus,
    normalizeResponse,
    adaptStream,
  }

  return { provider, modelId, buildBody, normalizeResponse, adaptStream }
}
