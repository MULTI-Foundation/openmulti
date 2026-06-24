// Overrides de config council « à la volée » : le mainteneur ajuste les panels par
// preset (flash/budget/quality), les chairs et le preset par défaut via
// PUT /admin/council/:slot — sans release ni rollout. Même philosophie que
// catalog-overrides.ts : store partagé (hash `council:slots`), cache mémoire, refresh
// périodique + immédiat après mutation locale, multi-pod converge en ≤ un refresh, store
// down = dernier état connu. Précédence (effectiveCouncil, council.ts) : override > env.
//
// Slots hétérogènes :
//   panelFlash | panelBudget | panelQuality  -> liste de modèles (CSV en store)
//   chair | chairFlash                       -> un seul modèle
//   defaultPreset                            -> flash | budget | quality

import { storeClient, storeHealthy } from './store.js'
import { log } from './log.js'

const SLOTS_KEY = 'council:slots'
const REFRESH_MS = Math.max(1000, Number(process.env.OPENMULTI_KEYS_REFRESH_MS ?? 10_000))
const MODEL_RE = /^[a-z0-9][a-z0-9._:/-]{1,127}$/i

const PANEL_SLOTS = new Set(['panelFlash', 'panelBudget', 'panelQuality'])
const SINGLE_SLOTS = new Set(['chair', 'chairFlash'])
const PRESETS = new Set(['flash', 'budget', 'quality'])

export interface CouncilOverrides {
  panelFlash?: string[]
  panelBudget?: string[]
  panelQuality?: string[]
  chair?: string
  chairFlash?: string
  defaultPreset?: string
}

let overrides: CouncilOverrides = {}
let timer: ReturnType<typeof setInterval> | null = null

export function councilOverrides(): CouncilOverrides {
  return overrides
}

function isValidModel(m: unknown): m is string {
  return typeof m === 'string' && MODEL_RE.test(m)
}

export async function refreshCouncilOverrides(): Promise<void> {
  const c = storeClient()
  if (!c || !storeHealthy()) return // fail-open : on garde le dernier état connu
  try {
    const hash = await c.hGetAll(SLOTS_KEY)
    const next: CouncilOverrides = {}
    for (const [slot, raw] of Object.entries(hash)) {
      if (PANEL_SLOTS.has(slot)) {
        const models = raw.split(',').map((s) => s.trim()).filter(Boolean)
        if (models.length && models.every(isValidModel)) next[slot as 'panelFlash'] = models
        else log.warn('council_override_bad_entry', { slot })
      } else if (SINGLE_SLOTS.has(slot)) {
        if (isValidModel(raw)) next[slot as 'chair'] = raw
        else log.warn('council_override_bad_entry', { slot })
      } else if (slot === 'defaultPreset') {
        if (PRESETS.has(raw)) next.defaultPreset = raw
        else log.warn('council_override_bad_entry', { slot })
      } else {
        log.warn('council_override_bad_entry', { slot })
      }
    }
    overrides = next
  } catch (e) {
    log.warn('council_overrides_refresh_failed', { error: e instanceof Error ? e.message : String(e) })
  }
}

/** Boot : premier refresh + rafraîchissement périodique (unref : ne retient pas le process). */
export function initCouncilOverrides(): void {
  void refreshCouncilOverrides()
  timer = setInterval(() => void refreshCouncilOverrides(), REFRESH_MS)
  timer.unref()
}

/** Valide + persiste un slot. Retourne un message d'erreur, ou null si OK. */
export async function setCouncilSlot(slot: string, value: unknown): Promise<string | null> {
  let stored: string
  if (PANEL_SLOTS.has(slot)) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
      return 'panel must be a non-empty array (max 8 — chaque membre coûte un appel)'
    }
    for (const m of value) if (!isValidModel(m)) return `invalid model id: ${JSON.stringify(m)}`
    stored = value.join(',')
  } else if (SINGLE_SLOTS.has(slot)) {
    if (!isValidModel(value)) return `invalid model id: ${JSON.stringify(value)}`
    stored = value
  } else if (slot === 'defaultPreset') {
    if (typeof value !== 'string' || !PRESETS.has(value)) return 'defaultPreset must be flash|budget|quality'
    stored = value
  } else {
    return 'invalid slot (panelFlash|panelBudget|panelQuality|chair|chairFlash|defaultPreset)'
  }
  const c = storeClient()
  if (!c) return 'council overrides disabled (set REDIS_URL)'
  await c.hSet(SLOTS_KEY, slot, stored)
  await refreshCouncilOverrides() // visible immédiatement sur CE pod ; ailleurs ≤ refresh
  return null
}

export async function deleteCouncilSlot(slot: string): Promise<boolean> {
  const c = storeClient()
  if (!c || !(slot in overrides)) return false
  await c.hDel(SLOTS_KEY, slot)
  await refreshCouncilOverrides()
  return true
}

/** Test helper : vide le cache mémoire. */
export function _resetCouncilOverridesForTests(): void {
  overrides = {}
  if (timer) clearInterval(timer)
  timer = null
}
