// The router: turn a caller's intention (model alias + openmulti extension) into a
// concrete model id + a human-readable reason. This is the seam where intelligence
// lands later (v1 routing, v2 learning); v0 is a deterministic mapping.

import { candidatesFor, IMAGE_MODEL, DEFAULT_TIER, isTier } from './catalog.js'
import { selectModel } from './select.js'
import { resolveBareModel, resolveFamilyModel } from './model-alias.js'
import { config } from './config.js'
import type { ChatRequest, RouteDecision, RouteStrategy, Tier } from './types.js'

/**
 * Refus de routage : un `model` nu (sans '/') inconnu ou ambigu, ou un objectif connu
 * mais pas encore servable (« fastest » sans données de latence). Toujours servi en
 * 400 structuré par les surfaces (chat, plan, x402, council) — jamais un repli
 * silencieux vers le tier par défaut (le piège historique : demander « kimi-k2.6 »
 * servait le primaire balanced, facturé, sans erreur).
 */
export class RouteRefusal extends Error {
  readonly status = 400 as const
  constructor(
    readonly code: 'model_unknown' | 'model_ambiguous' | 'objective_unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'RouteRefusal'
  }
}

// "auto", "auto:economy", "auto:quality" -> tier (if encoded in the alias).
function tierFromModelAlias(model: string | undefined): Tier | null {
  if (!model) return null
  if (model === 'auto') return null
  const m = /^auto:(economy|balanced|quality)$/.exec(model)
  return m ? (m[1] as Tier) : null
}

/** Cible NOMMÉE du langage MULTI : un niveau de gamme (@light/@mid/@max) ou un
 * objectif (@best/@cheapest). Résolue vers un tier, plus une stratégie IMPOSÉE pour
 * les objectifs : `best` = le primaire curé du tier quality (la stratégie 'default'
 * EST « le meilleur du moment », le bandit optimiserait le coût à rebours de
 * l'objectif) ; `cheapest` = le bandit ('smart', exploit = moins cher sain) sur le
 * tier economy. Cette stratégie d'objectif prime sur `openmulti.route` et sur
 * OPENMULTI_DEFAULT_ROUTE : l'objectif est la demande la plus explicite. */
interface NamedTarget {
  tier: Tier
  strategy?: RouteStrategy
  label: string
}

const NAMED_TARGETS: Record<string, NamedTarget> = {
  light: { tier: 'economy', label: 'light level' },
  mid: { tier: 'balanced', label: 'mid level' },
  max: { tier: 'quality', label: 'max level' },
  best: { tier: 'quality', strategy: 'default', label: 'best objective' },
  cheapest: { tier: 'economy', strategy: 'smart', label: 'cheapest objective' },
}

/** Résout un mot-cible nommé ; `fastest` est CONNU mais refusé tant que le gateway
 * n'observe pas la latence — une erreur claire vaut mieux qu'un routage mensonger. */
function resolveNamedTarget(word: string): NamedTarget | null {
  if (word === 'fastest') {
    throw new RouteRefusal(
      'objective_unavailable',
      'objective "fastest" is not available yet (no latency data) — use "auto", "cheapest", "best", or a tier',
    )
  }
  return NAMED_TARGETS[word] ?? null
}

/**
 * Pin par nom nu ou par famille : suffixe exact d'abord (« kimi-k2.6 »), famille
 * ensuite (« claude » → le mieux classé du catalogue courant). Ambigu = refus
 * explicite listant les candidats. Inconnu = refus (canal `model`, refuseUnknown) ou
 * null (canal `tier`, où l'appelant garde le repli historique vers le tier par défaut).
 */
function resolvePinnedName(word: string, refuseUnknown = true): RouteDecision | null {
  const hint = 'use a canonical "vendor/model" id, "auto", or "auto:<economy|balanced|quality>"'
  const exact = resolveBareModel(word)
  if (exact.kind === 'resolved') {
    return {
      model: exact.model,
      reason: `caller pinned "${word}" (resolved to ${exact.model})`,
      candidates: [exact.model],
    }
  }
  if (exact.kind === 'ambiguous') {
    throw new RouteRefusal(
      'model_ambiguous',
      `ambiguous model name "${word}" (matches: ${exact.matches.join(', ')}) — ${hint}`,
    )
  }
  const family = resolveFamilyModel(word)
  if (family.kind === 'resolved') {
    return {
      model: family.model,
      reason: `family "${word}" (best available: ${family.model})`,
      candidates: [family.model],
    }
  }
  if (family.kind === 'ambiguous') {
    throw new RouteRefusal(
      'model_ambiguous',
      `ambiguous family "${word}" (matches: ${family.matches.join(', ')}, none in the current catalog) — ${hint}`,
    )
  }
  if (refuseUnknown) {
    throw new RouteRefusal('model_unknown', `unknown model "${word}" — ${hint}`)
  }
  return null
}

