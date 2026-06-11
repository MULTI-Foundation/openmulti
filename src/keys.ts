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
import { meterDay } from './meter.js'
import { log } from './log.js'

const REGISTRY = 'keys:registry'
const CAPS = 'caps:usd_per_day'
const REFRESH_MS = Math.max(1000, Number(process.env.OPENMULTI_KEYS_REFRESH_MS ?? 10_000))

export interface KeyRecord {
  id: string
  project: string
  createdAt: string
  disabled?: boolean
}

// ── Caches mémoire (le chemin chaud ne touche jamais Redis) ────────────────────
let registryKeys: string[] = [] // les clés actives (secrets), pour l'auth
let registryRecords: (KeyRecord & { key: string })[] = []
let caps = new Map<string, number>() // projet -> USD/jour
let spendToday = new Map<string, number>() // projet -> USD observés (refresh + local)
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
    const [reg, capHash] = await Promise.all([c.hGetAll(REGISTRY), c.hGetAll(CAPS)])
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

    // Dépense du jour, uniquement pour les projets plafonnés (un HGETALL par projet,
    // hash minuscule). Reset si le jour UTC a tourné.
    const day = meterDay()
    const spend = new Map<string, number>()
    for (const project of caps.keys()) {
      const hash = await c.hGetAll(`meter:${project}:${day}`)
      let usd = 0
      for (const [field, raw] of Object.entries(hash)) {
        if (field.endsWith('|cost_usd')) usd += Number(raw) || 0
      }
      spend.set(project, usd)
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
export function noteLocalSpend(project: string, costUsd: number): void {
  if (!costUsd || !caps.has(project)) return
  const day = meterDay()
  if (day !== spendDay) {
    spendToday = new Map()
    spendDay = day
  }
  spendToday.set(project, (spendToday.get(project) ?? 0) + costUsd)
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

export async function createKey(project: string, capUsdPerDay?: number): Promise<CreatedKey | { error: string }> {
  if (!PROJECT_RE.test(project)) return { error: 'invalid project (expected /^[a-z0-9-]{1,32}$/)' }
  const c = storeClient()
  if (!c) return { error: 'key registry disabled (set REDIS_URL)' }
  const key = `sk_${project}_${randomBytes(24).toString('hex')}`
  const record: KeyRecord = { id: keyId(key), project, createdAt: new Date().toISOString() }
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
  spendToday = new Map()
  spendDay = ''
  if (timer) clearInterval(timer)
  timer = null
}
