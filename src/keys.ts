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
import { usdToMicro, microToUsd } from './micro-usd.js'
import { log } from './log.js'

const REGISTRY = 'keys:registry'
const CAPS = 'caps:usd_per_day'
const MARGINS = 'margins:pct'
// Ledgers crédits/dépense : depuis E-4, les écritures vont dans les hash *:microusd
// (entiers, HINCRBY). Les hash legacy en USD flottants ne sont plus incrémentés mais
// toujours LUS et additionnés au refresh — les soldes pré-migration restent justes.
const CREDITS = 'credits:usd' // legacy (float) : lu seulement
const CREDITS_MICRO = 'credits:microusd' // total achete (cumulatif), micro-USD entiers
const CREDIT_REFS = 'credits:refs' // idempotence des top-ups (field: projet|ref)
const SPENT = 'spent:usd' // legacy (float) : lu seulement
const SPENT_MICRO = 'spent:microusd' // cumul facture, incremente par meter.ts
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
// Comptes internes en micro-USD ENTIERS (E-4) — conversion USD aux frontières seulement.
let credits = new Map<string, number>() // projet -> total crédité (prépayé), µ$
let spentTotal = new Map<string, number>() // projet -> cumul facturé (depuis le store), µ$
let localBilled = new Map<string, number>() // facturé localement depuis le dernier refresh, µ$
let spendToday = new Map<string, number>() // projet -> µ$ facturés observés (refresh + local)
let spendDay = '' // jour UTC du cache de dépense (reset au changement de jour)
// F2/F4/F10 : réservations de dépense EN VOL — le coût MAX estimé des requêtes admises mais
// pas encore complétées. Ferme la fenêtre check-then-act : les gardes de solde/plafond les
// comptent, donc N requêtes concurrentes ne voient plus le même état pré-dépense. Node est
// mono-thread, donc « lire la garde puis réserver » est atomique tant qu'aucun await ne les
// sépare (les await de dispatch sont TOUS après la réservation). Libérées à la complétion,
// où le coût RÉEL est enregistré via noteLocalSpend. µ$ entiers, zéro I/O (même posture que
// le reste du module). Bornée aux projets métrés (plafond ou solde) — cf reserveSpend.
let pendingReserved = new Map<string, number>() // projet -> µ$ réservés en vol
let timer: ReturnType<typeof setInterval> | null = null

export const keyId = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 12)

/** Fusionne un ledger legacy (USD flottants) et son successeur micro-USD entier en une
 * vue µ$ par projet. Un projet présent dans l'UN des deux est « posé » (prépayé). */
function mergeLedgers(usdHash: Record<string, string>, microHash: Record<string, string>): Map<string, number> {
  const out = new Map<string, number>()
  for (const [p, v] of Object.entries(usdHash)) out.set(p, usdToMicro(Number(v) || 0))
  for (const [p, v] of Object.entries(microHash)) out.set(p, (out.get(p) ?? 0) + (Number(v) || 0))
  return out
}

/** Clés actives du registre (cache mémoire) — consommé par auth.ts en plus de l'env. */
export function registryApiKeys(): string[] {
  return registryKeys
}

