// Tests de l'arbitrage de chemin d'accès (étape 4 de la spec multi-provider) :
// OPENMULTI_PROVIDER_MOONSHOTAI=smart fait arbitrer moonshot-direct vs openrouter
// par la même mécanique explore/exploit que le bandit de tier, nourrie des stats
// amorties PAR CHEMIN. Tout est déterministe (pas de RNG).

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.MOONSHOT_API_KEY = 'msk-test'
process.env.OPENMULTI_PROVIDER_MOONSHOTAI = 'smart'
process.env.OPENMULTI_SMART_MIN_SAMPLES = '2'
process.env.OPENMULTI_SMART_MAX_ERROR_RATE = '0.2'
process.env.OPENMULTI_SMART_DECAY_WINDOW = '20'

const { providerFor } = await import('../src/providers/index.ts')
const { recordRequest, modelAggregate, pathAggregate, renderProm, _resetMetrics } =
  await import('../src/metrics.ts')

const MODEL = 'moonshotai/kimi-k2.6'

beforeEach(() => _resetMetrics())

test('hors moonshotai/*, le mode smart ne change rien : openrouter', () => {
  assert.equal(providerFor('anthropic/claude-sonnet-4-5').name, 'openrouter')
})

test('a froid, les deux chemins sont explores', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 8; i++) {
    const p = providerFor(MODEL)
    seen.add(p.name)
    recordRequest({ key: 'k', model: MODEL, provider: p.name, costUsd: 0.01 })
  }
  assert.deepEqual([...seen].sort(), ['moonshot', 'openrouter'])
})

test('exploite le chemin le moins cher une fois la data acquise (direct sans la marge)', () => {
  for (let i = 0; i < 3; i++) recordRequest({ key: 'k', model: MODEL, provider: 'moonshot', costUsd: 0.008 })
  for (let i = 0; i < 3; i++) recordRequest({ key: 'k', model: MODEL, provider: 'openrouter', costUsd: 0.01 })
  assert.equal(providerFor(MODEL).name, 'moonshot')
})

test('exploite openrouter si c\'est lui le moins cher (pas de biais pro-direct)', () => {
  for (let i = 0; i < 3; i++) recordRequest({ key: 'k', model: MODEL, provider: 'moonshot', costUsd: 0.02 })
  for (let i = 0; i < 3; i++) recordRequest({ key: 'k', model: MODEL, provider: 'openrouter', costUsd: 0.01 })
  assert.equal(providerFor(MODEL).name, 'openrouter')
})

test('un chemin direct malade rebascule sur openrouter malgre un cout plus bas', () => {
  for (let i = 0; i < 3; i++) recordRequest({ key: 'k', model: MODEL, provider: 'moonshot', costUsd: 0.008, error: true })
  for (let i = 0; i < 3; i++) recordRequest({ key: 'k', model: MODEL, provider: 'openrouter', costUsd: 0.01 })
  assert.equal(providerFor(MODEL).name, 'openrouter')
})

test('boucle fermee : incident moonshot -> bascule openrouter -> guerison -> retour direct', () => {
  let moonshotDown = true
  const picks: string[] = []
  for (let i = 0; i < 200; i++) {
    if (i === 60) moonshotDown = false
    const p = providerFor(MODEL).name
    picks.push(p)
    recordRequest({
      key: 'k', model: MODEL, provider: p,
      costUsd: p === 'moonshot' ? 0.008 : 0.01,
      error: p === 'moonshot' && moonshotDown,
    })
  }
  const incident = picks.slice(20, 60)
  const after = picks.slice(150)
  assert.ok(incident.filter((p) => p === 'moonshot').length <= incident.length / 4,
    'pendant l\'incident, le direct doit rester minoritaire')
  assert.ok(after.filter((p) => p === 'moonshot').length > after.length / 2,
    'apres guerison, le direct (moins cher) doit redevenir le chemin elu')
})

test('la vue tier (modelAggregate) somme les chemins ; la vue chemin reste exacte', () => {
  recordRequest({ key: 'k', model: MODEL, provider: 'moonshot', costUsd: 0.5 })
  recordRequest({ key: 'k', model: MODEL, provider: 'openrouter', costUsd: 0.3 })
  const total = modelAggregate(MODEL)
  assert.ok(Math.abs(total.costUsd - (0.5 * 0.95 + 0.3)) < 1e-9, `somme des chemins (amortie): ${total.costUsd}`)
  assert.ok(pathAggregate('openrouter', MODEL).costUsd === 0.3)
  assert.ok(pathAggregate('moonshot', MODEL).requests > 0.9)
})

test('les compteurs Prometheus portent le label provider', () => {
  recordRequest({ key: 'k', model: MODEL, provider: 'moonshot', costUsd: 0.01 })
  assert.match(renderProm(), /openmulti_cost_usd_total\{key="k",model="moonshotai\/kimi-k2\.6",provider="moonshot"\} 0\.01\b/)
})
