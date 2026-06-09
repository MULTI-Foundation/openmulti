// POST /v1/chat/completions - OpenAI-compatible, plus the openmulti extension.
//
// Flow: route (intention -> concrete model) -> steer -> forward upstream -> pipe back.
// Streaming pipes the upstream SSE untouched (so the caller's own usage parsing keeps
// working) and adds an inter-chunk watchdog. The route decision is surfaced via
// X-OpenMulti-* headers (stream) and the `openmulti` block (non-stream).

import { Hono } from 'hono'
import { route } from '../router.js'
import { buildUpstreamBody, callUpstream, isRetryableStatus } from '../providers/openrouter.js'
import { TIMEOUTS, config } from '../config.js'
import { log } from '../log.js'
import { recordRequest, recordRetry, keyLabel } from '../metrics.js'
import { SseUsageScanner } from '../sse.js'
import type { AppEnv, ChatRequest } from '../types.js'

export const chat = new Hono<AppEnv>()

// Backoff before a retry: exponential (200ms, 400ms, …) capped at 2s. Honor a sane
// Retry-After (seconds) from the upstream, capped so a request can't hang on it.
function backoff(attempt: number, retryAfter?: string | null): Promise<void> {
  let ms = Math.min(200 * 2 ** (attempt - 1), 2000)
  if (retryAfter) {
    const secs = Number(retryAfter)
    if (Number.isFinite(secs) && secs > 0) ms = Math.min(secs * 1000, 5000)
  }
  return new Promise((resolve) => setTimeout(resolve, ms))
}

chat.post('/v1/chat/completions', async (c) => {
  const startedAt = Date.now()
  const key = keyLabel(c.get('apiKey'))

  // OM-02: bound body size. The Content-Length middleware (app.ts) rejects honest
  // oversized clients before buffering; this catches a missing/lying Content-Length.
  const raw = await c.req.text().catch(() => '')
  if (config.maxBodyBytes > 0 && Buffer.byteLength(raw) > config.maxBodyBytes) {
    return c.json({ error: { message: 'Request body too large', type: 'invalid_request_error' } }, 413)
  }
  let req: ChatRequest
  try {
    req = JSON.parse(raw) as ChatRequest
  } catch {
    return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400)
  }
  if (!Array.isArray(req.messages)) {
    return c.json({ error: { message: '`messages` is required', type: 'invalid_request_error' } }, 400)
  }

  const decision = route(req)
  const body = buildUpstreamBody(req, decision.model, decision.maxTokensCeiling)
  const isStream = req.stream === true

  log.info('request', { key, model: decision.model, reason: decision.reason, stream: isStream, messages: req.messages.length })

  // Bounded retry on transient upstream failures, SAME model. We retry to ride out a
  // hiccup (connect error, 429/5xx); we never switch models (that would change the
  // answer — cross-model fallback is v1). A retry only ever happens before any byte
  // reaches the client, so it is safe for both stream and non-stream.
  let call!: Awaited<ReturnType<typeof callUpstream>>
  let attempt = 0
  while (true) {
    try {
      call = await callUpstream(body)
    } catch (e) {
      const reason = e instanceof Error && e.name === 'AbortError' ? 'upstream connect timeout' : 'upstream unreachable'
      if (attempt < config.maxRetries) {
        attempt++
        recordRetry(key, decision.model)
        log.warn('upstream_retry', { key, model: decision.model, attempt, reason })
        await backoff(attempt)
        continue
      }
      log.error('upstream_error', { key, model: decision.model, reason, attempts: attempt + 1, durationMs: Date.now() - startedAt })
      recordRequest({ key, model: decision.model, error: true, durationMs: Date.now() - startedAt })
      return c.json({ error: { message: reason, type: 'upstream_error' } }, 504)
    }

    if (!call.response.ok && isRetryableStatus(call.response.status) && attempt < config.maxRetries) {
      attempt++
      const retryAfter = call.response.headers.get('retry-after')
      await call.response.body?.cancel().catch(() => {}) // drain the failed body
      recordRetry(key, decision.model)
      log.warn('upstream_retry', { key, model: decision.model, attempt, status: call.response.status })
      await backoff(attempt, retryAfter)
      continue
    }
    break
  }

  const upstream = call.response
  if (!upstream.ok) {
    const text = await upstream.text()
    log.warn('upstream_not_ok', { key, model: decision.model, status: upstream.status, attempts: attempt + 1, durationMs: Date.now() - startedAt })
    recordRequest({ key, model: decision.model, error: true, durationMs: Date.now() - startedAt })
    return new Response(text, { status: upstream.status, headers: { 'Content-Type': 'application/json' } })
  }

  // ── Streaming: pipe through untouched + inter-chunk watchdog ───────────────
  if (isStream && upstream.body) {
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    const scanner = new SseUsageScanner()
    let lastChunkAt = Date.now()
    let stalled = false

    const watchdog = setInterval(() => {
      if (Date.now() - lastChunkAt > TIMEOUTS.interChunk) {
        stalled = true
        log.warn('upstream_stalled', { key, model: decision.model, provider: scanner.provider })
        call.abort.abort()
        clearInterval(watchdog)
      }
    }, 10_000)

    const stream = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
        lastChunkAt = Date.now()
        if (done) {
          clearInterval(watchdog)
          controller.close()
          log.info('completed', {
            key, model: decision.model, provider: scanner.provider, stream: true, stalled,
            promptTokens: scanner.usage?.prompt_tokens, completionTokens: scanner.usage?.completion_tokens,
            cost: scanner.usage?.cost, durationMs: Date.now() - startedAt,
          })
          recordRequest({
            key, model: decision.model, error: stalled,
            promptTokens: scanner.usage?.prompt_tokens, completionTokens: scanner.usage?.completion_tokens,
            costUsd: scanner.usage?.cost, durationMs: Date.now() - startedAt,
          })
          return
        }
        controller.enqueue(value) // raw bytes to the client, untouched
        scanner.push(decoder.decode(value, { stream: true })) // side-channel: cost/provider
      },
      cancel(reason) {
        // Client disconnected (or the response was aborted downstream): stop the
        // watchdog and tear down the upstream call so we don't leak the timer or
        // the upstream connection.
        clearInterval(watchdog)
        call.abort.abort()
        reader.cancel(reason).catch(() => {})
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-OpenMulti-Model': decision.model,
        'X-OpenMulti-Reason': decision.reason,
      },
    })
  }

  // ── Non-stream: parse, attach the route decision, return ───────────────────
  const data = (await upstream.json()) as Record<string, unknown>
  const u = data.usage as { prompt_tokens: number; completion_tokens: number; cost?: number } | undefined
  log.info('completed', {
    key, model: decision.model, stream: false,
    promptTokens: u?.prompt_tokens, completionTokens: u?.completion_tokens,
    cost: u?.cost, durationMs: Date.now() - startedAt,
  })
  recordRequest({
    key, model: decision.model,
    promptTokens: u?.prompt_tokens, completionTokens: u?.completion_tokens,
    costUsd: u?.cost, durationMs: Date.now() - startedAt,
  })
  // Only echo the routing decision when the caller opted into the extension.
  // Without it, the response stays byte-identical to the upstream provider, so a
  // plain OpenAI client (e.g. an agent proxied through us) sees no extra field.
  if (req.openmulti) {
    return c.json({ ...data, openmulti: { reason: decision.reason } })
  }
  return c.json(data)
})
