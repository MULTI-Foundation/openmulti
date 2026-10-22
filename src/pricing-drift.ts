// Dérive de la table de prix (pricing.ts, maintenue à la main) par rapport au feed
// OpenRouter (/api/v1/models, prix par token). Constat 2026-10-21 : deepseek-v4-pro à
// 0.435/0.87 dans la table contre 0.955/1.91 chez OpenRouter — les devis sous-estimaient
// de moitié. On ne corrige JAMAIS la table automatiquement (règle du repo : chaque prix
// est vérifié à une source datée) : on SIGNALE — jauge Prometheus par modèle dérivant +
// endpoint admin pour le badge console. Rafraîchi avec le cache du feed (1 h), fail-open.

import { fetchModelPricing, type FeedPrice } from './openrouter-catalog.js'
import { priceFor, pricedModelIds, type ModelPrice } from './pricing.js'
import { setPricingDrift } from './metrics.js'
import { log } from './log.js'

/** Écart relatif toléré avant de signaler (défaut 10 %). */
export const DRIFT_TOLERANCE = Math.max(0, Number(process.env.OPENMULTI_PRICING_DRIFT_PCT ?? 10)) / 100
const REFRESH_MS = Math.max(60_000, Number(process.env.OPENMULTI_VISION_REFRESH_MS ?? 60 * 60 * 1000))

export interface DriftRow {
  model: string
  table: { inputPerMTok: number; outputPerMTok: number }
  openrouter: { inputPerMTok: number; outputPerMTok: number }
  /** openrouter / table — > 1 : la table sous-estime (devis trop bas). */
  inputRatio: number
  outputRatio: number
}

const ratio = (feed: number, table: number): number => (table > 0 ? feed / table : feed > 0 ? Infinity : 1)
const drifts = (r: number): boolean => !Number.isFinite(r) || Math.abs(r - 1) > DRIFT_TOLERANCE

/** Modèles de la table présents dans le feed dont un prix s'écarte de plus de la tolérance.
 * Pur, testé. Un modèle absent du feed (chemin direct uniquement, id Anthropic à points…)
 * n'est pas comparable : ignoré, pas signalé. */
export function computePricingDrift(
  table: Record<string, Pick<ModelPrice, 'inputPerMTok' | 'outputPerMTok'>>,
  feed: Record<string, FeedPrice>,
): DriftRow[] {
  const out: DriftRow[] = []
  for (const model of Object.keys(table).sort()) {
    const t = table[model]!
    const f = feed[model]
    if (!f) continue
    const inputRatio = ratio(f.inputPerMTok, t.inputPerMTok)
    const outputRatio = ratio(f.outputPerMTok, t.outputPerMTok)
    if (!drifts(inputRatio) && !drifts(outputRatio)) continue
    out.push({
      model,
      table: { inputPerMTok: t.inputPerMTok, outputPerMTok: t.outputPerMTok },
      openrouter: { inputPerMTok: f.inputPerMTok, outputPerMTok: f.outputPerMTok },
      inputRatio,
      outputRatio,
    })
  }
  return out
}

export interface DriftReport {
  /** null = feed jamais chargé (pas de comparaison possible, rien à signaler). */
  rows: DriftRow[] | null
  tolerance: number
}

let last: DriftRow[] | null = null
let lastLogged = ''
let timer: ReturnType<typeof setInterval> | null = null

function currentTable(): Record<string, ModelPrice> {
  const t: Record<string, ModelPrice> = {}
  for (const id of pricedModelIds()) {
    const p = priceFor(id)
    if (p) t[id] = p
  }
  return t
}

export async function refreshPricingDrift(now: number = Date.now()): Promise<DriftReport> {
  try {
    const feed = await fetchModelPricing(now)
    if (Object.keys(feed).length > 0) {
      last = computePricingDrift(currentTable(), feed)
      setPricingDrift(last.map((r) => ({ model: r.model, inputRatio: r.inputRatio, outputRatio: r.outputRatio })))
      // Un warn par CHANGEMENT de l'ensemble dérivant, pas par refresh (la console lit le
      // rapport à chaque chargement de page).
      const key = last.map((r) => r.model).join(',')
      if (key !== lastLogged) {
        lastLogged = key
        if (last.length) log.warn('pricing_drift', { models: last.map((r) => r.model) })
      }
    }
  } catch (e) {
    log.warn('pricing_drift_refresh_failed', { error: e instanceof Error ? e.message : String(e) })
  }
  return { rows: last, tolerance: DRIFT_TOLERANCE }
}

/** Dernier rapport connu (null tant que le feed n'a pas été lu). */
export function pricingDriftReport(): DriftReport {
  return { rows: last, tolerance: DRIFT_TOLERANCE }
}

/** Boot : premier calcul + rafraîchissement périodique (unref). Jamais bloquant. */
export function initPricingDrift(): void {
  void refreshPricingDrift()
  timer = setInterval(() => void refreshPricingDrift(), REFRESH_MS)
  timer.unref()
}

/** Test helper. */
export function _resetPricingDriftForTests(): void {
  last = null
  lastLogged = ''
  if (timer) clearInterval(timer)
  timer = null
}
