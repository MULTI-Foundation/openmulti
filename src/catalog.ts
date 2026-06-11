// The catalog: tier -> concrete model. This is the ONE place a maintainer changes
// "which model is the economy / balanced / quality model" without any consuming
// project (MyMULTI included) having to change a line.
//
// v0: each tier maps to a single fixed model (iso-comportement with today's MyMULTI
//     DEFAULT_MODELS). v1 will turn each tier into a candidate set the router picks
//     from based on the task; v2 learns from feedback.

import type { Tier } from './types.js'

// Default primary model per tier — the iso-comportement model. It MUST stay the first
// candidate so the 'default' selection strategy reproduces today's behavior exactly.
const TIER_DEFAULT: Record<Tier, string> = {
  economy: 'anthropic/claude-haiku-4-5',
  balanced: 'anthropic/claude-sonnet-4-5',
  quality: 'anthropic/claude-opus-4-1',
}

// Routing par tache: certaines taches ont un modele plus adapte que le defaut du tier.
// 'agent' = generation de code longue (containers OpenClaw): on route vers un modele de
// code (Kimi K2.6) sur balanced/quality. C'est pourquoi le floor max_tokens Kimi et le
// steering provider de buildUpstreamBody se declenchent pour ces appels.
const PURPOSE_DEFAULT: Record<string, Partial<Record<Tier, string>>> = {
  agent: { balanced: 'moonshotai/kimi-k2.6', quality: 'moonshotai/kimi-k2.6' },
}

function envList(name: string): string[] | undefined {
  const v = process.env[name]
  if (!v) return undefined
  const list = v.split(',').map((s) => s.trim()).filter(Boolean)
  return list.length ? list : undefined
}

const envName = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '_')

/**
 * Ordered candidate models for a (tier, purpose). The FIRST is the iso-comportement
 * primary — the 'default' strategy always picks it, so behavior is unchanged unless a
 * caller opts into 'smart' (see select.ts). Config precedence per slot:
 *   1. plural env OPENMULTI_MODELS_[PURPOSE_]TIER (comma-separated) -> the full set
 *   2. singular env OPENMULTI_MODEL_[PURPOSE_]TIER (back-compat) -> a one-model set
 *   3. built-in default
 * A purpose with no model of its own falls through to the tier candidates.
 */
export function candidatesFor(tier: Tier, purpose?: string): string[] {
  const T = envName(tier)
  if (purpose) {
    const slot = `${envName(purpose)}_${T}`
    const plural = envList(`OPENMULTI_MODELS_${slot}`)
    if (plural) return plural
    const single = process.env[`OPENMULTI_MODEL_${slot}`] || PURPOSE_DEFAULT[purpose]?.[tier]
    if (single) return [single]
  }
  return envList(`OPENMULTI_MODELS_${T}`) ?? [process.env[`OPENMULTI_MODEL_${T}`] || TIER_DEFAULT[tier]]
}

// Image generation is a /v1/chat/completions call with modalities:['image','text']
// (OpenRouter contract). When a caller asks for image output via `auto` (rather than
// pinning a concrete image model), the router resolves to this model — a text tier
// would be wrong. Image gen is part of bloc A (OpenMulti owns it), cf ARCHITECTURE.md.
export const IMAGE_MODEL = process.env.OPENMULTI_MODEL_IMAGE || 'google/gemini-2.5-flash-image'

// Modèle d'embeddings par défaut quand l'appelant envoie model:'auto' sur
// /v1/embeddings. Id vérifié sur openrouter.ai/collections/embedding-models
// (2026-06-11) : le standard le moins cher ($0.02/MTok input).
export const EMBEDDING_MODEL = process.env.OPENMULTI_MODEL_EMBEDDING || 'openai/text-embedding-3-small'

export const DEFAULT_TIER: Tier = 'balanced'

export function isTier(v: unknown): v is Tier {
  return v === 'economy' || v === 'balanced' || v === 'quality'
}

const TIERS: Tier[] = ['economy', 'balanced', 'quality']

export interface CatalogEntry {
  model: string
  /** Tiers où ce modèle apparaît comme candidat (hors purpose). */
  tiers: Tier[]
  /** Purposes où ce modèle apparaît ('image' = le modèle de génération d'image). */
  purposes: string[]
}

/**
 * Inventaire des modèles servis (pour GET /v1/models) : candidats de chaque tier,
 * modèles par purpose (intégrés + pilotés par env), et le modèle image. Les purposes
 * découverts via l'env sont dé-manglés par approximation (AGENT -> agent,
 * EDIT_HTML_BLOCK -> edit-html-block) — exact pour les purposes kebab-case
 * conventionnels, cf envName().
 */
export function catalogModels(): CatalogEntry[] {
  const map = new Map<string, CatalogEntry>()
  const add = (model: string, tier?: Tier, purpose?: string) => {
    let e = map.get(model)
    if (!e) {
      e = { model, tiers: [], purposes: [] }
      map.set(model, e)
    }
    if (tier && !e.tiers.includes(tier)) e.tiers.push(tier)
    if (purpose && !e.purposes.includes(purpose)) e.purposes.push(purpose)
  }

  for (const tier of TIERS) for (const m of candidatesFor(tier)) add(m, tier)

  const purposes = new Set<string>(Object.keys(PURPOSE_DEFAULT))
  for (const k of Object.keys(process.env)) {
    const m = /^OPENMULTI_MODELS?_([A-Z0-9_]+)_(ECONOMY|BALANCED|QUALITY)$/.exec(k)
    if (m) purposes.add(m[1]!.toLowerCase().replace(/_/g, '-'))
  }
  for (const purpose of purposes) {
    for (const tier of TIERS) {
      // Ne lister que les purposes qui ont VRAIMENT un modèle propre sur ce tier
      // (candidatesFor retombe sur le tier sinon, ce qui dupliquerait tout).
      const own = candidatesFor(tier, purpose)
      const base = candidatesFor(tier)
      if (own.join(',') !== base.join(',')) for (const m of own) add(m, undefined, purpose)
    }
  }

  add(IMAGE_MODEL, undefined, 'image')
  add(EMBEDDING_MODEL, undefined, 'embedding')
  return [...map.values()]
}