/**
 * Decide which concrete model to call.
 *
 * Precedence:
 *   1. openmulti.allow -> hard constraint, pick the first allowed (v0). The router
 *      may NOT exceed this set. (Used when a caller pins a specific model.)
 *   2. A concrete provider/model id passed as `model` (not "auto*") -> honored as-is.
 *   2b. A named target or bare/family model name passed as `model` (light/mid/max/
 *       best/cheapest -> tier below; "kimi-k2.6"/"claude" -> pin; unknown -> refusal).
 *   3. tier, from openmulti.tier (canonical tier, named target, or bare/family name —
 *      the verbatim MULTI target channel) or the "auto:<tier>" alias or DEFAULT_TIER.
 *      An objective's strategy (best -> 'default', cheapest -> 'smart') overrides the
 *      caller's `route` and the configured default.
 *
 * `constrainTo` (E-1, quote-pin) : snapshot de candidats épinglé par un jeton de devis.
 * La sélection (default/smart) tourne NORMALEMENT, mais restreinte à l'intersection
 * candidats-du-tier ∩ snapshot — le pin est un ensemble, jamais un modèle imposé.
 * Intersection vide (catalogue changé depuis le devis) : la sélection retombe sur les
 * candidats courants et c'est le VÉRIFICATEUR du jeton qui rejette (le modèle résolu
 * sort du snapshot) — sous contrainte, route() ne refuse jamais, il décide.
 *
 * SEULE exception (RouteRefusal) : un `model` nu (sans '/') inconnu ou ambigu — voir
 * model-alias.ts. Toutes les surfaces qui routent du `model` appelant doivent le
 * servir en 400 structuré.
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

  // Mot NU dans `model` (string non vide, pas 'auto'/'auto:<tier>', sans '/') :
  // d'abord une cible NOMMÉE du langage (light/mid/max/best/cheapest — route vers un
  // tier, plus bas), sinon résolution stricte vers l'id canonique par correspondance
  // UNIQUE de suffixe puis par FAMILLE (model-alias.ts). Inconnu ou ambigu →
  // RouteRefusal (400 aux surfaces), jamais le tier par défaut en silence.
  const modelWord =
    typeof req.model === 'string' && req.model.length > 0 && req.model !== 'auto' && alias === null
      ? req.model
      : null
  const modelNamed = modelWord !== null ? resolveNamedTarget(modelWord) : null
  if (modelWord !== null && modelNamed === null) {
    const pinned = resolvePinnedName(modelWord)
    if (pinned) return pinned
  }

  // Image generation is a chat completion with image modality. An `auto`/tier
  // request that wants image output needs an image-capable model, not a text tier.
  // (A caller that pinned a concrete image model is already handled above.)
  if (Array.isArray(req.modalities) && req.modalities.includes('image')) {
    return { model: IMAGE_MODEL, reason: 'image generation', candidates: [IMAGE_MODEL] }
  }

  // Le canal `openmulti.tier` transporte la cible VERBATIM des clients MULTI
  // (multi-lang envoie `@cible` telle quelle) : un tier canonique d'abord, sinon une
  // cible nommée (@light/@best…), sinon un nom de modèle nu ou de famille (@claude,
  // @kimi-k2.6 — le même piège du repli silencieux, fermé ici aussi). Un mot inconnu
  // de tout cela garde le repli historique vers le tier par défaut (contrat
  // multi-lang : « tier inconnu = fallback serveur »).
  let named = modelNamed
  let tier: Tier
  const rawTier = req.openmulti?.tier
  if (rawTier && isTier(rawTier)) {
    tier = rawTier
  } else {
    if (named === null && typeof rawTier === 'string' && rawTier.length > 0) {
      named = resolveNamedTarget(rawTier)
      if (named === null) {
        const pinned = resolvePinnedName(rawTier, /* refuseUnknown */ false)
        if (pinned) return pinned
      }
    }
    tier = named?.tier ?? alias ?? DEFAULT_TIER
  }

  const purpose = req.openmulti?.purpose
  const strategy: RouteStrategy =
    named?.strategy ?? (req.openmulti?.route === 'smart' ? 'smart' : config.defaultRoute)
  let candidates = candidatesFor(tier, purpose)
  // E-1 : restreindre au snapshot épinglé s'il y a intersection ; sinon garder les
  // candidats courants — le vérificateur du jeton tranchera (candidate_set_mismatch).
  if (constrainTo && constrainTo.length > 0) {
    const pinned = candidates.filter((m) => constrainTo.includes(m))
    if (pinned.length > 0) candidates = pinned
  }
  const sel = selectModel(candidates, strategy)

  const reason = [named?.label ?? null, purpose ? `${purpose} task` : null, `${tier} tier`, sel.note || null]
    .filter(Boolean)
    .join(', ')

  // OM-01: optional per-tier max_tokens ceiling (tier is 'economy'|'balanced'|'quality',
  // so the env name is safe to build directly). 0/unset disables it.
  const ceiling = Number(process.env[`OPENMULTI_MAX_TOKENS_${tier.toUpperCase()}`] ?? 0)
  return { model: sel.model, reason, maxTokensCeiling: ceiling > 0 ? ceiling : undefined, candidates }
}
