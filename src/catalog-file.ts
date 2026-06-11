// Le fichier de catalogue local — la « tambouille interne » (quel modèle face à quel
// tier, une partie de la valeur d'OpenMulti). Il n'est JAMAIS versionné :
//   - en local : `catalog.local.json` (gitignoré), pointé par OPENMULTI_CATALOG_FILE ;
//   - en cluster : ConfigMap créée HORS manifeste (comme les secrets), montée en
//     volume, ex. OPENMULTI_CATALOG_FILE=/etc/openmulti/catalog.json.
//
// Format :
//   { "slots": { "economy": ["vendor/model", ...], "agent_balanced": [...], ... } }
// Le premier modèle de chaque slot est le primaire. Slots valides : un tier
// (economy|balanced|quality) ou `<purpose>_<tier>`.
//
// Lu UNE FOIS au boot (cohérent avec le reste de la config) : changer le fichier =
// rollout restart. Pour l'ajustement à chaud sans restart, c'est l'API admin
// (PUT /admin/catalog/:slot) qui prime de toute façon sur ce fichier.
// Fichier absent/corrompu : warning + fallback env/défauts — jamais un crash au boot.

import { readFileSync } from 'node:fs'
import { log } from './log.js'

const SLOT_RE = /^([a-z0-9-]+_)?(economy|balanced|quality)$/
const MODEL_RE = /^[a-z0-9][a-z0-9._:/-]{1,127}$/i

function load(): Record<string, string[]> {
  const path = process.env.OPENMULTI_CATALOG_FILE
  if (!path) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    log.warn('catalog_file_unreadable', { path, error: e instanceof Error ? e.message : String(e) })
    return {}
  }
  const slots = (parsed as { slots?: unknown })?.slots
  if (typeof slots !== 'object' || slots === null) {
    log.warn('catalog_file_invalid', { path, error: 'expected { "slots": { ... } }' })
    return {}
  }
  const out: Record<string, string[]> = {}
  for (const [slot, models] of Object.entries(slots)) {
    const ok =
      SLOT_RE.test(slot) &&
      Array.isArray(models) &&
      models.length > 0 &&
      models.every((m) => typeof m === 'string' && MODEL_RE.test(m))
    if (ok) out[slot] = models as string[]
    else log.warn('catalog_file_bad_slot', { path, slot })
  }
  log.info('catalog_file_loaded', { path, slots: Object.keys(out) })
  return out
}

let slots = load()

export function catalogFileSlot(slot: string): string[] | undefined {
  return slots[slot]
}

export function catalogFileSlots(): Record<string, string[]> {
  return slots
}

/** Test helper : recharge depuis l'env courant (l'app, elle, lit une fois au boot). */
export function _reloadCatalogFileForTests(): void {
  slots = load()
}
