// Tests de la table de prix (spec multi-provider §5). buildPricing est pur, on le
// teste directement ; priceFor/computeCostUsd sont exercés via l'override env posé
// avant l'import (lu une fois au boot, comme le reste de la config).

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENMULTI_PRICING_JSON = JSON.stringify({
  'vendor/cheap': { inputPerMTok: 0.5, outputPerMTok: 1.5 },
  'vendor/free-tier': { inputPerMTok: 0, outputPerMTok: 0 },
  // tarifs cache portés par la table : hit à 0.1x, écriture à 1.25x (modèle Anthropic)
  'vendor/cached': { inputPerMTok: 1, outputPerMTok: 2, cachedInputPerMTok: 0.1, cacheWriteInputPerMTok: 1.25 },
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

test('les modeles du catalogue d\'exploitation sont tarifes (regression smoke 2026-07-02)', () => {
  // Un modele de catalogue sans prix, sur un chemin direct, est metered sans cout :
  // le bandit le croit gratuit et le sur-exploite. Verrouille les entrees ajoutees
  // (prix verifies API OpenRouter 2026-07-02) + la double graphie anthropic
  // (point cote OpenRouter, tiret cote API directe).
  // deepEqual STRICT : verrouille aussi les flags tiered/thinking (P0-1/Q-1) — en perdre
  // un ré-ouvrirait un devis « garanti » sous-estimant sur ces modèles.
  // deepEqual STRICT aussi sur les tarifs cache (cachedInputPerMTok / cacheWriteInputPerMTok) :
  // un tarif cache qui disparaît remet les tokens cachés au plein tarif (silencieusement).
  const expected: Record<string, { inputPerMTok: number; outputPerMTok: number; tiered?: true; thinking?: true; audioInputPerSecond?: number; cachedInputPerMTok?: number; cacheWriteInputPerMTok?: number }> = {
    'openai/gpt-5.1': { inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.125 },
    'openai/gpt-5-mini': { inputPerMTok: 0.25, outputPerMTok: 2, cachedInputPerMTok: 0.025 },
    'z-ai/glm-5': { inputPerMTok: 1, outputPerMTok: 3.2, cachedInputPerMTok: 0.2 },
    'qwen/qwen3-coder-plus': { inputPerMTok: 0.65, outputPerMTok: 3.25, tiered: true },
    // Prix audio (chantier x402 audio 2026-09-08) : 0.50 $/MTok x 32 tokens/s.
    'google/gemini-3.1-flash-lite': { inputPerMTok: 0.25, outputPerMTok: 1.5, thinking: true, audioInputPerSecond: 0.000016 },
    // Slot `audio` de prod : audio facturé à la seconde (pire endpoint OpenRouter).
    'mistralai/voxtral-small-24b-2507': { inputPerMTok: 0.11, outputPerMTok: 0.33, audioInputPerSecond: 0.00011 },
    'anthropic/claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3, cacheWriteInputPerMTok: 3.75 },
    'anthropic/claude-sonnet-4.5': { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3, cacheWriteInputPerMTok: 3.75 },
    'anthropic/claude-opus-4.8': { inputPerMTok: 5, outputPerMTok: 25, cachedInputPerMTok: 0.5, cacheWriteInputPerMTok: 6.25 },
  }
  for (const [model, price] of Object.entries(expected)) {
    assert.deepEqual(priceFor(model), price, `prix manquant/different pour ${model}`)
  }
})

test('gpt-oss-120b : tarifé (base ET variante :nitro), borne = pire provider du pool', () => {
  // Le slot `fast` de prod pointe ce modèle ; sans entrée de prix, les devis de
  // @fastest refuseraient. La variante :nitro (tri débit OpenRouter) doit être
  // tarifée à l'identique — même pool de providers, mêmes prix par provider.
  const base = priceFor('openai/gpt-oss-120b')
  const nitro = priceFor('openai/gpt-oss-120b:nitro')
  assert.ok(base && nitro)
  assert.deepEqual(base, nitro)
  assert.equal(base!.inputPerMTok, 0.35)
  assert.equal(base!.outputPerMTok, 0.95)
})

// ── Prompt caching : tokens cachés au tarif cache quand la table le porte ──────────

test('computeCostUsd: tokens cachés (read) au tarif cache hit, écriture au tarif write', () => {
  // 1M prompt dont 600k relus (0.1 $/M) et 100k écrits (1.25 $/M), 300k pleins (1 $/M) ; 10k out (2 $/M)
  // = 0.06 + 0.125 + 0.3 + 0.02
  assert.equal(computeCostUsd('vendor/cached', 1_000_000, 10_000, { read: 600_000, write: 100_000 }), 0.505)
  // sans ventilation cache : plein tarif (= comportement historique)
  assert.equal(computeCostUsd('vendor/cached', 1_000_000, 10_000), 1.02)
  assert.equal(computeCostUsd('vendor/cached', 1_000_000, 10_000, {}), 1.02)
})

test('computeCostUsd: tarif cache ABSENT de la table -> plein tarif input (jamais optimiste par defaut)', () => {
  // vendor/cheap n'a pas de cachedInputPerMTok : 600k cachés comptent comme 600k pleins
  assert.equal(computeCostUsd('vendor/cheap', 1_000_000, 10_000, { read: 600_000 }), 0.515)
})

test('computeCostUsd: comptes cache incoherents ecretes au prompt (pas de cout sous le plein tarif du reste)', () => {
  // read > prompt : tout le prompt au tarif cache, rien de negatif
  assert.equal(computeCostUsd('vendor/cached', 1_000, 0, { read: 5_000 }), 0.0001)
  // read + write > prompt : write ecrete a ce qui reste ; valeurs negatives ignorees
  assert.equal(computeCostUsd('vendor/cached', 1_000, 0, { read: 800, write: 800 }), (800 * 0.1 + 200 * 1.25) / 1_000_000)
  assert.equal(computeCostUsd('vendor/cached', 1_000, 0, { read: -5, write: -5 }), 0.001)
})

test('buildPricing: tarifs cache valides (optionnels, >= 0), invalides rejetes', () => {
  const { prices, invalid } = buildPricing({}, JSON.stringify({
    'ok/cached': { inputPerMTok: 1, outputPerMTok: 2, cachedInputPerMTok: 0.1, cacheWriteInputPerMTok: 1.25 },
    'ok/plain': { inputPerMTok: 1, outputPerMTok: 2 },
    'neg/cached': { inputPerMTok: 1, outputPerMTok: 2, cachedInputPerMTok: -0.1 },
    'nan/write': { inputPerMTok: 1, outputPerMTok: 2, cacheWriteInputPerMTok: 'x' },
  }))
  assert.deepEqual(Object.keys(prices).sort(), ['ok/cached', 'ok/plain'])
  assert.deepEqual(invalid.sort(), ['nan/write', 'neg/cached'])
})

test('tarifs cache verifies des chemins directs (Anthropic 2026-10-21, OpenAI 2026-10-21, Moonshot 2026-06-10)', () => {
  // Un tarif cache qui saute remet silencieusement les tokens cachés au plein tarif.
  assert.equal(priceFor('anthropic/claude-sonnet-4-6')?.cachedInputPerMTok, 0.3)
  assert.equal(priceFor('anthropic/claude-sonnet-4-6')?.cacheWriteInputPerMTok, 3.75)
  assert.equal(priceFor('anthropic/claude-haiku-4-5')?.cachedInputPerMTok, 0.1)
  assert.equal(priceFor('anthropic/claude-fable-5')?.cachedInputPerMTok, 1)
  assert.equal(priceFor('openai/gpt-5.5')?.cachedInputPerMTok, 0.5)
  assert.equal(priceFor('moonshotai/kimi-k2.6')?.cachedInputPerMTok, 0.16)
  // vendors dont le tarif cache n'est PAS vérifié : volontairement absent (plein tarif)
  assert.equal(priceFor('deepseek/deepseek-v4-flash')?.cachedInputPerMTok, undefined)
  assert.equal(priceFor('z-ai/glm-5')?.cachedInputPerMTok, 0.2)
  assert.equal(priceFor('z-ai/glm-5')?.cacheWriteInputPerMTok, undefined, 'stockage « limited-time free » : pas de prix d\'écriture inscrit')
})
