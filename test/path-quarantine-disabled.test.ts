// OPENMULTI_PATH_QUARANTINE_TTL_S=0 coupe la quarantaine (échappatoire opérateur) :
// aucun marquage, l'élection et le failover par requête gardent le comportement
// historique. Fichier séparé car le TTL est lu à l'import du module.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_PATH_QUARANTINE_TTL_S = '0'

const { markPathUnservable, isPathQuarantined } = await import('../src/path-quarantine.ts')

test('TTL=0 : markPathUnservable est un no-op', () => {
  assert.equal(markPathUnservable('moonshot', 'moonshotai/kimi-k2.6', 404), false)
  assert.equal(isPathQuarantined('moonshot', 'moonshotai/kimi-k2.6'), false)
})
