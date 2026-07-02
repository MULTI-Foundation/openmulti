// Audit sécu 2026-07-02 : le label `model` peut être contrôlé par l'appelant (id
// concret épinglé, panel council). Non borné, il fait exploser la cardinalité des Maps
// stats/bandit (OOM + boucle d'amortissement O(n) pénalisant tous les tenants). On borne
// au catalogue ∪ modèles tarifés, repli 'other'. Et `esc()` doit échapper \r (injection
// de ligne dans l'exposition /metrics).

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
// un modèle connu (tarifé dans pricing.ts) pour vérifier qu'il n'est PAS collapsé
process.env.OPENMULTI_MODEL_BALANCED = 'moonshotai/kimi-k2.6'

const { recordRequest, renderProm, modelAggregate, _resetMetrics } = await import('../src/metrics.ts')

beforeEach(() => _resetMetrics())

test('un modele inconnu (id force par l\'appelant) est collapse sur "other"', () => {
  for (let i = 0; i < 50; i++) recordRequest({ key: 'p', model: `x/uuid-${i}`, costUsd: 0.001 })
  const prom = renderProm()
  // aucune ligne ne porte un des ids d'attaque
  assert.ok(!prom.includes('x/uuid-0'), 'un id inconnu a fui dans /metrics')
  assert.ok(prom.includes('model="other"'), 'le bucket other est absent')
  // une seule entrée de coût pour tous les inconnus (cardinalité bornée)
  const otherCostLines = prom.split('\n').filter((l) => l.startsWith('openmulti_cost_usd_total') && l.includes('model="other"'))
  assert.equal(otherCostLines.length, 1)
})

test('un modele connu (catalogue/tarifé) garde son id', () => {
  recordRequest({ key: 'p', model: 'moonshotai/kimi-k2.6', costUsd: 0.002 })
  const prom = renderProm()
  assert.ok(prom.includes('model="moonshotai/kimi-k2.6"'))
})

test('le bandit ne grossit pas avec des modeles inconnus (tous collapses sur other)', () => {
  for (let i = 0; i < 100; i++) recordRequest({ key: 'p', model: `junk/${i}` })
  // Tous les ids inconnus pointent le MÊME bucket 'other' : la requête pour n'importe
  // lequel renvoie l'agrégat d'other (preuve du collapse, donc cardinalité bornée).
  const other = modelAggregate('other').requests
  assert.ok(other > 0)
  assert.equal(modelAggregate('junk/7').requests, other)
  assert.equal(modelAggregate('junk/50').requests, other)
  // un modèle CONNU mais non sollicité reste bien distinct (à 0).
  assert.equal(modelAggregate('moonshotai/kimi-k2.6').requests, 0)
})

test('esc: un retour chariot dans un label est echappe (pas d\'injection de ligne)', () => {
  // un id inconnu est déjà collapsé en 'other' ; on force un cas via une clé de projet.
  // keyLabel hash les clés hors motif, donc on vise le champ provider via un enregistrement.
  recordRequest({ key: 'p', model: 'moonshotai/kimi-k2.6', provider: 'evil\r\ninjected 999', costUsd: 0 })
  const prom = renderProm()
  assert.ok(!/\r/.test(prom), 'un \\r brut subsiste dans l\'exposition')
  assert.ok(prom.includes('\\r'), 'le \\r n\'a pas ete echappe')
})
