// Verrouille le seam Provider (docs/MULTI-PROVIDER-SPEC.md §3-4) côté v0 :
// un seul chemin d'accès (OpenRouter) et une normalisation strictement identité —
// c'est la propriété qui garantit, par construction, la réponse byte-identique du
// contrat (les octets eux-mêmes sont verrouillés par contract.test.ts).

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-key'

const { providerFor } = await import('../src/providers/index.ts')

test('v0: tout modele resout vers le chemin openrouter', () => {
  for (const m of ['anthropic/claude-sonnet-4-5', 'moonshotai/kimi-k2.6', 'openai/gpt-5', 'x/y']) {
    assert.equal(providerFor(m).name, 'openrouter')
  }
})

test('openrouter: normalizeResponse est l\'identite (meme reference, rien de modifie)', () => {
  const p = providerFor('anthropic/claude-sonnet-4-5')
  const data = { id: 'gen-1', usage: { prompt_tokens: 1, completion_tokens: 2, cost: 0.003 } }
  const out = p.normalizeResponse(data, 'anthropic/claude-sonnet-4-5')
  assert.equal(out, data) // identite stricte : aucune copie, aucun champ touche
})
