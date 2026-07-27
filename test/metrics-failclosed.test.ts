// F1/F3/F7 : /metrics est FAIL-CLOSED sans token ops dès qu'une allowlist existe. Une
// clé appelante ne lit plus l'exposition per-projet (fuite cross-tenant coût/tokens/
// facturé) : sans OPENMULTI_METRICS_TOKEN, une allowlist configurée -> 503. Le repli sur
// l'auth appelante ne subsiste que dans le mode open (aucune clé = dev local), couvert
// par metrics-open-dev.test.ts (config distincte, autre process de test).

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_test_proj'
delete process.env.OPENMULTI_METRICS_TOKEN // token ops absent : cas par défaut du finding

const { app } = await import('../src/app.ts')

const KEY = 'sk_test_proj'

test('F1: sans token ops, une cle appelante valide est REFUSEE (503, pas de fuite)', async () => {
  const res = await app.fetch(new Request('http://test/metrics', { headers: { authorization: `Bearer ${KEY}` } }))
  assert.equal(res.status, 503)
  const body = (await res.json()) as { error?: { type?: string } }
  assert.equal(body.error?.type, 'metrics_disabled')
})

test('F1: sans token ops, /metrics sans autorisation est aussi refuse (503)', async () => {
  const res = await app.fetch(new Request('http://test/metrics'))
  assert.equal(res.status, 503)
})
