// Tests des cibles NOMMÉES du langage MULTI (router.ts + model-alias.ts) : niveaux de
// gamme (light/mid/max), objectifs (best/cheapest, fastest refusé tant que la latence
// n'est pas observée) et familles de modèles (« claude » → le meilleur Claude du
// catalogue courant). Verrouille aussi la fermeture du repli silencieux sur le canal
// `openmulti.tier` (celui qu'emprunte multi-lang avec la cible VERBATIM) : un nom nu
// ou une famille connus y sont désormais résolus en pin, un mot réellement inconnu
// garde le repli historique vers le tier par défaut (contrat multi-lang).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_target_test'
// economy à DEUX candidats : prouve que `cheapest` impose la stratégie 'smart'
// (note « smart: … » dans reason) là où `light` reste sur 'default'.
process.env.OPENMULTI_MODELS_ECONOMY = 'anthropic/claude-haiku-4-5,vendorx/filler-eco'
process.env.OPENMULTI_MODEL_BALANCED = 'moonshotai/kimi-k2.6'
// quality à DEUX candidats : prouve que `best` impose 'default' (primaire curé) même
// si l'appelant demande route:'smart'.
process.env.OPENMULTI_MODELS_QUALITY = 'anthropic/claude-opus-4.8,vendorx/filler-q'
// Famille ambiguë fabriquée : deux membres « dup-fam-* » via des slots purpose (donc
// connus du gateway) mais AUCUN au catalogue des tiers (donc hors familyRank).
process.env.OPENMULTI_MODEL_AGENT_QUALITY = 'vendora/dup-fam-1'
process.env.OPENMULTI_MODEL_AGENT_BALANCED = 'vendorb/dup-fam-2'

let app: { fetch: (req: Request) => Promise<Response> }
let route: typeof import('../src/router.ts').route
let RouteRefusal: typeof import('../src/router.ts').RouteRefusal
let resolveFamilyModel: typeof import('../src/model-alias.ts').resolveFamilyModel
let familyRank: typeof import('../src/model-alias.ts').familyRank

before(async () => {
  ;({ app } = await import('../src/app.ts'))
  ;({ route, RouteRefusal } = await import('../src/router.ts'))
  ;({ resolveFamilyModel, familyRank } = await import('../src/model-alias.ts'))
})

const MSGS = [{ role: 'user', content: 'bonjour' }]

