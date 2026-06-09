// v0 auth: static Bearer key allowlist. Each consuming project gets its own sk_ key.
// OpenMulti knows nothing about the caller's own tenants/billing; the key only
// identifies which project is calling (for future per-key metering).

import type { MiddlewareHandler } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { config } from './config.js'
import type { AppEnv } from './types.js'

/** Constant-time string compare (avoids leaking a token via response timing). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('authorization')
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: { message: 'Missing authorization', type: 'auth_error' } }, 401)
  }
  const key = header.slice(7)

  // Empty allowlist = open (dev only). In any deployed env, set OPENMULTI_API_KEYS.
  if (config.apiKeys.length > 0 && !config.apiKeys.includes(key)) {
    return c.json({ error: { message: 'Invalid API key', type: 'auth_error' } }, 401)
  }

  c.set('apiKey', key)
  await next()
}

// OM-03: guard for GET /metrics. With OPENMULTI_METRICS_TOKEN set, /metrics requires
// exactly that token (constant-time) — caller keys are rejected, so a consuming
// project can no longer read every project's cost/usage. Without it, fall back to the
// caller-key auth above (unchanged behavior), so this is opt-in and regression-free.
export const metricsAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!config.metricsToken) return auth(c, next)

  const header = c.req.header('authorization')
  const token = header?.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token || !safeEqual(token, config.metricsToken)) {
    return c.json({ error: { message: 'Invalid metrics token', type: 'auth_error' } }, 401)
  }
  await next()
}
