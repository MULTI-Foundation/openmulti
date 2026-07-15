// P0-9 (régime effondré) + P0-10 (gate de santé appliqué à l'exploration). Fichier
// dédié car il fige un env EFFONDRÉ lu à l'import (MIN_SAMPLES >= DECAY_WINDOW), et
// chaque fichier node:test est un process isolé — les env n'y fuient pas.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_SMART_MIN_SAMPLES = '20'
process.env.OPENMULTI_SMART_MAX_ERROR_RATE = '0.2'
process.env.OPENMULTI_SMART_DECAY_WINDOW = '10' // MIN(20) >= WINDOW(10) => effondré

const { selectModel, banditRegimeCollapsed } = await import('../src/select.ts')
const { recordRequest, renderProm, _resetMetrics, _setKnownModelsForTest } = await import('../src/metrics.ts')

type Agg = { requests: number; errors: number; costUsd: number }

beforeEach(() => {
  _resetMetrics()
  _setKnownModelsForTest(['a/1', 'b/2'])
})

test('P0-9 : banditRegimeCollapsed — window>0 & MIN>=window => true ; window=0 (legacy) => false', () => {
  assert.equal(banditRegimeCollapsed(20, 10), true)
  assert.equal(banditRegimeCollapsed(10, 10), true) // >= : la saturation empêche le plancher
  assert.equal(banditRegimeCollapsed(9, 10), false)
  assert.equal(banditRegimeCollapsed(20, 0), false) // legacy (pas d'amortissement) : non effondré
  assert.equal(banditRegimeCollapsed(200, 200), true)
})

test('P0-9 : le boot SIGNALE le régime effondré via la jauge Prometheus (posée à 1)', () => {
  // select.ts a été importé avec MIN=20 >= WINDOW=10 -> setBanditCollapsedRegime(true).
  assert.match(renderProm(), /openmulti_bandit_collapsed_regime\{\} 1\b/)
})

test('P0-10 : l\'exploration écarte un bras malsain quand un sain sous-échantillonné existe', () => {
  // Aggregate injecté (déterministe) : b/2 est le MOINS échantillonné mais malsain
  // (taux d'erreur 1.0). Sans le fix, l'exploration prend le moins-échantillonné (b/2) ;
  // avec, le gate de santé l'écarte au profit de a/1 (sain).
  const stats: Record<string, Agg> = {
    'a/1': { requests: 1, errors: 0, costUsd: 0.1 },
    'b/2': { requests: 0.5, errors: 0.5, costUsd: 0.01 },
  }
  const s = selectModel(['a/1', 'b/2'], 'smart', (m) => stats[m]!)
  assert.equal(s.model, 'a/1')
})

test('P0-10 : repli — si TOUS les sous-échantillonnés sont malsains, on explore quand même', () => {
  // Garantit qu'on ne bloque jamais : un bras malade isolé garde sa chance de guérir.
  const stats: Record<string, Agg> = {
    'a/1': { requests: 1, errors: 1, costUsd: 0.1 }, // malsain
    'b/2': { requests: 0.5, errors: 0.5, costUsd: 0.01 }, // malsain, moins échantillonné
  }
  const s = selectModel(['a/1', 'b/2'], 'smart', (m) => stats[m]!)
  assert.equal(s.model, 'b/2') // aucun sain -> repli sur tous -> least-sampled
})

test('P0-10 : en régime effondré, un bras qui échoue toujours est écarté de l\'exploration', () => {
  // Chaque pick est une exploration (le plancher n'est jamais atteint). b/2 échoue
  // toujours -> jugé malsain -> exclu ; avant le fix il captait ~1/2 du trafic.
  const picks: string[] = []
  for (let i = 0; i < 200; i++) {
    const s = selectModel(['a/1', 'b/2'], 'smart')
    picks.push(s.model)
    recordRequest({ key: 'k', model: s.model, costUsd: 0.01, error: s.model === 'b/2' })
  }
  const tail = picks.slice(100)
  const bTail = tail.filter((m) => m === 'b/2').length
  assert.ok(bTail < tail.length / 4, `b/2 malsain doit rester écarté de l'exploration (vu ${bTail}/${tail.length})`)
  assert.ok(tail.filter((m) => m === 'a/1').length > tail.length / 2, 'a/1 (sain) capte l\'essentiel du trafic')
})
