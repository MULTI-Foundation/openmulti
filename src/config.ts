// Centralized env config. Fail fast on missing required secrets.

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required`)
  return v
}

export const config = {
  openrouter: {
    apiKey: required('OPENROUTER_API_KEY'),
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  },
  // Attribution headers forwarded to the upstream provider.
  referer: process.env.OPENMULTI_REFERER || 'https://openmulti.ai',
  title: process.env.OPENMULTI_TITLE || 'OpenMulti',
  port: Number(process.env.PORT || 8080),
  // Static API key allowlist for v0. Each consuming project gets its own key.
  apiKeys: (process.env.OPENMULTI_API_KEYS || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean),
  // Max retries on a transient upstream failure (same model). 0 disables. Only ever
  // fires before any byte reaches the client, so it's safe for stream + non-stream.
  maxRetries: Math.max(0, Number(process.env.OPENMULTI_MAX_RETRIES ?? 2)),
  // Default selection strategy among a tier's candidates. 'default' = first candidate
  // (iso-comportement). Per-request override via openmulti.route. See select.ts.
  defaultRoute: (process.env.OPENMULTI_DEFAULT_ROUTE === 'smart' ? 'smart' : 'default') as 'default' | 'smart',
  // OM-02: reject a request whose declared Content-Length exceeds this (bytes). The
  // 8 MiB default is a safety net far above realistic proxy traffic; tune as needed.
  maxBodyBytes: Math.max(0, Number(process.env.OPENMULTI_MAX_BODY_BYTES ?? 8_388_608)),
  // OM-01: per-key request rate limit over a 60s window. 0 = disabled (default).
  rateLimitPerMin: Math.max(0, Number(process.env.OPENMULTI_RATE_LIMIT_PER_MIN ?? 0)),
  // OM-03: dedicated ops token for GET /metrics. Empty = fall back to caller-key auth
  // (current behavior). Set it in any deployed env to stop cross-tenant metric reads.
  metricsToken: process.env.OPENMULTI_METRICS_TOKEN || '',
}

// Fail closed: an empty allowlist leaves every /v1 route open (see auth.ts). That's
// fine for local dev, but in a deployed env it's almost always a missing-config bug.
// Refuse to boot rather than start silently open.
if (process.env.NODE_ENV === 'production' && config.apiKeys.length === 0) {
  throw new Error('OPENMULTI_API_KEYS is required in production (refusing to start open)')
}

// Timeouts (ms). Ported 1:1 from MyMULTI's proxy so v0 is iso-comportement.
export const TIMEOUTS = {
  connect: 30_000, // headers must arrive within 30s
  interChunk: 60_000, // abort if no byte for 60s mid-stream
} as const
