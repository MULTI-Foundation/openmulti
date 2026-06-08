// OpenAI-compatible request/response shapes plus the OpenMulti extension.

export type Tier = 'economy' | 'balanced' | 'quality'

export type Purpose = 'generation' | 'light' | 'agent' | 'edit-html-block' | string

/** The OpenMulti extension block a caller may attach to a chat request. */
export interface OpenMultiExtension {
  tier?: Tier
  purpose?: Purpose
  /** Hard constraint: pick only within these concrete model IDs. */
  allow?: string[]
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: unknown
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
}
