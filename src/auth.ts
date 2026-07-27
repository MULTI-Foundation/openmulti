// v0 auth: static Bearer key allowlist. Each consuming project gets its own sk_ key.
// OpenMulti knows nothing about the caller's own tenants/billing; the key only
// identifies which project is calling (for future per-key metering).

import type { MiddlewareHandler } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { config } from './config.js'
import { registryApiKeys } from './keys.js'
import type { AppEnv } from './types.js'

/** Constant-time string compare (avoids leaking a token via response timing). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
  // B4 : une requête déjà authentifiée EN AMONT (gate x402 : paiement encaissé, projet
  // wallet posé dans le contexte) ne repasse pas par la clé. Seule la gate écrit cette
  // valeur avant auth ; sans x402 activé, ce chemin est mort.
  if (c.get('apiKey')) return next()

  const header = c.req.header('authorization')
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: { message: 'Missing authorization', type: 'auth_error' } }, 401)
  }
  const key = header.slice(7)

  // Allowlist = clés env (OPENMULTI_API_KEYS) ∪ registre dynamique (keys.ts, cache
  // mémoire — les clés révoquées en sortent au refresh). Vide = open (dev only).
  // OM-04: constant-time compare, and don't short-circuit on the matching key, so
  // neither the key content nor which key matched leaks through response timing.
  const allowlist = [...config.apiKeys, ...registryApiKeys()]
  if (allowlist.length > 0) {
    let ok = false
    for (const allowed of allowlist) if (safeEqual(key, allowed)) ok = true
    if (!ok) return c.json({ error: { message: 'Invalid API key', type: 'auth_error' } }, 401)
  }

  c.set('apiKey', key)
  await next()
}

// OM-03 / F1-F3-F7: guard for GET /metrics. With OPENMULTI_METRICS_TOKEN set, /metrics
// requires exactly that token (constant-time) — caller keys are rejected, so a consuming
// project can no longer read every project's cost/usage.
//
// Sans token : FAIL-CLOSED dès qu'une allowlist existe (env OU registre dynamique). Une
// clé appelante ne doit jamais lire /metrics — l'exposition est per-projet (coût, tokens,
// facturé), donc en multi-tenant (signup ag-*, plusieurs consommateurs) c'est une fuite
// cross-tenant. Le repli sur l'auth appelante ne subsiste QUE dans le mode open (aucune
// clé configurée nulle part = dev local), où il n'y a de toute façon pas de tenants à
// isoler. En prod, le token ops dédié est requis (runbook openmulti-ops).
export const metricsAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!config.metricsToken) {
    const hasAllowlist = config.apiKeys.length > 0 || registryApiKeys().length > 0
    if (!hasAllowlist) return auth(c, next) // dev open : pas de tenants, pas de fuite
    return c.json({ error: { message: 'Metrics endpoint disabled (set OPENMULTI_METRICS_TOKEN)', type: 'metrics_disabled' } }, 503)
  }

  const header = c.req.header('authorization')
  const token = header?.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token || !safeEqual(token, config.metricsToken)) {
    return c.json({ error: { message: 'Invalid metrics token', type: 'auth_error' } }, 401)
  }
  await next()
}

// Garde des routes /admin/* (metering, et bientôt cycle de vie des clés) : token ops
// STRICTEMENT requis — pas de fallback sur les clés appelantes (un projet ne doit
// jamais lire l'usage des autres). Sans token configuré, l'admin est simplement
// désactivée (503) : opt-in, zéro régression.
export const adminAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  // audit #4 : le token admin est DISTINCT du token /metrics. OPENMULTI_ADMIN_TOKEN si
  // posé, sinon repli sur OPENMULTI_METRICS_TOKEN (rétro-compat). Ainsi un lecteur de
  // /metrics ne peut plus écrire (créer des clés, marges, crédits).
  const validToken = config.adminToken || config.metricsToken
  if (!validToken) {
    return c.json({ error: { message: 'Admin API disabled (set OPENMULTI_ADMIN_TOKEN)', type: 'admin_disabled' } }, 503)
  }
  const header = c.req.header('authorization')
  const token = header?.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token || !safeEqual(token, validToken)) {
    return c.json({ error: { message: 'Invalid admin token', type: 'auth_error' } }, 401)
  }
  await next()
}
