// Modèles MORTS - vécu prod 2026-11-03 : qwen/qwen3-coder-plus, déprécié le 2026-10-09
// (Qwen direct « Model not exist », OpenRouter 404 « deprecated »), restait candidat des
// slots agent. Le bandit le re-sondait (recovery probe), chaque sonde finissait en 404
// TERMINAL (la quarantaine de chemin n'écarte jamais OpenRouter) et le run de l'agent
// mourait sans sortie.
//
// Un modèle est déclaré mort sur DEUX preuves, jamais une seule :
//   1. un 404 terminal sur le chemin OpenRouter (le chemin de référence) ;
//   2. le modèle est ABSENT du feed /models d'OpenRouter (après normalisation d'id).
// Un 404 seul ne suffit pas : OpenRouter renvoie aussi 404 « No endpoints found that can
// handle the requested parameters », propre à la REQUÊTE. Feed jamais chargé = on ne
// déclare rien (fail-open, comme vision.ts).
//
// Effets (routes/chat.ts, router.ts) : le routage auto écarte le modèle mort pendant un TTL
// (OPENMULTI_DEAD_MODEL_TTL_S, défaut 6 h, 0 = coupé) et la requête qui l'a découvert est
// re-routée UNE fois vers un autre candidat. Ce n'est pas le fallback cross-modèle exclu
// par le contrat (« changer de modèle changerait la réponse ») : l'appelant a demandé
// `auto`, pas ce modèle, et un modèle qui n'existe plus n'a aucune réponse à préserver.
//
// Signal de curation : refreshDeadModels() liste aussi les candidats de chat du catalogue
// absents du feed (jauge openmulti_catalog_model_unlisted) - alerter AVANT qu'un modèle
// retiré ne casse des runs.

import { fetchModelIds } from './openrouter-catalog.js'
import { catalogModels } from './catalog.js'
import { setCatalogUnlisted, recordModelDead } from './metrics.js'
import { log } from './log.js'

const TTL_MS = Math.max(0, Number(process.env.OPENMULTI_DEAD_MODEL_TTL_S ?? 6 * 3600)) * 1000
const REFRESH_MS = Math.max(60_000, Number(process.env.OPENMULTI_VISION_REFRESH_MS ?? 60 * 60 * 1000))
const MAX_ENTRIES = 200

let feed: Set<string> | null = null
const until = new Map<string, number>()
let lastUnlisted = ''
let timer: ReturnType<typeof setInterval> | null = null

/** Variantes d'un id qu'OpenRouter peut lister : l'id nu, sans suffixe de variante
 * (`:nitro`, `:free`…), et la version à points des ids à tirets (API Anthropic directe :
 * claude-sonnet-4-5 <-> claude-sonnet-4.5). Pur, testé. */
export function idVariants(model: string): string[] {
  const base = model.replace(/:[^/]+$/, '')
  const dotted = base.replace(/(\d)-(\d)/g, '$1.$2')
  return [...new Set([model, base, dotted])]
}

/** true/false si le feed est connu ; null = inconnu (rien n'est déclaré mort). */
export function isListedOnOpenRouter(model: string, ids: Set<string> | null = feed): boolean | null {
  if (!ids || ids.size === 0) return null
  return idVariants(model).some((v) => ids.has(v))
}

/** Pose le modèle comme mort si (404 terminal OpenRouter) ET absent du feed.
 * Renvoie true si posé. */
export function markModelDead(model: string, status: number, provider: string, now = Date.now()): boolean {
  if (TTL_MS === 0 || status !== 404 || provider !== 'openrouter') return false
  if (isListedOnOpenRouter(model) !== false) return false
  if (!until.has(model) && until.size >= MAX_ENTRIES) {
    const oldest = until.keys().next().value
    if (oldest !== undefined) until.delete(oldest)
  }
  until.set(model, now + TTL_MS)
  recordModelDead(model)
  log.warn('model_dead', { model, ttlS: TTL_MS / 1000 })
  return true
}

export function isModelDead(model: string, now = Date.now()): boolean {
  const t = until.get(model)
  if (t === undefined) return false
  if (now >= t) {
    until.delete(model)
    return false
  }
  return true
}

/** Candidats de chat du catalogue (tiers + purposes, hors image/embedding qui ne sont pas
 * dans le feed /models) absents du feed. Pur, testé. */
export function computeUnlisted(entries: ReturnType<typeof catalogModels>, ids: Set<string>): string[] {
  return entries
    .filter((e) => !e.purposes.includes('image') && !e.purposes.includes('embedding'))
    .map((e) => e.model)
    .filter((m) => isListedOnOpenRouter(m, ids) === false)
    .sort()
}

export async function refreshDeadModels(): Promise<void> {
  try {
    const ids = await fetchModelIds()
    if (ids.length === 0) return // fail-open : on garde l'état connu
    feed = new Set(ids)
    const unlisted = computeUnlisted(catalogModels(), feed)
    setCatalogUnlisted(unlisted)
    const sig = unlisted.join(',')
    if (sig !== lastUnlisted) {
      lastUnlisted = sig
      if (unlisted.length) log.warn('catalog_models_unlisted', { models: unlisted })
    }
  } catch (e) {
    log.warn('dead_models_refresh_failed', { error: e instanceof Error ? e.message : String(e) })
  }
}

export function initDeadModels(): void {
  void refreshDeadModels()
  timer = setInterval(() => void refreshDeadModels(), REFRESH_MS)
  timer.unref()
}

/** Réservé aux tests. */
export function _setDeadModelsFeedForTests(ids: string[] | null): void {
  feed = ids ? new Set(ids) : null
}
export function _resetDeadModels(): void {
  until.clear()
  feed = null
  lastUnlisted = ''
}
