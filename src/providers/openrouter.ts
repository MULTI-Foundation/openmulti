// Upstream provider adapter (OpenRouter, OpenAI-compatible).
//
// Carries the provider-optimization behaviors ported 1:1 from MyMULTI so OpenMulti
// v0 is iso-comportement:
//   - force usage.include (cost reporting in the final chunk)
//   - provider.sort = 'throughput' (steer away from slow/stalling providers)
//   - max_tokens floor for the Kimi K2 family when the caller left it unset
//   - 30s connect timeout (the inter-chunk watchdog lives in the route, tied to the reader)

import { config } from '../config.js'
import type { ChatRequest } from '../types.js'

/**
 * Mutate the outgoing body: set the resolved model + apply steering. Returns the
 * body ready to send upstream. `req.openmulti` is stripped (provider must not see it).
 */
export function buildUpstreamBody(
  req: ChatRequest,
  resolvedModel: string,
  maxTokensCeiling?: number,
): Record<string, unknown> {
  const { openmulti: _omit, ...rest } = req
  const body: Record<string, unknown> = { ...rest, model: resolvedModel }

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

// Transient upstream statuses worth retrying on the SAME model. 4xx (bad request,
// auth, unprocessable) are deterministic — retrying won't help — except 429, which
// is a rate-limit hiccup and honors Retry-After.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status)
}

export interface UpstreamCall {
  response: Response
  abort: AbortController
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
