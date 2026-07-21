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
import { route, RouteRefusal } from './router.js'
import { forwardChatNonStream, type ForwardCtx, type ForwardResult } from './forward.js'
import {
  responseText,
  anonymizeResponses,
  formatComparison,
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
  /** Vide en mode `compare` (aucune synthèse, donc aucun chair requis ni utilisé). */
  chair: string
  mode: 'fuse' | 'deliberate' | 'compare'
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
  const mode = c.mode === 'deliberate' ? 'deliberate' : c.mode === 'compare' ? 'compare' : 'fuse'
  if (!panel.length) return { error: 'council: no panel (set OPENMULTI_COUNCIL_PANEL_* or openmulti.council.panel)' }
  // `compare` ne synthétise pas : pas de chair requis, et un chair configuré est
  // IGNORÉ (chair vide dans le résolu — jamais un appel de synthèse payé pour rien).
  if (mode === 'compare') return { panel, chair: '', mode }
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
export function subRequest(model: string, messages: unknown[], req: ChatRequest): ChatRequest {
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

  // Refus AMONT, jamais une dégradation silencieuse (amendement 4 du chantier
  // vision) : chaque membre (+ le chair hors compare) doit être ROUTABLE pour CETTE
  // requête — nom résolvable, vision-capable si image en entrée — AVANT la première
  // dépense. Sinon un panéliste aveugle « échouerait gracieusement » et le panel
  // rétrécirait sans le dire. Même pré-validation que le devis (council-quote, E-5).
  try {
    for (const m of mode === 'compare' ? panel : [...panel, chair]) route(subRequest(m, userMessages, req))
  } catch (e) {
    if (e instanceof RouteRefusal) {
      return { status: 400, body: { error: { message: e.message, type: 'invalid_request_error', code: e.code } } }
    }
    throw e
  }

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
  // P0-3 : on n'envoie la ronde de review qu'aux SURVIVANTS de l'étape 1 (okPanel),
  // pas au panel configuré complet — sinon on dépense des appels sur des membres déjà
  // morts à l'étape 1.
  let reviews: string[] = []
  if (mode === 'deliberate' && okPanel.length >= 2) {
    const reviewResults = await Promise.all(
      okPanel.map((r) => deps.forward(subRequest(r.model, buildReviewMessages(userMessages, anon), req), ctx)),
    )
    for (const r of reviewResults) {
      if (r.ok) {
        const t = responseText(r.data)
        if (t.trim()) reviews.push(t)
        usageParts.push((r.data?.usage as UsagePart) ?? {})
      }
    }
  }

  // Étape 3 : la sortie finale. `compare` : les réponses survivantes mises EN REGARD,
  // chacune sous son modèle résolu — aucune synthèse, aucun appel de plus. Sinon : le
  // chair synthétise.
  let finalText: string
  let chairUsed: string | null = null
  if (mode === 'compare') {
    finalText = formatComparison(okPanel.map((r) => r.model), texts)
  } else {
    const chairRes = await deps.forward(subRequest(chair, buildSynthesisMessages(userMessages, anon, reviews), req), ctx)
    if (chairRes.ok && responseText(chairRes.data).trim()) {
      finalText = responseText(chairRes.data)
      usageParts.push((chairRes.data?.usage as UsagePart) ?? {})
      chairUsed = chair
    } else {
      // Dégradation gracieuse : le chair a échoué. Faute de synthèse, on rend la réponse
      // survivante la PLUS LONGUE — proxy grossier mais honnête d'un signal de contenu
      // (P0-4 : pas de « meilleure » sans juge ; l'ancien texts[0] = premier survivant
      // dans l'ordre de config, sans aucun signal de qualité). texts est non vide
      // (okPanel.length >= 1 garanti plus haut).
      log.warn('council_chair_failed', { key: ctx.key, chair, status: chairRes.status })
      finalText = texts.reduce((a, b) => (b.length > a.length ? b : a))
    }
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
      council: { mode, panel: okPanel.map((r) => r.model), chair: chairUsed, members: okPanel.length },
      reason: `council ${mode}: ${okPanel.length} panel${mode === 'compare' ? '' : ' + chair'}`,
    }
  }
  return { status: 200, body }
}
