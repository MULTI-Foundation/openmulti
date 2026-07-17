// Chemin d'accès direct DeepSeek (spec multi-provider §3). Endpoint/ids/prix vérifiés
// le 2026-06-22 (api-docs.deepseek.com). API OpenAI-compatible, include_usage standard.
// Base SANS /v1 (canonique). Le champ `reasoning_content` des réponses thinking-mode
// n'est PAS un champ OpenAI mais transite tel quel (la normalisation n'ajoute que le
// cost) - rien à faire côté corps. Donc simple instance de la fabrique.

import { config } from '../config.js'
import { makeOpenAICompatibleProvider } from './openai-compatible.js'

const deepseek = makeOpenAICompatibleProvider({
  name: 'deepseek',
  baseUrl: config.deepseek.baseUrl,
  apiKey: config.deepseek.apiKey,
  vendorPrefix: 'deepseek/',
  steer: (body, resolvedModel) => {
    // Thinking mode V4 (défaut: enabled, api-docs.deepseek.com/guides/thinking_mode) :
    // dans une boucle d'outils, l'API exige que le `reasoning_content` des tours
    // assistant soit renvoyé tel quel, sinon 400 "must be passed back to the API"
    // (vécu prod 2026-07-17). Un appelant OpenAI-shape (OpenClaw/MyMULTI) ne le
    // round-trip jamais : on coupe le thinking quand la requête a des `tools` et
    // qu'aucun message assistant de l'historique ne porte de reasoning_content.
    // Un appelant DeepSeek-aware qui round-trip garde le thinking.
    if (!resolvedModel.startsWith('deepseek/deepseek-v4') || !body.tools || body.thinking !== undefined) return
    const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : []
    const roundTrips = messages.some((m) => m?.role === 'assistant' && typeof m.reasoning_content === 'string')
    if (!roundTrips) body.thinking = { type: 'disabled' }
  },
})

export const deepseekProvider = deepseek.provider
