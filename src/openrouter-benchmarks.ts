// Benchmarks OpenRouter (export public quotidien, CC BY 4.0, sans clé) — le signal de
// QUALITÉ pour la curation du catalogue côté console. Deux benchmarks aujourd'hui :
// `tau_bench_verified_airline` (tool-calling agentique, bon proxy des slots agent_*) et
// `gpqa_diamond` (raisonnement scientifique). Rien d'automatique : la curation reste
// humaine (I-3 : pas de signal qualité propre au gateway, donc pas de bandit sur ces
// scores). Le badge « Pareto » de la page openrouter.ai n'est PAS dans l'export : on le
// recalcule (front accuracy × coût par tâche).
//
// Source vérifiée 2026-10-21 : `latest.manifest.json` (snapshot_date, sha256 des fichiers)
// puis le JSON daté qu'il désigne. On vérifie le sha256 avant de parser : un export
// tronqué ou altéré n'entre jamais en cache. Cache mémoire 24 h (cadence quotidienne),
// fail-open : injoignable = dernier état connu, sinon null (la console n'affiche rien).
//
// Attribution : « Source: OpenRouter (openrouter.ai), licensed under CC BY 4.0 » — exposée
// dans la réponse admin pour que la console l'affiche.

import { createHash } from 'node:crypto'
import { log } from './log.js'

export const BENCHMARK_EXPORT_BASE = 'https://openrouter.ai/api/v1/datasets/exports/benchmark-leaderboard'

export interface BenchRow {
  benchmark: string
  benchmarkPageUrl: string
  modelSlug: string
  modelPermaslug: string
  modelName: string
  provider: string
  accuracy: number
  accuracyStdDev: number | null
  runCount: number
  totalQuestions: number
  costPerTaskUsd: number
  durationPerTaskMs: number
  outputTokensPerTask: number
  lastRun: string
}

export interface Leaderboard {
  snapshotDate: string
  retrievedAt: string
  attribution: string
  rows: BenchRow[]
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Parse l'export JSON. Lenient sur les lignes (une ligne incomplète est ignorée, jamais
 * d'exception) ; null si la forme globale n'est pas celle attendue. */
export function parseLeaderboard(body: unknown): Leaderboard | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  if (!Array.isArray(b.rows)) return null
  const rows: BenchRow[] = []
  for (const raw of b.rows as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    const accuracy = num(r.accuracy)
    const cost = num(r.avg_cost_per_task_usd)
    const benchmark = str(r.benchmark)
    const modelSlug = str(r.model_slug)
    if (accuracy == null || cost == null || !benchmark || !modelSlug) continue
    rows.push({
      benchmark,
      benchmarkPageUrl: str(r.benchmark_page_url),
      modelSlug,
      modelPermaslug: str(r.model_permaslug) || modelSlug,
      modelName: str(r.model_name) || modelSlug,
      provider: str(r.provider_name) || 'unknown',
      accuracy,
      accuracyStdDev: num(r.accuracy_std_dev),
      runCount: num(r.run_count) ?? 0,
      totalQuestions: num(r.total_questions) ?? 0,
      costPerTaskUsd: cost,
      durationPerTaskMs: num(r.avg_duration_per_task_ms) ?? 0,
      outputTokensPerTask: num(r.avg_output_tokens_per_task) ?? 0,
      lastRun: str(r.last_run_timestamp),
    })
  }
  return {
    snapshotDate: str(b.snapshot_date),
    retrievedAt: str(b.retrieved_at),
    attribution: str(b.attribution),
    rows,
  }
}

/** Un modèle sur un benchmark, réduit à UNE ligne (un provider) + ses badges. */
export interface ModelScore {
  model: string
  modelName: string
  /** Provider dont la ligne a été retenue (cf pickRow). */
  provider: string
  accuracy: number
  accuracyStdDev: number | null
  costPerTaskUsd: number
  durationPerTaskMs: number
  runCount: number
  lastRun: string
  /** Sur le front de Pareto accuracy × coût : aucun modèle n'est à la fois meilleur ET moins cher. */
  pareto: boolean
  /** Le moins cher du front à ≤ 5 points d'accuracy du maximum. */
  bestValue: boolean
}

export interface BenchmarkTable {
  id: string
  pageUrl: string
  /** Triés par accuracy décroissante. */
  models: ModelScore[]
}

// Ligne retenue par modèle : la route `auto-routing` d'OpenRouter si elle a été mesurée
// (c'est ce qu'un client OpenRouter obtient par défaut), sinon le provider le plus précis
// (à égalité, le moins cher). On ne mélange jamais l'accuracy d'un provider avec le coût
// d'un autre : les deux viennent de la MÊME ligne.
function pickRow(rows: BenchRow[]): BenchRow {
  const auto = rows.find((r) => r.provider === 'auto-routing')
  if (auto) return auto
  let best = rows[0]!
  for (const r of rows) {
    if (r.accuracy > best.accuracy || (r.accuracy === best.accuracy && r.costPerTaskUsd < best.costPerTaskUsd)) best = r
  }
  return best
}

/** Ids (index dans `points`) du front de Pareto : maximiser accuracy, minimiser coût. */
export function paretoFront(points: Array<{ accuracy: number; cost: number }>): Set<number> {
  const order = points.map((p, i) => ({ ...p, i })).sort((a, b) => a.cost - b.cost || b.accuracy - a.accuracy)
  const front = new Set<number>()
  let bestAcc = -Infinity
  for (const p of order) {
    if (p.accuracy > bestAcc) {
      front.add(p.i)
      bestAcc = p.accuracy
    }
  }
  return front
}

