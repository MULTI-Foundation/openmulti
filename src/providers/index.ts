// Access-path resolution (docs/MULTI-PROVIDER-SPEC.md §4): given a resolved model id
// (vendor/model), pick the Provider that will carry the call. The vendor prefix is NOT
// the access path: anthropic/claude-* may go through OpenRouter or (later) Anthropic
// direct. Default: everything goes through OpenRouter (iso).
//
// Per-vendor opt-in via OPENMULTI_PROVIDER_<VENDOR> (requires the vendor's API key —
// missing key = silent OpenRouter fallback, flipping the env alone can never break):
//   - 'direct' : tout le vendor passe en direct, déterministe.
//   - 'smart'  : ARBITRAGE par chemin (étape 4) — la même mécanique explore/exploit
//     que le bandit de tier (select.ts), nourrie des stats amorties PAR CHEMIN
//     (pathAggregate). Direct est premier candidat (le pari : moins cher sans la
//     marge OpenRouter) ; s'il se dégrade, le trafic rebascule sur OpenRouter, et
//     l'exploration continue lui laisse prouver sa guérison.

import { config } from '../config.js'
import { pathAggregate } from '../metrics.js'
import { selectModel } from '../select.js'
import { openRouterProvider } from './openrouter.js'
import { moonshotProvider } from './moonshot.js'
import type { Provider } from './types.js'

// Lu une fois au boot, comme le reste de la config.
const moonshotMode =
  config.moonshot.apiKey !== '' &&
  (process.env.OPENMULTI_PROVIDER_MOONSHOTAI === 'direct' || process.env.OPENMULTI_PROVIDER_MOONSHOTAI === 'smart')
    ? (process.env.OPENMULTI_PROVIDER_MOONSHOTAI as 'direct' | 'smart')
    : 'openrouter'

const PATHS: Record<string, Provider> = {
  openrouter: openRouterProvider,
  moonshot: moonshotProvider,
}

export function providerFor(model: string): Provider {
  if (model.startsWith('moonshotai/')) {
    if (moonshotMode === 'direct') return moonshotProvider
    if (moonshotMode === 'smart') {
      // Candidats = noms de chemins ; stats = la vue bandit par (chemin, modèle).
      const sel = selectModel(['moonshot', 'openrouter'], 'smart', (path) => pathAggregate(path, model))
      return PATHS[sel.model] ?? openRouterProvider
    }
  }
  return openRouterProvider
}

export type { Provider, UpstreamCall } from './types.js'
