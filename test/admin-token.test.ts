// audit #4 : le token admin (OPENMULTI_ADMIN_TOKEN) est DISTINCT du token /metrics.
// Un lecteur de /metrics ne doit pas pouvoir écrire via /admin/*, et inversement.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'x'
process.env.OPENMULTI_API_KEYS = 'sk_at_test'
process.env.OPENMULTI_METRICS_TOKEN = 'metrics-tok-aaa'
process.env.OPENMULTI_ADMIN_TOKEN = 'admin-tok-bbb'

const { app } = await import('../src/app.ts')
const get = (path: string, tok: string) =>
  app.fetch(new Request(`http://t${path}`, { headers: { authorization: `Bearer ${tok}` } }))

test('/admin/* exige le token ADMIN, refuse le token /metrics', async () => {
  assert.equal((await get('/admin/margins', 'admin-tok-bbb')).status, 200)
  assert.equal((await get('/admin/margins', 'metrics-tok-aaa')).status, 401)
  assert.equal((await get('/admin/margins', 'sk_at_test')).status, 401)
})

test('/metrics utilise le token /metrics, refuse le token admin', async () => {
  assert.equal((await get('/metrics', 'metrics-tok-aaa')).status, 200)
  assert.equal((await get('/metrics', 'admin-tok-bbb')).status, 401)
})
