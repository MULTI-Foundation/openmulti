// Le kill-switch du fallback de chemin (OPENMULTI_PATH_FALLBACK=0, lu à l'import —
// d'où ce fichier séparé) : un chemin direct en panne rend son erreur, comme avant
// l'incrément D.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_fbd_test'
process.env.MOONSHOT_API_KEY = 'msk-test'
process.env.OPENMULTI_PROVIDER_MOONSHOTAI = 'direct'
process.env.OPENMULTI_MAX_RETRIES = '0'
process.env.OPENMULTI_PATH_FALLBACK = '0'

const { app } = await import('../src/app.ts')
const { renderProm } = await import('../src/metrics.ts')

test('fallback coupe : la panne du chemin direct est rendue telle quelle', async () => {
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes('moonshot')) {
      return new Response('{"error":"down"}', { status: 503, headers: { 'content-type': 'application/json' } })
    }
    throw new Error('openrouter ne doit pas etre appele')
  }) as any

  const res = await app.fetch(new Request('http://test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer sk_fbd_test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'moonshotai/kimi-k2.6', messages: [{ role: 'user', content: 'hi' }] }),
  }))
  assert.equal(res.status, 503)
  assert.doesNotMatch(renderProm(), /openmulti_path_fallback_total\{/)
})
