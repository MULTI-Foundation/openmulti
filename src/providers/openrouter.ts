// Upstream provider adapter (OpenRouter, OpenAI-compatible).
//
// Carries the provider-optimization behaviors ported 1:1 from MyMULTI so OpenMulti
// v0 is iso-comportement:
//   - force usage.include (cost reporting in the final chunk)
//   - provider.sort = 'throughput' (steer away from slow/stalling providers)
//   - max_tokens floor for the Kimi K2 family when the caller left it unset
//   - 30s connect timeout (the inter-chunk watchdog lives in the route, tied to the reader)

import { config } from '../config.js'
import { isRetryableStatus, pickAllowedFields } from './shared.js'
import type { ChatRequest } from '../types.js'
import type { Provider, UpstreamCall } from './types.js'

export { isRetryableStatus }

/**
 * Mutate the outgoing body: set the resolved model + apply steering. Returns the
 * body ready to send upstream. `req.openmulti` is stripped (provider must not see it)
 * and only allowlisted fields are forwarded (OM-06, cf shared.ts).
 */
export function buildUpstreamBody(
  req: ChatRequest,
  resolvedModel: string,
  maxTokensCeiling?: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...pickAllowedFields(req), model: resolvedModel }

  // Force cost reporting (OpenRouter contract).
  body.usage = { ...(req.usage ?? {}), include: true }

  // Kimi K2 family: OpenRouter falls back to a tiny per-provider max_tokens default
  // (Moonshot caps at 8192) which truncates long generations. Floor it when unset.
  if (!body.max_tokens && resolvedModel.startsWith('moonshotai/kimi-k2')) {
    body.max_tokens = 32000
  }

  // OM-01: clamp max_tokens to the tier ceiling when set (bounds unit cost). Applied
  // after the Kimi floor so a configured ceiling wins. Also caps an unset value.
  if (maxTokensCeiling && maxTokensCeiling > 0) {
    const current = typeof body.max_tokens === 'number' ? body.max_tokens : Infinity
    if (current > maxTokensCeiling) body.max_tokens = maxTokensCeiling
  }

  // Bias routing toward consistently fast providers, keep fallbacks on.
  body.provider = { ...(req.provider ?? {}), sort: 'throughput' }

  return body
}

/** POST to the upstream provider with a 30s connect timeout. Throws on network error. */
export async function callUpstream(body: Record<string, unknown>): Promise<UpstreamCall> {
  const abort = new AbortController()
  const connectTimer = setTimeout(() => abort.abort(), 30_000)

  let response: Response
  try {
    response = await fetch(`${config.openrouter.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openrouter.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': config.referer,
        'X-Title': config.title,
      },
      body: JSON.stringify(body),
      signal: abort.signal,
    })
  } finally {
    clearTimeout(connectTimer)
  }

  return { response, abort }
}

/** The OpenRouter access path, behind the Provider seam. The functions above ARE the
 * v0 behavior, moved 1:1 — and OpenRouter already reports usage.cost and speaks the
 * OpenAI shape, so normalization is the identity (contract: byte-identical response
 * when the caller didn't send the openmulti extension). */
export const openRouterProvider: Provider = {
  name: 'openrouter',
  buildBody: buildUpstreamBody,
  call: callUpstream,
  isRetryable: isRetryableStatus,
  normalizeResponse: (data) => data,
}
