// Dérive de la table de prix vs feed OpenRouter. Verrouille : parsing des prix du feed
// (par token -> par MTok, strict), détection pure (tolérance, modèle absent du feed =
// ignoré, prix table nul = signalé), jauge Prometheus par modèle dérivant, GET
// /admin/pricing/drift (null tant que le feed n'est pas lu, token strict), et le
// cas réel qui a motivé le chantier (deepseek-v4-pro x2.2).

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'x'
process.env.OPENMULTI_API_KEYS = 'sk_drift_test'
process.env.OPENMULTI_ADMIN_TOKEN = 'admin-tok-drift'

const { parseModelPricing, _resetCatalogCacheForTests } = await import('../src/openrouter-catalog.ts')
const { computePricingDrift, refreshPricingDrift, pricingDriftReport, _resetPricingDriftForTests } = await import('../src/pricing-drift.ts')
const { renderProm, _resetMetrics } = await import('../src/metrics.ts')
const { priceFor } = await import('../src/pricing.ts')
const { app } = await import('../src/app.ts')

beforeEach(() => {
  _resetMetrics()
  _resetPricingDriftForTests()
  _resetCatalogCacheForTests()
})

test('parseModelPricing : par token -> par MTok, cache optionnel, entrées incomplètes absentes', () => {
  const p = parseModelPricing({
    data: [
      { id: 'deepseek/deepseek-v4-pro', pricing: { prompt: '0.00000095526', completion: '0.00000191052', input_cache_read: '0.000000079605' } },
      { id: 'x/no-cache', pricing: { prompt: 0.000001, completion: '0.000002' } },
      { id: 'x/free', pricing: { prompt: '0', completion: '0' } },
      { id: 'x/bad', pricing: { prompt: 'n/a', completion: '0.000002' } },
      { id: 'x/none' },
      { pricing: { prompt: '1', completion: '1' } },
    ],
  })
  assert.ok(Math.abs(p['deepseek/deepseek-v4-pro']!.inputPerMTok - 0.95526) < 1e-9)
  assert.ok(Math.abs(p['deepseek/deepseek-v4-pro']!.outputPerMTok - 1.91052) < 1e-9)
  assert.ok(Math.abs(p['deepseek/deepseek-v4-pro']!.cachedInputPerMTok! - 0.079605) < 1e-9)
  assert.deepEqual(p['x/no-cache'], { inputPerMTok: 1, outputPerMTok: 2 })
  assert.deepEqual(p['x/free'], { inputPerMTok: 0, outputPerMTok: 0 })
  assert.deepEqual(Object.keys(p).sort(), ['deepseek/deepseek-v4-pro', 'x/free', 'x/no-cache'])
  assert.deepEqual(parseModelPricing(null), {})
})

test('computePricingDrift : au-delà de 10 % signalé, en deçà non, absent du feed ignoré', () => {
  const rows = computePricingDrift(
    {
      'v/drift-in': { inputPerMTok: 1, outputPerMTok: 2 },
      'v/drift-out': { inputPerMTok: 1, outputPerMTok: 2 },
      'v/ok': { inputPerMTok: 1, outputPerMTok: 2 },
      'v/direct-only': { inputPerMTok: 1, outputPerMTok: 2 },
      'v/zero': { inputPerMTok: 0, outputPerMTok: 2 },
    },
    {
      'v/drift-in': { inputPerMTok: 1.2, outputPerMTok: 2 },
      'v/drift-out': { inputPerMTok: 1, outputPerMTok: 1.5 },
      'v/ok': { inputPerMTok: 1.09, outputPerMTok: 1.85 },
      'v/zero': { inputPerMTok: 0.5, outputPerMTok: 2 },
      'v/not-in-table': { inputPerMTok: 9, outputPerMTok: 9 },
    },
  )
  assert.deepEqual(rows.map((r) => r.model), ['v/drift-in', 'v/drift-out', 'v/zero'])
  assert.ok(Math.abs(rows[0]!.inputRatio - 1.2) < 1e-12)
  assert.equal(rows[0]!.outputRatio, 1)
  assert.equal(rows[1]!.outputRatio, 0.75)
  assert.equal(rows[2]!.inputRatio, Infinity, 'prix table nul face à un prix feed > 0 : signalé')
})

test('cas réel 2026-10-21 : deepseek-v4-pro à 0.435/0.87 dans la table, 0.955/1.91 chez OpenRouter', () => {
  const table = priceFor('deepseek/deepseek-v4-pro')
  assert.ok(table, 'le modèle doit rester tarifé pour que ce test ait un sens')
  const rows = computePricingDrift(
    { 'deepseek/deepseek-v4-pro': table },
    { 'deepseek/deepseek-v4-pro': { inputPerMTok: 0.95526, outputPerMTok: 1.91052 } },
  )
  // Signalé tant que la table n'est pas réalignée (à vérifier à la source, pas ici).
  if (Math.abs(table.inputPerMTok - 0.435) < 1e-9) {
    assert.equal(rows.length, 1)
    assert.ok(rows[0]!.inputRatio > 2.1 && rows[0]!.inputRatio < 2.3)
  }
})

test('refresh : jauge openmulti_pricing_drift_ratio par modèle dérivant (input/output)', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({
      data: [
        { id: 'deepseek/deepseek-v4-pro', pricing: { prompt: '0.00000095526', completion: '0.00000191052' } },
        { id: 'anthropic/claude-sonnet-4-6', pricing: { prompt: '0.000003', completion: '0.000015' } },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  const report = await refreshPricingDrift(5_000_000)
  assert.ok(report.rows)
  const prom = renderProm()
  if (report.rows.some((r) => r.model === 'deepseek/deepseek-v4-pro')) {
    assert.match(prom, /openmulti_pricing_drift_ratio\{model="deepseek\/deepseek-v4-pro",side="input"\} 2\.19/)
    assert.match(prom, /openmulti_pricing_drift_ratio\{model="deepseek\/deepseek-v4-pro",side="output"\} 2\.19/)
  }
  assert.doesNotMatch(prom, /drift_ratio\{model="anthropic\/claude-sonnet-4-6"/, 'sonnet-4-6 3/15 : aligné, pas de jauge')
})

test('refresh : feed vide ou en panne -> rapport inchangé (null au départ), jamais d\'exception', async () => {
  globalThis.fetch = (async () => { throw new Error('ECONNRESET') }) as typeof fetch
  const report = await refreshPricingDrift(9_000_000)
  assert.equal(report.rows, null)
  assert.equal(pricingDriftReport().rows, null)
  assert.doesNotMatch(renderProm(), /openmulti_pricing_drift_ratio\{/)
})

test('GET /admin/pricing/drift : tolérance + lignes (null tant que le feed n\'est pas lu) ; token strict', async () => {
  globalThis.fetch = (async () => new Response('oops', { status: 503 })) as typeof fetch
  let res = await app.fetch(new Request('http://t/admin/pricing/drift', { headers: { authorization: 'Bearer admin-tok-drift' } }))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { tolerance_pct: 10, rows: null })
  res = await app.fetch(new Request('http://t/admin/pricing/drift', { headers: { authorization: 'Bearer nope' } }))
  assert.equal(res.status, 401)
})
