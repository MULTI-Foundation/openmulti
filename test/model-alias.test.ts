// Tests de la résolution des noms de modèles NUS (model-alias.ts + router.ts).
// Verrouille la fermeture du piège historique : un `model` sans '/' qui n'était ni
// "auto" ni un alias de tier retombait EN SILENCE sur le tier par défaut (demander
// « kimi-k2.6 » servait le primaire balanced, facturé, sans erreur). Désormais :
// correspondance UNIQUE sur le suffixe d'un modèle connu = pin résolu ; inconnu ou
// ambigu = 400 explicite (RouteRefusal) sur TOUTES les surfaces — jamais de repli.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_alias_test'
// balanced = modèle tarifé (devis calculable) ; economy = un autre vendor.
process.env.OPENMULTI_MODEL_BALANCED = 'moonshotai/kimi-k2.6'
process.env.OPENMULTI_MODEL_ECONOMY = 'deepseek/deepseek-chat'
// Ambiguïté fabriquée : même suffixe « dup-model » sous deux vendors (slot tier +
// slot purpose), tous deux membres du catalogue effectif.
process.env.OPENMULTI_MODEL_QUALITY = 'vendora/dup-model'
process.env.OPENMULTI_MODEL_AGENT_QUALITY = 'vendorb/dup-model'

let app: { fetch: (req: Request) => Promise<Response> }
let route: typeof import('../src/router.ts').route
let RouteRefusal: typeof import('../src/router.ts').RouteRefusal
let resolveBareModel: typeof import('../src/model-alias.ts').resolveBareModel
let computeCouncilQuote: typeof import('../src/council-quote.ts').computeCouncilQuote

before(async () => {
  ;({ app } = await import('../src/app.ts'))
  ;({ route, RouteRefusal } = await import('../src/router.ts'))
  ;({ resolveBareModel } = await import('../src/model-alias.ts'))
  ;({ computeCouncilQuote } = await import('../src/council-quote.ts'))
})

const MSGS = [{ role: 'user', content: 'bonjour' }]

function post(path: string, body: unknown) {
  return app.fetch(
    new Request(`http://test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk_alias_test' },
      body: JSON.stringify(body),
    }),
  )
}

// ── resolveBareModel (pur, ids injectés) ────────────────────────────────────────

test('resolveBareModel: correspondance unique -> resolved', () => {
  const r = resolveBareModel('kimi-k2.6', ['moonshotai/kimi-k2.6', 'deepseek/deepseek-chat'])
  assert.deepEqual(r, { kind: 'resolved', model: 'moonshotai/kimi-k2.6' })
})

test('resolveBareModel: plusieurs vendors -> ambiguous avec les matches triés', () => {
  const r = resolveBareModel('m', ['b/m', 'a/m', 'c/autre'])
  assert.deepEqual(r, { kind: 'ambiguous', matches: ['a/m', 'b/m'] })
})

test('resolveBareModel: aucun match -> unknown (sensible à la casse)', () => {
  assert.deepEqual(resolveBareModel('ghost', ['a/m']), { kind: 'unknown' })
  assert.deepEqual(resolveBareModel('Kimi-K2.6', ['moonshotai/kimi-k2.6']), { kind: 'unknown' })
})

test('resolveBareModel: le suffixe est TOUT ce qui suit le premier /', () => {
  const r = resolveBareModel('org/nested', ['hub/org/nested'])
  assert.deepEqual(r, { kind: 'resolved', model: 'hub/org/nested' })
})

// ── route() ─────────────────────────────────────────────────────────────────────

test('route: nom nu unique résolu en pin canonique', () => {
  const d = route({ model: 'kimi-k2.6', messages: MSGS })
  assert.equal(d.model, 'moonshotai/kimi-k2.6')
  assert.match(d.reason, /resolved to moonshotai\/kimi-k2\.6/)
  assert.deepEqual(d.candidates, ['moonshotai/kimi-k2.6'])
})

test('route: nom nu inconnu -> RouteRefusal model_unknown (plus JAMAIS le tier par défaut)', () => {
  assert.throws(
    () => route({ model: 'ghost-model', messages: MSGS }),
    (e: unknown) => e instanceof RouteRefusal && e.code === 'model_unknown' && e.status === 400,
  )
})

test('route: nom nu ambigu -> RouteRefusal model_ambiguous listant les candidats', () => {
  assert.throws(
    () => route({ model: 'dup-model', messages: MSGS }),
    (e: unknown) =>
      e instanceof RouteRefusal &&
      e.code === 'model_ambiguous' &&
      /vendora\/dup-model/.test(e.message) &&
      /vendorb\/dup-model/.test(e.message),
  )
})

test('route: auto / alias de tier / id concret inchangés (contrat)', () => {
  assert.equal(route({ model: 'auto', messages: MSGS }).model, 'moonshotai/kimi-k2.6')
  assert.equal(route({ model: 'auto:economy', messages: MSGS }).model, 'deepseek/deepseek-chat')
  assert.equal(route({ model: 'x/y-inconnu', messages: MSGS }).model, 'x/y-inconnu')
})

// ── Surfaces HTTP ───────────────────────────────────────────────────────────────

test('/v1/plan: nom nu unique -> 200, devis sur le modèle résolu', async () => {
  const res = await post('/v1/plan', { model: 'kimi-k2.6', messages: MSGS, max_tokens: 100 })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { model: string; quote: unknown }
  assert.equal(body.model, 'moonshotai/kimi-k2.6')
  assert.ok(body.quote)
})

test('/v1/plan: nom nu inconnu -> 400 model_unknown', async () => {
  const res = await post('/v1/plan', { model: 'ghost-model', messages: MSGS })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string; message: string } }
  assert.equal(body.error.code, 'model_unknown')
  assert.match(body.error.message, /vendor\/model/)
})

test('/v1/chat/completions: nom nu inconnu -> 400 SANS aucun appel upstream', async () => {
  const realFetch = globalThis.fetch
  let upstreamCalls = 0
  globalThis.fetch = (async () => {
    upstreamCalls++
    throw new Error('no upstream expected')
  }) as typeof fetch
  try {
    const res = await post('/v1/chat/completions', { model: 'ghost-model', messages: MSGS })
    assert.equal(res.status, 400)
    const body = (await res.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'model_unknown')
    assert.equal(upstreamCalls, 0)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('/v1/chat/completions: nom nu ambigu -> 400 model_ambiguous', async () => {
  const res = await post('/v1/chat/completions', { model: 'dup-model', messages: MSGS })
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'model_ambiguous')
})

// ── Council ─────────────────────────────────────────────────────────────────────

test('council quote: membre au nom nu inconnu -> { error }, jamais un devis silencieux', () => {
  const cq = computeCouncilQuote(
    {
      model: 'council',
      messages: MSGS,
      max_tokens: 100,
      openmulti: { council: { panel: ['ghost-model'], chair: 'moonshotai/kimi-k2.6' } },
    },
    1,
  )
  assert.ok('error' in cq)
  assert.match((cq as { error: string }).error, /unknown model "ghost-model"/)
})

test('council quote: membre au nom nu RÉSOLU -> quotable (le pin résolu marche aussi en council)', () => {
  const cq = computeCouncilQuote(
    {
      model: 'council',
      messages: MSGS,
      max_tokens: 100,
      openmulti: { council: { panel: ['kimi-k2.6'], chair: 'moonshotai/kimi-k2.6' } },
    },
    1,
  )
  assert.ok(!('error' in cq))
})
