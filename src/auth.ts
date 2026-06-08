// v0 auth: static Bearer key allowlist. Each consuming project gets its own sk_ key.
// OpenMulti knows nothing about the caller's own tenants/billing; the key only
// identifies which project is calling (for future per-key metering).

import type { MiddlewareHandler } from 'hono'
import { config } from './config.js'
import type { AppEnv } from './types.js'

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
