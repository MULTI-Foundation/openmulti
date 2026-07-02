// Council / fusion (mixture-of-agents) — orchestrateur. « OpenMulti qui s'appelle
// lui-même » : un panel répond en parallèle (chaque membre via le routing interne =
// chemins directs + bandit + failover), puis (mode deliberate) une revue par les pairs
// anonymisée, puis un chair synthétise la réponse finale. Opt-in (openmulti.council ou
// model:'council'), non-stream (MVP). Coût agrégé = somme de tous les sous-appels.
//
// Inspiré d'OpenRouter Fusion (juge/synthèse) et de karpathy/llm-council (revue par les
// pairs). Différenciation OpenMulti : le panel passe par NOS chemins directs (moins cher
// que via OpenRouter), et un preset « budget » de modèles ouverts vise le quasi-frontier.

import { config } from './config.js'
import { councilOverrides } from './council-overrides.js'
import { forwardChatNonStream, type ForwardCtx, type ForwardResult } from './forward.js'
import {
  responseText,
  anonymizeResponses,
  buildReviewMessages,
  buildSynthesisMessages,
  aggregateUsage,
  type UsagePart,
} from './council-prompts.js'
import { log } from './log.js'
import type { ChatRequest } from './types.js'

type Dict = Record<string, unknown>

const MAX_PANEL = 8
// Même forme que catalog-overrides/council-overrides : id de modèle plausible.
const MODEL_RE = /^[a-z0-9][a-z0-9._:/-]{1,127}$/i

export interface CouncilResolved {
  panel: string[]
  chair: string
  mode: 'fuse' | 'deliberate'
}

/** Config council effective : override admin à chaud (Redis) > env. Source unique
 * pour resolveCouncil et la route GET /v1/council/presets. */
export function effectiveCouncil() {
  const o = councilOverrides()
  const c = config.council
  return {
    chair: o.chair ?? c.chair,
    chairFlash: o.chairFlash ?? c.chairFlash,
    defaultPreset: o.defaultPreset ?? c.defaultPreset,
    panelBudget: o.panelBudget ?? c.panelBudget,
    panelQuality: o.panelQuality ?? c.panelQuality,
    panelFlash: o.panelFlash ?? c.panelFlash,
  }
}

/** Panel/chair/mode effectifs : override de requête > preset (override admin > env). */
export function resolveCouncil(req: ChatRequest): CouncilResolved | { error: string } {
  const c = req.openmulti?.council ?? {}
  const eff = effectiveCouncil()
  const preset = c.preset || eff.defaultPreset
  const presetPanel =
    preset === 'flash'
      ? eff.panelFlash
      : preset === 'budget'
        ? eff.panelBudget
        : eff.panelQuality
  // Le panel fourni par l'appelant est validé au même MODEL_RE que le chemin admin
  // (council-overrides) : un membre non conforme est rejeté, pas routé à l'aveugle
  // (audit sécu — sinon des ids arbitraires partaient en sous-requêtes upstream).
  const rawPanel = Array.isArray(c.panel) && c.panel.length ? c.panel : presetPanel
  const panel = rawPanel.filter((m): m is string => typeof m === 'string' && MODEL_RE.test(m)).slice(0, MAX_PANEL)
  // Preset flash : chair rapide (chairFlash) s'il est configuré ; override de requête prime.
  const chair = c.chair || (preset === 'flash' && eff.chairFlash ? eff.chairFlash : eff.chair)
  const mode = c.mode === 'deliberate' ? 'deliberate' : 'fuse'
  if (!panel.length) return { error: 'council: no panel (set OPENMULTI_COUNCIL_PANEL_* or openmulti.council.panel)' }
  if (!chair) return { error: 'council: no chair (set OPENMULTI_COUNCIL_CHAIR or openmulti.council.chair)' }
  return { panel, chair, mode }
}

export interface CouncilDeps {
  forward: (req: ChatRequest, ctx: ForwardCtx) => Promise<ForwardResult>
}

export interface CouncilOutput {
  status: number
  body: Dict
}

/** Sous-requête chat « propre » (sans openmulti -> anti-récursion : un membre de panel
 * ne peut pas relancer un council). */
function subRequest(model: string, messages: unknown[], req: ChatRequest): ChatRequest {
  const sub: ChatRequest = { model, messages: messages as ChatRequest['messages'] }
  if (typeof req.max_tokens === 'number') sub.max_tokens = req.max_tokens
  if (typeof req.temperature === 'number') sub.temperature = req.temperature
  return sub
}

export async function runCouncil(
  req: ChatRequest,
  ctx: ForwardCtx,
  deps: CouncilDeps = { forward: forwardChatNonStream },
): Promise<CouncilOutput> {
  const resolved = resolveCouncil(req)
  if ('error' in resolved) {
    return { status: 400, body: { error: { message: resolved.error, type: 'invalid_request_error' } } }
  }
  const { panel, chair, mode } = resolved
  const userMessages = req.messages

  // Étape 1 : le panel répond en parallèle (chacun via le routing interne).
  const panelResults = await Promise.all(panel.map((m) => deps.forward(subRequest(m, userMessages, req), ctx)))
  const okPanel = panelResults.filter((r) => r.ok && responseText(r.data).trim().length > 0)
  if (okPanel.length === 0) {
    log.warn('council_panel_empty', { key: ctx.key, panel })
    return { status: 502, body: { error: { message: 'council: all panel members failed', type: 'upstream_error' } } }
  }

  const texts = okPanel.map((r) => responseText(r.data))
  const anon = anonymizeResponses(texts)
  const usageParts: UsagePart[] = okPanel.map((r) => (r.data?.usage as UsagePart) ?? {})

  // Étape 2 (deliberate) : revue par les pairs anonymisée.
  let reviews: string[] = []
  if (mode === 'deliberate' && okPanel.length >= 2) {
    const reviewResults = await Promise.all(
      panel.map((m) => deps.forward(subRequest(m, buildReviewMessages(userMessages, anon), req), ctx)),
    )
    for (const r of reviewResults) {
      if (r.ok) {
        const t = responseText(r.data)
        if (t.trim()) reviews.push(t)
        usageParts.push((r.data?.usage as UsagePart) ?? {})
      }
    }
  }

  // Étape 3 : le chair synthétise.
  const chairRes = await deps.forward(subRequest(chair, buildSynthesisMessages(userMessages, anon, reviews), req), ctx)
  let finalText: string
  if (chairRes.ok && responseText(chairRes.data).trim()) {
    finalText = responseText(chairRes.data)
    usageParts.push((chairRes.data?.usage as UsagePart) ?? {})
  } else {
    // Dégradation gracieuse : si le chair échoue, on rend la meilleure réponse du panel.
    log.warn('council_chair_failed', { key: ctx.key, chair, status: chairRes.status })
    finalText = texts[0]!
  }

  const usage = aggregateUsage(usageParts)
  if (ctx.marginFactor > 1 && typeof usage.cost === 'number') usage.cost = usage.cost * ctx.marginFactor

  const body: Dict = {
    id: 'chatcmpl-council',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'council',
    choices: [{ index: 0, message: { role: 'assistant', content: finalText }, finish_reason: 'stop' }],
    usage,
  }
  // Trace council uniquement si l'appelant a opté pour l'extension (réponse pure-OpenAI sinon).
  if (req.openmulti) {
    body.openmulti = {
      council: { mode, panel: okPanel.map((r) => r.model), chair: chairRes.ok ? chair : null, members: okPanel.length },
      reason: `council ${mode}: ${okPanel.length} panel + chair`,
    }
  }
  return { status: 200, body }
}
