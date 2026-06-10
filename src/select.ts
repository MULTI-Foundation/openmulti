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

import { modelAggregate } from './metrics.js'
import type { RouteStrategy } from './types.js'

const MIN_SAMPLES = Math.max(1, Number(process.env.OPENMULTI_SMART_MIN_SAMPLES ?? 10))
const MAX_ERROR_RATE = Math.min(1, Math.max(0, Number(process.env.OPENMULTI_SMART_MAX_ERROR_RATE ?? 0.2)))

export interface Selection {
  model: string
  /** Short trace of why this model was picked, surfaced in the route reason. */
  note: string
}

export function selectModel(candidates: string[], strategy: RouteStrategy): Selection {
  const first = candidates[0]!
  if (strategy === 'default' || candidates.length === 1) {
    return { model: first, note: candidates.length > 1 ? 'default: primary' : '' }
  }

  const agg = candidates.map((m) => ({ m, ...modelAggregate(m) }))

  // 1. Explore: any candidate short on data gets the request (least-sampled first).
  const undersampled = agg.filter((a) => a.requests < MIN_SAMPLES)
  if (undersampled.length) {
    let best = undersampled[0]!
    for (const a of undersampled) if (a.requests < best.requests) best = a
    // best.requests est un décompte amorti, donc fractionnaire — arrondi pour la trace.
    return { model: best.m, note: `smart: exploring (${best.requests.toFixed(1)}/${MIN_SAMPLES} samples)` }
  }

  // 2. Exploit: cheapest among healthy candidates (fall back to all if none healthy).
  const healthy = agg.filter((a) => a.errors / a.requests <= MAX_ERROR_RATE)
  const pool = healthy.length ? healthy : agg
  const costPerReq = (a: (typeof pool)[number]) => a.costUsd / a.requests
  let best = pool[0]!
  for (const a of pool) if (costPerReq(a) < costPerReq(best)) best = a
  return { model: best.m, note: `smart: cheapest healthy ($${costPerReq(best).toFixed(6)}/req)` }
}
