// Fail-closed boot check: in production an empty key allowlist must refuse to start
// rather than leave /v1 open. Own file so it controls NODE_ENV in its own process.

import { test } from 'node:test'
import assert from 'node:assert/strict'

test('auth fail-closed: refuse de booter en production sans OPENMULTI_API_KEYS', async () => {
  process.env.NODE_ENV = 'production'
  process.env.OPENROUTER_API_KEY = 'x' // l'autre secret requis, sinon on echoue pour la mauvaise raison
  delete process.env.OPENMULTI_API_KEYS
  await assert.rejects(() => import('../src/config.ts'), /OPENMULTI_API_KEYS is required in production/)
})
