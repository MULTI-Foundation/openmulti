// Tests de POST /v1/embeddings (incrément E) : pass-through OpenRouter avec les mêmes
// règles de contrat que le chat — auto résolu, id concret honoré, openmulti strippé à
// l'aller et réponse byte-identique sans extension, usage/coût enregistrés, retry
// transitoire, erreur upstream relayée telle quelle.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_emb_test'
process.env.OPENMULTI_MODEL_EMBEDDING = 'openai/text-embedding-3-small'
process.env.OPENMULTI_MAX_RETRIES = '1'

const KEY = 'sk_emb_test'
const { app } = await import('../src/app.ts')
const { renderProm, _resetMetrics } = await import('../src/metrics.ts')

let lastUrl = ''
let lastBody: any
let responses: (() => Response)[] = []

const ok = () =>
  new Response(JSON.stringify({
    object: 'list',
    data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
    model: 'openai/text-embedding-3-small',
    usage: { prompt_tokens: 7, total_tokens: 7, cost: 0.00000014 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  _resetMetrics()
  responses = [ok]
  globalThis.fetch = (async (url: any, init: any) => {
    lastUrl = String(url)
    lastBody = JSON.parse(init.body)
    const make = responses.length > 1 ? responses.shift()! : responses[0]!
    return make()
  }) as any
})

const post = (body: any, key: string | null = KEY) =>
  app.fetch(new Request('http://test/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  }))

test('auth requise (la route vit sous /v1/*)', async () => {
  assert.equal((await post({ input: 'x' }, null)).status, 401)
})

test('auto -> modele embedding par defaut ; openmulti strippe ; reponse byte-identique', async () => {
  const res = await post({ model: 'auto', input: ['hello'], openmulti: { tier: 'economy' } })
  assert.equal(res.status, 200)
  assert.ok(lastUrl.endsWith('/embeddings'))
  assert.equal(lastBody.model, 'openai/text-embedding-3-small')
  assert.equal(lastBody.openmulti, undefined)
  const j = await res.json()
  assert.ok(j.openmulti, 'extension envoyee -> reason attache')

  // sans extension : pas un champ de plus
  const res2 = await post({ model: 'auto', input: 'hello' })
  const j2 = await res2.json()
  assert.equal(j2.openmulti, undefined)
  assert.equal(j2.usage.cost, 0.00000014)
})

test('id concret honore tel quel', async () => {
  await post({ model: 'qwen/qwen3-embedding-8b', input: 'x' })
  assert.equal(lastBody.model, 'qwen/qwen3-embedding-8b')
})

test('input manquant -> 400 sans appel upstream', async () => {
  lastUrl = ''
  const res = await post({ model: 'auto' })
  assert.equal(res.status, 400)
  assert.equal(lastUrl, '')
})

test('usage enregistre dans les metriques (tokens + cout)', async () => {
  await post({ model: 'auto', input: 'x' })
  const prom = renderProm()
  assert.match(prom, /openmulti_requests_total\{key="emb",model="openai\/text-embedding-3-small",provider="openrouter"\} 1\b/)
  assert.match(prom, /openmulti_tokens_total\{key="emb",model="openai\/text-embedding-3-small",provider="openrouter",kind="prompt"\} 7\b/)
})

test('panne transitoire -> retry puis succes ; erreur deterministe relayee telle quelle', async () => {
  const status = (s: number, body: string) => () =>
    new Response(body, { status: s, headers: { 'content-type': 'application/json' } })
  responses = [status(503, '{"error":"overloaded"}'), ok]
  assert.equal((await post({ model: 'auto', input: 'x' })).status, 200)

  // OM-07 : statut conserve, corps upstream jamais relaye (normalise)
  responses = [status(422, '{"error":{"message":"bad input from provider xyz"}}')]
  const res = await post({ model: 'auto', input: 'x' })
  assert.equal(res.status, 422)
  const j = await res.json()
  assert.equal(j.error.type, 'upstream_rejected')
  assert.doesNotMatch(JSON.stringify(j), /provider xyz/)
})
