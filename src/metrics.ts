// In-process metrics, exposed at /metrics in Prometheus text format. This is the
// substrate the roadmap needs anyway: per-key metering (OpenMulti's own future
// billing, cf auth.ts) and quality/cost monitoring. It does NOT touch proxied
// responses — pure side-channel.
//
// v0 scope: in-memory, resets on restart (Prometheus tolerates counter resets).
// Cardinality stays low: one label per consuming project (not per raw key — see
// keyLabel) times the catalog of models.

import { createHash } from 'node:crypto'

interface Stat {
  requests: number
  errors: number
  retries: number
  promptTokens: number
  completionTokens: number
  costUsd: number
  durationMsSum: number
  durationCount: number
}

const SEP = '␟' // unit separator; cannot appear in a key label, model id or provider name
const stats = new Map<string, Stat>()

// Le chemin d'accès (openrouter, moonshot, …) est une dimension à part entière depuis
// l'étape 4 de la spec multi-provider : un même modèle peut être servi par plusieurs
// chemins, au coût/santé différents. 'openrouter' par défaut (l'unique chemin historique).
const DEFAULT_PROVIDER = 'openrouter'

function bucket(key: string, model: string, provider: string): Stat {
  const id = `${key}${SEP}${model}${SEP}${provider}`
  let s = stats.get(id)
  if (!s) {
    s = { requests: 0, errors: 0, retries: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, durationMsSum: 0, durationCount: 0 }
    stats.set(id, s)
  }
  return s
}

/**
 * Derive a non-secret, low-cardinality label from an API key. We never expose the
 * raw `sk_...` secret in metrics. Keys are provisioned per project as
 * `sk_<project>_<secret>` (cf auth.ts / ARCHITECTURE.md), so we surface `<project>`;
 * anything else collapses to a stable 8-char hash (never reversible to the secret).
 */
export function keyLabel(apiKey: string | undefined): string {
  if (!apiKey) return 'anon'
  const m = /^sk_([a-z0-9-]+)_/i.exec(apiKey)
  if (m) return m[1]!
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 8)
}

export interface RequestRecord {
  key: string // already a keyLabel(), not the raw secret
  model: string
  /** Chemin d'accès qui a porté l'appel (Provider.name). Défaut : openrouter. */
  provider?: string
  promptTokens?: number
  completionTokens?: number
  costUsd?: number
  durationMs?: number
  error?: boolean
}

/** A transient upstream failure was retried (same model, same access path). */
export function recordRetry(key: string, model: string, provider = DEFAULT_PROVIDER): void {
  bucket(key, model, provider).retries += 1
}

// Trous de tarif : un provider DIRECT a servi un modèle absent de pricing.ts, donc
// usage.cost n'a pas pu être synthétisé (spec multi-provider §5 : jamais un faux
// zéro, mais le trou doit rester visible — c'est un prix à ajouter, pas un détail).
const pricingMisses = new Map<string, number>()

export function recordPricingMiss(model: string): void {
  pricingMisses.set(model, (pricingMisses.get(model) ?? 0) + 1)
}

// Écritures de metering durable perdues (Redis indisponible) — cf meter.ts. Si ça
// monte, la facturation sous-compte : c'est une alerte, pas un détail.
let meterDrops = 0

export function recordMeterDrop(): void {
  meterDrops += 1
}

export interface ModelAggregate {
  requests: number
  errors: number
  costUsd: number
}

// --- Vue « bandit » (stats amorties), nourrit la stratégie 'smart' de select.ts ---
//
// Séparée des compteurs Prometheus ci-dessus, qui doivent rester MONOTONES : ici,
// à chaque observation, TOUTES les entrées sont multipliées par RHO avant d'ajouter
// la nouvelle (discounted bandit). Effets :
//   - le récent pèse plus que l'ancien (un modèle dégradé/réparé est vu vite) ;
//   - le décompte amorti d'un modèle délaissé glisse vers 0, ce qui re-déclenche
//     l'exploration côté select.ts (refresh continu, ~MIN_SAMPLES/WINDOW du trafic).
// OPENMULTI_SMART_DECAY_WINDOW est l'horizon effectif en nombre de requêtes
// (RHO = 1 - 1/window) ; 0 = pas d'amortissement (stats à vie, comportement legacy).
const DECAY_WINDOW = Math.max(0, Number(process.env.OPENMULTI_SMART_DECAY_WINDOW ?? 200))
const RHO = DECAY_WINDOW > 0 ? 1 - 1 / DECAY_WINDOW : 1

// Clé : `${provider}␟${model}` — le bandit distingue les chemins d'accès (étape 4 :
// arbitrer moonshot-direct vs openrouter pour un même modèle).
const bandit = new Map<string, ModelAggregate>()

/** Stats amorties d'un modèle, tous projets ET chemins d'accès confondus (vue de la
 * sélection de modèle par tier — le tier ne se soucie pas du chemin). */
export function modelAggregate(model: string): ModelAggregate {
  const out = { requests: 0, errors: 0, costUsd: 0 }
  for (const [id, b] of bandit) {
    if (id.slice(id.indexOf(SEP) + 1) === model) {
      out.requests += b.requests
      out.errors += b.errors
      out.costUsd += b.costUsd
    }
  }
  return out
}

/** Stats amorties d'un (chemin d'accès, modèle) précis — la vue de l'arbitrage de
 * chemin (providers/index.ts, mode 'smart'). */
