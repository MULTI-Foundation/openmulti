// E-5 — devis council : la surface la plus chère devient quotable (donc payable x402).
// Borne = Σ des sous-appels au pire : fuse N+1, deliberate 2N+1. Verrouille le compte
// d'appels, la somme des bornes, la propagation d'un membre non quotable, et l'émission
// /v1/plan council (auparavant refusée en 400).

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_cq_test'
process.env.OPENMULTI_COUNCIL_PANEL_QUALITY = 'moonshotai/kimi-k2.6,deepseek/deepseek-chat'
process.env.OPENMULTI_COUNCIL_CHAIR = 'anthropic/claude-haiku-4-5'

const KEY = 'sk_cq_test'
const { app } = await import('../src/app.ts')
const { computeCouncilQuote } = await import('../src/council-quote.ts')
import type { ChatRequest } from '../src/types.ts'

const req = (over: Partial<ChatRequest> = {}): ChatRequest =>
  ({ model: 'auto', messages: [{ role: 'user', content: 'résume ce texte' }], max_tokens: 100, openmulti: { council: {} }, ...over })

test('fuse : N+1 appels (2 panel + chair), borne = somme des sous-appels', () => {
  const cq = computeCouncilQuote(req(), 1)
  assert.ok(!('error' in cq))
  if ('error' in cq) return
  assert.equal(cq.calls, 3) // 2 panel + 1 chair
  assert.deepEqual(cq.panel, ['moonshotai/kimi-k2.6', 'deepseek/deepseek-chat'])
  assert.equal(cq.chair, 'anthropic/claude-haiku-4-5')
  assert.ok(cq.quote && cq.quote.max_cost_usd > 0)
})

test('deliberate (N>=2) : 2N+1 appels (panel + revues + chair), borne >= fuse', () => {
  const fuse = computeCouncilQuote(req({ openmulti: { council: { mode: 'fuse' } } }), 1)
  const delib = computeCouncilQuote(req({ openmulti: { council: { mode: 'deliberate' } } }), 1)
  assert.ok(!('error' in fuse) && !('error' in delib))
  if ('error' in fuse || 'error' in delib) return
  assert.equal(delib.calls, 5) // 2 panel + 2 revues + chair
  // la ronde de revue ajoute du coût -> deliberate borne >= fuse
  assert.ok(delib.quote!.max_cost_usd >= fuse.quote!.max_cost_usd)
})

test('un membre non quotable propage l\'indisponibilité (pas de devis muet)', () => {
  const cq = computeCouncilQuote(req({ openmulti: { council: { panel: ['unknown/model'], chair: 'anthropic/claude-haiku-4-5' } } }), 1)
  assert.ok(!('error' in cq))
  if ('error' in cq) return
  assert.equal(cq.quote, null)
  assert.equal(cq.unavailable, 'pricing_unknown')
})

test('/v1/plan council : 200 avec devis agrégé + bloc council (plus de refus 400)', async () => {
  const res = await app.fetch(new Request('http://test/v1/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(req()),
  }))
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.model, 'council')
  assert.ok(j.quote && j.quote.max_cost_usd > 0)
  assert.equal(j.council.calls, 3)
  assert.deepEqual(j.council.panel, ['moonshotai/kimi-k2.6', 'deepseek/deepseek-chat'])
})
