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

const SEP = '␟' // unit separator; cannot appear in a key label or model id
const stats = new Map<string, Stat>()

function bucket(key: string, model: string): Stat {
  const id = `${key}${SEP}${model}`
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
  promptTokens?: number
  completionTokens?: number
  costUsd?: number
  durationMs?: number
  error?: boolean
}

/** A transient upstream failure was retried (same model). */
export function recordRetry(key: string, model: string): void {
  bucket(key, model).retries += 1
}

export interface ModelAggregate {
  requests: number
  errors: number
  costUsd: number
}

/** Observed totals for one model, summed across every calling project. Feeds the
 * 'smart' selection strategy (see select.ts). */
export function modelAggregate(model: string): ModelAggregate {
  let requests = 0
  let errors = 0
  let costUsd = 0
  for (const [id, s] of stats) {
    if (id.slice(id.indexOf(SEP) + 1) === model) {
      requests += s.requests
      errors += s.errors
      costUsd += s.costUsd
    }
  }
  return { requests, errors, costUsd }
}

export function recordRequest(r: RequestRecord): void {
  const s = bucket(r.key, r.model)
  s.requests += 1
  if (r.error) s.errors += 1
  if (r.promptTokens) s.promptTokens += r.promptTokens
  if (r.completionTokens) s.completionTokens += r.completionTokens
  if (r.costUsd) s.costUsd += r.costUsd
  if (typeof r.durationMs === 'number') {
    s.durationMsSum += r.durationMs
    s.durationCount += 1
  }
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
    const [key, model] = id.split(SEP) as [string, string]
    line('openmulti_requests_total', `key="${esc(key)}",model="${esc(model)}"`, s.requests)
  }

  out.push('# HELP openmulti_request_errors_total Requests that failed upstream.')
  out.push('# TYPE openmulti_request_errors_total counter')
  for (const [id, s] of stats) {
    const [key, model] = id.split(SEP) as [string, string]
    line('openmulti_request_errors_total', `key="${esc(key)}",model="${esc(model)}"`, s.errors)
  }

  out.push('# HELP openmulti_retries_total Transient upstream failures retried (same model).')
  out.push('# TYPE openmulti_retries_total counter')
  for (const [id, s] of stats) {
    const [key, model] = id.split(SEP) as [string, string]
    line('openmulti_retries_total', `key="${esc(key)}",model="${esc(model)}"`, s.retries)
  }

  out.push('# HELP openmulti_tokens_total Tokens billed by the upstream provider.')
  out.push('# TYPE openmulti_tokens_total counter')
  for (const [id, s] of stats) {
    const [key, model] = id.split(SEP) as [string, string]
    line('openmulti_tokens_total', `key="${esc(key)}",model="${esc(model)}",kind="prompt"`, s.promptTokens)
    line('openmulti_tokens_total', `key="${esc(key)}",model="${esc(model)}",kind="completion"`, s.completionTokens)
  }

  out.push('# HELP openmulti_cost_usd_total Upstream cost in USD (from usage.cost).')
  out.push('# TYPE openmulti_cost_usd_total counter')
  for (const [id, s] of stats) {
    const [key, model] = id.split(SEP) as [string, string]
    line('openmulti_cost_usd_total', `key="${esc(key)}",model="${esc(model)}"`, s.costUsd)
  }

  // Duration as sum+count so a scraper can compute the average (avg = sum / count).
  out.push('# HELP openmulti_request_duration_ms_sum Total handling time, ms.')
  out.push('# TYPE openmulti_request_duration_ms_sum counter')
  out.push('# HELP openmulti_request_duration_ms_count Requests timed.')
  out.push('# TYPE openmulti_request_duration_ms_count counter')
  for (const [id, s] of stats) {
    const [key, model] = id.split(SEP) as [string, string]
    line('openmulti_request_duration_ms_sum', `key="${esc(key)}",model="${esc(model)}"`, s.durationMsSum)
    line('openmulti_request_duration_ms_count', `key="${esc(key)}",model="${esc(model)}"`, s.durationCount)
  }

  return out.join('\n') + '\n'
}

/** Test helper: wipe the registry between cases. */
export function _resetMetrics(): void {
  stats.clear()
}
