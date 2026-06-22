// Chemin d'accès direct Z.ai (GLM, surface internationale). Endpoint/ids/prix vérifiés
// le 2026-06-22 (docs.z.ai). Base OpenAI-compatible '…/api/paas/v4' ; include_usage
// supporté. Préfixe catalogue 'z-ai/' (id OpenRouter), retiré pour donner 'glm-4.6'.
// Le `thinking`/`reasoning_content` propre à GLM transite tel quel (rien à faire côté
// corps pour le câblage de base) → simple instance de la fabrique.

import { config } from '../config.js'
import { makeOpenAICompatibleProvider } from './openai-compatible.js'

const zai = makeOpenAICompatibleProvider({
  name: 'zai',
  baseUrl: config.zai.baseUrl,
  apiKey: config.zai.apiKey,
  vendorPrefix: 'z-ai/',
})

export const zaiProvider = zai.provider
