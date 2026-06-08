// POST /v1/chat/completions - OpenAI-compatible, plus the openmulti extension.
//
// Flow: route (intention -> concrete model) -> steer -> forward upstream -> pipe back.
// Streaming pipes the upstream SSE untouched (so the caller's own usage parsing keeps
// working) and adds an inter-chunk watchdog. The route decision is surfaced via
// X-OpenMulti-* headers (stream) and the `openmulti` block (non-stream).

import { Hono } from 'hono'
import { route } from '../router.js'
import { buildUpstreamBody, callUpstream } from '../providers/openrouter.js'
import { TIMEOUTS } from '../config.js'
import type { ChatRequest } from '../types.js'

export const chat = new Hono()

chat.post('/v1/chat/completions', async (c) => {
  let req: ChatRequest
  try {
    req = await c.req.json()
  } catch {
    return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400)
  }
  if (!Array.isArray(req.messages)) {
    return c.json({ error: { message: '`messages` is required', type: 'invalid_request_error' } }, 400)
  }

  const decision = route(req)
  const body = buildUpstreamBody(req, decision.model)
  const isStream = req.stream === true

  console.log(
    `[openmulti] model=${decision.model} reason="${decision.reason}" ` +
      `stream=${isStream} messages=${req.messages.length}`,
  )

  let call: Awaited<ReturnType<typeof callUpstream>>
  try {
    call = await callUpstream(body)
  } catch (e) {
    const reason = e instanceof Error && e.name === 'AbortError' ? 'upstream connect timeout' : 'upstream unreachable'
    return c.json({ error: { message: reason, type: 'upstream_error' } }, 504)
  }

  const upstream = call.response
  if (!upstream.ok) {
    const text = await upstream.text()
    return new Response(text, { status: upstream.status, headers: { 'Content-Type': 'application/json' } })
  }

  // ── Streaming: pipe through untouched + inter-chunk watchdog ───────────────
  if (isStream && upstream.body) {
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let usageData: { prompt_tokens: number; completion_tokens: number; cost?: number } | null = null
    let lastProvider: string | null = null
    let lastChunkAt = Date.now()

    const watchdog = setInterval(() => {
      if (Date.now() - lastChunkAt > TIMEOUTS.interChunk) {
        console.warn(`[openmulti] upstream stalled model=${decision.model} provider=${lastProvider ?? '-'}`)
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
          if (usageData) {
            console.log(
              `[openmulti] done model=${decision.model} provider=${lastProvider ?? '-'} ` +
                `prompt=${usageData.prompt_tokens} completion=${usageData.completion_tokens} ` +
                `cost=${Number(usageData.cost ?? 0).toFixed(6)}`,
            )
          }
          return
        }
        controller.enqueue(value)
        const text = decoder.decode(value, { stream: true })
        for (const line of text.split('\n')) {
          if (!line.startsWith('data: ') || line.includes('[DONE]')) continue
          try {
            const parsed = JSON.parse(line.slice(6))
            if (parsed.usage) usageData = parsed.usage
            if (parsed.provider) lastProvider = parsed.provider
          } catch {}
        }
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
  if (data.usage) {
    const u = data.usage as { prompt_tokens: number; completion_tokens: number; cost?: number }
    console.log(
      `[openmulti] done model=${decision.model} prompt=${u.prompt_tokens} ` +
        `completion=${u.completion_tokens} cost=${Number(u.cost ?? 0).toFixed(6)}`,
    )
  }
  return c.json({ ...data, openmulti: { reason: decision.reason } })
})
