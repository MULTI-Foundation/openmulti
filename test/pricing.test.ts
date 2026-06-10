// Tests de la table de prix (spec multi-provider §5). buildPricing est pur, on le
// teste directement ; priceFor/computeCostUsd sont exercés via l'override env posé
// avant l'import (lu une fois au boot, comme le reste de la config).

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENMULTI_PRICING_JSON = JSON.stringify({
  'vendor/cheap': { inputPerMTok: 0.5, outputPerMTok: 1.5 },
  'vendor/free-tier': { inputPerMTok: 0, outputPerMTok: 0 },
})

const { buildPricing, priceFor, computeCostUsd } = await import('../src/pricing.ts')

test('buildPricing: l\'override env gagne sur le defaut, entree par entree', () => {
  const defaults = {
    'a/1': { inputPerMTok: 3, outputPerMTok: 15 },
    'b/2': { inputPerMTok: 1, outputPerMTok: 5 },
  }
  const { prices, invalid } = buildPricing(defaults, '{"a/1":{"inputPerMTok":2,"outputPerMTok":10}}')
  assert.deepEqual(prices['a/1'], { inputPerMTok: 2, outputPerMTok: 10 }) // surchargé
  assert.deepEqual(prices['b/2'], { inputPerMTok: 1, outputPerMTok: 5 }) // conservé
  assert.deepEqual(invalid, [])
})

test('buildPricing: JSON invalide -> defauts intacts + signale, jamais un crash au boot', () => {
  const defaults = { 'a/1': { inputPerMTok: 3, outputPerMTok: 15 } }
  for (const bad of ['{oops', '[1,2]', '"str"']) {
    const { prices, invalid } = buildPricing(defaults, bad)
    assert.deepEqual(prices, defaults)
    assert.deepEqual(invalid, ['*'])
  }
})

test('buildPricing: entree malformee rejetee et signalee, les valides passent', () => {
  const { prices, invalid } = buildPricing({}, JSON.stringify({
    'ok/model': { inputPerMTok: 1, outputPerMTok: 2 },
    'neg/model': { inputPerMTok: -1, outputPerMTok: 2 },
    'nan/model': { inputPerMTok: 'x', outputPerMTok: 2 },
    'partial/model': { inputPerMTok: 1 },
  }))
  assert.deepEqual(Object.keys(prices), ['ok/model'])
  assert.deepEqual(invalid.sort(), ['nan/model', 'neg/model', 'partial/model'])
})

test('computeCostUsd: synthese depuis les tokens (USD par MTok)', () => {
  // 100k tokens in à 0.5 $/M + 10k tokens out à 1.5 $/M = 0.05 + 0.015
  assert.equal(computeCostUsd('vendor/cheap', 100_000, 10_000), 0.065)
  // un modele tarife a zero rend un VRAI zero (prix connu, pas un trou)
  assert.equal(computeCostUsd('vendor/free-tier', 100_000, 10_000), 0)
})

test('computeCostUsd: modele non tarife -> undefined, jamais un faux zero', () => {
  assert.equal(computeCostUsd('unknown/model', 100_000, 10_000), undefined)
  assert.equal(priceFor('unknown/model'), undefined)
})
