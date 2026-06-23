// Chemin d'accès direct Moonshot/Kimi (étape 3 de docs/MULTI-PROVIDER-SPEC.md).
//
// API OpenAI-compatible (vérifiée le 2026-06-10 sur platform.kimi.ai/docs/api/chat) :
// Moonshot est donc une simple instance de la fabrique générique
// (src/providers/openai-compatible.ts) — endpoint/clé, préfixe vendor 'moonshotai/',
// et un seul tweak propre : le floor max_tokens de la famille Kimi K2 (le défaut
// Moonshot, 8192, tronque les longues générations agent). Tout le reste (strip des
// OpenRouter-ismes, plafond de tier, include_usage en stream, synthèse de usage.cost
// depuis pricing.ts en non-stream ET en stream) est commun et vit dans la fabrique.
//
// Les exports nommés ci-dessous sont conservés tels quels : ils verrouillent le
// contrat testé par test/moonshot.test.ts (signatures + comportement identiques).

import { config } from '../config.js'
import { makeOpenAICompatibleProvider } from './openai-compatible.js'

const moonshot = makeOpenAICompatibleProvider({
  name: 'moonshot',
  baseUrl: config.moonshot.baseUrl,
  apiKey: config.moonshot.apiKey,
  vendorPrefix: 'moonshotai/',
  steer: (body, resolvedModel) => {
    // Même règle que sur le chemin OpenRouter, pour la même raison : floor quand
    // l'appelant n'a rien mis. Appliqué avant le plafond de tier (qui peut le rogner).
    if (!body.max_tokens && resolvedModel.startsWith('moonshotai/kimi-k2')) {
      body.max_tokens = 32000
    }
  },
})

/** 'moonshotai/kimi-k2.6' (id catalogue/OpenRouter) -> 'kimi-k2.6' (id Moonshot). */
export const moonshotModelId = moonshot.modelId
export const buildMoonshotBody = moonshot.buildBody
export const normalizeMoonshotResponse = moonshot.normalizeResponse
export const adaptMoonshotStream = moonshot.adaptStream
export const moonshotProvider = moonshot.provider
