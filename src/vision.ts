// Capacité VISION (image en ENTRÉE) des modèles — le référentiel du routage par
// modalité d'entrée. Dérivé du feed OpenRouter (architecture.input_modalities via
// openrouter-catalog.ts), jamais d'une table manuelle : une table maintenue à la main
// dérive (leçon E-7). Rafraîchi périodiquement en mémoire pour que route() (synchrone,
// chemin chaud) lise un Set sans I/O — même philosophie que catalog-overrides.
//
// MODE DÉGRADÉ (décision 2026-07-21, amendement 2 du chantier vision) : AUCUNE donnée
// (feed jamais chargé, env absent) -> visionSet() = null -> le routeur NE FILTRE PAS
// (comportement historique préservé — une panne OpenRouter au boot ne doit jamais
// couper le trafic vision). Strict dès que les données existent. Une panne APRÈS un
// premier chargement garde le dernier état connu (le refresh ne remplace jamais un
// état connu par du vide).
//
// Soupape ops + tests : OPENMULTI_VISION_MODELS (CSV) REMPLACE le feed quand posé —
// pour épingler la vérité en cas de feed erroné, ou tester sans réseau.

import { fetchVisionModelIds } from './openrouter-catalog.js'
import { log } from './log.js'

const REFRESH_MS = Math.max(60_000, Number(process.env.OPENMULTI_VISION_REFRESH_MS ?? 60 * 60 * 1000))

let feedSet: Set<string> | null = null
let timer: ReturnType<typeof setInterval> | null = null

/** Le référentiel vision courant — null = INCONNU (aucune donnée : pas de filtrage). */
export function visionSet(): Set<string> | null {
  const env = process.env.OPENMULTI_VISION_MODELS
  if (env) {
    const ids = env.split(',').map((s) => s.trim()).filter(Boolean)
    if (ids.length) return new Set(ids)
  }
  return feedSet
}

/** true/false quand le référentiel existe ; null = inconnu (fail-open, pas de filtrage). */
export function isVisionCapable(model: string): boolean | null {
  const s = visionSet()
  return s ? s.has(model) : null
}

export async function refreshVisionModels(): Promise<void> {
  try {
    const ids = await fetchVisionModelIds()
    // Liste vide = fail-open du fetch (panne/1er échec) : on GARDE l'état connu.
    if (ids.length) feedSet = new Set(ids)
    else if (!feedSet) log.warn('vision_models_unavailable', { detail: 'feed OpenRouter sans données — routage vision NON filtré (mode dégradé)' })
  } catch (e) {
    log.warn('vision_models_refresh_failed', { error: e instanceof Error ? e.message : String(e) })
  }
}

/** Boot : premier chargement + rafraîchissement périodique (unref : ne retient pas le process). */
export function initVisionModels(): void {
  void refreshVisionModels()
  timer = setInterval(() => void refreshVisionModels(), REFRESH_MS)
  timer.unref()
}

/** Test helper : vide l'état (retour au mode « aucune donnée »). */
export function _resetVisionForTests(): void {
  feedSet = null
  if (timer) clearInterval(timer)
  timer = null
}
