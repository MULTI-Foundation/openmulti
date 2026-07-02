// Le helper pur de bornes de sortie (src/output-bounds.ts) + le clamp OM-01 côté
// buildUpstreamBody. Audit sécu 2026-07-02 : max_completion_tokens et n ne doivent PAS
// permettre de dépasser le plafond de tier ni de sous-estimer le devis. Les deux
// consommateurs (devis dans plan.ts, clamp dans openrouter.ts) partagent CE helper pour
// ne pas diverger.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'

const { completionCount, requestedOutputCap, effectiveOutputCap } = await import('../src/output-bounds.ts')
const { buildUpstreamBody } = await import('../src/providers/openrouter.ts')

test('completionCount: defaut 1, valeurs invalides -> 1', () => {
  assert.equal(completionCount({ messages: [] } as never), 1)
  assert.equal(completionCount({ messages: [], n: 5 } as never), 5)
  for (const n of [0, -1, 2.5, NaN, Infinity, 'x' as never]) {
    assert.equal(completionCount({ messages: [], n } as never), 1, `n=${n}`)
  }
})

test('requestedOutputCap: max des deux champs (borne haute conservatrice)', () => {
  assert.equal(requestedOutputCap({ messages: [] } as never), undefined)
  assert.equal(requestedOutputCap({ messages: [], max_tokens: 100 } as never), 100)
  assert.equal(requestedOutputCap({ messages: [], max_completion_tokens: 300 } as never), 300)
  assert.equal(requestedOutputCap({ messages: [], max_tokens: 100, max_completion_tokens: 300 } as never), 300)
  assert.equal(requestedOutputCap({ messages: [], max_tokens: 500, max_completion_tokens: 100 } as never), 500)
})

test('effectiveOutputCap: min(demande, plafond) ; plafond seul si pas de demande', () => {
  assert.equal(effectiveOutputCap({ messages: [] } as never, undefined), undefined)
  assert.equal(effectiveOutputCap({ messages: [] } as never, 4000), 4000)
  assert.equal(effectiveOutputCap({ messages: [], max_tokens: 100 } as never, 4000), 100)
  assert.equal(effectiveOutputCap({ messages: [], max_tokens: 9000 } as never, 4000), 4000)
  assert.equal(effectiveOutputCap({ messages: [], max_completion_tokens: 9000 } as never, 4000), 4000)
})

test('OM-01: buildUpstreamBody clampe max_tokens ET max_completion_tokens au plafond', () => {
  const body = buildUpstreamBody(
    { messages: [{ role: 'user', content: 'x' }], max_tokens: 9000, max_completion_tokens: 8000 } as never,
    'anthropic/claude-haiku-4-5',
    4000,
  )
  assert.equal(body.max_tokens, 4000)
  assert.equal(body.max_completion_tokens, 4000)
})

test('OM-01: max_completion_tokens seul est clampe (ne contourne pas le plafond)', () => {
  const body = buildUpstreamBody(
    { messages: [{ role: 'user', content: 'x' }], max_completion_tokens: 200000 } as never,
    'anthropic/claude-haiku-4-5',
    4000,
  )
  assert.equal(body.max_completion_tokens, 4000)
})

test('OM-01: sous le plafond, les champs sont honores tels quels', () => {
  const body = buildUpstreamBody(
    { messages: [{ role: 'user', content: 'x' }], max_tokens: 100, max_completion_tokens: 200 } as never,
    'anthropic/claude-haiku-4-5',
    4000,
  )
  assert.equal(body.max_tokens, 100)
  assert.equal(body.max_completion_tokens, 200)
})
