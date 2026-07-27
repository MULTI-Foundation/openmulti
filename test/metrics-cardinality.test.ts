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

const { recordRequest, renderProm, modelAggregate, recordPathFallback, recordPricingMiss, _resetMetrics } = await import('../src/metrics.ts')

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

test('F9: recordPathFallback borne le model inconnu sur "other" (Map non croissante)', () => {
  // Un flot d'ids uniques épinglés par l'appelant (failover à chaque 4xx d'un chemin direct)
  // ne doit pas créer une entrée par id : tous collapsent sur 'other'.
  for (let i = 0; i < 200; i++) recordPathFallback(`moonshotai/junk-${i}`, 'moonshot', 'openrouter')
  const prom = renderProm()
  const lines = prom.split('\n').filter((l) => l.startsWith('openmulti_path_fallback_total'))
  assert.ok(!prom.includes('moonshotai/junk-0'), 'un id inconnu a fui dans path_fallback')
  assert.equal(lines.length, 1, 'la cardinalite de path_fallback n\'est pas bornee')
  assert.ok(lines[0]!.includes('model="other"'))
  assert.ok(lines[0]!.endsWith(' 200'), 'les 200 bascules doivent s\'agreger sur other')
})

test('F9: un model CONNU garde son id dans path_fallback', () => {
  recordPathFallback('moonshotai/kimi-k2.6', 'moonshot', 'openrouter')
  const prom = renderProm()
  assert.ok(prom.includes('openmulti_path_fallback_total{model="moonshotai/kimi-k2.6"'))
})

test('F9: recordPricingMiss GARDE l\'id reel (signal ops) mais borne le nombre d\'ids (cap)', () => {
  // L'id réel est le signal (quel modèle ajouter à pricing.ts), donc pas de collapse ;
  // le backstop mémoire est un cap de taille : passé 256 ids distincts, plus de nouvel id,
  // mais les compteurs déjà présents continuent de monter.
  recordPricingMiss('moonshotai/kimi-future')
  recordPricingMiss('moonshotai/kimi-future')
  for (let i = 0; i < 400; i++) recordPricingMiss(`vendor/miss-${i}`)
  const prom = renderProm()
  // l'id réel est préservé avec son compte
  assert.match(prom, /openmulti_pricing_miss_total\{model="moonshotai\/kimi-future"\} 2\b/)
  // le nombre de séries est borné par le cap (256), pas 402
  const lines = prom.split('\n').filter((l) => l.startsWith('openmulti_pricing_miss_total{'))
  assert.ok(lines.length <= 256, `cardinalite pricing_miss non bornee: ${lines.length}`)
})

test('esc: un retour chariot dans un label est echappe (pas d\'injection de ligne)', () => {
  // un id inconnu est déjà collapsé en 'other' ; on force un cas via une clé de projet.
  // keyLabel hash les clés hors motif, donc on vise le champ provider via un enregistrement.
  recordRequest({ key: 'p', model: 'moonshotai/kimi-k2.6', provider: 'evil\r\ninjected 999', costUsd: 0 })
  const prom = renderProm()
  assert.ok(!/\r/.test(prom), 'un \\r brut subsiste dans l\'exposition')
  assert.ok(prom.includes('\\r'), 'le \\r n\'a pas ete echappe')
})