export function pathAggregate(provider: string, model: string): ModelAggregate {
  const b = bandit.get(`${provider}${SEP}${model}`)
  return b ? { ...b } : { requests: 0, errors: 0, costUsd: 0 }
}

export function recordRequest(r: RequestRecord): void {
  const provider = r.provider ?? DEFAULT_PROVIDER
  const s = bucket(r.key, r.model, provider)
  s.requests += 1
  if (r.error) s.errors += 1
  if (r.promptTokens) s.promptTokens += r.promptTokens
  if (r.completionTokens) s.completionTokens += r.completionTokens
  if (r.costUsd) s.costUsd += r.costUsd
  if (typeof r.durationMs === 'number') {
    s.durationMsSum += r.durationMs
    s.durationCount += 1
  }

  if (RHO < 1) {
    for (const b of bandit.values()) {
      b.requests *= RHO
      b.errors *= RHO
      b.costUsd *= RHO
    }
  }
  const banditId = `${provider}${SEP}${r.model}`
  let b = bandit.get(banditId)
  if (!b) {
    b = { requests: 0, errors: 0, costUsd: 0 }
    bandit.set(banditId, b)
  }
  b.requests += 1
  if (r.error) b.errors += 1
  if (r.costUsd) b.costUsd += r.costUsd
}

function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

/** Render the registry in Prometheus text exposition format (version 0.0.4). */
export function renderProm(): string {
  const out: string[] = []
  const line = (name: string, labels: string, value: number) =>
    out.push(`${name}{${labels}} ${value}`)

  out.push('# HELP openmulti_requests_total Chat completion requests handled.')
  out.push('# TYPE openmulti_requests_total counter')
  for (const [id, s] of stats) {
    const [key, model, provider] = id.split(SEP) as [string, string, string]
    line('openmulti_requests_total', `key="${esc(key)}",model="${esc(model)}",provider="${esc(provider)}"`, s.requests)
  }

  out.push('# HELP openmulti_request_errors_total Requests that failed upstream.')
  out.push('# TYPE openmulti_request_errors_total counter')
  for (const [id, s] of stats) {
    const [key, model, provider] = id.split(SEP) as [string, string, string]
    line('openmulti_request_errors_total', `key="${esc(key)}",model="${esc(model)}",provider="${esc(provider)}"`, s.errors)
  }

  out.push('# HELP openmulti_retries_total Transient upstream failures retried (same model).')
  out.push('# TYPE openmulti_retries_total counter')
  for (const [id, s] of stats) {
    const [key, model, provider] = id.split(SEP) as [string, string, string]
    line('openmulti_retries_total', `key="${esc(key)}",model="${esc(model)}",provider="${esc(provider)}"`, s.retries)
  }

  out.push('# HELP openmulti_tokens_total Tokens billed by the upstream provider.')
  out.push('# TYPE openmulti_tokens_total counter')
  for (const [id, s] of stats) {
    const [key, model, provider] = id.split(SEP) as [string, string, string]
    line('openmulti_tokens_total', `key="${esc(key)}",model="${esc(model)}",provider="${esc(provider)}",kind="prompt"`, s.promptTokens)
    line('openmulti_tokens_total', `key="${esc(key)}",model="${esc(model)}",provider="${esc(provider)}",kind="completion"`, s.completionTokens)
  }

  out.push('# HELP openmulti_cost_usd_total Upstream cost in USD (from usage.cost).')
  out.push('# TYPE openmulti_cost_usd_total counter')
  for (const [id, s] of stats) {
    const [key, model, provider] = id.split(SEP) as [string, string, string]
    line('openmulti_cost_usd_total', `key="${esc(key)}",model="${esc(model)}",provider="${esc(provider)}"`, s.costUsd)
  }

  // Duration as sum+count so a scraper can compute the average (avg = sum / count).
  out.push('# HELP openmulti_request_duration_ms_sum Total handling time, ms.')
  out.push('# TYPE openmulti_request_duration_ms_sum counter')
  out.push('# HELP openmulti_request_duration_ms_count Requests timed.')
  out.push('# TYPE openmulti_request_duration_ms_count counter')
  for (const [id, s] of stats) {
    const [key, model, provider] = id.split(SEP) as [string, string, string]
    line('openmulti_request_duration_ms_sum', `key="${esc(key)}",model="${esc(model)}",provider="${esc(provider)}"`, s.durationMsSum)
    line('openmulti_request_duration_ms_count', `key="${esc(key)}",model="${esc(model)}",provider="${esc(provider)}"`, s.durationCount)
  }

  out.push('# HELP openmulti_pricing_miss_total Direct-provider responses whose cost could not be synthesized (model missing from pricing.ts).')
  out.push('# TYPE openmulti_pricing_miss_total counter')
  for (const [model, n] of pricingMisses) {
    line('openmulti_pricing_miss_total', `model="${esc(model)}"`, n)
  }

  out.push('# HELP openmulti_meter_dropped_total Durable metering writes lost (Redis unavailable) - billing undercounts when > 0.')
  out.push('# TYPE openmulti_meter_dropped_total counter')
  out.push(`openmulti_meter_dropped_total{} ${meterDrops}`)

  return out.join('\n') + '\n'
}

/** Test helper: wipe the registry between cases. */
export function _resetMetrics(): void {
  stats.clear()
  bandit.clear()
  pricingMisses.clear()
  meterDrops = 0
}
