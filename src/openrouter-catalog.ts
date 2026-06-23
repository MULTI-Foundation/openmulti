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
  architecture?: { output_modalities?: unknown; modality?: unknown }
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

const TTL_MS = 60 * 60 * 1000 // 1 h : le catalogue upstream bouge peu
let cache: { ids: string[]; at: number } | null = null
let inflight: Promise<string[]> | null = null

/** Ids OpenRouter (cachés 1 h, fail-open). `now` injectable pour les tests. */
export async function fetchModelIds(now: number = Date.now()): Promise<string[]> {
  if (cache && now - cache.at < TTL_MS) return cache.ids
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await fetch(`${config.openrouter.baseUrl}/models`, {
        headers: { authorization: `Bearer ${config.openrouter.apiKey}` },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) {
        log.warn('openrouter_catalog_not_ok', { status: res.status })
        return cache?.ids ?? []
      }
      const ids = parseModelIds(await res.json())
      if (ids.length > 0) cache = { ids, at: now }
      return ids.length > 0 ? ids : (cache?.ids ?? [])
    } catch (e) {
      log.warn('openrouter_catalog_error', { error: e instanceof Error ? e.message : String(e) })
      return cache?.ids ?? []
    } finally {
      inflight = null
    }
  })()
  return inflight
}
