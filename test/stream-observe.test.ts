// P0-7 : un stream annulé par le client (déconnexion) doit tout de même produire UNE
// observation (usage partiel scanné jusqu'ici) — sinon la requête est invisible au
// bandit et au metering. Fichier dédié : il possède son env et inspecte le registre.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_obs_test'

const KEY = 'sk_obs_test'
const { app } = await import('../src/app.ts')
const { renderProm, _resetMetrics, _setKnownModelsForTest } = await import('../src/metrics.ts')

beforeEach(() => {
  _resetMetrics()
  _setKnownModelsForTest(['test/model']) // label déterministe (sinon borné à 'other')
})

const post = (body: unknown) =>
  app.fetch(new Request('http://test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  }))

test('P0-7 : cancel client -> observation partielle enregistrée (bandit/metering)', async () => {
  const enc = new TextEncoder()
  globalThis.fetch = (async () => {
    const stream = new ReadableStream({
      start(c) {
        // un chunk portant DÉJÀ l'usage (cost) puis jamais close : flux upstream en cours
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":5,"completion_tokens":3,"cost":0.002}}\n\n'))
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as never

  const res = await post({ model: 'test/model', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 200)
  const reader = res.body!.getReader()
  await reader.read() // lit le chunk usage -> le scanner l'a capté
  await reader.cancel() // = déconnexion client -> cancel() du ReadableStream
  await new Promise((r) => setTimeout(r, 25)) // laisser cancel()+record se propager

  const prom = renderProm()
  // AVANT le fix : aucune ligne (0 observation). APRÈS : 1 requête + le coût partiel.
  assert.match(prom, /openmulti_requests_total\{key="obs",model="test\/model",provider="openrouter"\} 1\b/)
  assert.match(prom, /openmulti_cost_usd_total\{key="obs",model="test\/model",provider="openrouter"\} 0\.002\b/)
  // un cancel n'est PAS une erreur du modèle
  assert.match(prom, /openmulti_request_errors_total\{key="obs",model="test\/model",provider="openrouter"\} 0\b/)
})
