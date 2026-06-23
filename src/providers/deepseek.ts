// Chemin d'accès direct DeepSeek (spec multi-provider §3). Endpoint/ids/prix vérifiés
// le 2026-06-22 (api-docs.deepseek.com). API OpenAI-compatible, include_usage standard.
// Base SANS /v1 (canonique). Le champ `reasoning_content` des réponses thinking-mode
// n'est PAS un champ OpenAI mais transite tel quel (la normalisation n'ajoute que le
// cost) — rien à faire côté corps. Donc simple instance de la fabrique.

import { config } from '../config.js'
import { makeOpenAICompatibleProvider } from './openai-compatible.js'

const deepseek = makeOpenAICompatibleProvider({
  name: 'deepseek',
  baseUrl: config.deepseek.baseUrl,
  apiKey: config.deepseek.apiKey,
  vendorPrefix: 'deepseek/',
})

export const deepseekProvider = deepseek.provider
