// OpenAI-compatible request/response shapes plus the OpenMulti extension.

export type Tier = 'economy' | 'balanced' | 'quality'

export type Purpose = 'generation' | 'light' | 'agent' | 'edit-html-block' | string

/** How OpenMulti picks among a tier's candidate models. */
export type RouteStrategy = 'default' | 'smart'

/** The OpenMulti extension block a caller may attach to a chat request. */
export interface OpenMultiExtension {
  tier?: Tier
  purpose?: Purpose
  /** Hard constraint: pick only within these concrete model IDs. */
  allow?: string[]
  /** Selection strategy among tier candidates. Defaults to OPENMULTI_DEFAULT_ROUTE. */
  route?: RouteStrategy
  /** Council / fusion (mixture-of-agents) — opt-in. Présent = la requête est délibérée
   * par un panel puis synthétisée (cf council.ts). Coûteux (N+1 ou 2N+1 appels). */
  council?: CouncilRequest
}

/** Configuration de la délibération council (toutes optionnelles : presets/défauts). */
export interface CouncilRequest {
  /** Preset d'exploitation : 'flash' (rapide) | 'budget' | 'quality' (mappé à un panel). */
  preset?: string
  /** Override explicite du panel (ids de modèle, 1-8). Prime sur le preset. */
  panel?: string[]
  /** Modèle juge/synthétiseur (chair). Défaut : OPENMULTI_COUNCIL_CHAIR. */
  chair?: string
  /** 'fuse' (panel -> chair, défaut) | 'deliberate' (panel -> revue pairs -> chair). */
  mode?: 'fuse' | 'deliberate'
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: unknown
  /** Champs OpenAI additionnels (tool_calls, tool_call_id, name…) — pass-through. */
  [k: string]: unknown
}

/** Incoming chat request (OpenAI-compatible + openmulti extension). */
export interface ChatRequest {
  model?: string // "auto", "auto:economy", or a concrete provider/model id
  messages: ChatMessage[]
  stream?: boolean
  max_tokens?: number
  temperature?: number
  usage?: { include?: boolean }
  provider?: Record<string, unknown>
  modalities?: string[]
  openmulti?: OpenMultiExtension
  [k: string]: unknown // pass-through for any other OpenAI fields
}

/** What the router decided, attached to responses for traceability. */
export interface RouteDecision {
  model: string
  reason: string
  /** OM-01: optional per-tier ceiling on max_tokens to bound unit cost (0/undef = none). */
  maxTokensCeiling?: number
}

/** Hono environment: the auth middleware stashes the calling project's API key here. */
export type AppEnv = { Variables: { apiKey: string } }
