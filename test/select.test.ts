// Unit tests for the selection strategy. The catalog/contract are exercised in
// contract.test.ts; here we drive selectModel directly with seeded metrics.
// Ce fichier verrouille le mode SANS amortissement (DECAY_WINDOW=0 : stats à vie,
// explore une fois puis exploite pour toujours) ; le bandit amorti — le défaut —
// est verrouillé par test/bandit.test.ts (chaque fichier = un process node:test,
// donc chacun peut figer ses env lus à l'import).

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Read at import time by select.ts/metrics.ts — set low so tests stay short.
process.env.OPENROUTER_API_KEY ||= 'test-upstream-key' // metrics.ts importe catalog/pricing -> config
process.env.OPENMULTI_SMART_MIN_SAMPLES = '2'
process.env.OPENMULTI_SMART_MAX_ERROR_RATE = '0.2'
process.env.OPENMULTI_SMART_DECAY_WINDOW = '0'

const { selectModel } = await import('../src/select.ts')
const { recordRequest, _resetMetrics, _setKnownModelsForTest } = await import('../src/metrics.ts')

beforeEach(() => {
  _resetMetrics()
  _setKnownModelsForTest(['a/1', 'b/2']) // ids synthétiques déclarés connus (bornage cardinalité)
})

test('default: toujours le 1er candidat, quelles que soient les metriques', () => {
  recordRequest({ key: 'k', model: 'b/2', costUsd: 0.001 }) // b/2 moins cher mais ignore
  assert.equal(selectModel(['a/1', 'b/2'], 'default').model, 'a/1')
})

test('un seul candidat: smart == le candidat (pas de choix)', () => {
  assert.equal(selectModel(['a/1'], 'smart').model, 'a/1')
})

test('smart explore: comble les candidats sous-echantillonnes (least-sampled)', () => {
  assert.equal(selectModel(['a/1', 'b/2'], 'smart').model, 'a/1') // 0/0 -> ordre
  recordRequest({ key: 'k', model: 'a/1' })
  assert.equal(selectModel(['a/1', 'b/2'], 'smart').model, 'b/2') // a/1=1, b/2=0
})

test('smart exploit: choisit le moins cher une fois la data acquise', () => {
  for (let i = 0; i < 2; i++) recordRequest({ key: 'k', model: 'a/1', costUsd: 0.1 })
  for (let i = 0; i < 2; i++) recordRequest({ key: 'k', model: 'b/2', costUsd: 0.01 })
  assert.equal(selectModel(['a/1', 'b/2'], 'smart').model, 'b/2')
})

test('smart exploit: ecarte un candidat malsain malgre un cout plus bas', () => {
  for (let i = 0; i < 2; i++) recordRequest({ key: 'k', model: 'a/1', costUsd: 0.1 })
  for (let i = 0; i < 2; i++) recordRequest({ key: 'k', model: 'b/2', costUsd: 0.01, error: true })
  assert.equal(selectModel(['a/1', 'b/2'], 'smart').model, 'a/1')
})
