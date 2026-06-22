// Résolution du chemin d'accès (docs/MULTI-PROVIDER-SPEC.md §4) : à partir d'un id de
// modèle résolu (vendor/model), choisir le Provider qui portera l'appel. Le préfixe
// vendor n'est PAS le chemin d'accès : anthropic/claude-* peut passer par OpenRouter
// ou (plus tard) Anthropic direct. Défaut : tout passe par OpenRouter (iso).
//
// Chaque vendor à chemin direct est déclaré une fois dans DIRECT_VENDORS (préfixe
// catalogue, variable d'env de mode, provider, clé). Un vendor n'est ACTIF que si son
// mode est direct|smart ET sa clé est configurée — clé manquante = fallback silencieux
// sur OpenRouter, donc basculer l'env seul ne peut jamais casser un appel. Ajouter un
// fournisseur = une ligne dans DIRECT_VENDORS, pas une branche de plus.
//
//   - 'direct' : tout le vendor passe en direct, déterministe.
//   - 'smart'  : ARBITRAGE par chemin (étape 4) — la même mécanique explore/exploit
//     que le bandit de tier (select.ts), nourrie des stats amorties PAR CHEMIN
//     (pathAggregate). Direct est premier candidat ; s'il se dégrade, le trafic
//     rebascule sur OpenRouter, et l'exploration continue lui laisse prouver sa guérison.

import { config } from '../config.js'
import { pathAggregate } from '../metrics.js'
import { selectModel } from '../select.js'
import { openRouterProvider } from './openrouter.js'
import { moonshotProvider } from './moonshot.js'
import type { Provider } from './types.js'

type DirectMode = 'direct' | 'smart'

interface DirectVendor {
  /** Préfixe d'id catalogue qui élit ce vendor (ex. 'moonshotai/'). */
  prefix: string
  /** Variable d'env de mode (ex. 'OPENMULTI_PROVIDER_MOONSHOTAI'). */
  envVar: string
  /** Provider direct (instance de la fabrique OpenAI-compatible, ou un adaptateur dédié). */
  provider: Provider
  /** Clé du vendor : vide = jamais actif (fallback OpenRouter). */
  apiKey: string
}

// Déclaration des vendors à chemin direct. Lu une fois au boot, comme le reste de la config.
// Ajouter un fournisseur = une ligne ici (+ son module providers/<vendor>.ts, sa clé de
// config, ses prix dans pricing.ts). Le préfixe est l'id CATALOGUE (style OpenRouter).
const DIRECT_VENDORS: DirectVendor[] = [
  { prefix: 'moonshotai/', envVar: 'OPENMULTI_PROVIDER_MOONSHOTAI', provider: moonshotProvider, apiKey: config.moonshot.apiKey },
]

interface ActiveVendor {
  prefix: string
  provider: Provider
  mode: DirectMode
}

// Vendors réellement actifs (mode valide + clé présente).
const ACTIVE: ActiveVendor[] = DIRECT_VENDORS.flatMap((v) => {
  const raw = process.env[v.envVar]
  const mode: DirectMode | undefined = raw === 'direct' || raw === 'smart' ? raw : undefined
  if (!mode || v.apiKey === '') return []
  return [{ prefix: v.prefix, provider: v.provider, mode }]
})

// Tous les chemins adressables par nom (pour la résolution de la sélection smart).
const PATHS: Record<string, Provider> = { openrouter: openRouterProvider }
for (const v of DIRECT_VENDORS) PATHS[v.provider.name] = v.provider

function activeVendorFor(model: string): ActiveVendor | undefined {
  return ACTIVE.find((v) => model.startsWith(v.prefix))
}

export function providerFor(model: string): Provider {
  const v = activeVendorFor(model)
  if (v) {
    if (v.mode === 'direct') return v.provider
    if (v.mode === 'smart') {
      // Candidats = noms de chemins ; stats = la vue bandit par (chemin, modèle).
      const sel = selectModel([v.provider.name, 'openrouter'], 'smart', (path) => pathAggregate(path, model))
      return PATHS[sel.model] ?? openRouterProvider
    }
  }
  return openRouterProvider
}

// Fallback de chemin (incrément D, docs/PRODUCT-V1.md) : actif par défaut dès qu'un
// modèle a un chemin direct configuré ; OPENMULTI_PATH_FALLBACK=0 le coupe.
const PATH_FALLBACK = process.env.OPENMULTI_PATH_FALLBACK !== '0'

/**
 * Chemins d'accès ordonnés pour ce modèle : l'élu d'abord (providerFor), puis les
 * alternatives vers lesquelles basculer si l'élu épuise ses retries sur une panne
 * transitoire — MÊME modèle, donc la réponse est préservée (le fallback cross-MODEL,
 * qui change la réponse, reste hors périmètre). Un seul chemin = comportement actuel.
 */
export function pathsFor(model: string): Provider[] {
  const elected = providerFor(model)
  const v = activeVendorFor(model)
  if (PATH_FALLBACK && v) {
    const alternate = elected.name === v.provider.name ? openRouterProvider : v.provider
    return [elected, alternate]
  }
  return [elected]
}

export type { Provider, UpstreamCall } from './types.js'
