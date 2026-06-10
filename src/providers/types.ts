// The Provider seam (docs/MULTI-PROVIDER-SPEC.md §3): everything that varies from one
// upstream provider to another lives behind this interface — endpoint/auth, body
// steering, retryable statuses, response normalization. The route handler only ever
// talks to a Provider; it owns what is COMMON to all of them (retry loop, watchdog,
// metrics, the openmulti extension echo).
//
// v0 has a single implementation (OpenRouter). `adaptStream` (SSE re-encoding for
// non-OpenAI-shaped providers, spec §3) is deliberately NOT here yet: the stream path
// is a byte-for-byte passthrough today, and the contract wants it that way. It lands
// with the first provider that actually needs translation (spec step 5).

import type { ChatRequest } from '../types.js'

export interface UpstreamCall {
  response: Response
  abort: AbortController
}

export interface Provider {
  /** Stable id, surfaced in logs/metrics later (e.g. 'openrouter', 'anthropic'). */
  name: string
  /** Build the outgoing body: strip `openmulti`, set the resolved model, apply the
   * provider's own steering. Must NOT leak another provider's steering. */
  buildBody(req: ChatRequest, model: string, maxTokensCeiling?: number): Record<string, unknown>
  /** POST to the provider (endpoint, auth headers, 30s connect timeout). */
  call(body: Record<string, unknown>): Promise<UpstreamCall>
  /** Transient statuses worth retrying on the SAME model. */
  isRetryable(status: number): boolean
  /** Normalize a non-stream response to the OpenAI shape with usage.cost populated.
   * MUST be the identity for OpenAI-shaped providers that already report cost
   * (the no-extension response is contractually byte-identical to the upstream). */
  normalizeResponse(data: Record<string, unknown>, model: string): Record<string, unknown>
  /** Optional: adapt the upstream SSE byte stream before it is piped to the client.
   * Absent = byte-for-byte passthrough (the OpenRouter path). Direct providers use it
   * to keep the stream contract-equivalent (e.g. inject the synthesized usage.cost
   * into the final usage chunk — coupling point #1 applies to streams too). */
  adaptStream?(upstream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array>
}
