// Chemin d'accès direct Mistral (spec multi-provider §3). Endpoint/ids/prix vérifiés le
// 2026-06-22 (docs.mistral.ai + mistral.ai/pricing). API OpenAI-compatible ; l'usage en
// stream exige stream_options.include_usage (déjà posé par la fabrique). Pas de
// transformation de corps nécessaire pour le câblage de base → simple instance.

import { config } from '../config.js'
import { makeOpenAICompatibleProvider } from './openai-compatible.js'

const mistral = makeOpenAICompatibleProvider({
  name: 'mistral',
  baseUrl: config.mistral.baseUrl,
  apiKey: config.mistral.apiKey,
  vendorPrefix: 'mistralai/',
})

export const mistralProvider = mistral.provider
