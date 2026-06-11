// OM-01: per-key request rate limit, fixed 60s window. Disabled unless
// OPENMULTI_RATE_LIMIT_PER_MIN is set, so the default path is unchanged.
//
// Incrément F (docs/PRODUCT-V1.md) : quand le store partagé est là (REDIS_URL), le
// compteur vit dans Valkey (`rl:{projet}:{fenêtre}`, INCR + TTL) — la limite vaut
// pour l'ENSEMBLE des replicas. Sans store, ou store en panne : repli sur le
// compteur mémoire historique (per pod) — une panne Redis ne durcit ni ne coupe
// jamais le trafic, elle relâche au pire vers le comportement d'avant.
//
// Keyed by project label (keyLabel), not the raw secret, so neither map nor store
// ever holds keys.

import type { MiddlewareHandler } from 'hono'
import { config } from './config.js'
import { keyLabel } from './metrics.js'
import { storeClient, storeHealthy } from './store.js'
import { log } from './log.js'
import type { AppEnv } from './types.js'

const WINDOW_MS = 60_000

/** Identifiant de la fenêtre courante (minute epoch) — pure, testable. */
export function windowId(nowMs: number): number {
  return Math.floor(nowMs / WINDOW_MS)
}

/** Secondes jusqu'à la fin de la fenêtre courante — pure, testable. */
export function windowRetryAfter(nowMs: number): number {
  return Math.max(1, Math.ceil(((windowId(nowMs) + 1) * WINDOW_MS - nowMs) / 1000))
}

interface Window {
  start: number
  count: number
}

const windows = new Map<string, Window>()
let sharedBroken = false // pour ne logger le repli mémoire qu'au changement d'état

function localCount(key: string, now: number): number {
  let w = windows.get(key)
  if (!w || now - w.start >= WINDOW_MS) {
    w = { start: now, count: 0 }
    windows.set(key, w)
  }
  w.count += 1
  return w.count
}

export const rateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const limit = config.rateLimitPerMin
  if (limit <= 0) return next() // disabled: no-op

  const key = keyLabel(c.get('apiKey'))
  const now = Date.now()

  let count: number
  const store = storeClient()
  if (store && storeHealthy()) {
    try {
      const id = `rl:${key}:${windowId(now)}`
      count = await store.incr(id)
      // TTL posé à la création de la fenêtre (2 min : couvre la fenêtre + l'horloge).
      if (count === 1) void store.expire(id, 120).catch(() => {})
      if (sharedBroken) {
        sharedBroken = false
        log.info('ratelimit_shared_restored', {})
      }
    } catch (e) {
      if (!sharedBroken) {
        sharedBroken = true
        log.warn('ratelimit_shared_fallback_memory', { error: e instanceof Error ? e.message : String(e) })
      }
      count = localCount(key, now)
    }
  } else {
    count = localCount(key, now)
  }

  if (count > limit) {
    c.header('Retry-After', String(windowRetryAfter(now)))
    return c.json({ error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } }, 429)
  }
  return next()
}

/** Test helper: clear all windows between cases. */
export function _resetRateLimit(): void {
  windows.clear()
  sharedBroken = false
}
