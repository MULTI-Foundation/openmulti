// Model selection: given a tier's ordered candidate set (catalog.ts), pick one.
// This is where the v1 "intelligence" lands. It is OPT-IN — the 'default' strategy
// returns the first candidate (the iso-comportement primary), so unless a caller asks
// for 'smart' nothing changes.
//
// 'smart' is a deterministic discounted bandit over observed metrics (no RNG, so
// it's testable and reproducible). The stats are AMORTIES (metrics.ts, RHO per
// observation — horizon OPENMULTI_SMART_DECAY_WINDOW), which makes ONE rule cover
// both phases:
//   1. Explore: while any candidate's decayed sample count is < MIN_SAMPLES, send
//      traffic to the least-sampled one. Cold: fills the data round-robin. Warm: a
//      losing candidate's count decays back under the floor, so it keeps getting
//      ~MIN_SAMPLES/WINDOW of the traffic — data stays fresh, a degraded model can
//      prove it recovered, a cheaper one can win back the slot.
//   2. Exploit: drop unhealthy candidates (decayed error rate above threshold), then
//      pick the cheapest by decayed cost/request. Ties break by order (so the primary
//      wins on a tie — stays closest to iso).
// OPENMULTI_SMART_DECAY_WINDOW=0 disables the decay (lifetime stats: explore once,
// exploit forever — the pre-bandit behavior, locked by test/select.test.ts).

import { modelAggregate, setBanditCollapsedRegime, DECAY_WINDOW, type ModelAggregate } from './metrics.js'
import { log } from './log.js'
import type { RouteStrategy } from './types.js'

const MIN_SAMPLES = Math.max(1, Number(process.env.OPENMULTI_SMART_MIN_SAMPLES ?? 10))
const MAX_ERROR_RATE = Math.min(1, Math.max(0, Number(process.env.OPENMULTI_SMART_MAX_ERROR_RATE ?? 0.2)))

// P0-9 : régime effondré. Avec amortissement actif (window>0), le décompte amorti d'un
// bras sature à ~window ; si le plancher d'exploration MIN_SAMPLES atteint ou dépasse
// cet horizon, AUCUN bras ne franchit jamais le plancher -> l'exploration ne se termine
// jamais (round-robin permanent) et la branche exploit (avec son gate de santé) n'est
// jamais atteinte. window=0 = legacy (explore une fois puis exploit), non effondré.
export function banditRegimeCollapsed(minSamples: number, decayWindow: number): boolean {
  return decayWindow > 0 && minSamples >= decayWindow
}

// Garde de boot : détecte et SIGNALE le régime effondré (log + jauge Prometheus
// openmulti_bandit_collapsed_regime), au lieu de le subir en silence.
const _collapsed = banditRegimeCollapsed(MIN_SAMPLES, DECAY_WINDOW)
setBanditCollapsedRegime(_collapsed)
if (_collapsed) {
  log.warn('bandit_collapsed_regime', {
    minSamples: MIN_SAMPLES,
    decayWindow: DECAY_WINDOW,
    detail: 'MIN_SAMPLES >= DECAY_WINDOW : exploration permanente, gate de santé jamais atteint via exploit',
  })
}

// Santé d'un candidat (taux d'erreur amorti sous le seuil). Un bras jamais échantillonné
// (requests <= 0) est réputé sain : il DOIT rester explorable, sinon il ne démarre jamais.
const isHealthy = (a: { requests: number; errors: number }): boolean =>
  a.requests <= 0 || a.errors / a.requests <= MAX_ERROR_RATE

export interface Selection {
  model: string
  /** Short trace of why this model was picked, surfaced in the route reason. */
  note: string
}

/**
 * `aggregate` permet de réutiliser la même mécanique explore/exploit sur d'autres
 * candidats que des modèles : l'étape 4 (providers/index.ts) arbitre des CHEMINS
 * D'ACCÈS du même modèle avec les stats par chemin (pathAggregate). Défaut : stats
 * par modèle, tous chemins confondus (la sélection de tier).
 */
export function selectModel(
  candidates: string[],
  strategy: RouteStrategy,
  aggregate: (candidate: string) => ModelAggregate = modelAggregate,
): Selection {
  const first = candidates[0]!
  if (strategy === 'default' || candidates.length === 1) {
    return { model: first, note: candidates.length > 1 ? 'default: primary' : '' }
  }

  const agg = candidates.map((m) => ({ m, ...aggregate(m) }))

  // 1. Explore: any candidate short on data gets the request (least-sampled first).
  // P0-10 : le gate de santé s'applique AUSSI ici. Un bras jugé malsain (assez de
  // données ET taux d'erreur amorti > seuil) ne doit pas continuer à capter du trafic
  // d'exploration — décisif en régime effondré, où l'exploit (et son gate) n'est jamais
  // atteint. On retombe sur TOUS les sous-échantillonnés si aucun n'est sain, pour ne
  // jamais bloquer : un bras malade isolé garde ainsi sa chance de prouver sa guérison.
  const undersampled = agg.filter((a) => a.requests < MIN_SAMPLES)
  if (undersampled.length) {
    const explorable = undersampled.filter(isHealthy)
    const pool = explorable.length ? explorable : undersampled
    let best = pool[0]!
    for (const a of pool) if (a.requests < best.requests) best = a
    // best.requests est un décompte amorti, donc fractionnaire — arrondi pour la trace.
    return { model: best.m, note: `smart: exploring (${best.requests.toFixed(1)}/${MIN_SAMPLES} samples)` }
  }

  // 2. Exploit: cheapest among healthy candidates (fall back to all if none healthy).
  const healthy = agg.filter(isHealthy)
  const pool = healthy.length ? healthy : agg
  const costPerReq = (a: (typeof pool)[number]) => a.costUsd / a.requests
  let best = pool[0]!
  for (const a of pool) if (costPerReq(a) < costPerReq(best)) best = a
  return { model: best.m, note: `smart: cheapest healthy ($${costPerReq(best).toFixed(6)}/req)` }
}
