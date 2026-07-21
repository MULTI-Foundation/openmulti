// Overrides de catalogue « à la volée » (incrément G, docs/PRODUCT-V1.md) : le
// mainteneur ajuste les candidate sets via PUT /admin/catalog/:slot — sans release ni
// rollout. Stockés dans le store partagé (hash `catalog:slots`, field = slot, value =
// liste CSV), cachés en mémoire comme le registre de clés (même philosophie :
// zéro I/O sur le chemin chaud, refresh périodique + immédiat après mutation locale,
// multi-pod converge en ≤ un refresh, store down = dernier état connu).
//
// Slots : `economy` | `balanced` | `quality` (tier), `<purpose>_<tier>`
// (ex. `agent_balanced`), `fast` (la sélection MANUELLE de @fastest, en attendant
// le routage par latence) ou `image` (le modèle de génération d'image,
// modalities:['image']). La précédence vit dans catalog.ts : override > env > défauts.

import { storeClient, storeHealthy } from './store.js'
import { log } from './log.js'

const SLOTS_KEY = 'catalog:slots'
const REFRESH_MS = Math.max(1000, Number(process.env.OPENMULTI_KEYS_REFRESH_MS ?? 10_000))

const SLOT_RE = /^(fast|image|([a-z0-9-]+_)?(economy|balanced|quality))$/
// Charset des ids de modèles (vendor/model, points/tirets/deux-points pour les variantes).
const MODEL_RE = /^[a-z0-9][a-z0-9._:/-]{1,127}$/i

let overrides = new Map<string, string[]>()
let timer: ReturnType<typeof setInterval> | null = null

export function catalogOverride(slot: string): string[] | undefined {
  return overrides.get(slot)
}

export function listCatalogOverrides(): Record<string, string[]> {
  return Object.fromEntries(overrides)
}

export async function refreshCatalogOverrides(): Promise<void> {
  const c = storeClient()
  if (!c || !storeHealthy()) return // fail-open : on garde le dernier état connu
  try {
    const hash = await c.hGetAll(SLOTS_KEY)
    const next = new Map<string, string[]>()
    for (const [slot, csv] of Object.entries(hash)) {
      const models = csv.split(',').map((s) => s.trim()).filter(Boolean)
      if (SLOT_RE.test(slot) && models.length) next.set(slot, models)
      else log.warn('catalog_override_bad_entry', { slot })
    }
    overrides = next
  } catch (e) {
    log.warn('catalog_overrides_refresh_failed', { error: e instanceof Error ? e.message : String(e) })
  }
}

/** Boot : premier refresh + rafraîchissement périodique (unref : ne retient pas le process). */
export function initCatalogOverrides(): void {
  void refreshCatalogOverrides()
  timer = setInterval(() => void refreshCatalogOverrides(), REFRESH_MS)
  timer.unref()
}

export async function setCatalogSlot(slot: string, models: string[]): Promise<string | null> {
  if (!SLOT_RE.test(slot)) return `invalid slot (expected ${SLOT_RE})`
  if (!Array.isArray(models) || models.length === 0 || models.length > 8) {
    return 'models must be a non-empty array (max 8 — chaque candidat coûte son exploration au bandit)'
  }
  for (const m of models) {
    if (typeof m !== 'string' || !MODEL_RE.test(m)) return `invalid model id: ${JSON.stringify(m)}`
  }
  const c = storeClient()
  if (!c) return 'catalog overrides disabled (set REDIS_URL)'
  await c.hSet(SLOTS_KEY, slot, models.join(','))
  await refreshCatalogOverrides() // visible immédiatement sur CE pod ; ailleurs ≤ refresh
  return null
}

export async function deleteCatalogSlot(slot: string): Promise<boolean> {
  const c = storeClient()
  if (!c || !overrides.has(slot)) return false
  await c.hDel(SLOTS_KEY, slot)
  await refreshCatalogOverrides()
  return true
}

/** Test helper : vide le cache mémoire. */
export function _resetCatalogOverridesForTests(): void {
  overrides = new Map()
  if (timer) clearInterval(timer)
  timer = null
}
