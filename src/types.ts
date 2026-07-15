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
  /** E-1 (quote-pin) : jeton de devis signé émis par /v1/plan. Présent = la requête
   * s'exécute SOUS CONTRAT (borne recalculée <= montant quoté, sinon 409). Opaque à
   * l'appelant, retiré avant le forward (n'atteint jamais le provider). */
  quote_token?: string
  /** E-1 (programme) : index PLAT de l'étage couvert par un jeton kind=program rejoué
   * par le runtime multi-lang sur chaque appel d'étage. */
  quote_stage?: number
  /** WS2 : AST MULTI complet (forme gelée §3.6) soumis à /v1/plan pour un devis
   * PROGRAMME (borne pipeline entier). Validé par validateProgram (jamais de confiance). */
  program?: unknown
  /** Borne d'octets du stdin du run programme — absent = les étages qui lisent stdin
   * sont quotés à vide et marqués guaranteed=false. */
  stdin_bytes?: number
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
  /** API OpenAI moderne : prime sur max_tokens (déprécié). Dans l'allowlist upstream. */
  max_completion_tokens?: number
  /** Nombre de complétions ; multiplie les tokens de sortie facturés. Dans l'allowlist. */
  n?: number
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
  /** E-1 (quote-pin) : le SNAPSHOT de candidats considéré pour cette décision (l'ensemble
   * résolu du tier, ou [model] pour un pin/id concret/image). C'est le matériau du jeton
   * de devis (le pin est un ensemble, jamais un modèle imposé) et la contrainte que le
   * vérificateur du jeton applique (le modèle résolu doit y rester). */
  candidates?: string[]
}

/** Hono environment: the auth middleware stashes the calling project's API key here. */
export type AppEnv = { Variables: { apiKey: string } }
