// Tests du bandit amorti (la stratégie 'smart' avec DECAY_WINDOW > 0, le défaut).
// Le mode sans amortissement (WINDOW=0, legacy) est verrouillé par select.test.ts.
// Tout est déterministe (pas de RNG) : on déroule des séquences en boucle fermée
// (select -> record) et on vérifie les propriétés bandit — exploration continue,
// guérison d'un modèle malade, primauté du récent sur l'historique.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Lus à l'import par select.ts / metrics.ts — fenêtre courte pour des tests courts.
// rho = 1 - 1/20 = 0.95 ; exploration en régime établi ~ MIN_SAMPLES/WINDOW = 10 %.
process.env.OPENROUTER_API_KEY ||= 'test-upstream-key' // metrics.ts importe catalog/pricing -> config
process.env.OPENMULTI_SMART_MIN_SAMPLES = '2'
process.env.OPENMULTI_SMART_MAX_ERROR_RATE = '0.2'
process.env.OPENMULTI_SMART_DECAY_WINDOW = '20'

const { selectModel } = await import('../src/select.ts')
const { recordRequest, modelAggregate, renderProm, _resetMetrics, _setKnownModelsForTest } = await import('../src/metrics.ts')

beforeEach(() => {
  _resetMetrics()
  // Les ids synthétiques doivent être "connus" sinon le bornage de cardinalité les
  // collapse sur 'other' (cf metrics-cardinality.test.ts).
  _setKnownModelsForTest(['a/1', 'b/2'])
})

test('decay: la vue bandit s\'amortit, les compteurs Prometheus restent monotones', () => {
  recordRequest({ key: 'k', model: 'a/1', costUsd: 1 })
  recordRequest({ key: 'k', model: 'b/2' }) // amortit a/1 d'un facteur rho
  const a = modelAggregate('a/1')
  assert.ok(a.requests > 0.94 && a.requests < 1, `requests amorti attendu ~0.95, obtenu ${a.requests}`)
  assert.ok(a.costUsd > 0.94 && a.costUsd < 1)
  // Le compteur exposé sur /metrics, lui, ne décroît jamais.
  assert.match(renderProm(), /openmulti_requests_total\{key="k",model="a\/1",provider="openrouter"\} 1\b/)
})

test('refresh: le candidat non élu continue d\'être ré-échantillonné (pas d\'exploit éternel)', () => {
  // Boucle fermée : b/2 moins cher devient l'élu, mais le décompte amorti de a/1
  // repasse périodiquement sous MIN_SAMPLES -> il revoit du trafic. En mode legacy
  // (stats à vie), a/1 ne serait plus JAMAIS choisi après la phase de remplissage.
  const picks: string[] = []
  for (let i = 0; i < 100; i++) {
    const s = selectModel(['a/1', 'b/2'], 'smart')
    picks.push(s.model)
    recordRequest({ key: 'k', model: s.model, costUsd: s.model === 'a/1' ? 0.1 : 0.01 })
  }
  const tail = picks.slice(50)
  const aPicks = tail.filter((m) => m === 'a/1').length
  assert.ok(aPicks >= 2, `a/1 doit rester exploré en régime établi (vu ${aPicks} fois sur ${tail.length})`)
  assert.ok(aPicks <= tail.length / 4, `l'exploration doit rester minoritaire (vu ${aPicks} fois sur ${tail.length})`)
})

test('guérison: un modèle malade redevient éligible une fois ses erreurs amorties', () => {
  // b/2 (moins cher) est en panne au début : écarté comme malsain, mais l'exploration
  // continue le re-teste. Quand l'incident se termine, ses succès diluent le taux
  // d'erreur amorti -> il redevient sain et reprend le trafic. En mode legacy, le
  // taux d'erreur à vie le bannirait durablement.
  const picks: string[] = []
  for (let i = 0; i < 200; i++) {
    const bDown = i < 60
    const s = selectModel(['a/1', 'b/2'], 'smart')
    picks.push(s.model)
    recordRequest({
      key: 'k',
      model: s.model,
      costUsd: s.model === 'a/1' ? 0.1 : 0.01,
      error: s.model === 'b/2' && bDown,
    })
  }
  const incident = picks.slice(20, 60)
  const after = picks.slice(150)
  const bDuring = incident.filter((m) => m === 'b/2').length
  const bAfter = after.filter((m) => m === 'b/2').length
  assert.ok(bDuring <= incident.length / 4, `pendant l'incident, b/2 doit rester minoritaire (${bDuring}/${incident.length})`)
  assert.ok(bAfter > after.length / 2, `après guérison, b/2 (moins cher) doit redevenir l'élu (${bAfter}/${after.length})`)
})

test('récence: un historique pas cher ne masque pas un coût récent élevé', () => {
  // a/1 a un long passé très bon marché puis devient cher ; b/2 est stable à 0.05.
  // Moyenne à vie de a/1 : (100*0.001 + 5*1)/105 ≈ 0.049 < 0.05 -> le legacy
  // choisirait a/1. La vue amortie pèse le récent : a/1 ≈ 0.23/req -> b/2 gagne.
  for (let i = 0; i < 100; i++) recordRequest({ key: 'k', model: 'a/1', costUsd: 0.001 })
  for (let i = 0; i < 5; i++) recordRequest({ key: 'k', model: 'a/1', costUsd: 1 })
  for (let i = 0; i < 3; i++) recordRequest({ key: 'k', model: 'b/2', costUsd: 0.05 })
  const s = selectModel(['a/1', 'b/2'], 'smart')
  assert.equal(s.model, 'b/2')
})
