// Contract test: verrouille l'interface dont MyMULTI (et tout consommateur) depend.
// Tant que ces tests passent, on peut changer le catalogue, le routing, ajouter des
// providers, etc. SANS casser les consommateurs. L'upstream est mocke (aucun reseau).
//
// Les 5 points de couplage (cf docs/ARCHITECTURE.md section 5):
//   1. usage.cost preserve dans la reponse (facturation MyMULTI).
//   2. reponse OpenAI pure si pas d'extension openmulti (clients standard).
//   3. openmulti.reason expose si extension fournie.
//   4. model='auto' + tier resolu (purpose-aware), IDs concrets honores.
//   5. auth Bearer.

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// config.ts exige ces variables au chargement; le mock fetch evite tout appel reel.
process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS ||= 'sk_contract_test'
process.env.OPENMULTI_MODEL_BALANCED ||= 'anthropic/claude-sonnet-4-5'
process.env.OPENMULTI_MODEL_ECONOMY ||= 'anthropic/claude-haiku-4-5'
process.env.OPENMULTI_MODEL_AGENT_BALANCED ||= 'moonshotai/kimi-k2.6'
process.env.OPENMULTI_MODEL_IMAGE ||= 'google/gemini-2.5-flash-image'

const KEY = 'sk_contract_test'
let app: { fetch: (req: Request) => Promise<Response> }
let lastBody: any

// Import apres avoir pose l'env (config se charge a l'import).
before(async () => {
  ;({ app } = await import('../src/app.ts'))
})

