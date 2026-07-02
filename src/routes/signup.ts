// Routes publiques du signup self-service (B2). SANS auth par construction — c'est le
// point d'entrée d'un inconnu — donc chaque garde vit ici ou dans src/signup.ts :
// opt-in 404, corps borné, rate limit IP, plafond global, fail-closed. Voir signup.ts
// pour le modèle de menace complet.

import { Hono } from 'hono'
import { config } from '../config.js'
import { startSignup, verifySignup } from '../signup.js'
import type { AppEnv } from '../types.js'

export const signup = new Hono<AppEnv>()

// Un JSON { email, code } tient dans 4 KiB avec une marge énorme ; au-delà c'est un abus.
const MAX_SIGNUP_BODY = 4096

/** IP cliente : premier hop de X-Forwarded-For (posé par l'ingress). Hors proxy c'est
 * spoofable — le plafond global quotidien reste le garde-fou (cf signup.ts). */
function clientIp(header: string | undefined): string {
  const first = header?.split(',')[0]?.trim()
  return first && first.length <= 45 ? first : 'unknown'
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text()
    if (text.length > MAX_SIGNUP_BODY) return null
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

signup.post('/signup', async (c) => {
  if (!config.signup.enabled) return c.notFound()
  const body = await readBody(c.req.raw)
  const email = typeof body?.email === 'string' ? body.email : ''
  if (!body || !email) {
    return c.json({ error: { message: 'Expected JSON body { email }', type: 'invalid_request_error' } }, 400)
  }

  const out = await startSignup(email, clientIp(c.req.header('x-forwarded-for')))
  if (!out.ok) {
    if (out.status === 429) {
      if (out.retryAfterS) c.header('Retry-After', String(out.retryAfterS))
      return c.json({ error: { message: 'Too many signup requests', type: 'rate_limit_error' } }, 429)
    }
    return c.json({ error: { message: 'Signup temporarily unavailable', type: 'service_unavailable' } }, 503)
  }
  // Réponse identique que l'email soit nouveau, déjà inscrit ou invalide (anti-énumération).
  return c.json({ status: 'verification_sent', message: 'If the address is valid, a verification code was sent. POST it to /signup/verify.' })
})

signup.post('/signup/verify', async (c) => {
  if (!config.signup.enabled) return c.notFound()
  const body = await readBody(c.req.raw)
  const email = typeof body?.email === 'string' ? body.email : ''
  const code = typeof body?.code === 'string' ? body.code : ''
  if (!body || !email || !code) {
    return c.json({ error: { message: 'Expected JSON body { email, code }', type: 'invalid_request_error' } }, 400)
  }

  const out = await verifySignup(email, code, clientIp(c.req.header('x-forwarded-for')))
  if (!out.ok) {
    if (out.status === 429) {
      c.header('Retry-After', '60')
      return c.json({ error: { message: 'Too many attempts', type: 'rate_limit_error' } }, 429)
    }
    if (out.status === 503) {
      return c.json({ error: { message: 'Signup temporarily unavailable', type: 'service_unavailable' } }, 503)
    }
    // 400 générique unique : ne distingue jamais code faux / expiré / inconnu / épuisé.
    return c.json({ error: { message: 'Invalid or expired verification code', type: 'invalid_request_error' } }, 400)
  }

  // Le secret n'est montré QU'ICI (même contrat que POST /admin/keys).
  return c.json(
    {
      key: out.key,
      project: out.project,
      capUsdPerDay: out.capUsdPerDay,
      message: 'Store this key now: it will never be shown again. Raise limits later via your provider contact.',
    },
    201,
  )
})
