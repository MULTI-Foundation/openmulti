// Benchmarks OpenRouter (export public) -> curation console. Verrouille : parsing lenient
// (ligne incomplète ignorée, forme inattendue -> null), front de Pareto et « best value »
// recalculés, ligne retenue par modèle (auto-routing d'abord, sinon le plus précis à coût
// cohérent), suffixe de variante retiré pour la correspondance, fetch vérifié par sha256
// (export altéré = jamais en cache), cache 24 h + fail-open, et GET /admin/benchmarks
// (null sans données, token ops strict).

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

process.env.OPENROUTER_API_KEY ||= 'x'
process.env.OPENMULTI_API_KEYS = 'sk_bench_test'
process.env.OPENMULTI_ADMIN_TOKEN = 'admin-tok-bench'

const { parseLeaderboard, paretoFront, buildTables, benchmarkSlugFor, fetchBenchmarks, _resetBenchmarksForTests, BENCHMARK_EXPORT_BASE } =
  await import('../src/openrouter-benchmarks.ts')
const { app } = await import('../src/app.ts')

const row = (o: Partial<Record<string, unknown>>) => ({
  benchmark: 'tau_bench_verified_airline',
  benchmark_page_url: 'https://openrouter.ai/benchmarks/tau2-bench-airline',
  model_permaslug: 'x/m-20260101',
  model_slug: 'x/m',
  model_name: 'X: M',
  provider_name: 'P',
  accuracy: 0.5,
  accuracy_std_dev: null,
  run_count: 1,
  total_questions: 50,
  avg_cost_per_task_usd: 0.01,
  avg_duration_per_task_ms: 1000,
  avg_output_tokens_per_task: 100,
  last_run_timestamp: '2026-10-10T00:00:00Z',
  ...o,
})

beforeEach(() => _resetBenchmarksForTests())

test('parseLeaderboard : lignes incomplètes ignorées, forme inattendue -> null', () => {
  const lb = parseLeaderboard({
    snapshot_date: '2026-10-21',
    retrieved_at: '2026-10-21T01:45:33Z',
    attribution: 'Source: OpenRouter',
    rows: [row({}), row({ accuracy: null }), row({ avg_cost_per_task_usd: 'n/a' }), 'junk', row({ model_slug: '' })],
  })
  assert.ok(lb)
  assert.equal(lb.rows.length, 1)
  assert.equal(lb.snapshotDate, '2026-10-21')
  assert.equal(lb.rows[0]!.provider, 'P')
  assert.equal(parseLeaderboard(null), null)
  assert.equal(parseLeaderboard({ rows: 'nope' }), null)
  assert.equal(parseLeaderboard([]), null)
})

test('paretoFront : aucun point du front n\'est dominé ; les dominés sont exclus', () => {
  const pts = [
    { accuracy: 0.9, cost: 1.0 }, // 0 front (le plus précis)
    { accuracy: 0.8, cost: 0.1 }, // 1 front
    { accuracy: 0.7, cost: 0.5 }, // 2 dominé par 1 (moins précis ET plus cher)
    { accuracy: 0.8, cost: 0.2 }, // 3 dominé par 1 (même accuracy, plus cher)
    { accuracy: 0.3, cost: 0.01 }, // 4 front (le moins cher)
    { accuracy: 0.9, cost: 1.0 }, // 5 doublon exact de 0 : un seul gardé
  ]
  assert.deepEqual([...paretoFront(pts)].sort(), [0, 1, 4])
  assert.deepEqual([...paretoFront([])], [])
})

test('buildTables : auto-routing retenu si mesuré, sinon le plus précis (coût de la MÊME ligne)', () => {
  const tables = buildTables(parseLeaderboard({
    rows: [
      row({ model_slug: 'a/auto', provider_name: 'Cheap', accuracy: 0.9, avg_cost_per_task_usd: 0.001 }),
      row({ model_slug: 'a/auto', provider_name: 'auto-routing', accuracy: 0.7, avg_cost_per_task_usd: 0.02 }),
      row({ model_slug: 'b/best', provider_name: 'P1', accuracy: 0.6, avg_cost_per_task_usd: 0.05 }),
      row({ model_slug: 'b/best', provider_name: 'P2', accuracy: 0.8, avg_cost_per_task_usd: 0.09 }),
      row({ model_slug: 'b/best', provider_name: 'P3', accuracy: 0.8, avg_cost_per_task_usd: 0.07 }),
    ],
  })!.rows)
  assert.equal(tables.length, 1)
  const t = tables[0]!
  assert.equal(t.id, 'tau_bench_verified_airline')
  assert.equal(t.pageUrl, 'https://openrouter.ai/benchmarks/tau2-bench-airline')
  const a = t.models.find((m) => m.model === 'a/auto')!
  assert.deepEqual([a.provider, a.accuracy, a.costPerTaskUsd], ['auto-routing', 0.7, 0.02])
  const b = t.models.find((m) => m.model === 'b/best')!
  assert.deepEqual([b.provider, b.accuracy, b.costPerTaskUsd], ['P3', 0.8, 0.07], 'à égalité d\'accuracy, le moins cher')
  // tri par accuracy décroissante
  assert.deepEqual(t.models.map((m) => m.model), ['b/best', 'a/auto'])
})

