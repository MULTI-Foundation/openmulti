// The router: turn a caller's intention (model alias + openmulti extension) into a
// concrete model id + a human-readable reason. This is the seam where intelligence
// lands later (v1 routing, v2 learning); v0 is a deterministic mapping.

import { candidatesFor, IMAGE_MODEL, DEFAULT_TIER, isTier } from './catalog.js'
import { selectModel } from './select.js'
import { config } from './config.js'
import type { ChatRequest, RouteDecision, RouteStrategy, Tier } from './types.js'

// "auto", "auto:economy", "auto:quality" -> tier (if encoded in the alias).
function tierFromModelAlias(model: string | undefined): Tier | null {
  if (!model) return null
  if (model === 'auto') return null
  const m = /^auto:(economy|balanced|quality)$/.exec(model)
  return m ? (m[1] as Tier) : null
}

/**
 * Decide which concrete model to call.
 *
 * Precedence:
 *   1. openmulti.allow -> hard constraint, pick the first allowed (v0). The router
 *      may NOT exceed this set. (Used when a caller pins a specific model.)
 *   2. A concrete provider/model id passed as `model` (not "auto*") -> honored as-is.
 *   3. tier, from openmulti.tier or the "auto:<tier>" alias or DEFAULT_TIER.
 *
 * `constrainTo` (E-1, quote-pin) : snapshot de candidats épinglé par un jeton de devis.
 * La sélection (default/smart) tourne NORMALEMENT, mais restreinte à l'intersection
 * candidats-du-tier ∩ snapshot — le pin est un ensemble, jamais un modèle imposé.
 * Intersection vide (catalogue changé depuis le devis) : la sélection retombe sur les
 * candidats courants et c'est le VÉRIFICATEUR du jeton qui rejette (le modèle résolu
 * sort du snapshot) — route() ne refuse jamais, il décide.
 */
export function route(req: ChatRequest, constrainTo?: readonly string[]): RouteDecision {
  const allow = req.openmulti?.allow
  if (allow && allow.length > 0) {
    return { model: allow[0]!, reason: `pinned to caller allowlist (${allow.length} allowed)`, candidates: [allow[0]!] }
  }

  const alias = tierFromModelAlias(req.model)
  const looksConcrete =
    typeof req.model === 'string' && req.model !== 'auto' && alias === null && req.model.includes('/')
  if (looksConcrete) {
    return { model: req.model as string, reason: 'caller pinned a concrete model', candidates: [req.model as string] }
  }

  // Image generation is a chat completion with image modality. An `auto`/tier
  // request that wants image output needs an image-capable model, not a text tier.
  // (A caller that pinned a concrete image model is already handled above.)
  if (Array.isArray(req.modalities) && req.modalities.includes('image')) {
    return { model: IMAGE_MODEL, reason: 'image generation', candidates: [IMAGE_MODEL] }
  }

  const tier: Tier = req.openmulti?.tier && isTier(req.openmulti.tier)
    ? req.openmulti.tier
    : alias ?? DEFAULT_TIER

  const purpose = req.openmulti?.purpose
  const strategy: RouteStrategy = req.openmulti?.route === 'smart' ? 'smart' : config.defaultRoute
  let candidates = candidatesFor(tier, purpose)
  // E-1 : restreindre au snapshot épinglé s'il y a intersection ; sinon garder les
  // candidats courants — le vérificateur du jeton tranchera (candidate_set_mismatch).
  if (constrainTo && constrainTo.length > 0) {
    const pinned = candidates.filter((m) => constrainTo.includes(m))
    if (pinned.length > 0) candidates = pinned
  }
  const sel = selectModel(candidates, strategy)

  const reason = [purpose ? `${purpose} task` : null, `${tier} tier`, sel.note || null]
    .filter(Boolean)
    .join(', ')

  // OM-01: optional per-tier max_tokens ceiling (tier is 'economy'|'balanced'|'quality',
  // so the env name is safe to build directly). 0/unset disables it.
  const ceiling = Number(process.env[`OPENMULTI_MAX_TOKENS_${tier.toUpperCase()}`] ?? 0)
  return { model: sel.model, reason, maxTokensCeiling: ceiling > 0 ? ceiling : undefined, candidates }
}