export async function refreshKeys(): Promise<void> {
  const c = storeClient()
  if (!c || !storeHealthy()) return // fail-open : on garde le dernier état connu
  try {
    const [reg, capHash, marginHash, creditHash, creditMicroHash, spentHash, spentMicroHash] = await Promise.all([
      c.hGetAll(REGISTRY), c.hGetAll(CAPS), c.hGetAll(MARGINS),
      c.hGetAll(CREDITS), c.hGetAll(CREDITS_MICRO), c.hGetAll(SPENT), c.hGetAll(SPENT_MICRO),
    ])
    credits = mergeLedgers(creditHash, creditMicroHash)
    spentTotal = mergeLedgers(spentHash, spentMicroHash)
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
      let billed = 0 // µ$
      let rawCost = 0 // µ$
      let hasBilled = false
      for (const [field, raw] of Object.entries(hash)) {
        if (field.endsWith('|billed_microusd')) {
          billed += Number(raw) || 0
          hasBilled = true
        } else if (field.endsWith('|billed_usd')) {
          billed += usdToMicro(Number(raw) || 0)
          hasBilled = true
        } else if (field.endsWith('|cost_microusd')) {
          rawCost += Number(raw) || 0
        } else if (field.endsWith('|cost_usd')) {
          rawCost += usdToMicro(Number(raw) || 0)
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
  const billedMicro = usdToMicro(billedUsd) // conversion à la frontière, cumul entier (E-4)
  if (!billedMicro) return
  // solde prepaye : on decompte localement entre deux refreshs
  if (credits.has(project)) localBilled.set(project, (localBilled.get(project) ?? 0) + billedMicro)
  if (!caps.has(project)) return
  const day = meterDay()
  if (day !== spendDay) {
    spendToday = new Map()
    spendDay = day
  }
  spendToday.set(project, (spendToday.get(project) ?? 0) + billedMicro)
}

export interface CapVerdict {
  blocked: boolean
  capUsd?: number
  spentUsd?: number
}

/** Le projet est-il soumis à une limite (plafond journalier OU solde prépayé) ? Sinon
 * (clé de confiance : MyMULTI, dev) il n'y a ni solde ni plafond, donc rien à réserver. */
export function isMetered(project: string): boolean {
  return caps.has(project) || credits.has(project)
}

/** Réserve le coût MAX estimé (µ$ FACTURÉS) d'une requête admise, pour que les gardes de
 * solde/plafond des requêtes concurrentes le comptent (F2/F4/F10). Retourne un releaser
 * IDEMPOTENT à appeler à la complétion (une fois le coût réel enregistré). No-op pour un
 * projet non métré (rien à tenir) ou un montant nul. */
export function reserveSpend(project: string, billedUsd: number): () => void {
  if (!isMetered(project)) return () => {}
  const micro = usdToMicro(billedUsd)
  if (micro <= 0) return () => {}
  pendingReserved.set(project, (pendingReserved.get(project) ?? 0) + micro)
  let released = false
  return () => {
    if (released) return
    released = true
    const next = (pendingReserved.get(project) ?? 0) - micro
    if (next > 0) pendingReserved.set(project, next)
    else pendingReserved.delete(project)
  }
}

/** Vérifie le plafond du PROJET (jour UTC courant). Sans plafond, sans store ou sans
 * donnée : fail-open. Purement mémoire — jamais d'I/O sur le chemin de la requête. Compte
 * les réservations en vol (F2/F4/F10) : une requête concurrente déjà admise pèse sur le
 * plafond avant même d'avoir enregistré son coût réel. */
export function checkSpendCap(project: string): CapVerdict {
  const cap = caps.get(project)
  if (!cap) return { blocked: false }
  if (meterDay() !== spendDay) return { blocked: false, capUsd: cap, spentUsd: 0 } // jour neuf, refresh pas encore passé
  const spent = (spendToday.get(project) ?? 0) + (pendingReserved.get(project) ?? 0) // µ$
  return { blocked: spent >= usdToMicro(cap), capUsd: cap, spentUsd: microToUsd(spent) }
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
  // Réservations en vol comptées (F2/F4/F10) : le solde disponible pour ADMETTRE une
  // requête de plus tient compte de ce que les requêtes déjà admises peuvent dépenser au
  // pire, avant même qu'elles aient enregistré leur coût réel via noteLocalSpend.
  const balance =
    total - (spentTotal.get(project) ?? 0) - (localBilled.get(project) ?? 0) - (pendingReserved.get(project) ?? 0) // µ$ entiers
  return { blocked: balance <= 0, balanceUsd: microToUsd(balance) }
}

// audit 2026-07-02 : dédup ET crédit dans UN script Lua — un crash entre les deux
// commandes ne peut plus marquer la ref appliquée sans avoir crédité (crédit perdu).
// HSETNX (vs HSET) : une redelivery avec un montant différent ne réécrit pas le
// montant enregistré de la ref (en USD, valeur d'audit). Le crédit s'incrémente en
// micro-USD ENTIERS (HINCRBY, E-4). Retourne nil si duplicate, sinon le nouveau total.
const ADD_CREDITS_LUA = `
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 0 then
  return nil
end
return redis.call('HINCRBY', KEYS[2], ARGV[3], ARGV[4])
`.trim()

/** Top-up idempotent (ref = id d'événement Stripe côté console). Retourne le nouveau
 * total crédité (USD — la frontière reste en flottants), ou null si store coupé /
 * entrée invalide ; 'duplicate' si la ref a déjà été appliquée (la console peut
 * re-livrer un webhook sans double-créditer). */
export async function addCredits(project: string, usd: number, ref: string): Promise<number | null | 'duplicate'> {
  if (!PROJECT_RE.test(project) || !Number.isFinite(usd) || usd <= 0 || !ref || ref.length > 128) return null
  const micro = usdToMicro(usd)
  if (micro <= 0) return null // sous la résolution du ledger (< 0.5 µ$)
  const c = storeClient()
  if (!c) return null
  const refField = `${project}|${ref}`
  if (c.eval) {
    const total = await c.eval(ADD_CREDITS_LUA, {
      keys: [CREDIT_REFS, CREDITS_MICRO],
      arguments: [refField, String(usd), project, String(micro)],
    })
    if (total === null) return 'duplicate'
  } else {
    // Repli deux temps (client sans eval) — audit #8 : dédup atomique via le retour de
    // HSET (1 = champ nouveau). Fenêtre de crash résiduelle entre les deux commandes,
    // fermée par le chemin Lua ci-dessus en production.
    const fresh = (await c.hSet(CREDIT_REFS, refField, String(usd))) as number
    if (fresh === 0) return 'duplicate'
    await c.hIncrBy(CREDITS_MICRO, project, micro)
  }
  await refreshKeys()
  const total = credits.get(project)
  return total !== undefined ? microToUsd(total) : usd
}

/** URL de recharge pour un projet (template OPENMULTI_TOPUP_URL), ou undefined. */
export function topupUrlFor(project: string): string | undefined {
  if (!config.topupUrl) return undefined
  return config.topupUrl.replaceAll('{project}', encodeURIComponent(project))
}

export interface ProjectAccount {
  /** Le projet a un solde prépayé posé (sinon : facturation de confiance, pas de solde). */
  prepaid: boolean
  creditsUsd?: number
  spentUsd?: number
  balanceUsd?: number
  capUsdPerDay?: number
  spentTodayUsd?: number
}

/** Vue compte d'UN projet, depuis les caches mémoire (zéro I/O — même source que les
 * gardes du chemin chaud, donc l'agent voit exactement ce qui l'autorise/le bloque). */
export function projectAccount(project: string): ProjectAccount {
  const total = credits.get(project)
  const cap = caps.get(project)
  const out: ProjectAccount = { prepaid: total !== undefined }
  if (total !== undefined) {
    const spent = (spentTotal.get(project) ?? 0) + (localBilled.get(project) ?? 0) // µ$
    out.creditsUsd = microToUsd(total)
    out.spentUsd = microToUsd(spent)
    out.balanceUsd = microToUsd(total - spent)
  }
  if (cap !== undefined) {
    out.capUsdPerDay = cap
    out.spentTodayUsd = meterDay() === spendDay ? microToUsd(spendToday.get(project) ?? 0) : 0
  }
  return out
}

export function balanceReport(): Record<string, { creditsUsd: number; spentUsd: number; balanceUsd: number }> {
  const out: Record<string, { creditsUsd: number; spentUsd: number; balanceUsd: number }> = {}
  for (const [project, total] of credits) {
    const spent = (spentTotal.get(project) ?? 0) + (localBilled.get(project) ?? 0) // µ$
    out[project] = { creditsUsd: microToUsd(total), spentUsd: microToUsd(spent), balanceUsd: microToUsd(total - spent) }
  }
  return out
}

// ── Posture prépayé anonyme (projets signup, plan interprète B3) ────────────────

/** Préfixe des projets nés du signup self-service (générés par signup.ts). C'est LE
 * marqueur de la classe « anonyme » : personne d'autre ne crée de projets ag-*
 * (PROJECT_RE l'autorise, mais /admin/keys est réservé à l'ops). */
export const SIGNUP_PROJECT_PREFIX = 'ag-'

export interface SignupGateVerdict {
  blocked: boolean
  status?: 402 | 503
  message?: string
}

/** Posture B3 : les projets ANONYMES (signup) sont servis fail-closed, les clients à
 * clé de confiance gardent le fail-open historique (une panne du store ne coupe
 * jamais MyMULTI/console).
 *  - Store absent/malade -> 503 : sans metering ni solde frais, on ne sert pas à
 *    crédit un inconnu (le plafond journalier ne mord plus si la dépense n'est plus
 *    comptée nulle part de façon durable).
 *  - OPENMULTI_SIGNUP_REQUIRE_CREDITS=1 (posture zéro-avance) : sans crédits posés,
 *    402 tant que pas de top-up — désactive le free tier d'essai sans redéployer. */
export function signupGate(project: string): SignupGateVerdict {
  if (!project.startsWith(SIGNUP_PROJECT_PREFIX)) return { blocked: false }
  if (!storeClient() || !storeHealthy()) {
    return { blocked: true, status: 503, message: 'Self-service accounts are temporarily unavailable — retry shortly' }
  }
  if (config.signup.requireCredits && !credits.has(project)) {
    return { blocked: true, status: 402, message: 'This account is prepaid-only — top up credits before use' }
  }
  return { blocked: false }
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
  pendingReserved = new Map()
  if (timer) clearInterval(timer)
  timer = null
}
