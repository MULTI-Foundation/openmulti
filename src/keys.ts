// Cycle de vie des clés + plafonds de dépense (incrément C, docs/PRODUCT-V1.md).
//
// Registre dans le store partagé (Redis/Valkey) :
//   - hash `keys:registry`  : field = la clé `sk_<projet>_<secret>`, value = JSON
//     { id, project, createdAt, disabled? }. L'id (sha256 tronqué) sert à lister/
//     révoquer sans jamais ré-exposer le secret.
//   - hash `caps:usd_per_day` : field = projet, value = plafond USD/jour.
//
// Le PLAFOND EST PAR PROJET — l'unité de facturation (le metering agrège déjà par
// projet via keyLabel) ; toutes les clés d'un projet partagent son plafond.
//
// Chemin chaud sans Redis : l'auth lit un CACHE en mémoire (rafraîchi toutes les
// REFRESH_MS, et immédiatement après une mutation admin locale) ; la vérification de
// plafond lit un cache de dépense du jour (rafraîchi pareil) + les coûts observés
// localement depuis le dernier refresh. Multi-pod : propagation ≤ REFRESH_MS.
// Redis down = FAIL-OPEN sur le dernier état connu — une panne du store ne coupe
// jamais le trafic (cohérent avec meter.ts).

import { createHash, randomBytes } from 'node:crypto'
import { storeClient, storeHealthy } from './store.js'
import { config } from './config.js'
import { meterDay } from './meter.js'
import { log } from './log.js'

const REGISTRY = 'keys:registry'
const CAPS = 'caps:usd_per_day'
const MARGINS = 'margins:pct'
const CREDITS = 'credits:usd' // total achete (cumulatif), pousse par la console
const CREDIT_REFS = 'credits:refs' // idempotence des top-ups (field: projet|ref)
const SPENT = 'spent:usd' // cumul facture, incremente par meter.ts
const REFRESH_MS = Math.max(1000, Number(process.env.OPENMULTI_KEYS_REFRESH_MS ?? 10_000))

export interface KeyRecord {
  id: string
  project: string
  createdAt: string
  name?: string
  disabled?: boolean
}

// ── Caches mémoire (le chemin chaud ne touche jamais Redis) ────────────────────
let registryKeys: string[] = [] // les clés actives (secrets), pour l'auth
let registryRecords: (KeyRecord & { key: string })[] = []
let caps = new Map<string, number>() // projet -> USD/jour (en dollars FACTURÉS)
let margins = new Map<string, number>() // projet -> marge % (surcharge du défaut config)
let credits = new Map<string, number>() // projet -> total crédité (prépayé)
let spentTotal = new Map<string, number>() // projet -> cumul facturé (depuis le store)
let localBilled = new Map<string, number>() // facturé localement depuis le dernier refresh
let spendToday = new Map<string, number>() // projet -> USD facturés observés (refresh + local)
let spendDay = '' // jour UTC du cache de dépense (reset au changement de jour)
let timer: ReturnType<typeof setInterval> | null = null

export const keyId = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 12)

/** Clés actives du registre (cache mémoire) — consommé par auth.ts en plus de l'env. */
export function registryApiKeys(): string[] {
  return registryKeys
}

export async function refreshKeys(): Promise<void> {
  const c = storeClient()
  if (!c || !storeHealthy()) return // fail-open : on garde le dernier état connu
  try {
    const [reg, capHash, marginHash, creditHash, spentHash] = await Promise.all([
      c.hGetAll(REGISTRY), c.hGetAll(CAPS), c.hGetAll(MARGINS), c.hGetAll(CREDITS), c.hGetAll(SPENT),
    ])
    credits = new Map(Object.entries(creditHash).map(([p, v]) => [p, Number(v) || 0]))
    spentTotal = new Map(Object.entries(spentHash).map(([p, v]) => [p, Number(v) || 0]))
    localBilled = new Map() // le store vient d'etre relu : l'accumulateur local repart
    margins = new Map(
      Object.entries(marginHash).map(([p, v]) => [p, Number(v)]).filter(([, v]) => Number.isFinite(v) && (v as number) >= 0) as [string, number][],
    )
    const records: (KeyRecord & { key: string })[] = []
    for (const [key, raw] of Object.entries(reg)) {
      try {
        records.push({ key, ...(JSON.parse(raw) as KeyRecord) })
      } catch {
        log.warn('keys_registry_bad_record', { id: keyId(key) })
      }
    }
    registryRecords = records
    registryKeys = records.filter((r) => !r.disabled).map((r) => r.key)
    caps = new Map(Object.entries(capHash).map(([p, v]) => [p, Number(v)]).filter(([, v]) => Number.isFinite(v) && (v as number) > 0) as [string, number][])

    // Dépense FACTURÉE du jour, uniquement pour les projets plafonnés (un HGETALL par
    // projet, hash minuscule). billed_usd (coût × marge) ; repli sur cost_usd pour les
    // séries écrites avant l'arrivée de la marge. Reset si le jour UTC a tourné.
    const day = meterDay()
    const spend = new Map<string, number>()
    for (const project of caps.keys()) {
      const hash = await c.hGetAll(`meter:${project}:${day}`)
      let billed = 0
      let rawCost = 0
      let hasBilled = false
      for (const [field, raw] of Object.entries(hash)) {
        if (field.endsWith('|billed_usd')) {
          billed += Number(raw) || 0
          hasBilled = true
        } else if (field.endsWith('|cost_usd')) {
          rawCost += Number(raw) || 0
        }
      }
      spend.set(project, hasBilled ? billed : rawCost)
    }
    spendToday = spend
    spendDay = day
  } catch (e) {
    log.warn('keys_refresh_failed', { error: e instanceof Error ? e.message : String(e) })
  }
}

