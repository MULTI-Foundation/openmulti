// The catalog: tier -> concrete model. This is the ONE place a maintainer changes
// "which model is the economy / balanced / quality model" without any consuming
// project (MyMULTI included) having to change a line.
//
// v0: each tier maps to a single fixed model (iso-comportement with today's MyMULTI
//     DEFAULT_MODELS). v1 will turn each tier into a candidate set the router picks
//     from based on the task; v2 learns from feedback.

import type { Tier } from './types.js'

export const TIER_MODELS: Record<Tier, string> = {
  economy: process.env.OPENMULTI_MODEL_ECONOMY || 'anthropic/claude-haiku-4-5',
  balanced: process.env.OPENMULTI_MODEL_BALANCED || 'anthropic/claude-sonnet-4-5',
  quality: process.env.OPENMULTI_MODEL_QUALITY || 'anthropic/claude-opus-4-1',
}

// Routing par tache: certaines taches ont un modele plus adapte que le defaut du tier.
// 'agent' = generation de code longue (containers OpenClaw): on route vers un modele de
// code (Kimi K2.6) sur balanced/quality. C'est pourquoi le floor max_tokens Kimi et le
// steering provider de buildUpstreamBody se declenchent pour ces appels. Premier pas de
// l'intelligence "le bon modele pour la bonne tache"; etendre/affiner ici.
const PURPOSE_OVERRIDES: Record<string, Partial<Record<Tier, string>>> = {
  agent: {
    balanced: process.env.OPENMULTI_MODEL_AGENT_BALANCED || 'moonshotai/kimi-k2.6',
    quality: process.env.OPENMULTI_MODEL_AGENT_QUALITY || 'moonshotai/kimi-k2.6',
  },
}

/** Resolve the concrete model for a tier, refined by task when a purpose is given. */
export function modelFor(tier: Tier, purpose?: string): string {
  const override = purpose ? PURPOSE_OVERRIDES[purpose]?.[tier] : undefined
  return override ?? TIER_MODELS[tier]
}

export const IMAGE_MODEL = process.env.OPENMULTI_MODEL_IMAGE || 'google/gemini-2.5-flash-image'

export const DEFAULT_TIER: Tier = 'balanced'

export function isTier(v: unknown): v is Tier {
  return v === 'economy' || v === 'balanced' || v === 'quality'
}
