// Chemin d'accès direct OpenAI (spec multi-provider §3). Endpoint/ids/quirks vérifiés
// le 2026-06-22 (developers.openai.com + la matrice « reasoning » des docs modèles).
//
// OpenAI est OpenAI-shape par définition — donc instance de la fabrique générique. La
// seule subtilité : les modèles de RAISONNEMENT (famille gpt-5*, série o*) refusent
// `max_tokens` (il faut `max_completion_tokens`) ET les paramètres d'échantillonnage
// (`temperature`, `top_p`, penalties, logprobs…). Un proxy fiable réécrit/retire ces
// champs plutôt que de laisser l'upstream renvoyer un 400. Les modèles non-raisonnement
// (gpt-4.1, gpt-4o-mini, chat-latest) passent tels quels.
//
// `finalize` tourne APRÈS le plafond de tier : on renomme la valeur déjà plafonnée.

import { config } from '../config.js'
import { makeOpenAICompatibleProvider } from './openai-compatible.js'

/** Modèle de raisonnement OpenAI (famille gpt-5*, série o1/o3/o4…) — l'id est déjà nu
 * (préfixe vendor retiré). Ces modèles imposent max_completion_tokens et rejettent les
 * paramètres d'échantillonnage. */
export function isOpenAIReasoningModel(id: string): boolean {
  return /^gpt-5/.test(id) || /^o[1-9]/.test(id)
}

// Paramètres d'échantillonnage non supportés par les modèles de raisonnement (liste
// vérifiée sur la doc « reasoning » OpenAI, 2026-06-22).
const REASONING_UNSUPPORTED = [
  'temperature', 'top_p', 'presence_penalty', 'frequency_penalty',
  'logprobs', 'top_logprobs', 'logit_bias',
] as const

const openai = makeOpenAICompatibleProvider({
  name: 'openai',
  baseUrl: config.openai.baseUrl,
  apiKey: config.openai.apiKey,
  vendorPrefix: 'openai/',
  finalize: (body) => {
    // body.model est l'id nu (la fabrique a déjà retiré le préfixe).
    if (!isOpenAIReasoningModel(String(body.model))) return
    // max_tokens -> max_completion_tokens (sans écraser une valeur déjà posée).
    if (body.max_tokens !== undefined) {
      if (body.max_completion_tokens === undefined) body.max_completion_tokens = body.max_tokens
      delete body.max_tokens
    }
    // Retire les paramètres d'échantillonnage que l'upstream rejetterait.
    for (const f of REASONING_UNSUPPORTED) delete body[f]
  },
})

export const buildOpenAIBody = openai.buildBody
export const openaiModelId = openai.modelId
export const openaiProvider = openai.provider
