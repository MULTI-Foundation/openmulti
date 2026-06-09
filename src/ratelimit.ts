// OM-01: per-key request rate limit. Fixed 60s window, in-memory (per pod — fine at
// replicas:1; a multi-replica deploy would need a shared store). Disabled unless
// OPENMULTI_RATE_LIMIT_PER_MIN is set, so the default path is unchanged.
//
// Keyed by project label (keyLabel), not the raw secret, so the map never holds keys.

import type { MiddlewareHandler } from 'hono'
import { config } from './config.js'
import { keyLabel } from './metrics.js'
import type { AppEnv } from './types.js'

const WINDOW_MS = 60_000

interface Window {
  start: number
  count: number
}

const windows = new Map<string, Window>()

export const rateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const limit = config.rateLimitPerMin
  if (limit <= 0) return next() // disabled: no-op

  const key = keyLabel(c.get('apiKey'))
  const now = Date.now()
  let w = windows.get(key)
  if (!w || now - w.start >= WINDOW_MS) {
    w = { start: now, count: 0 }
    windows.set(key, w)
  }
  w.count += 1

  if (w.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((w.start + WINDOW_MS - now) / 1000))
    c.header('Retry-After', String(retryAfter))
    return c.json({ error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } }, 429)
  }
  return next()
}

/** Test helper: clear all windows between cases. */
export function _resetRateLimit(): void {
  windows.clear()
}
