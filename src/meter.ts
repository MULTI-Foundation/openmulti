// Metering durable par clé (incrément B de docs/PRODUCT-V1.md) — le socle de
// facturation. Distinct de metrics.ts (Prometheus, in-memory, monitoring) : ici on
// écrit dans Redis/Valkey des compteurs qui SURVIVENT aux restarts, par
// clé × jour (UTC) × modèle × chemin d'accès.
//
// Schéma : un hash par `meter:{keyLabel}:{YYYY-MM-DD}`, champs
// `{model}|{provider}|{metric}` (le « | » ne peut apparaître ni dans un id de modèle
// ni dans un nom de chemin). Lecture sans SCAN : les clés se reconstruisent par
// arithmétique de dates. TTL ~400 jours (couvre un exercice de facturation).
//
// Règles :
//   - OPT-IN : sans REDIS_URL, tout est no-op (dev local, tests, comportement actuel).
//   - JAMAIS sur le chemin de la réponse : écrit en fire-and-forget ; une panne Redis
//     ne casse aucun appel — les écritures perdues sont comptées dans
//     openmulti_meter_dropped_total (et un log au changement d'état, pas par requête).

import { createClient } from 'redis'
import { config } from './config.js'
import { log } from './log.js'
import { recordMeterDrop } from './metrics.js'
import type { RequestRecord } from './metrics.js'

/** Le sous-ensemble du client redis utilisé — injectable pour les tests. */
export interface MeterClient {
  hIncrBy(key: string, field: string, n: number): Promise<unknown>
  hIncrByFloat(key: string, field: string, n: number): Promise<unknown>
  expire(key: string, seconds: number, mode?: 'NX'): Promise<unknown>
  hGetAll(key: string): Promise<Record<string, string>>
}

const TTL_SECONDS = 400 * 24 * 3600 // ~13 mois : couvre le mois facturé + litiges

let client: MeterClient | null = null
let healthy = false

/** Câblage production : appelé au boot (index.ts). No-op sans REDIS_URL. */
export function initMeter(): void {
  if (!config.redisUrl) return
  const c = createClient({ url: config.redisUrl })
  c.on('error', (e: Error) => {
    if (healthy) log.warn('meter_redis_down', { error: e.message })
    healthy = false
  })
  c.on('ready', () => {
    if (!healthy) log.info('meter_redis_ready', {})
    healthy = true
  })
  // connect() rejette si le premier essai échoue, mais le client retente ensuite
  // tout seul (reconnect strategy par défaut) — on ne bloque jamais le boot.
  c.connect().catch((e: Error) => log.warn('meter_redis_connect_failed', { error: e.message }))
  client = c as unknown as MeterClient
}

/** Injection pour les tests (et _resetMeter pour l'isolation entre cas). */
export function _setMeterClientForTests(c: MeterClient | null, ready = true): void {
  client = c
  healthy = c !== null && ready
}

export function meterDay(now = new Date()): string {
  return now.toISOString().slice(0, 10) // jour UTC — la facturation est en UTC
}

const meterKey = (keyLabel: string, day: string) => `meter:${keyLabel}:${day}`

/** Écriture durable d'une requête servie. Fire-and-forget : ne bloque ni n'échoue
 * jamais le chemin de la réponse. */
export function meterUsage(r: RequestRecord): void {
  if (!client) return
  if (!healthy) {
    recordMeterDrop()
    return
  }
  const c = client
  const key = meterKey(r.key, meterDay())
  const f = (metric: string) => `${r.model}|${r.provider ?? 'openrouter'}|${metric}`
  const writes: Promise<unknown>[] = [c.hIncrBy(key, f('requests'), 1)]
  if (r.error) writes.push(c.hIncrBy(key, f('errors'), 1))
  if (r.promptTokens) writes.push(c.hIncrBy(key, f('prompt_tokens'), r.promptTokens))
  if (r.completionTokens) writes.push(c.hIncrBy(key, f('completion_tokens'), r.completionTokens))
  if (r.costUsd) writes.push(c.hIncrByFloat(key, f('cost_usd'), r.costUsd))
  writes.push(c.expire(key, TTL_SECONDS, 'NX'))
  void Promise.all(writes).catch((e: Error) => {
    recordMeterDrop()
    if (healthy) log.warn('meter_write_failed', { error: e.message })
  })
}

export interface UsageBreakdown {
  requests: number
  errors: number
  promptTokens: number
  completionTokens: number
  costUsd: number
}

export interface UsageReport {
  key: string
  from: string
  to: string
  totals: UsageBreakdown
  /** Par `${model}|${provider}` agrégé sur la période. */
  byModel: Record<string, UsageBreakdown>
  /** Par jour (UTC), totaux toutes séries confondues. */
  byDay: Record<string, UsageBreakdown>
}

const zero = (): UsageBreakdown => ({ requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 })

const FIELD_TO_PROP: Record<string, keyof UsageBreakdown> = {
  requests: 'requests',
  errors: 'errors',
  prompt_tokens: 'promptTokens',
  completion_tokens: 'completionTokens',
  cost_usd: 'costUsd',
}

/** Lecture agrégée sur les `days` derniers jours (inclus aujourd'hui, UTC). Les clés
 * se reconstruisent par dates — pas de SCAN. */
export async function readUsage(keyLabel: string, days: number, now = new Date()): Promise<UsageReport | null> {
  if (!client) return null
  const report: UsageReport = { key: keyLabel, from: '', to: meterDay(now), totals: zero(), byModel: {}, byDay: {} }
  for (let i = days - 1; i >= 0; i--) {
    const day = meterDay(new Date(now.getTime() - i * 24 * 3600 * 1000))
    if (!report.from) report.from = day
    const hash = await client.hGetAll(meterKey(keyLabel, day))
    for (const [field, raw] of Object.entries(hash)) {
      const sep = field.lastIndexOf('|')
      const series = field.slice(0, sep) // `${model}|${provider}`
      const prop = FIELD_TO_PROP[field.slice(sep + 1)]
      if (!prop) continue
      const v = Number(raw)
      if (!Number.isFinite(v)) continue
      report.totals[prop] += v
      ;(report.byModel[series] ??= zero())[prop] += v
      ;(report.byDay[day] ??= zero())[prop] += v
    }
  }
  return report
}