/** Boot : premier refresh + rafraîchissement périodique (unref : ne retient pas le process). */
export function initKeys(): void {
  void refreshKeys()
  timer = setInterval(() => void refreshKeys(), REFRESH_MS)
  timer.unref()
}

// ── Plafond de dépense ─────────────────────────────────────────────────────────

/** Coût observé localement (appelé par routes/chat.ts à chaque réponse) : comble le
 * trou entre deux refreshs pour que le plafond morde sans attendre le prochain sync. */
export function noteLocalSpend(project: string, billedUsd: number): void {
  if (!billedUsd) return
  // solde prepaye : on decompte localement entre deux refreshs
  if (credits.has(project)) localBilled.set(project, (localBilled.get(project) ?? 0) + billedUsd)
  if (!caps.has(project)) return
  const day = meterDay()
  if (day !== spendDay) {
    spendToday = new Map()
    spendDay = day
  }
  spendToday.set(project, (spendToday.get(project) ?? 0) + billedUsd)
}

export interface CapVerdict {
  blocked: boolean
  capUsd?: number
  spentUsd?: number
}

/** Vérifie le plafond du PROJET (jour UTC courant). Sans plafond, sans store ou sans
 * donnée : fail-open. Purement mémoire — jamais d'I/O sur le chemin de la requête. */
export function checkSpendCap(project: string): CapVerdict {
  const cap = caps.get(project)
  if (!cap) return { blocked: false }
  if (meterDay() !== spendDay) return { blocked: false, capUsd: cap, spentUsd: 0 } // jour neuf, refresh pas encore passé
  const spent = spendToday.get(project) ?? 0
  return { blocked: spent >= cap, capUsd: cap, spentUsd: spent }
}

// ── Solde prépayé (la console pousse les top-ups, le gateway décompte) ─────────

export interface BalanceVerdict {
  blocked: boolean
  balanceUsd?: number
}

/** Solde du projet = crédits − cumul facturé (store) − facturé local depuis le
 * dernier refresh. Projets SANS crédits posés : pas de notion de solde → fail-open
 * (MyMULTI, dev). Purement mémoire — zéro I/O sur le chemin de la requête. */
export function checkBalance(project: string): BalanceVerdict {
  const total = credits.get(project)
  if (total === undefined) return { blocked: false }
  const balance = total - (spentTotal.get(project) ?? 0) - (localBilled.get(project) ?? 0)
  return { blocked: balance <= 0, balanceUsd: balance }
}

// audit 2026-07-02 : dédup ET crédit dans UN script Lua — un crash entre les deux
// commandes ne peut plus marquer la ref appliquée sans avoir crédité (crédit perdu).
// HSETNX (vs HSET) : une redelivery avec un montant différent ne réécrit pas le
// montant enregistré de la ref. Retourne nil si duplicate, sinon le nouveau total.
const ADD_CREDITS_LUA = `
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 0 then
  return nil
end
return redis.call('HINCRBYFLOAT', KEYS[2], ARGV[3], ARGV[2])
`.trim()

/** Top-up idempotent (ref = id d'événement Stripe côté console). Retourne le nouveau
 * total crédité, ou null si store coupé / entrée invalide ; 'duplicate' si la ref a
 * déjà été appliquée (la console peut re-livrer un webhook sans double-créditer). */
export async function addCredits(project: string, usd: number, ref: string): Promise<number | null | 'duplicate'> {
  if (!PROJECT_RE.test(project) || !Number.isFinite(usd) || usd <= 0 || !ref || ref.length > 128) return null
  const c = storeClient()
  if (!c) return null
  const refField = `${project}|${ref}`
  if (c.eval) {
    const total = await c.eval(ADD_CREDITS_LUA, { keys: [CREDIT_REFS, CREDITS], arguments: [refField, String(usd), project] })
    if (total === null) return 'duplicate'
  } else {
    // Repli deux temps (client sans eval) — audit #8 : dédup atomique via le retour de
    // HSET (1 = champ nouveau). Fenêtre de crash résiduelle entre les deux commandes,
    // fermée par le chemin Lua ci-dessus en production.
    const fresh = (await c.hSet(CREDIT_REFS, refField, String(usd))) as number
    if (fresh === 0) return 'duplicate'
    await c.hIncrByFloat(CREDITS, project, usd)
  }
  await refreshKeys()
  return credits.get(project) ?? usd
}

