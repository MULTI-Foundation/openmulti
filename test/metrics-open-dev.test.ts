// F1/F3/F7 (contre-épreuve) : le mode OPEN (aucune clé configurée nulle part = dev
// local) n'a pas de tenants à isoler, donc /metrics reste servi même sans token ops —
// c'est le seul cas où metricsAuth retombe sur l'auth appelante (ici : open). Zéro
// régression pour le dev. Le cas multi-tenant fail-closed est dans metrics-failclosed.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
delete process.env.OPENMULTI_API_KEYS // aucune allowlist env
delete process.env.OPENMULTI_METRICS_TOKEN // aucun token ops
delete process.env.REDIS_URL // aucun registre dynamique -> allowlist vide -> mode open

const { app } = await import('../src/app.ts')

test('dev open (aucune cle): /metrics reste accessible sans token ops', async () => {
  const res = await app.fetch(new Request('http://test/metrics', { headers: { authorization: 'Bearer anything' } }))
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/)
})
