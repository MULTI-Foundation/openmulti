// Devis council (E-5) — la borne de coût maximum d'un council, calculable AVANT toute
// dépense : la surface la plus chère du produit était déclarée non-quotable, donc
// impayable sur le rail x402. Le devis est la somme des bornes des sous-appels que
// runCouncil peut émettre au pire :
//   - fuse : N appels panel + 1 chair (N+1) ;
//   - deliberate (N ≥ 2) : + N appels de revue (2N+1) ;
//   - compare : N appels panel, sans chair (la mise en regard est un gabarit local).
// Chaque borne de sous-appel réutilise computeQuote sur la MÊME sous-requête que
// l'exécution (subRequest + les builders de prompts, verrouillé par test). Les réponses
// du panel injectées dans les prompts de revue/synthèse ne sont pas connues au devis :
// elles sont comptées à leur cap de sortie, en TOKENS, ajoutés à la borne octets du
// gabarit rendu à vide (hypothèse : un token généré se re-tokenise en ≤ 1 token côté
// relecteur — même famille byte-BPE ; l'enveloppe de validité rejoint celle de la borne
// « octets ≥ tokens » de plan.ts, cf P0-2). Comme tout devis : des bornes ou rien.

import { computeQuote, type Quote, type QuoteResult, type QuoteUnavailable } from './plan.js'
import { resolveCouncil, subRequest, type CouncilResolved } from './council.js'
import { anonymizeResponses, formatComparison, buildReviewMessages, buildSynthesisMessages } from './council-prompts.js'
import { route, RouteRefusal } from './router.js'
import type { ChatRequest } from './types.js'

export interface CouncilQuote extends CouncilResolved {
  /** Nombre de sous-appels au pire : N+1 (fuse), 2N+1 (deliberate, N ≥ 2), N (compare). */
  calls: number
  reason: string
  quote: Quote | null
  unavailable?: QuoteUnavailable
  /** Cap en TOKENS de la RÉPONSE finale (≠ la somme facturée `quote.output_tokens_max`,
   * qui compte TOUS les sous-appels) : le cap du chair — avec le repli « réponse du
   * panel la plus longue » couvert par le max — pour fuse/deliberate, la concaténation
   * bornée du panel + gabarit pour compare. C'est le matériau du PLIAGE du devis
   * programme (l'entrée de l'étage aval d'un pipe). Présent ssi `quote` l'est. */
  response_tokens_max?: number
  /** Union des snapshots de candidats des sous-appels (le matériau du pin E-1 : un
   * ensemble, jamais un modèle imposé). Présent ssi `quote` l'est. */
  candidates?: string[]
}

/** Longueur max d'un id de modèle (MODEL_RE de council.ts) : borne les étiquettes du
 * gabarit compare rendu au pire cas — octets >= tokens, même règle que plan.ts. */
const MAX_MODEL_ID_BYTES = 128

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
 * `extraInputTokens` (devis programme) : borne en tokens d'une ENTRÉE de pipe collée
 * sous le prompt — chaque sous-appel qui voit la conversation d'origine la voit aussi.
 */