test('buildTables : badges Pareto et best value (≤ 5 pts du max, le moins cher du front)', () => {
  const tables = buildTables(parseLeaderboard({
    rows: [
      row({ model_slug: 'top', accuracy: 0.90, avg_cost_per_task_usd: 1.0 }),
      row({ model_slug: 'near', accuracy: 0.86, avg_cost_per_task_usd: 0.1 }), // front, à 4 pts -> best value
      row({ model_slug: 'cheap', accuracy: 0.80, avg_cost_per_task_usd: 0.01 }), // front, trop loin du max
      row({ model_slug: 'dom', accuracy: 0.85, avg_cost_per_task_usd: 0.5 }), // dominé par near
      row({ benchmark: 'gpqa_diamond', model_slug: 'only', accuracy: 0.5, avg_cost_per_task_usd: 0.2 }),
    ],
  })!.rows)
  assert.deepEqual(tables.map((t) => t.id), ['gpqa_diamond', 'tau_bench_verified_airline'])
  const tau = tables[1]!
  const by = Object.fromEntries(tau.models.map((m) => [m.model, m]))
  assert.deepEqual([by.top!.pareto, by.near!.pareto, by.cheap!.pareto, by.dom!.pareto], [true, true, true, false])
  assert.deepEqual(tau.models.filter((m) => m.bestValue).map((m) => m.model), ['near'])
  const gpqa = tables[0]!
  assert.equal(gpqa.models[0]!.pareto, true, 'seul modèle = sur le front')
  assert.equal(gpqa.models[0]!.bestValue, true)
})

test('benchmarkSlugFor : la variante OpenRouter (:nitro, :free) est un routage, pas un modèle', () => {
  assert.equal(benchmarkSlugFor('openai/gpt-oss-120b:nitro'), 'openai/gpt-oss-120b')
  assert.equal(benchmarkSlugFor('deepseek/deepseek-v4-flash'), 'deepseek/deepseek-v4-flash')
})

// ── fetch : manifest -> export daté, sha256, cache, fail-open ────────────────────

function mockFetch(opts: { manifest?: unknown; body?: string; sha?: string; manifestStatus?: number; exportStatus?: number }) {
  const calls: string[] = []
  const body = opts.body ?? JSON.stringify({ snapshot_date: '2026-10-21', retrieved_at: 'r', attribution: 'Source: OpenRouter', rows: [row({})] })
  const sha = opts.sha ?? createHash('sha256').update(body).digest('hex')
  const manifest = opts.manifest ?? { files: { json: { url: `${BENCHMARK_EXPORT_BASE}/2026-10-21.json`, sha256: sha } } }
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url)
    calls.push(u)
    if (u.endsWith('latest.manifest.json')) return new Response(JSON.stringify(manifest), { status: opts.manifestStatus ?? 200 })
    return new Response(body, { status: opts.exportStatus ?? 200 })
  }) as typeof fetch
  return calls
}

test('fetchBenchmarks : manifest puis export, sha256 vérifié, résultat caché 24 h', async () => {
  const calls = mockFetch({})
  const snap = await fetchBenchmarks(1000)
  assert.ok(snap)
  assert.equal(snap.snapshotDate, '2026-10-21')
  assert.equal(snap.benchmarks[0]!.models[0]!.model, 'x/m')
  assert.deepEqual(calls, [`${BENCHMARK_EXPORT_BASE}/latest.manifest.json`, `${BENCHMARK_EXPORT_BASE}/2026-10-21.json`])
  await fetchBenchmarks(1000 + 23 * 3600_000)
  assert.equal(calls.length, 2, 'dans le TTL : pas de refetch')
  await fetchBenchmarks(1000 + 25 * 3600_000)
  assert.equal(calls.length, 4, 'TTL expiré : refetch')
})

test('fetchBenchmarks : sha256 faux -> null, rien en cache ; export hors domaine -> null', async () => {
  mockFetch({ sha: 'deadbeef' })
  assert.equal(await fetchBenchmarks(1000), null)
  mockFetch({ manifest: { files: { json: { url: 'https://evil.example/x.json', sha256: 'aa' } } } })
  assert.equal(await fetchBenchmarks(2000), null)
})

test('fetchBenchmarks : panne après un premier chargement -> dernier état connu', async () => {
  mockFetch({})
  const first = await fetchBenchmarks(1000)
  assert.ok(first)
  mockFetch({ manifestStatus: 503 })
  const again = await fetchBenchmarks(1000 + 25 * 3600_000)
  assert.equal(again?.snapshotDate, '2026-10-21')
  globalThis.fetch = (async () => { throw new Error('ECONNRESET') }) as typeof fetch
  assert.equal((await fetchBenchmarks(1000 + 50 * 3600_000))?.snapshotDate, '2026-10-21')
})

test('fetchBenchmarks : jamais chargé + panne -> null (la console n\'affiche rien)', async () => {
  mockFetch({ manifestStatus: 500 })
  assert.equal(await fetchBenchmarks(1000), null)
})

// ── GET /admin/benchmarks ───────────────────────────────────────────────────────

const get = (tok = 'admin-tok-bench') => app.fetch(new Request('http://t/admin/benchmarks', { headers: { authorization: `Bearer ${tok}` } }))

test('GET /admin/benchmarks : snapshot agrégé avec badges ; null sans données ; token strict', async () => {
  mockFetch({ manifestStatus: 500 })
  let res = await get()
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { snapshot_date: null, attribution: null, benchmarks: null })

  mockFetch({})
  res = await get()
  const j = await res.json()
  assert.equal(j.snapshot_date, '2026-10-21')
  assert.equal(j.attribution, 'Source: OpenRouter')
  assert.equal(j.benchmarks[0].id, 'tau_bench_verified_airline')
  assert.equal(j.benchmarks[0].page_url, 'https://openrouter.ai/benchmarks/tau2-bench-airline')
  assert.equal(j.benchmarks[0].models[0].pareto, true)

  assert.equal((await get('wrong')).status, 401)
})
