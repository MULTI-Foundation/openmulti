// Bornes de sortie d'un appel chat — la logique PARTAGÉE entre le clamp OM-01
// (buildUpstreamBody, qui borne le coût unitaire réel) et le devis (computeQuote, qui
// borne le coût maximum facturé). Les deux DOIVENT s'accorder, sinon le devis ment sur
// ce que l'exécution produira. Extrait ici, pur et testé, pour qu'ils ne divergent pas.
//
// Deux subtilités que le premier jet ratait (audit sécu 2026-07-02) :
//   1. `max_completion_tokens` (API OpenAI moderne) prime sur `max_tokens` (déprécié) et
//      est dans l'allowlist upstream : borner seulement `max_tokens` laisse un appelant
//      dépasser le plafond via `max_completion_tokens`.
//   2. `n` (nombre de complétions) est dans l'allowlist et multiplie les tokens de
//      sortie facturés (usage.completion_tokens somme les n) : une borne par complétion
//      qui ignore `n` sous-estime le coût d'un facteur arbitraire.

import type { ChatRequest } from './types.js'

/** Un entier fini > 0, sinon undefined (NaN/négatif/0/Infinity rejetés). */
function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined
}

/** Nombre de complétions demandées (`n`), défaut 1. Une valeur invalide retombe à 1
 *  (le devis reste une borne : on ne sous-estime jamais, mais on n'invente pas non plus
 *  un n géant à partir d'une saisie absurde — l'upstream lui-même rejetterait). */
export function completionCount(req: ChatRequest): number {
  return positiveInt(req.n) ?? 1
}

/** Plafond de sortie PAR COMPLÉTION demandé par l'appelant : le max des deux champs
 *  (conservateur — une borne haute), ou undefined si aucun n'est un entier positif.
 *  On prend le MAX et non celui qui "primerait" upstream : surestimer une borne est sûr,
 *  la sous-estimer casse la garantie. */
export function requestedOutputCap(req: ChatRequest): number | undefined {
  const a = positiveInt(req.max_tokens)
  const b = positiveInt(req.max_completion_tokens)
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.max(a, b)
}

/** Borne de sortie PAR COMPLÉTION après application du plafond de tier (OM-01) :
 *  min(demande, plafond) si le plafond est posé, sinon la demande. undefined = aucune
 *  borne connue (ni demande ni plafond) → pas de devis possible. */
export function effectiveOutputCap(req: ChatRequest, ceiling: number | undefined): number | undefined {
  const requested = requestedOutputCap(req)
  const cap = ceiling && ceiling > 0 ? ceiling : undefined
  if (cap === undefined) return requested
  if (requested === undefined) return cap
  return Math.min(requested, cap)
}
