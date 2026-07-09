// Devis council (E-5) — la borne de coût maximum d'un council, calculable AVANT toute
// dépense : la surface la plus chère du produit était déclarée non-quotable, donc
// impayable sur le rail x402. Le devis est la somme des bornes des sous-appels que
// runCouncil peut émettre au pire :
//   - fuse : N appels panel + 1 chair (N+1) ;
//   - deliberate (N ≥ 2) : + N appels de revue (2N+1).
// Chaque borne de sous-appel réutilise computeQuote sur la MÊME sous-requête que
// l'exécution (subRequest + les builders de prompts, verrouillé par test). Les réponses
// du panel injectées dans les prompts de revue/synthèse ne sont pas connues au devis :
// elles sont comptées à leur cap de sortie, en TOKENS, ajoutés à la borne octets du
// gabarit rendu à vide (hypothèse : un token généré se re-tokenise en ≤ 1 token côté
// relecteur — même famille byte-BPE ; l'enveloppe de validité rejoint celle de la borne
// « octets ≥ tokens » de plan.ts, cf P0-2). Comme tout devis : des bornes ou rien.

import { computeQuote, type Quote, type QuoteResult, type QuoteUnavailable } from './plan.js'
import { resolveCouncil, subRequest, type CouncilResolved } from './council.js'
import { anonymizeResponses, buildReviewMessages, buildSynthesisMessages } from './council-prompts.js'
import { route } from './router.js'
import type { ChatRequest } from './types.js'

export interface CouncilQuote extends CouncilResolved {
  /** Nombre de sous-appels au pire : N+1 (fuse) ou 2N+1 (deliberate, N ≥ 2). */
  calls: number
  reason: string
  quote: Quote | null
  unavailable?: QuoteUnavailable
}

/** Devis d'un sous-appel : mêmes briques que l'exécution (route -> plafond de tier,
 * computeQuote). `extraInputTokens` = réponses embarquées comptées à leur cap. */
function subQuote(sub: ChatRequest, marginFactor: number, extraInputTokens = 0): QuoteResult {
  const decision = route(sub)
  return computeQuote(sub, decision.model, decision.maxTokensCeiling, marginFactor, extraInputTokens)
}

/**
 * Borne de coût maximum d'une requête council. Pure (aucune I/O) : résout le panel/
 * chair/mode comme runCouncil, puis somme les devis des sous-appels au pire cas.
 * { error } = council irrésoluble (mêmes messages que runCouncil, à servir en 400).
 */
export function computeCouncilQuote(req: ChatRequest, marginFactor: number): CouncilQuote | { error: string } {
  const resolved = resolveCouncil(req)
  if ('error' in resolved) return resolved
  const { panel, chair, mode } = resolved
  const deliberate = mode === 'deliberate' && panel.length >= 2
  const calls = panel.length + (deliberate ? panel.length : 0) + 1
  const reason = `council ${mode}: ${panel.length} panel${deliberate ? ' + review' : ''} + chair`
  const out = (q: QuoteResult): CouncilQuote =>
    ({ ...resolved, calls, reason, quote: q.quote, ...(q.unavailable ? { unavailable: q.unavailable } : {}) })

  // Étape 1 : le panel répond à la conversation d'origine.
  const total = { input_tokens_max: 0, output_tokens_max: 0, max_cost_usd: 0 }
  const panelCaps: number[] = [] // cap de sortie par membre, réinjecté aux étapes 2/3
  for (const m of panel) {
    const q = subQuote(subRequest(m, req.messages, req), marginFactor)
    if (!q.quote) return out(q)
    panelCaps.push(q.quote.output_tokens_max)
    total.input_tokens_max += q.quote.input_tokens_max
    total.output_tokens_max += q.quote.output_tokens_max
    total.max_cost_usd += q.quote.max_cost_usd
  }
  const panelCapSum = panelCaps.reduce((a, b) => a + b, 0)

  // Gabarits rendus à VIDE (réponses/revues absentes) : leur poids en octets est connu,
  // les contenus générés sont comptés à part via extraInputTokens.
  const anonEmpty = anonymizeResponses(panel.map(() => ''))

  // Étape 2 (deliberate, N ≥ 2) : chaque membre relit les N réponses du panel. Au pire
  // le panel COMPLET répond puis relit (l'exécution peut en faire moins, jamais plus).
  if (deliberate) {
    for (const m of panel) {
      const q = subQuote(subRequest(m, buildReviewMessages(req.messages, anonEmpty), req), marginFactor, panelCapSum)
      if (!q.quote) return out(q)
      total.input_tokens_max += q.quote.input_tokens_max
      total.output_tokens_max += q.quote.output_tokens_max
      total.max_cost_usd += q.quote.max_cost_usd
    }
  }

  // Étape 3 : le chair voit les réponses du panel + (deliberate) les N revues, chacune
  // bornée par le cap de sortie de son relecteur (mêmes caps que le panel).
  const reviewsEmpty = deliberate ? panel.map(() => '') : []
  const chairExtra = panelCapSum + (deliberate ? panelCapSum : 0)
  const q = subQuote(subRequest(chair, buildSynthesisMessages(req.messages, anonEmpty, reviewsEmpty), req), marginFactor, chairExtra)
  if (!q.quote) return out(q)
  total.input_tokens_max += q.quote.input_tokens_max
  total.output_tokens_max += q.quote.output_tokens_max
  total.max_cost_usd += q.quote.max_cost_usd

  // Somme de bornes déjà arrondies au micro-dollar supérieur : reste une borne.
  total.max_cost_usd = Math.round(total.max_cost_usd * 1_000_000) / 1_000_000
  return { ...resolved, calls, reason, quote: total }
}
