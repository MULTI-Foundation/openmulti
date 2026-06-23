// Chemin d'accès direct Qwen (Alibaba DashScope, mode OpenAI-compatible, surface
// internationale). Endpoint/ids/prix vérifiés le 2026-06-23 sur
// alibabacloud.com/help/en/model-studio. include_usage standard, préfixe catalogue
// 'qwen/' (id OpenRouter) retiré pour donner l'id DashScope ('qwen-plus'…).
//
// Particularités Qwen NON gérées par ce câblage de base (à activer plus tard si besoin) :
//   - le « deep thinking » se pilote par des champs top-level non-OpenAI
//     (enable_thinking / thinking_budget / preserve_thinking) que l'allowlist OM-06
//     retire ; les modèles commerciaux (qwen-max/plus/flash) ont le thinking OFF par
//     défaut, donc le proxy de base reste cohérent. Pour l'exposer : ajouter ces champs
//     via OPENMULTI_ALLOWED_EXTRA_FIELDS.
//   - `tools` + `stream=true` sont mutuellement exclusifs côté Qwen (l'upstream rejette,
//     erreur normalisée OM-07). `reasoning_content` (réponses thinking) transite tel quel.
// Donc, comme DeepSeek/Mistral/Z.ai : simple instance de la fabrique.

import { config } from '../config.js'
import { makeOpenAICompatibleProvider } from './openai-compatible.js'

const qwen = makeOpenAICompatibleProvider({
  name: 'qwen',
  baseUrl: config.qwen.baseUrl,
  apiKey: config.qwen.apiKey,
  vendorPrefix: 'qwen/',
})

export const qwenProvider = qwen.provider
