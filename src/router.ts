// The router: turn a caller's intention (model alias + openmulti extension) into a
// concrete model id + a human-readable reason. This is the seam where intelligence
// lands later (v1 routing, v2 learning); v0 is a deterministic mapping.

import { modelFor, DEFAULT_TIER, isTier } from './catalog.js'
import type { ChatRequest, RouteDecision, Tier } from './types.js'

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
 */
export function route(req: ChatRequest): RouteDecision {
  const allow = req.openmulti?.allow
  if (allow && allow.length > 0) {
    return { model: allow[0]!, reason: `pinned to caller allowlist (${allow.length} allowed)` }
  }

  const alias = tierFromModelAlias(req.model)
  const looksConcrete =
    typeof req.model === 'string' && req.model !== 'auto' && alias === null && req.model.includes('/')
  if (looksConcrete) {
    return { model: req.model as string, reason: 'caller pinned a concrete model' }
  }

  const tier: Tier = req.openmulti?.tier && isTier(req.openmulti.tier)
    ? req.openmulti.tier
    : alias ?? DEFAULT_TIER

  const purpose = req.openmulti?.purpose
  const model = modelFor(tier, purpose)
  const reason = purpose
    ? `${purpose} task, ${tier} tier`
    : `${tier} tier`

  return { model, reason }
}
