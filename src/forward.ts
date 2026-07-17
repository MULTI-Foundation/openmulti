// Forward NON-STREAM d'un chat à travers le routing interne d'OpenMulti (route +
// pathsFor + retry/failover same-model + normalize), avec enregistrement PAR APPEL
// (bandit/metering/caps voient chaque appel). C'est le seam réutilisable : le council
// (council.ts) s'en sert pour chaque membre du panel, le juge et le chair - « OpenMulti
// qui s'appelle lui-même » N+1 fois.
//
// Le handler stream/non-stream historique (routes/chat.ts) n'est PAS modifié (le contrat
// est la loi) ; il convergera vers ce seam plus tard. La boucle retry/failover ci-dessous
// est volontairement le miroir de celle du handler.

import { route, RouteRefusal } from './router.js'
import { pathsFor } from './providers/index.js'
import { backoff } from './providers/shared.js'
import { config } from './config.js'
import { recordRequest, recordRetry, recordPathFallback, type RequestRecord } from './metrics.js'
import { meterUsage } from './meter.js'
import { noteLocalSpend } from './keys.js'
import type { ChatRequest } from './types.js'

export interface ForwardResult {
  ok: boolean
  status: number
  /** Réponse normalisée (forme OpenAI) en cas de succès. Coût BRUT (sans marge). */
  data?: Record<string, unknown>
  costUsd?: number
  promptTokens?: number
  completionTokens?: number
  model: string
  provider: string
  reason: string
}

export interface ForwardCtx {
  key: string
  /** Facteur de marge (1 + t/100) - appliqué au coût FACTURÉ (metering/caps), pas au brut. */
  marginFactor: number
}

export async function forwardChatNonStream(req: ChatRequest, ctx: ForwardCtx): Promise<ForwardResult> {
  const startedAt = Date.now()
  // Un membre au nom nu inconnu/ambigu (RouteRefusal) est un membre EN ÉCHEC (ok:false),
  // pas une exception : le council dégrade proprement (okPanel), jamais un 500.
  let decision: ReturnType<typeof route>
  try {
    decision = route(req)
  } catch (e) {
    if (e instanceof RouteRefusal) {
      return {
        ok: false,
        status: e.status,
        data: { error: { message: e.message, type: 'invalid_request_error', code: e.code } },
        model: typeof req.model === 'string' ? req.model : 'auto',
        provider: 'none',
        reason: 'route refused',
      }
    }
    throw e
  }
  const paths = pathsFor(decision.model)
  let provider = paths[0]!
  let failedOver = false

  const record = (r: Omit<RequestRecord, 'key' | 'model' | 'provider'>) => {
    const rec: RequestRecord = { key: ctx.key, model: decision.model, provider: provider.name, ...r }
    if (rec.costUsd) rec.billedUsd = rec.costUsd * ctx.marginFactor
    recordRequest(rec)
    meterUsage(rec)
    if (rec.billedUsd) noteLocalSpend(ctx.key, rec.billedUsd)
  }

  let call!: Awaited<ReturnType<(typeof provider)['call']>>
  pathLoop: for (let p = 0; p < paths.length; p++) {
    provider = paths[p]!
    const next = paths[p + 1]
    const body = provider.buildBody(req, decision.model, decision.maxTokensCeiling)
    let attempt = 0
    while (true) {
      try {
        call = await provider.call(body)
      } catch {
        if (attempt < config.maxRetries) {
          attempt++
          recordRetry(ctx.key, decision.model, provider.name)
          await backoff(attempt)
          continue
        }
        if (next) {
          record({ error: true, durationMs: Date.now() - startedAt })
          recordPathFallback(decision.model, provider.name, next.name)
          failedOver = true
          continue pathLoop
        }
        record({ error: true, durationMs: Date.now() - startedAt })
        return { ok: false, status: 504, model: decision.model, provider: provider.name, reason: decision.reason }
      }
      if (!call.response.ok && provider.isRetryable(call.response.status)) {
        if (attempt < config.maxRetries) {
          attempt++
          const retryAfter = call.response.headers.get('retry-after')
          await call.response.body?.cancel().catch(() => {})
          recordRetry(ctx.key, decision.model, provider.name)
          await backoff(attempt, retryAfter)
          continue
        }
        if (next) {
          await call.response.body?.cancel().catch(() => {})
          record({ error: true, durationMs: Date.now() - startedAt })
          recordPathFallback(decision.model, provider.name, next.name)
          failedOver = true
          continue pathLoop
        }
      }
      // Miroir de routes/chat.ts : un 4xx non-retryable est déterministe pour CE
      // chemin, pas forcément pour l'autre (exigences de forme propres aux API
      // natives, qu'OpenRouter normalise). Une seule bascule, jamais de retry.
      if (!call.response.ok && call.response.status < 500 && !provider.isRetryable(call.response.status) && next) {
        await call.response.body?.cancel().catch(() => {})
        record({ error: true, durationMs: Date.now() - startedAt })
        recordPathFallback(decision.model, provider.name, next.name)
        failedOver = true
        continue pathLoop
      }
      break pathLoop
    }
  }

  let reason = decision.reason
  if (provider.name !== 'openrouter' || failedOver) {
    reason = `${reason}, via ${provider.name}${failedOver ? ` (fallback from ${paths[0]!.name})` : ''}`
  }

  if (!call.response.ok) {
    await call.response.text().catch(() => {})
    record({ error: true, durationMs: Date.now() - startedAt })
    return { ok: false, status: call.response.status, model: decision.model, provider: provider.name, reason }
  }

  const data = provider.normalizeResponse((await call.response.json()) as Record<string, unknown>, decision.model)
  const u = data.usage as { prompt_tokens?: number; completion_tokens?: number; cost?: number } | undefined
  record({ costUsd: u?.cost, promptTokens: u?.prompt_tokens, completionTokens: u?.completion_tokens, durationMs: Date.now() - startedAt })
  return {
    ok: true,
    status: 200,
    data,
    costUsd: u?.cost,
    promptTokens: u?.prompt_tokens,
    completionTokens: u?.completion_tokens,
    model: decision.model,
    provider: provider.name,
    reason,
  }
}
