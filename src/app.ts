// The Hono app (routes + middleware). Kept separate from index.ts so it can be
// imported by the contract tests without starting a server.

import { Hono } from 'hono'
import { auth, metricsAuth, adminAuth } from './auth.js'
import { rateLimit } from './ratelimit.js'
import { chat } from './routes/chat.js'
import { models } from './routes/models.js'
import { plan } from './routes/plan.js'
import { council } from './routes/council.js'
import { embeddings } from './routes/embeddings.js'
import { admin } from './routes/admin.js'
import { signup } from './routes/signup.js'
import { account } from './routes/account.js'
import { renderProm } from './metrics.js'
import { config } from './config.js'
import type { AppEnv } from './types.js'

export const app = new Hono<AppEnv>()

// OM-08: no version in the public health body (avoids fingerprinting). k8s probes
// only check the status code; nothing depends on the body.
app.get('/health', (c) => c.json({ status: 'ok', service: 'openmulti' }))

// Prometheus metrics. metricsAuth requires a dedicated ops token when configured
// (OPENMULTI_METRICS_TOKEN), else falls back to caller-key auth (see OM-03).
app.use('/metrics', metricsAuth)
app.get('/metrics', (c) =>
  c.text(renderProm(), 200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' }),
)

// OM-02: reject oversized bodies up front (cheap, before auth/parsing).
app.use('/v1/*', async (c, next) => {
  if (config.maxBodyBytes > 0) {
    const len = Number(c.req.header('content-length') ?? 0)
    if (len > config.maxBodyBytes) {
      return c.json({ error: { message: 'Request body too large', type: 'invalid_request_error' } }, 413)
    }
  }
  return next()
})
// All /v1 routes require a valid API key, then the (optional) per-key rate limit.
app.use('/v1/*', auth)
app.use('/v1/*', rateLimit)
app.route('/', chat)
app.route('/', models)
app.route('/', account)
app.route('/', plan)
app.route('/', council)
app.route('/', embeddings)

// Routes d'admin (metering durable, bientôt cycle de vie des clés) : token ops strict.
app.use('/admin/*', adminAuth)
app.route('/', admin)

// B2 : signup self-service — PUBLIC par construction (le point d'entrée d'un inconnu),
// donc hors des middlewares /v1 ; toutes ses gardes (opt-in 404, corps borné, rate
// limit IP, plafond global/jour, fail-closed) vivent dans routes/signup.ts + signup.ts.
app.route('/', signup)