export function computeCouncilQuote(
  req: ChatRequest,
  marginFactor: number,
  extraInputTokens = 0,
): CouncilQuote | { error: string } {
  const resolved = resolveCouncil(req)
  if ('error' in resolved) return resolved
  const { panel, chair, mode } = resolved
  const compare = mode === 'compare'
  const deliberate = mode === 'deliberate' && panel.length >= 2
  const calls = compare ? panel.length : panel.length + (deliberate ? panel.length : 0) + 1
  const reason = `council ${mode}: ${panel.length} panel${deliberate ? ' + review' : ''}${compare ? '' : ' + chair'}`

  // Un membre au nom nu inconnu/ambigu (RouteRefusal) rend le council irrésoluble,
  // comme un panel invalide — 400 explicite, jamais un devis calculé en silence sur le
  // tier par défaut. Pré-validation : route() est pur, le double routage est gratuit.
  // On en profite pour collecter l'union des snapshots de candidats (matériau pin E-1).
  const candidateSet = new Set<string>()
  try {
    for (const m of compare ? panel : [...panel, chair]) {
      const d = route(subRequest(m, req.messages, req))
      for (const cand of d.candidates ?? []) candidateSet.add(cand)
      candidateSet.add(d.model)
    }
  } catch (e) {
    if (e instanceof RouteRefusal) return { error: e.message }
    throw e
  }
  const out = (q: QuoteResult): CouncilQuote =>
    ({ ...resolved, calls, reason, quote: q.quote, ...(q.unavailable ? { unavailable: q.unavailable } : {}) })
  const done = (total: Quote, responseTokensMax: number): CouncilQuote => ({
    ...resolved,
    calls,
    reason,
    // Somme de bornes déjà arrondies au micro-dollar supérieur : reste une borne.
    quote: { ...total, max_cost_usd: Math.round(total.max_cost_usd * 1_000_000) / 1_000_000 },
    response_tokens_max: responseTokensMax,
    candidates: [...candidateSet].sort(),
  })

  // Étape 1 : le panel répond à la conversation d'origine (+ l'entrée de pipe éventuelle).
  const total = { input_tokens_max: 0, output_tokens_max: 0, max_cost_usd: 0 }
  const panelCaps: number[] = [] // cap de sortie par membre, réinjecté aux étapes 2/3
  for (const m of panel) {
    const q = subQuote(subRequest(m, req.messages, req), marginFactor, extraInputTokens)
    if (!q.quote) return out(q)
    panelCaps.push(q.quote.output_tokens_max)
    total.input_tokens_max += q.quote.input_tokens_max
    total.output_tokens_max += q.quote.output_tokens_max
    total.max_cost_usd += q.quote.max_cost_usd
  }
  const panelCapSum = panelCaps.reduce((a, b) => a + b, 0)

  // `compare` s'arrête là : aucune revue, aucun chair. La réponse finale est la mise
  // en regard — bornée par la somme des caps du panel + le gabarit rendu au pire cas
  // (étiquettes = ids de modèle de longueur MODEL_RE max ; octets >= tokens).
  if (compare) {
    const templateBytes = Buffer.byteLength(
      formatComparison(panel.map(() => 'x'.repeat(MAX_MODEL_ID_BYTES)), panel.map(() => '')),
      'utf8',
    )
    return done(total, panelCapSum + templateBytes)
  }

  // Gabarits rendus à VIDE (réponses/revues absentes) : leur poids en octets est connu,
  // les contenus générés sont comptés à part via extraInputTokens.
  const anonEmpty = anonymizeResponses(panel.map(() => ''))

  // Étape 2 (deliberate, N ≥ 2) : chaque membre relit les N réponses du panel. Au pire
  // le panel COMPLET répond puis relit (l'exécution peut en faire moins, jamais plus).
  if (deliberate) {
    for (const m of panel) {
      const q = subQuote(subRequest(m, buildReviewMessages(req.messages, anonEmpty), req), marginFactor, panelCapSum + extraInputTokens)
      if (!q.quote) return out(q)
      total.input_tokens_max += q.quote.input_tokens_max
      total.output_tokens_max += q.quote.output_tokens_max
      total.max_cost_usd += q.quote.max_cost_usd
    }
  }

  // Étape 3 : le chair voit les réponses du panel + (deliberate) les N revues, chacune
  // bornée par le cap de sortie de son relecteur (mêmes caps que le panel).
  const reviewsEmpty = deliberate ? panel.map(() => '') : []
  const chairExtra = panelCapSum + (deliberate ? panelCapSum : 0) + extraInputTokens
  const q = subQuote(subRequest(chair, buildSynthesisMessages(req.messages, anonEmpty, reviewsEmpty), req), marginFactor, chairExtra)
  if (!q.quote) return out(q)
  total.input_tokens_max += q.quote.input_tokens_max
  total.output_tokens_max += q.quote.output_tokens_max
  total.max_cost_usd += q.quote.max_cost_usd

  // La réponse finale est la synthèse du chair — ou, en dégradation gracieuse
  // (council.ts), la réponse du panel la plus longue : le max couvre les deux.
  return done(total, Math.max(q.quote.output_tokens_max, ...panelCaps))
}