function post(path: string, body: unknown) {
  return app.fetch(
    new Request(`http://test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk_target_test' },
      body: JSON.stringify(body),
    }),
  )
}

// ── resolveFamilyModel (pur, ids et rang injectés) ──────────────────────────────

test('famille: correspondance unique -> resolved', () => {
  const r = resolveFamilyModel('kimi', ['moonshotai/kimi-k2.6', 'deepseek/deepseek-chat'], [])
  assert.deepEqual(r, { kind: 'resolved', model: 'moonshotai/kimi-k2.6' })
})

test('famille: plusieurs correspondances -> le mieux classé du catalogue gagne', () => {
  const ids = ['anthropic/claude-haiku-4-5', 'anthropic/claude-opus-4.8']
  const r = resolveFamilyModel('claude', ids, ['anthropic/claude-opus-4.8', 'anthropic/claude-haiku-4-5'])
  assert.deepEqual(r, { kind: 'resolved', model: 'anthropic/claude-opus-4.8' })
})

test('famille: plusieurs correspondances, aucune au catalogue -> ambiguous triée', () => {
  const r = resolveFamilyModel('dup', ['b/dup-2', 'a/dup-1'], [])
  assert.deepEqual(r, { kind: 'ambiguous', matches: ['a/dup-1', 'b/dup-2'] })
})

test('famille: la frontière est `-` ou `.` — jamais un préfixe arbitraire', () => {
  const ids = ['anthropic/claude-opus-4.8', 'x/claudex-1']
  assert.deepEqual(resolveFamilyModel('clau', ids, []), { kind: 'unknown' })
  assert.deepEqual(resolveFamilyModel('claude', ids, []), { kind: 'resolved', model: 'anthropic/claude-opus-4.8' })
  assert.deepEqual(resolveFamilyModel('kimi-k2', ['moonshotai/kimi-k2.6'], []), {
    kind: 'resolved',
    model: 'moonshotai/kimi-k2.6',
  })
  assert.deepEqual(resolveFamilyModel('ghost', ids, []), { kind: 'unknown' })
})

test('familyRank: quality avant balanced avant economy, primaires en tête', () => {
  const rank = familyRank()
  assert.equal(rank[0], 'anthropic/claude-opus-4.8')
  assert.ok(rank.indexOf('anthropic/claude-opus-4.8') < rank.indexOf('moonshotai/kimi-k2.6'))
  assert.ok(rank.indexOf('moonshotai/kimi-k2.6') < rank.indexOf('anthropic/claude-haiku-4-5'))
})

// ── Niveaux de gamme (canal `model` et canal `tier`) ────────────────────────────

test('route: light/mid/max -> economy/balanced/quality (primaire du tier)', () => {
  assert.equal(route({ model: 'light', messages: MSGS }).model, 'anthropic/claude-haiku-4-5')
  assert.equal(route({ model: 'mid', messages: MSGS }).model, 'moonshotai/kimi-k2.6')
  assert.equal(route({ model: 'max', messages: MSGS }).model, 'anthropic/claude-opus-4.8')
  assert.match(route({ model: 'light', messages: MSGS }).reason, /light level, economy tier/)
})

test('route: les niveaux passent aussi par openmulti.tier (cible multi-lang verbatim)', () => {
  assert.equal(route({ model: 'auto', messages: MSGS, openmulti: { tier: 'light' } }).model, 'anthropic/claude-haiku-4-5')
  assert.equal(route({ model: 'auto', messages: MSGS, openmulti: { tier: 'max' } }).model, 'anthropic/claude-opus-4.8')
})

// ── Objectifs ───────────────────────────────────────────────────────────────────

test('route: best -> primaire curé du tier quality, MÊME si l’appelant demande smart', () => {
  const d = route({ model: 'best', messages: MSGS, openmulti: { route: 'smart' } })
  assert.equal(d.model, 'anthropic/claude-opus-4.8')
  assert.match(d.reason, /best objective, quality tier, default: primary/)
})

test('route: cheapest -> tier economy sous stratégie smart (bandit)', () => {
  const d = route({ model: 'cheapest', messages: MSGS })
  assert.match(d.reason, /cheapest objective, economy tier, smart:/)
  assert.ok(d.candidates!.includes('anthropic/claude-haiku-4-5'))
})

test('route: fastest SANS slot fast -> RouteRefusal objective_unavailable (erreur claire, jamais un routage mensonger)', () => {
  for (const req of [
    { model: 'fastest', messages: MSGS },
    { model: 'auto', messages: MSGS, openmulti: { tier: 'fastest' } },
  ]) {
    assert.throws(
      () => route(req),
      (e: unknown) => e instanceof RouteRefusal && e.code === 'objective_unavailable' && e.status === 400,
    )
  }
})

test('route: fastest AVEC slot fast -> sélection manuelle (primaire, hors tiers, sans plafond de tier)', () => {
  process.env.OPENMULTI_MODELS_FAST = 'vendorf/rapid-1,vendorf/rapid-2'
  try {
    const d = route({ model: 'fastest', messages: MSGS })
    assert.equal(d.model, 'vendorf/rapid-1')
    assert.match(d.reason, /fastest objective \(manual selection\)/)
    assert.ok(!/tier/.test(d.reason)) // pas de mensonge de tier
    assert.deepEqual(d.candidates, ['vendorf/rapid-1', 'vendorf/rapid-2'])
    // Le canal tier (cible multi-lang verbatim) résout pareil.
    assert.equal(route({ model: 'auto', messages: MSGS, openmulti: { tier: 'fastest' } }).model, 'vendorf/rapid-1')
  } finally {
    delete process.env.OPENMULTI_MODELS_FAST
  }
})

// ── Familles et noms nus sur le canal `tier` (le piège multi-lang, fermé) ───────

test('route: famille via model OU tier -> le meilleur membre du catalogue courant', () => {
  const viaModel = route({ model: 'claude', messages: MSGS })
  assert.equal(viaModel.model, 'anthropic/claude-opus-4.8')
  assert.match(viaModel.reason, /family "claude"/)
  const viaTier = route({ model: 'auto', messages: MSGS, openmulti: { tier: 'claude' } })
  assert.equal(viaTier.model, 'anthropic/claude-opus-4.8')
})

test('route: nom nu exact via tier -> pin résolu (plus jamais balanced en silence)', () => {
  const d = route({ model: 'auto', messages: MSGS, openmulti: { tier: 'kimi-k2.6' } })
  assert.equal(d.model, 'moonshotai/kimi-k2.6')
  assert.deepEqual(d.candidates, ['moonshotai/kimi-k2.6'])
})

test('route: famille ambiguë (aucun membre au catalogue des tiers) -> model_ambiguous', () => {
  assert.throws(
    () => route({ model: 'dup-fam', messages: MSGS }),
    (e: unknown) =>
      e instanceof RouteRefusal &&
      e.code === 'model_ambiguous' &&
      /vendora\/dup-fam-1/.test(e.message) &&
      /vendorb\/dup-fam-2/.test(e.message),
  )
})

test('route: mot VRAIMENT inconnu via tier -> repli historique (contrat multi-lang)', () => {
  const d = route({ model: 'auto', messages: MSGS, openmulti: { tier: 'zzz-unknown' } })
  assert.equal(d.model, 'moonshotai/kimi-k2.6') // primaire balanced = DEFAULT_TIER
})

test('route: tiers canoniques, auto, alias auto:<tier> et id concret inchangés (contrat)', () => {
  assert.equal(route({ model: 'auto', messages: MSGS }).model, 'moonshotai/kimi-k2.6')
  assert.equal(route({ model: 'auto:economy', messages: MSGS }).model, 'anthropic/claude-haiku-4-5')
  assert.equal(route({ model: 'auto', messages: MSGS, openmulti: { tier: 'quality' } }).model, 'anthropic/claude-opus-4.8')
  assert.equal(route({ model: 'x/y-inconnu', messages: MSGS }).model, 'x/y-inconnu')
})

// ── Surfaces HTTP ───────────────────────────────────────────────────────────────

test('/v1/plan: model "best" -> 200, devis sur le primaire quality', async () => {
  const res = await post('/v1/plan', { model: 'best', messages: MSGS, max_tokens: 100 })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { model: string }
  assert.equal(body.model, 'anthropic/claude-opus-4.8')
})

test('/v1/chat/completions: "fastest" -> 400 objective_unavailable SANS appel upstream', async () => {
  const realFetch = globalThis.fetch
  let upstreamCalls = 0
  globalThis.fetch = (async () => {
    upstreamCalls++
    throw new Error('no upstream expected')
  }) as typeof fetch
  try {
    const res = await post('/v1/chat/completions', { model: 'fastest', messages: MSGS })
    assert.equal(res.status, 400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'objective_unavailable')
    assert.match(body.error.message, /"fast" catalog slot/)
    assert.equal(upstreamCalls, 0)
  } finally {
    globalThis.fetch = realFetch
  }
})
