// Modèles morts - vécu prod 2026-11-03 : qwen/qwen3-coder-plus déprécié restait candidat
// des slots agent, chaque élection finissait en 404 terminal OpenRouter et le run de
// l'agent mourait sans sortie. Verrouille : double preuve (404 OpenRouter + absent du
// feed), re-routage UNE fois d'une décision auto, exclusion pendant le TTL, jamais de
// re-routage d'un modèle imposé par l'appelant, jauge des candidats absents du feed.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_dead_test'
process.env.OPENMULTI_MAX_RETRIES = '0'
process.env.OPENMULTI_MODELS_BALANCED = 'vendora/dead-1,vendorb/alive-2'

const KEY = 'sk_dead_test'
const DEAD = 'vendora/dead-1'
const ALIVE = 'vendorb/alive-2'

const { app } = await import('../src/app.ts')
const dm = await import('../src/dead-models.ts')
const { renderProm, _resetMetrics } = await import('../src/metrics.ts')

let calls: string[] = []
let deadBody = '{"error":{"message":"Dead 1 was deprecated on Oct 9, 2026.","code":404}}'

const ok = () =>
  new Response(JSON.stringify({ id: 'gen-1', choices: [{ message: { role: 'assistant', content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

beforeEach(() => {
  _resetMetrics()
  dm._resetDeadModels()
  dm._setDeadModelsFeedForTests([ALIVE, 'vendorc/other-3'])
  calls = []
  deadBody = '{"error":{"message":"Dead 1 was deprecated on Oct 9, 2026.","code":404}}'
  globalThis.fetch = (async (_url: any, init: any) => {
    const model = JSON.parse(String(init?.body ?? '{}')).model as string
    calls.push(model)
    if (model === DEAD) return new Response(deadBody, { status: 404, headers: { 'content-type': 'application/json' } })
    return ok()
  }) as any
})

const chat = (body: Record<string, unknown> = {}) =>
  app.fetch(new Request('http://test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], openmulti: { tier: 'balanced' }, ...body }),
  }))

test('unité : variantes d\'id (suffixe :variant, tirets de version -> points)', () => {
  assert.deepEqual(dm.idVariants('anthropic/claude-sonnet-4-5'), ['anthropic/claude-sonnet-4-5', 'anthropic/claude-sonnet-4.5'])
  assert.deepEqual(dm.idVariants('openai/gpt-oss-120b:nitro'), ['openai/gpt-oss-120b:nitro', 'openai/gpt-oss-120b'])
  const ids = new Set(['anthropic/claude-sonnet-4.5', 'openai/gpt-oss-120b'])
  assert.equal(dm.isListedOnOpenRouter('anthropic/claude-sonnet-4-5', ids), true)
  assert.equal(dm.isListedOnOpenRouter('openai/gpt-oss-120b:nitro', ids), true)
  assert.equal(dm.isListedOnOpenRouter('qwen/qwen3-coder-plus', ids), false)
  assert.equal(dm.isListedOnOpenRouter('qwen/qwen3-coder-plus', null), null, 'feed inconnu = inconnu')
})

test('unité : double preuve exigée (404 + openrouter + absent du feed)', () => {
  assert.equal(dm.markModelDead(DEAD, 400, 'openrouter'), false, '400 = la requête')
  assert.equal(dm.markModelDead(DEAD, 404, 'qwen'), false, 'chemin direct = quarantaine de chemin, pas mort')
  assert.equal(dm.markModelDead(ALIVE, 404, 'openrouter'), false, 'listé = 404 propre à la requête (No endpoints found)')
  dm._setDeadModelsFeedForTests(null)
  assert.equal(dm.markModelDead(DEAD, 404, 'openrouter'), false, 'feed inconnu = fail-open')
  dm._setDeadModelsFeedForTests([ALIVE])
  assert.equal(dm.markModelDead(DEAD, 404, 'openrouter', 1000), true)
  assert.equal(dm.isModelDead(DEAD, 1000 + 1), true)
  assert.equal(dm.isModelDead(DEAD, 1000 + 6 * 3600 * 1000), false, 'TTL 6 h par défaut')
})

test('auto : 404 d\'un modèle mort -> re-routé UNE fois vers un candidat vivant, 200', async () => {
  const res = await chat()
  assert.equal(res.status, 200)
  assert.deepEqual(calls, [DEAD, ALIVE])
  const body = (await res.json()) as any
  assert.match(body.openmulti.reason, /rerouted from vendora\/dead-1 \(model unavailable\)/)
  assert.match(renderProm(), /openmulti_model_dead_total\{model="[^"]*"\} 1/)
})

test('auto : ensuite le modèle mort est écarté de l\'élection (aucun aller-retour perdu)', async () => {
  await chat()
  calls = []
  const res = await chat()
  assert.equal(res.status, 200)
  assert.deepEqual(calls, [ALIVE])
  const body = (await res.json()) as any
  assert.match(body.openmulti.reason, /unavailable model skipped/)
})

test('auto : 404 sur un modèle LISTÉ (paramètres non servables) -> relayé, pas de re-routage', async () => {
  dm._setDeadModelsFeedForTests([DEAD, ALIVE])
  deadBody = '{"error":{"message":"No endpoints found that can handle the requested parameters.","code":404}}'
  const res = await chat()
  assert.equal(res.status, 404)
  assert.deepEqual(calls, [DEAD])
})

test('modèle imposé par l\'appelant : jamais re-routé (la réponse demandée est celle de CE modèle)', async () => {
  const res = await chat({ model: DEAD, openmulti: undefined })
  assert.equal(res.status, 404)
  assert.deepEqual(calls, [DEAD])
})

test('stream : le re-routage a lieu avant le premier octet', async () => {
  globalThis.fetch = (async (_url: any, init: any) => {
    const model = JSON.parse(String(init?.body ?? '{}')).model as string
    calls.push(model)
    if (model === DEAD) return new Response(deadBody, { status: 404, headers: { 'content-type': 'application/json' } })
    return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as any
  const res = await chat({ stream: true })
  assert.equal(res.status, 200)
  assert.match(await res.text(), /OK/)
  assert.deepEqual(calls, [DEAD, ALIVE])
})

test('curation : candidats de chat absents du feed listés, image/embedding ignorés', () => {
  const entries = [
    { model: DEAD, tiers: ['balanced' as const], purposes: [] },
    { model: ALIVE, tiers: ['balanced' as const], purposes: [] },
    { model: 'anthropic/claude-sonnet-4-5', tiers: [], purposes: ['agent'] },
    { model: 'microsoft/mai-image-2.5', tiers: [], purposes: ['image'] },
    { model: 'openai/text-embedding-3-small', tiers: [], purposes: ['embedding'] },
  ]
  assert.deepEqual(dm.computeUnlisted(entries, new Set([ALIVE, 'anthropic/claude-sonnet-4.5'])), [DEAD])
})
