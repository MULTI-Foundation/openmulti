// Le store partagé Redis/Valkey (un seul client pour meter.ts et keys.ts). Opt-in par
// REDIS_URL : vide = pas de client, les modules consommateurs no-opent. La connexion
// ne bloque jamais le boot, le client retente seul, et l'état de santé est exposé pour
// que les écritures fire-and-forget sachent compter leurs pertes.

import { createClient } from 'redis'
import { config } from './config.js'
import { log } from './log.js'

/** Le sous-ensemble du client redis utilisé — injectable pour les tests. */
export interface StoreClient {
  hIncrBy(key: string, field: string, n: number): Promise<unknown>
  hIncrByFloat(key: string, field: string, n: number): Promise<unknown>
  expire(key: string, seconds: number, mode?: 'NX'): Promise<unknown>
  hGetAll(key: string): Promise<Record<string, string>>
  hSet(key: string, field: string, value: string): Promise<unknown>
  hDel(key: string, field: string): Promise<unknown>
}

let client: StoreClient | null = null
let healthy = false

export function storeClient(): StoreClient | null {
  return client
}

export function storeHealthy(): boolean {
  return healthy
}

/** Câblage production : appelé au boot (index.ts). No-op sans REDIS_URL. */
export function initStore(): void {
  if (!config.redisUrl) return
  const c = createClient({ url: config.redisUrl })
  c.on('error', (e: Error) => {
    if (healthy) log.warn('store_redis_down', { error: e.message })
    healthy = false
  })
  c.on('ready', () => {
    if (!healthy) log.info('meter_redis_ready', {}) // nom historique, des alertes peuvent pointer dessus
    healthy = true
  })
  c.connect().catch((e: Error) => log.warn('meter_redis_connect_failed', { error: e.message }))
  client = c as unknown as StoreClient
}

/** Injection pour les tests. */
export function _setStoreClientForTests(c: StoreClient | null, ready = true): void {
  client = c
  healthy = c !== null && ready
}
