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

import { storeClient, storeHealthy, _setStoreClientForTests, type StoreClient } from './store.js'
import { log } from './log.js'
import { recordMeterDrop } from './metrics.js'
import { usdToMicro, microToUsd } from './micro-usd.js'
import type { RequestRecord } from './metrics.js'

/** @deprecated alias historique — le client vit dans store.ts désormais. */
export type MeterClient = StoreClient

const TTL_SECONDS = 400 * 24 * 3600 // ~13 mois : couvre le mois facturé + litiges

/** Injection pour les tests (délègue au store partagé). */
export const _setMeterClientForTests = _setStoreClientForTests

export function meterDay(now = new Date()): string {
  return now.toISOString().slice(0, 10) // jour UTC — la facturation est en UTC
}

const meterKey = (keyLabel: string, day: string) => `meter:${keyLabel}:${day}`

/** Écriture durable d'une requête servie. Fire-and-forget : ne bloque ni n'échoue
 * jamais le chemin de la réponse. */
export function meterUsage(r: RequestRecord): void {
  const c = storeClient()
  if (!c) return
  if (!storeHealthy()) {
    recordMeterDrop()
    return
  }
  const key = meterKey(r.key, meterDay())
  const f = (metric: string) => `${r.model}|${r.provider ?? 'openrouter'}|${metric}`
  const writes: Promise<unknown>[] = [c.hIncrBy(key, f('requests'), 1)]
  if (r.error) writes.push(c.hIncrBy(key, f('errors'), 1))
  if (r.promptTokens) writes.push(c.hIncrBy(key, f('prompt_tokens'), r.promptTokens))
  if (r.completionTokens) writes.push(c.hIncrBy(key, f('completion_tokens'), r.completionTokens))
  // E-4 : les montants s'écrivent en micro-USD ENTIERS (HINCRBY, jamais HINCRBYFLOAT
  // qui dérive). Les champs legacy *_usd / spent:usd ne sont plus incrémentés mais
  // restent lus (readUsage, refreshKeys) : les données pré-migration comptent toujours.
  // P0-6 : != null, pas truthiness — un appel à coût 0 écrit ses champs à 0 (mesuré,
  // distinguable d'un appel non mesuré où les champs sont absents du hash).
  if (r.costUsd != null) writes.push(c.hIncrBy(key, f('cost_microusd'), usdToMicro(r.costUsd)))
  if (r.billedUsd != null) {
    const billedMicro = usdToMicro(r.billedUsd)
    writes.push(c.hIncrBy(key, f('billed_microusd'), billedMicro))
    // Cumul a vie du facture par projet : la base du solde prepaye
    // (balance = credits - spent, cf keys.ts). Pas de TTL : c'est du ledger.
    writes.push(c.hIncrBy('spent:microusd', r.key, billedMicro))
  }
  // Registre des projets connus (pour GET /admin/usage multi-projets). Idempotent.
  writes.push(c.hSet('projects:known', r.key, '1'))
  writes.push(c.expire(key, TTL_SECONDS, 'NX'))
  void Promise.all(writes).catch((e: Error) => {
    recordMeterDrop()
    if (storeHealthy()) log.warn('meter_write_failed', { error: e.message })
  })
}

export interface UsageBreakdown {
  requests: number
  errors: number
  promptTokens: number
  completionTokens: number
  costUsd: number
  /** Montant facturé (coût x marge) — la base du ledger de la console. */
  billedUsd: number
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

const zero = (): UsageBreakdown => ({ requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, billedUsd: 0 })

const FIELD_TO_PROP: Record<string, keyof UsageBreakdown> = {
  requests: 'requests',
  errors: 'errors',
  prompt_tokens: 'promptTokens',
  completion_tokens: 'completionTokens',
  // Legacy pré-E-4 : champs flottants, plus écrits mais toujours lus.
  cost_usd: 'costUsd',
  billed_usd: 'billedUsd',
}

// Champs micro-USD entiers (E-4) : convertis en USD à la lecture (frontière de sortie).
const MICRO_FIELD_TO_PROP: Record<string, keyof UsageBreakdown> = {
  cost_microusd: 'costUsd',
  billed_microusd: 'billedUsd',
}

/** Lecture agrégée sur les `days` derniers jours (inclus aujourd'hui, UTC). Les clés
 * se reconstruisent par dates — pas de SCAN. */
export async function readUsage(keyLabel: string, days: number, now = new Date()): Promise<UsageReport | null> {
  const c = storeClient()
  if (!c) return null
  const report: UsageReport = { key: keyLabel, from: '', to: meterDay(now), totals: zero(), byModel: {}, byDay: {} }
  for (let i = days - 1; i >= 0; i--) {
    const day = meterDay(new Date(now.getTime() - i * 24 * 3600 * 1000))
    if (!report.from) report.from = day
    const hash = await c.hGetAll(meterKey(keyLabel, day))
    for (const [field, raw] of Object.entries(hash)) {
      const sep = field.lastIndexOf('|')
      const series = field.slice(0, sep) // `${model}|${provider}`
      const metric = field.slice(sep + 1)
      const micro = MICRO_FIELD_TO_PROP[metric]
      const prop = micro ?? FIELD_TO_PROP[metric]
      if (!prop) continue
      let v = Number(raw)
      if (!Number.isFinite(v)) continue
      if (micro) v = microToUsd(v) // frontière de sortie : µ$ entiers -> USD
      report.totals[prop] += v
      ;(report.byModel[series] ??= zero())[prop] += v
      ;(report.byDay[day] ??= zero())[prop] += v
    }
  }
  return report
}

/** Usage agrégé de TOUS les projets connus sur `days` jours (le batch de sync de la
 * console). Itère projects:known × jours — pas de SCAN, cardinalité bornée. */
export async function readAllUsage(days: number, now = new Date()): Promise<Record<string, UsageReport> | null> {
  const c = storeClient()
  if (!c) return null
  const known = Object.keys(await c.hGetAll('projects:known'))
  const out: Record<string, UsageReport> = {}
  for (const project of known) {
    const report = await readUsage(project, days, now)
    if (report) out[project] = report
  }
  return out
}
