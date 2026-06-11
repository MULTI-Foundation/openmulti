// Partagé entre adaptateurs provider — ce qui est commun à (presque) tous les
// upstreams HTTP, indépendamment de leur forme d'API.

import { log } from '../log.js'
import { recordFieldStripped } from '../metrics.js'

// OM-06 : allowlist des champs de requête transmis à l'upstream. Tout champ hors
// liste est RETIRÉ (pas de 400 : on ne casse pas un appelant qui envoie un extra
// inoffensif), compté dans openmulti_request_fields_stripped_total et loggé une fois
// par nom de champ. Vérifié contre l'usage réel de MyMUlTI (model, messages,
// max_tokens, temperature, usage, stream, modalities) — large marge.
const ALLOWED_CHAT_FIELDS = new Set([
  // OpenAI chat completions
  'model', 'messages', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens',
  'temperature', 'top_p', 'n', 'stop', 'presence_penalty', 'frequency_penalty',
  'logit_bias', 'logprobs', 'top_logprobs', 'user', 'seed', 'tools', 'tool_choice',
  'parallel_tool_calls', 'response_format', 'modalities', 'audio', 'prediction',
  // extensions OpenRouter explicitement supportées
  'usage', 'provider', 'transforms', 'models', 'route', 'reasoning', 'plugins',
  'web_search_options', 'top_k', 'min_p', 'top_a', 'repetition_penalty',
])

export const ALLOWED_EMBEDDINGS_FIELDS = new Set([
  'model', 'input', 'dimensions', 'encoding_format', 'user',
])

// Soupape sans release : étendre l'allowlist par env (CSV), ex. un nouveau champ
// OpenAI pas encore dans la liste.
for (const f of (process.env.OPENMULTI_ALLOWED_EXTRA_FIELDS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  ALLOWED_CHAT_FIELDS.add(f)
  ALLOWED_EMBEDDINGS_FIELDS.add(f)
}

const warnedFields = new Set<string>()

/** OM-06 : ne garde que les champs autorisés. `openmulti` est géré par l'appelant
 * (strippé par les buildBody) et n'est pas un champ upstream. */
export function pickAllowedFields(
  req: Record<string, unknown>,
  allowed: Set<string> = ALLOWED_CHAT_FIELDS,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(req)) {
    if (k === 'openmulti') continue // extension OpenMulti, jamais transmise (et pas un strip à compter)
    if (allowed.has(k)) {
      out[k] = v
    } else {
      recordFieldStripped()
      if (!warnedFields.has(k)) {
        warnedFields.add(k)
        log.warn('request_field_stripped', { field: k })
      }
    }
  }
  return out
}

// OM-07 : normalisation des erreurs upstream. Le corps upstream n'est JAMAIS relayé
// (divulgation provider/routing/internals) — il est loggé côté serveur seulement.
// Le statut est conservé (les appelants s'y fient, MyMULTI compris) ; le corps devient
// un schéma OpenAI-shape stable.
export function normalizedUpstreamError(status: number): { error: { message: string; type: string; code: number } } {
  const type = status === 429 ? 'rate_limit_error' : status >= 500 ? 'upstream_error' : 'upstream_rejected'
  const message =
    status === 429
      ? 'Upstream rate limited the request'
      : status >= 500
        ? 'Upstream provider error'
        : 'Upstream rejected the request'
  return { error: { message, type, code: status } }
}

// Transient upstream statuses worth retrying on the SAME model. 4xx (bad request,
// auth, unprocessable) are deterministic — retrying won't help — except 429, which
// is a rate-limit hiccup and honors Retry-After.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status)
}

// Backoff before a retry: exponential (200ms, 400ms, …) capped at 2s. Honor a sane
// Retry-After (seconds) from the upstream, capped so a request can't hang on it.
export function backoff(attempt: number, retryAfter?: string | null): Promise<void> {
  let ms = Math.min(200 * 2 ** (attempt - 1), 2000)
  if (retryAfter) {
    const secs = Number(retryAfter)
    if (Number.isFinite(secs) && secs > 0) ms = Math.min(secs * 1000, 5000)
  }
  return new Promise((resolve) => setTimeout(resolve, ms))
}
