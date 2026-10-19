// Tests de POST /v1/images : pass-through vers l'endpoint images d'OpenRouter, memes
// regles de contrat que /v1/embeddings (auto resolu sur le slot image, id concret
// honore, openmulti strippe, reponse byte-identique sans extension, champs hors
// allowlist retires, usage/cout enregistres, retry transitoire, erreur normalisee).

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_img_test'
process.env.OPENMULTI_MODEL_IMAGE = 'openai/gpt-image-2'
process.env.OPENMULTI_MAX_RETRIES = '1'
process.env.OPENMULTI_MAX_BODY_BYTES = '100000'

const KEY = 'sk_img_test'
const { app } = await import('../src/app.ts')
const { renderProm, _resetMetrics } = await import('../src/metrics.ts')

let lastUrl = ''
let lastBody: any
let responses: (() => Response)[] = []

const ok = () =>
  new Response(JSON.stringify({
    created: 0,
    data: [{ b64_json: 'iVBORw0KGgo=', media_type: 'image/png' }],
    usage: { prompt_tokens: 6, completion_tokens: 4175, total_tokens: 4181, cost: 0.009 },
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
  app.fetch(new Request('http://test/v1/images', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  }))

test('auth requise (la route vit sous /v1/*)', async () => {
  assert.equal((await post({ prompt: 'x' }, null)).status, 401)
})

test('auto -> modele image par defaut ; openmulti strippe ; reponse byte-identique', async () => {
  const res = await post({ model: 'auto', prompt: 'a mug', openmulti: { tier: 'economy' } })
  assert.equal(res.status, 200)
  assert.ok(lastUrl.endsWith('/images'))
  assert.equal(lastBody.model, 'openai/gpt-image-2')
  assert.equal(lastBody.openmulti, undefined)
  const j = await res.json()
  assert.ok(j.openmulti, 'extension envoyee -> reason attache')

  const j2 = await (await post({ prompt: 'a mug' })).json()
  assert.equal(j2.openmulti, undefined)
  assert.equal(j2.data[0].b64_json, 'iVBORw0KGgo=')
  assert.equal(j2.usage.cost, 0.009)
})

test('id concret honore ; parametres images transmis, champs inconnus retires', async () => {
  const ref = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]
  await post({ model: 'recraft/recraft-v4.1-vector', prompt: 'logo', aspect_ratio: '16:9', input_references: ref, temperature: 2 })
  assert.equal(lastBody.model, 'recraft/recraft-v4.1-vector')
  assert.equal(lastBody.aspect_ratio, '16:9')
  assert.deepEqual(lastBody.input_references, ref)
  assert.equal(lastBody.temperature, undefined)
})

test('prompt manquant ou vide -> 400 sans appel upstream', async () => {
  lastUrl = ''
  assert.equal((await post({ model: 'auto' })).status, 400)
  assert.equal((await post({ model: 'auto', prompt: '  ' })).status, 400)
  assert.equal(lastUrl, '')
})

test('usage enregistre dans les metriques (cout + tokens image)', async () => {
  await post({ model: 'auto', prompt: 'x' })
  const prom = renderProm()
  assert.match(prom, /openmulti_requests_total\{key="img",model="openai\/gpt-image-2",provider="openrouter"\} 1\b/)
  assert.match(prom, /openmulti_tokens_total\{key="img",model="openai\/gpt-image-2",provider="openrouter",kind="completion"\} 4175\b/)
})

test('panne transitoire -> retry puis succes ; erreur deterministe normalisee', async () => {
  const status = (s: number, body: string) => () =>
    new Response(body, { status: s, headers: { 'content-type': 'application/json' } })
  responses = [status(503, '{"error":"overloaded"}'), ok]
  assert.equal((await post({ prompt: 'x' })).status, 200)

  responses = [status(400, '{"error":{"message":"content policy from provider xyz"}}')]
  const res = await post({ prompt: 'x' })
  assert.equal(res.status, 400)
  const j = await res.json()
  assert.equal(j.error.type, 'upstream_rejected')
  assert.doesNotMatch(JSON.stringify(j), /provider xyz/)
})
