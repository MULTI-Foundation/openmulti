// Devis pour POST /v1/plan (brique B1 du chantier multi-lang, docs/MULTI-Interpreter-
// Plan-Implementation.md) : la borne de coût MAXIMUM d'un appel, calculable AVANT toute
// dépense. C'est le socle d'EXPLAIN côté interprète MULTI et, plus tard, du prépaiement
// (S1 du modèle de menace : un devis payé doit couvrir le pire cas). Donc jamais
// d'estimation optimiste : uniquement des bornes, ou pas de devis du tout.
//
// Bornes :
//   - entrée : octets UTF-8 du JSON de la requête. Un tokenizer BPE byte-level ne
//     produit jamais plus d'un token par octet, et le JSON complet (rôles, tools,
//     quotes, extension) majore ce que le provider tokenise réellement. Large (~4x sur
//     du texte latin) mais GARANTI — et l'entrée est la part bon marché du coût.
//   - sortie : max_tokens demandé, écrêté par le plafond de tier (OM-01, même règle que
//     buildUpstreamBody). Aucun des deux = pas de borne = pas de devis.
//   - prix : table pricing.ts ; modèle non tarifé = pas de devis (jamais un faux zéro,
//     même règle que computeCostUsd).
//
// Le devis est en dollars FACTURÉS (marge du projet incluse — c'est ce que paiera le
// client), arrondi au micro-dollar SUPÉRIEUR : une borne s'arrondit vers le haut.

import { computeCostUsd } from './pricing.js'
import { completionCount, effectiveOutputCap } from './output-bounds.js'
import type { ChatRequest } from './types.js'

export interface Quote {
  /** Borne haute de tokens d'entrée (octets UTF-8 du JSON de la requête). */
  input_tokens_max: number
  /** Borne de tokens de sortie (max_tokens effectif après plafond de tier). */
  output_tokens_max: number
  /** Coût maximum FACTURÉ en USD (marge incluse), arrondi au micro-dollar supérieur. */
  max_cost_usd: number
}

/** Pourquoi aucun devis n'a pu être garanti (jamais de devis approximatif à la place). */
export type QuoteUnavailable = 'unsupported_content' | 'no_output_bound' | 'pricing_unknown'

export type QuoteResult = { quote: Quote; unavailable?: undefined } | { quote: null; unavailable: QuoteUnavailable }

// Un devis ne se garantit que sur du TEXTE : une image (en entrée comme en sortie) est
// tarifée hors tokens de texte, sa borne n'est pas calculable depuis les octets.
function hasNonTextContent(req: ChatRequest): boolean {
  if (Array.isArray(req.modalities) && req.modalities.some((m) => m !== 'text')) return true
  for (const msg of req.messages) {
    const content = msg.content
    if (typeof content === 'string' || content === null || content === undefined) continue
    if (Array.isArray(content)) {
      for (const part of content) {
        const type = typeof part === 'object' && part !== null ? (part as Record<string, unknown>).type : undefined
        if (type !== 'text') return true
      }
      continue
    }
    return true // contenu ni texte ni liste de parts : on refuse de borner à l'aveugle
  }
  return false
}

/**
 * Calcule le devis (borne de coût maximum) pour une requête déjà routée.
 * Pure : aucune I/O, aucun état — testable sans HTTP (cf test/plan.test.ts).
 */
export function computeQuote(
  req: ChatRequest,
  model: string,
  maxTokensCeiling: number | undefined,
  marginFactor: number,
): QuoteResult {
  if (hasNonTextContent(req)) return { quote: null, unavailable: 'unsupported_content' }

  // Borne de sortie par complétion (prend en compte max_completion_tokens ET le plafond
  // de tier), multipliée par n : c'est le total de tokens de sortie que l'exécution du
  // MÊME modèle épinglé peut facturer au pire (audit sécu : n et max_completion_tokens
  // contournaient la borne).
  const perCompletion = effectiveOutputCap(req, maxTokensCeiling)
  if (perCompletion === undefined) return { quote: null, unavailable: 'no_output_bound' }
  const outputMax = perCompletion * completionCount(req)

  const inputMax = Buffer.byteLength(JSON.stringify(req), 'utf8')
  const rawMax = computeCostUsd(model, inputMax, outputMax)
  if (rawMax === undefined) return { quote: null, unavailable: 'pricing_unknown' }

  return {
    quote: {
      input_tokens_max: inputMax,
      output_tokens_max: outputMax,
      max_cost_usd: Math.ceil(rawMax * marginFactor * 1_000_000) / 1_000_000,
    },
  }
}