const BEST_VALUE_TOLERANCE = 0.05

/** Agrège l'export par benchmark puis par modèle, et pose les badges. Pur, testé. */
export function buildTables(rows: BenchRow[]): BenchmarkTable[] {
  const byBench = new Map<string, Map<string, BenchRow[]>>()
  const pageUrls = new Map<string, string>()
  for (const r of rows) {
    let models = byBench.get(r.benchmark)
    if (!models) {
      models = new Map()
      byBench.set(r.benchmark, models)
    }
    if (r.benchmarkPageUrl && !pageUrls.has(r.benchmark)) pageUrls.set(r.benchmark, r.benchmarkPageUrl)
    const list = models.get(r.modelSlug)
    if (list) list.push(r)
    else models.set(r.modelSlug, [r])
  }
  const tables: BenchmarkTable[] = []
  for (const [id, models] of byBench) {
    const picked = [...models.values()].map(pickRow)
    const front = paretoFront(picked.map((r) => ({ accuracy: r.accuracy, cost: r.costPerTaskUsd })))
    const maxAcc = Math.max(...picked.map((r) => r.accuracy))
    let bestValue = -1
    picked.forEach((r, i) => {
      if (!front.has(i) || r.accuracy < maxAcc - BEST_VALUE_TOLERANCE) return
      if (bestValue < 0 || r.costPerTaskUsd < picked[bestValue]!.costPerTaskUsd) bestValue = i
    })
    const scores: ModelScore[] = picked.map((r, i) => ({
      model: r.modelSlug,
      modelName: r.modelName,
      provider: r.provider,
      accuracy: r.accuracy,
      accuracyStdDev: r.accuracyStdDev,
      costPerTaskUsd: r.costPerTaskUsd,
      durationPerTaskMs: r.durationPerTaskMs,
      runCount: r.runCount,
      lastRun: r.lastRun,
      pareto: front.has(i),
      bestValue: i === bestValue,
    }))
    scores.sort((a, b) => b.accuracy - a.accuracy || a.costPerTaskUsd - b.costPerTaskUsd)
    tables.push({ id, pageUrl: pageUrls.get(id) ?? '', models: scores })
  }
  tables.sort((a, b) => a.id.localeCompare(b.id))
  return tables
}

/** Slug de benchmark d'un id de catalogue : une variante OpenRouter (`:nitro`, `:free`) est
 * un routage, pas un modèle — on la retire pour retrouver la ligne mesurée. */
export function benchmarkSlugFor(catalogId: string): string {
  const i = catalogId.indexOf(':')
  return i > 0 ? catalogId.slice(0, i) : catalogId
}

export interface BenchmarksSnapshot {
  snapshotDate: string
  retrievedAt: string
  attribution: string
  benchmarks: BenchmarkTable[]
}

const TTL_MS = Math.max(60_000, Number(process.env.OPENMULTI_BENCHMARKS_TTL_MS ?? 24 * 60 * 60 * 1000))
let cache: (BenchmarksSnapshot & { at: number }) | null = null
let inflight: Promise<BenchmarksSnapshot | null> | null = null

interface Manifest {
  files?: { json?: { url?: unknown; sha256?: unknown } }
}

async function fetchSnapshot(): Promise<BenchmarksSnapshot | null> {
  const mres = await fetch(`${BENCHMARK_EXPORT_BASE}/latest.manifest.json`, { signal: AbortSignal.timeout(10_000) })
  if (!mres.ok) {
    log.warn('openrouter_benchmarks_manifest_not_ok', { status: mres.status })
    return null
  }
  const manifest = (await mres.json()) as Manifest
  const url = manifest.files?.json?.url
  const sha256 = manifest.files?.json?.sha256
  if (typeof url !== 'string' || !url.startsWith(BENCHMARK_EXPORT_BASE) || typeof sha256 !== 'string') {
    log.warn('openrouter_benchmarks_manifest_invalid', {})
    return null
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) {
    log.warn('openrouter_benchmarks_export_not_ok', { status: res.status })
    return null
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== sha256.toLowerCase()) {
    log.warn('openrouter_benchmarks_sha256_mismatch', { expected: sha256, got: digest })
    return null
  }
  const lb = parseLeaderboard(JSON.parse(bytes.toString('utf8')))
  if (!lb || lb.rows.length === 0) {
    log.warn('openrouter_benchmarks_export_empty', {})
    return null
  }
  return { snapshotDate: lb.snapshotDate, retrievedAt: lb.retrievedAt, attribution: lb.attribution, benchmarks: buildTables(lb.rows) }
}

/** Snapshot courant (caché 24 h, fail-open : dernier état connu, sinon null). `now` injectable. */
export async function fetchBenchmarks(now: number = Date.now()): Promise<BenchmarksSnapshot | null> {
  if (cache && now - cache.at < TTL_MS) return cache
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const snap = await fetchSnapshot()
      if (snap) cache = { ...snap, at: now }
      return snap ?? cache
    } catch (e) {
      log.warn('openrouter_benchmarks_error', { error: e instanceof Error ? e.message : String(e) })
      return cache
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** Test helper : vide le cache. */
export function _resetBenchmarksForTests(): void {
  cache = null
  inflight = null
}
