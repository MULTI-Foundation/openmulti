// Catalogue OpenRouter complet — la liste des modèles RÉELLEMENT adressables (≈300+),
// pour alimenter le menu déroulant de l'éditeur de panel côté console. On ne curated
// rien ici : c'est l'inventaire upstream, l'utilisateur choisit dedans (le council
// dégrade gracieusement si un membre échoue). Parsing pur + testable (parseModelIds) ;
// fetch caché en mémoire (TTL) et fail-open : OpenRouter injoignable -> [] (l'appelant
// retombe sur les ids tarifés, comportement d'avant).

import { config } from './config.js'
import { log } from './log.js'

interface RawModel {
  id?: unknown
  architecture?: { input_modalities?: unknown; output_modalities?: unknown; modality?: unknown }
}

/** Extrait les ids de modèles servables, triés. Ne garde que les modèles qui PRODUISENT
 * du texte (un générateur d'image pur n'a rien à faire dans un panel de chat). Lenient :
 * si l'info de modalité manque, on garde (par défaut c'est du texte chez OpenRouter). */
export function parseModelIds(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return []
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const ids = new Set<string>()
  for (const m of data as RawModel[]) {
    if (typeof m?.id !== 'string' || m.id === '') continue
    const arch = m.architecture
    const out = arch?.output_modalities
    if (Array.isArray(out)) {
      if (!out.includes('text')) continue // image/audio-only -> hors panel de chat
    } else if (typeof arch?.modality === 'string') {
      // Format OpenRouter `input->output` (ex. `text+image->text`) : on regarde la SORTIE.
      const outMod = arch.modality.split('->').pop() ?? ''
      if (!outMod.includes('text')) continue
    }
    ids.add(m.id)
  }
  return [...ids].sort()
}

/**
 * Ids des modèles qui ACCEPTENT une modalité donnée en ENTRÉE (image = vision,
 * audio = transcription/compréhension audio), dérivés du même feed — jamais d'une
 * table manuelle (leçon E-7 : une table maintenue à la main dérive). STRICT, à
 * l'inverse du lenient de parseModelIds : capacité non déclarée = pas capable. On ne
 * devine pas une capacité — un faux négatif écarte un candidat d'un tier (le slot de
 * repli rattrape), un faux positif recrée le bug mesuré en prod (réponse vide
 * facturée par un modèle aveugle/sourd).
 */
export type InputModality = 'image' | 'audio'

export function parseInputModalityIds(body: unknown, modality: InputModality): string[] {
  if (typeof body !== 'object' || body === null) return []
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const ids = new Set<string>()
  for (const m of data as RawModel[]) {
    if (typeof m?.id !== 'string' || m.id === '') continue
    const arch = m.architecture
    const input = arch?.input_modalities
    if (Array.isArray(input)) {
      if (input.includes(modality)) ids.add(m.id)
    } else if (typeof arch?.modality === 'string') {
      // Format `input->output` (ex. `text+image->text`) : on regarde l'ENTRÉE.
      const inMod = arch.modality.split('->')[0] ?? ''
      if (inMod.includes(modality)) ids.add(m.id)
    }
  }
  return [...ids].sort()
}

/** Ids vision (image en entrée). */
export function parseVisionModelIds(body: unknown): string[] {
  return parseInputModalityIds(body, 'image')
}

/** Ids audio (audio en entrée : content part `input_audio`). */
export function parseAudioModelIds(body: unknown): string[] {
  return parseInputModalityIds(body, 'audio')
}

const TTL_MS = 60 * 60 * 1000 // 1 h : le catalogue upstream bouge peu
interface CatalogLists {
  ids: string[]
  visionIds: string[]
  audioIds: string[]
}
let cache: (CatalogLists & { at: number }) | null = null
let inflight: Promise<CatalogLists> | null = null

/** UN fetch, les trois listes (ids servables + ids vision + ids audio), cachées 1 h, fail-open :
 * OpenRouter injoignable -> dernier état connu, sinon des listes vides. */
async function fetchCatalogLists(now: number): Promise<CatalogLists> {
  if (cache && now - cache.at < TTL_MS) return cache
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await fetch(`${config.openrouter.baseUrl}/models`, {
        headers: { authorization: `Bearer ${config.openrouter.apiKey}` },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) {
        log.warn('openrouter_catalog_not_ok', { status: res.status })
        return cache ?? { ids: [], visionIds: [], audioIds: [] }
      }
      const body = (await res.json()) as unknown
      const lists = { ids: parseModelIds(body), visionIds: parseVisionModelIds(body), audioIds: parseAudioModelIds(body) }
      if (lists.ids.length > 0) cache = { ...lists, at: now }
      return lists.ids.length > 0 ? lists : (cache ?? { ids: [], visionIds: [], audioIds: [] })
    } catch (e) {
      log.warn('openrouter_catalog_error', { error: e instanceof Error ? e.message : String(e) })
      return cache ?? { ids: [], visionIds: [], audioIds: [] }
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** Ids OpenRouter (cachés 1 h, fail-open). `now` injectable pour les tests. */
export async function fetchModelIds(now: number = Date.now()): Promise<string[]> {
  return (await fetchCatalogLists(now)).ids
}

/** Ids vision (image en entrée), même cache/fetch que fetchModelIds. */
export async function fetchVisionModelIds(now: number = Date.now()): Promise<string[]> {
  return (await fetchCatalogLists(now)).visionIds
}

/** Ids audio (audio en entrée), même cache/fetch que fetchModelIds. */
export async function fetchAudioModelIds(now: number = Date.now()): Promise<string[]> {
  return (await fetchCatalogLists(now)).audioIds
}