export function balanceReport(): Record<string, { creditsUsd: number; spentUsd: number; balanceUsd: number }> {
  const out: Record<string, { creditsUsd: number; spentUsd: number; balanceUsd: number }> = {}
  for (const [project, total] of credits) {
    const spent = (spentTotal.get(project) ?? 0) + (localBilled.get(project) ?? 0)
    out[project] = { creditsUsd: total, spentUsd: spent, balanceUsd: total - spent }
  }
  return out
}

/** Secondes jusqu'à minuit UTC — le Retry-After d'un plafond journalier atteint. */
export function secondsToUtcMidnight(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000))
}

// ── Mutations admin (routes/admin.ts) ──────────────────────────────────────────

const PROJECT_RE = /^[a-z0-9-]{1,32}$/

export interface CreatedKey {
  key: string // le secret — retourné UNE SEULE FOIS, à la création
  id: string
  project: string
}

export async function createKey(project: string, capUsdPerDay?: number, name?: string): Promise<CreatedKey | { error: string }> {
  if (!PROJECT_RE.test(project)) return { error: 'invalid project (expected /^[a-z0-9-]{1,32}$/)' }
  if (name !== undefined && (typeof name !== 'string' || name.length > 64)) return { error: 'invalid name (max 64 chars)' }
  const c = storeClient()
  if (!c) return { error: 'key registry disabled (set REDIS_URL)' }
  const key = `sk_${project}_${randomBytes(24).toString('hex')}`
  const record: KeyRecord = { id: keyId(key), project, createdAt: new Date().toISOString(), ...(name ? { name } : {}) }
  await c.hSet(REGISTRY, key, JSON.stringify(record))
  if (capUsdPerDay && capUsdPerDay > 0) await c.hSet(CAPS, project, String(capUsdPerDay))
  await refreshKeys() // visible immédiatement sur CE pod ; les autres ≤ REFRESH_MS
  return { key, id: record.id, project }
}

export async function revokeKey(id: string): Promise<boolean> {
  const c = storeClient()
  if (!c) return false
  const target = registryRecords.find((r) => r.id === id)
  if (!target) return false
  await c.hDel(REGISTRY, target.key)
  await refreshKeys()
  return true
}

// ── Marge sur les tokens (modèle de revenus) ───────────────────────────────────

/** Marge applicable au projet, en % : surcharge par projet sinon défaut global
 * (OPENMULTI_MARGIN_PCT). Le client paie coût × (1 + pct/100). */
export function marginFor(project: string): number {
  return margins.get(project) ?? config.marginPct
}

export async function setMargin(project: string, pct: number | null): Promise<boolean> {
  if (!PROJECT_RE.test(project)) return false
  const c = storeClient()
  if (!c) return false
  if (pct === null) {
    await c.hDel(MARGINS, project) // retour au défaut global
  } else {
    if (!Number.isFinite(pct) || pct < 0 || pct > 500) return false
    await c.hSet(MARGINS, project, String(pct))
  }
  await refreshKeys()
  return true
}

export function listMargins(): { defaultPct: number; overrides: Record<string, number> } {
  return { defaultPct: config.marginPct, overrides: Object.fromEntries(margins) }
}

/** Plafonds journaliers par projet (USD facturés). Pour l'admin (GET /admin/caps). */
export function listCaps(): Record<string, number> {
  return Object.fromEntries(caps)
}

export async function setCap(project: string, usdPerDay: number): Promise<boolean> {
  if (!PROJECT_RE.test(project) || !Number.isFinite(usdPerDay) || usdPerDay < 0) return false
  const c = storeClient()
  if (!c) return false
  if (usdPerDay === 0) await c.hDel(CAPS, project)
  else await c.hSet(CAPS, project, String(usdPerDay))
  await refreshKeys()
  return true
}

/** Liste RÉDIGÉE : jamais le secret, seulement id/projet/dates/état + plafond. */
export function listKeys(): (KeyRecord & { capUsdPerDay?: number })[] {
  return registryRecords.map(({ key: _secret, ...r }) => ({
    ...r,
    ...(caps.has(r.project) ? { capUsdPerDay: caps.get(r.project) } : {}),
  }))
}

/** Test helper : vide les caches mémoire. */
export function _resetKeysForTests(): void {
  registryKeys = []
  registryRecords = []
  caps = new Map()
  margins = new Map()
  credits = new Map()
  spentTotal = new Map()
  localBilled = new Map()
  spendToday = new Map()
  spendDay = ''
  if (timer) clearInterval(timer)
  timer = null
}