beforeEach(() => {
  globalThis.fetch = (async (_url: any, init: any) => {
    lastBody = JSON.parse(init.body)
    return new Response(
      JSON.stringify({
        id: 'gen-1',
        model: lastBody.model,
        choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cost: 0.0123 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as any
})

function post(body: any, key: string | null = KEY) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (key) headers.authorization = `Bearer ${key}`
  return app.fetch(
    new Request('http://test/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) }),
  )
}

test('1. usage.cost est preserve tel quel (facturation MyMULTI)', async () => {
  const res = await post({ model: 'auto', openmulti: { tier: 'balanced' }, messages: [{ role: 'user', content: 'hi' }] })
  const j = await res.json()
  assert.equal(res.status, 200)
  assert.ok(j.usage, 'usage absent')
  assert.equal(j.usage.cost, 0.0123)
})

test('2. pas de champ openmulti sans extension (reponse OpenAI pure)', async () => {
  const res = await post({ model: 'anthropic/claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] })
  const j = await res.json()
  assert.equal(j.openmulti, undefined)
})

test('3. openmulti.reason expose quand extension fournie', async () => {
  const res = await post({ model: 'auto', openmulti: { tier: 'balanced', purpose: 'generation' }, messages: [{ role: 'user', content: 'hi' }] })
  const j = await res.json()
  assert.ok(j.openmulti?.reason)
})

test('4a. auto + tier:agent route vers le modele de code (purpose-aware)', async () => {
  await post({ model: 'auto', openmulti: { tier: 'balanced', purpose: 'agent' }, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(lastBody.model, 'moonshotai/kimi-k2.6')
})

test('4b. un modele concret est honore tel quel', async () => {
  await post({ model: 'anthropic/claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(lastBody.model, 'anthropic/claude-sonnet-4-5')
})

test('4b-bis. auto + modalities image route vers le modele image (pas un modele texte)', async () => {
  await post({ model: 'auto', modalities: ['image', 'text'], messages: [{ role: 'user', content: 'a cat' }] })
  assert.equal(lastBody.model, process.env.OPENMULTI_MODEL_IMAGE || 'google/gemini-2.5-flash-image')
})

test('4f. route:smart est opt-in et sur: avec un seul candidat il reste le modele iso', async () => {
  // En env de test, balanced n'a qu'un candidat (pas de OPENMULTI_MODELS_*), donc
  // smart == default == iso. Le routing multi-candidats est teste dans select.test.ts.
  await post({ model: 'auto', openmulti: { tier: 'balanced', route: 'smart' }, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(lastBody.model, 'anthropic/claude-sonnet-4-5')
})

test('4c. steering applique upstream (usage.include + provider.sort)', async () => {
  await post({ model: 'auto', openmulti: { tier: 'balanced' }, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(lastBody.usage?.include, true)
  assert.equal(lastBody.provider?.sort, 'throughput')
})

test('4d. floor max_tokens pour la famille Kimi quand non fourni', async () => {
  await post({ model: 'auto', openmulti: { tier: 'balanced', purpose: 'agent' }, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(lastBody.max_tokens, 32000)
})

test('4e. l extension openmulti n est jamais transmise a l upstream', async () => {
  await post({ model: 'auto', openmulti: { tier: 'balanced' }, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(lastBody.openmulti, undefined)
})

test('securite: /health ne divulgue pas la version (OM-08)', async () => {
  const res = await app.fetch(new Request('http://test/health'))
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.status, 'ok')
  assert.equal(j.version, undefined)
})

test('5a. 401 sans bearer', async () => {
  const res = await post({ model: 'auto', messages: [] }, null)
  assert.equal(res.status, 401)
})

test('5b. 401 sur mauvaise cle', async () => {
  const res = await post({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }, 'wrong')
  assert.equal(res.status, 401)
})

test('streaming: reponse SSE OpenAI passee en pass-through', async () => {
  globalThis.fetch = (async () => {
    const enc = new TextEncoder()
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'))
        c.enqueue(enc.encode('data: {"usage":{"prompt_tokens":5,"completion_tokens":2,"cost":0.001}}\n\n'))
        c.enqueue(enc.encode('data: [DONE]\n\n'))
        c.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as any
  const res = await post({ model: 'auto', openmulti: { tier: 'balanced' }, stream: true, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') || '', /event-stream/)
  const text = await res.text()
  assert.match(text, /data: /)
  assert.match(text, /\[DONE\]/)
})

test('securite: un model avec CRLF ne peut pas injecter d en-tete (OM-05)', async () => {
  globalThis.fetch = (async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        c.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as any
  // model concret (contient '/') porteur d'une tentative d'injection CRLF.
  const res = await post({ model: 'evil/x\r\nX-Injected: 1', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-injected'), null) // pas d'en-tete injecte
  assert.doesNotMatch(res.headers.get('x-openmulti-model') || '', /[\r\n]/)
})

test('streaming: annuler la reponse (client deconnecte) abort l upstream', async () => {
  let captured: AbortSignal | null = null
  globalThis.fetch = (async (_url: any, init: any) => {
    captured = init.signal
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
        // jamais close: simule un flux upstream encore en cours
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as any
  const res = await post({ model: 'auto', openmulti: { tier: 'balanced' }, stream: true, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 200)
  const reader = res.body!.getReader()
  await reader.read() // un chunk
  await reader.cancel() // = deconnexion client
  await new Promise((r) => setTimeout(r, 10)) // laisser cancel() se propager
  assert.ok(captured, 'signal upstream non capture')
  assert.equal((captured as AbortSignal).aborted, true)
})

test('retry: un 503 transitoire est reessaye (meme modele) puis reussit', async () => {
  let n = 0
  globalThis.fetch = (async (_url: any, init: any) => {
    n++
    lastBody = JSON.parse(init.body)
    if (n === 1) return new Response('busy', { status: 503 })
    return new Response(
      JSON.stringify({ id: 'gen-2', model: lastBody.model, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as any
  const res = await post({ model: 'auto', openmulti: { tier: 'balanced' }, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 200)
  assert.equal(n, 2) // 1 echec + 1 retry reussi
})

test('retry: une erreur 400 (deterministe) n est PAS reessayee', async () => {
  let n = 0
  globalThis.fetch = (async () => {
    n++
    return new Response(JSON.stringify({ error: 'bad' }), { status: 400, headers: { 'content-type': 'application/json' } })
  }) as any
  const res = await post({ model: 'auto', openmulti: { tier: 'balanced' }, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 400)
  assert.equal(n, 1)
})

test('metrics: /metrics exige un bearer valide', async () => {
  const res = await app.fetch(new Request('http://test/metrics'))
  assert.equal(res.status, 401)
})

test('metrics: format prometheus, labelise par projet, jamais le secret brut', async () => {
  // Les tests precedents ont deja genere du trafic avec KEY -> les series existent.
  const res = await app.fetch(new Request('http://test/metrics', { headers: { authorization: `Bearer ${KEY}` } }))
  assert.equal(res.status, 200)
  const body = await res.text()
  assert.match(body, /openmulti_requests_total/)
  assert.match(body, /openmulti_cost_usd_total/)
  assert.match(body, /key="contract"/) // sk_contract_test -> label projet "contract"
  assert.doesNotMatch(body, /sk_contract_test/) // le secret brut ne fuit jamais
})
