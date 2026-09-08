// Capacités par modalité d'ENTRÉE des modèles — le référentiel du routage par
// modalité : VISION (image en entrée, chantier 2026-07-21) et AUDIO (audio en entrée,
// content part `input_audio`, chantier 2026-09-08). Dérivé du feed OpenRouter
// (architecture.input_modalities via openrouter-catalog.ts), jamais d'une table
// manuelle : une table maintenue à la main dérive (leçon E-7). Rafraîchi
// périodiquement en mémoire pour que route() (synchrone, chemin chaud) lise un Set
// sans I/O — même philosophie que catalog-overrides.
//
// MODE DÉGRADÉ (décision 2026-07-21, amendement 2 du chantier vision) : AUCUNE donnée
// (feed jamais chargé, env absent) -> set null -> le routeur NE FILTRE PAS
// (comportement historique préservé — une panne OpenRouter au boot ne doit jamais
// couper le trafic). Strict dès que les données existent. Une panne APRÈS un
// premier chargement garde le dernier état connu (le refresh ne remplace jamais un
// état connu par du vide). Même règle pour l'audio.
//
// Soupape ops + tests : OPENMULTI_VISION_MODELS / OPENMULTI_AUDIO_MODELS (CSV)
// REMPLACENT le feed quand posées — pour épingler la vérité en cas de feed erroné,
// ou tester sans réseau.

import { fetchVisionModelIds, fetchAudioModelIds, type InputModality } from './openrouter-catalog.js'
import { log } from './log.js'

const REFRESH_MS = Math.max(60_000, Number(process.env.OPENMULTI_VISION_REFRESH_MS ?? 60 * 60 * 1000))

const ENV_OVERRIDE: Record<InputModality, string> = {
  image: 'OPENMULTI_VISION_MODELS',
  audio: 'OPENMULTI_AUDIO_MODELS',
}
const feedSets: Record<InputModality, Set<string> | null> = { image: null, audio: null }
let timer: ReturnType<typeof setInterval> | null = null

/** Le référentiel courant d'une modalité — null = INCONNU (aucune donnée : pas de filtrage). */
export function modalitySet(modality: InputModality): Set<string> | null {
  const env = process.env[ENV_OVERRIDE[modality]]
  if (env) {
    const ids = env.split(',').map((s) => s.trim()).filter(Boolean)
    if (ids.length) return new Set(ids)
  }
  return feedSets[modality]
}

/** true/false quand le référentiel existe ; null = inconnu (fail-open, pas de filtrage). */
export function isCapable(modality: InputModality, model: string): boolean | null {
  const s = modalitySet(modality)
  return s ? s.has(model) : null
}

/** Le référentiel vision courant — null = INCONNU (aucune donnée : pas de filtrage). */
export function visionSet(): Set<string> | null {
  return modalitySet('image')
}

export function isVisionCapable(model: string): boolean | null {
  return isCapable('image', model)
}

export function isAudioCapable(model: string): boolean | null {
  return isCapable('audio', model)
}

export async function refreshVisionModels(): Promise<void> {
  // Un seul fetch upstream (cache partagé dans openrouter-catalog) alimente les
  // deux référentiels ; liste vide = fail-open du fetch : on GARDE l'état connu.
  const sources: Array<[InputModality, () => Promise<string[]>]> = [
    ['image', fetchVisionModelIds],
    ['audio', fetchAudioModelIds],
  ]
  for (const [modality, fetchIds] of sources) {
    try {
      const ids = await fetchIds()
      if (ids.length) feedSets[modality] = new Set(ids)
      else if (!feedSets[modality]) {
        log.warn(`${modality === 'image' ? 'vision' : 'audio'}_models_unavailable`, {
          detail: `feed OpenRouter sans données — routage ${modality} NON filtré (mode dégradé)`,
        })
      }
    } catch (e) {
      log.warn(`${modality === 'image' ? 'vision' : 'audio'}_models_refresh_failed`, { error: e instanceof Error ? e.message : String(e) })
    }
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
  feedSets.image = null
  feedSets.audio = null
  if (timer) clearInterval(timer)
  timer = null
}
