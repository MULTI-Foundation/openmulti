// Tests de POST /v1/plan (B1, docs/MULTI-Interpreter-Plan-Implementation.md) : dry-run
// de routage + devis maximum garanti, sans appel upstream. La résolution doit être
// identique à route() ; le devis est une BORNE (jamais d'estimation optimiste, jamais
// un faux zéro pour un modèle non tarifé — même règle que pricing.ts). Aucun mock
// upstream dans ce fichier : si le code appelait un provider, les tests échoueraient.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_plan_test'
// balanced = modèle tarifé dans pricing.ts (0.95/4 par MTok) pour un devis calculable.
process.env.OPENMULTI_MODEL_BALANCED = 'moonshotai/kimi-k2.6'
process.env.OPENMULTI_MODEL_ECONOMY = 'deepseek/deepseek-chat'

let app: { fetch: (req: Request) => Promise<Response> }
let computeQuote: typeof import('../src/plan.ts').computeQuote

before(async () => {
  ;({ app } = await import('../src/app.ts'))
  ;({ computeQuote } = await import('../src/plan.ts'))
})

function post(body: unknown, key = 'sk_plan_test') {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (key) headers.authorization = `Bearer ${key}`
  return app.fetch(
    new Request('http://test/v1/plan', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

const MSGS = [{ role: 'user', content: 'resume ce texte' }]

// ── Auth & validation ──────────────────────────────────────────────────────────

test('401 sans cle (la route est sous l\'auth /v1/*)', async () => {
  const res = await post({ model: 'auto', messages: MSGS }, '')
  assert.equal(res.status, 401)
})

test('400 JSON invalide', async () => {
  const res = await post('{oops')
  assert.equal(res.status, 400)
})

test('400 sans messages', async () => {
  const res = await post({ model: 'auto' })
  assert.equal(res.status, 400)
})

test('400 council (cout non bornable en un appel, refus explicite)', async () => {
  const res = await post({ model: 'auto', messages: MSGS, max_tokens: 100, openmulti: { council: {} } })
  assert.equal(res.status, 400)
})

// ── Résolution identique à route() ─────────────────────────────────────────────

test('auto -> tier par defaut (balanced), meme resolution que route()', async () => {
  const res = await post({ model: 'auto', messages: MSGS, max_tokens: 100 })
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.object, 'plan')
  assert.equal(j.model, 'moonshotai/kimi-k2.6')
  assert.equal(j.provider, 'openrouter') // aucun chemin direct configuré dans ce process
  assert.ok(j.reason.includes('balanced tier'))
})

test('openmulti.tier=economy -> le candidat economy', async () => {
  const res = await post({ model: 'auto', messages: MSGS, max_tokens: 100, openmulti: { tier: 'economy' } })
  const j = await res.json()
  assert.equal(j.model, 'deepseek/deepseek-chat')
})

test('id concret honore tel quel', async () => {
  const res = await post({ model: 'moonshotai/kimi-k2.6', messages: MSGS, max_tokens: 100 })
  const j = await res.json()
  assert.equal(j.model, 'moonshotai/kimi-k2.6')
  assert.ok(j.reason.includes('pinned'))
})

// ── Le devis est une borne exacte et verifiable ────────────────────────────────

test('devis: bornes entree/sortie et cout maximum (marge 0 = brut)', async () => {
  const body = { model: 'auto', messages: MSGS, max_tokens: 1000 }
  const res = await post(body)
  const j = await res.json()
  assert.equal(j.quote_unavailable, undefined)
  // borne d'entree = octets UTF-8 du JSON de la requete (>= tokens pour un BPE byte-level)
  const inputMax = Buffer.byteLength(JSON.stringify(body), 'utf8')
  assert.equal(j.quote.input_tokens_max, inputMax)
  assert.equal(j.quote.output_tokens_max, 1000)
  // kimi-k2.6 : 0.95 in / 4 out par MTok, arrondi micro-dollar superieur
  const raw = (inputMax * 0.95 + 1000 * 4) / 1_000_000
  assert.equal(j.quote.max_cost_usd, Math.ceil(raw * 1_000_000) / 1_000_000)
})

test('modele non tarife: quote null + pricing_unknown (jamais un faux zero)', async () => {
  const res = await post({ model: 'unpriced/model', messages: MSGS, max_tokens: 100 })
  const j = await res.json()
  assert.equal(j.model, 'unpriced/model')
  assert.equal(j.quote, null)
  assert.equal(j.quote_unavailable, 'pricing_unknown')
})

test('sans max_tokens ni plafond de tier: quote null + no_output_bound', async () => {
  const res = await post({ model: 'auto', messages: MSGS })
  const j = await res.json()
  assert.equal(j.quote, null)
  assert.equal(j.quote_unavailable, 'no_output_bound')
})

test('plafond de tier (OM-01): fournit la borne de sortie et ecrete la demande', async () => {
  process.env.OPENMULTI_MAX_TOKENS_BALANCED = '500'
  try {
    // sans max_tokens: le plafond EST la borne
    let j = await (await post({ model: 'auto', messages: MSGS })).json()
    assert.equal(j.quote.output_tokens_max, 500)
    // demande au-dessus du plafond: ecretee (meme regle que buildUpstreamBody)
    j = await (await post({ model: 'auto', messages: MSGS, max_tokens: 9000 })).json()
    assert.equal(j.quote.output_tokens_max, 500)
    // demande sous le plafond: honoree
    j = await (await post({ model: 'auto', messages: MSGS, max_tokens: 100 })).json()
    assert.equal(j.quote.output_tokens_max, 100)
  } finally {
    delete process.env.OPENMULTI_MAX_TOKENS_BALANCED
  }
})

test('contenu non-texte (image): quote null + unsupported_content, pas de borne mensongere', async () => {
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'decris' },
      { type: 'image_url', image_url: { url: 'https://x/y.png' } },
    ],
  }]
  const res = await post({ model: 'auto', messages, max_tokens: 100 })
  const j = await res.json()
  assert.equal(j.quote, null)
  assert.equal(j.quote_unavailable, 'unsupported_content')
})

// ── computeQuote (fonction pure) : marge et arrondi ────────────────────────────

test('computeQuote: la marge du projet est incluse (dollars factures)', () => {
  const req = { model: 'auto', messages: MSGS, max_tokens: 1000 }
  const r1 = computeQuote(req as never, 'moonshotai/kimi-k2.6', undefined, 1)
  const r2 = computeQuote(req as never, 'moonshotai/kimi-k2.6', undefined, 1.2)
  assert.ok(r1.quote && r2.quote)
  // meme calcul que l'implementation: l'arrondi part du cout BRUT (pas du devis deja arrondi)
  const inputMax = Buffer.byteLength(JSON.stringify(req), 'utf8')
  const raw = (inputMax * 0.95 + 1000 * 4) / 1_000_000
  assert.equal(r2.quote.max_cost_usd, Math.ceil(raw * 1.2 * 1_000_000) / 1_000_000)
  assert.ok(r2.quote.max_cost_usd > r1.quote.max_cost_usd)
})

test('computeQuote: arrondi au micro-dollar SUPERIEUR (une borne ne s\'arrondit pas vers le bas)', () => {
  // 1 message minuscule + 1 token de sortie -> cout brut fractionnaire en micro-dollars
  const req = { messages: [{ role: 'user', content: 'x' }], max_tokens: 1 }
  const r = computeQuote(req as never, 'moonshotai/kimi-k2.6', undefined, 1)
  assert.ok(r.quote)
  const inputMax = Buffer.byteLength(JSON.stringify(req), 'utf8')
  const raw = (inputMax * 0.95 + 1 * 4) / 1_000_000
  assert.ok(r.quote.max_cost_usd >= raw, 'la borne arrondie doit couvrir le cout brut')
  assert.equal(r.quote.max_cost_usd, Math.ceil(raw * 1_000_000) / 1_000_000)
})

test('computeQuote: modalities image -> unsupported_content', () => {
  const req = { messages: MSGS, max_tokens: 10, modalities: ['image'] }
  const r = computeQuote(req as never, 'moonshotai/kimi-k2.6', undefined, 1)
  assert.equal(r.quote, null)
  assert.equal(r.unavailable, 'unsupported_content')
})

// ── P0-1 / Q-1 : un modèle tarifé par palier ou thinking n'est pas quotable ─────
// La table ne porte que le palier de base (borne BASSE) : un devis « garanti » dessus
// sous-estimerait la facture. On refuse (jamais de devis muet optimiste), tout en
// gardant le prix de base pour la facturation best-effort (computeCostUsd non gardé).

test('computeQuote: modèle tiered (qwen par palier) -> pricing_tiered, pas de devis', () => {
  const req = { messages: MSGS, max_tokens: 100 }
  const r = computeQuote(req as never, 'qwen/qwen-plus', undefined, 1)
  assert.equal(r.quote, null)
  assert.equal(r.unavailable, 'pricing_tiered')
})

test('computeQuote: modèle thinking (deepseek-reasoner) -> pricing_thinking, pas de devis', () => {
  const req = { messages: MSGS, max_tokens: 100 }
  const r = computeQuote(req as never, 'deepseek/deepseek-reasoner', undefined, 1)
  assert.equal(r.quote, null)
  assert.equal(r.unavailable, 'pricing_thinking')
})

test('computeQuote: un modèle NON-tiered/thinking reste quotable (pas de refus faux positif)', () => {
  const req = { messages: MSGS, max_tokens: 100 }
  // deepseek-chat n'est ni tiered ni thinking (contrairement à -reasoner) -> devis garanti
  const r = computeQuote(req as never, 'deepseek/deepseek-chat', undefined, 1)
  assert.ok(r.quote, 'deepseek-chat doit rester quotable')
  assert.equal(r.unavailable, undefined)
})

test('/v1/plan: un modèle thinking épinglé -> 200 sans quote + quote_unavailable', async () => {
  // model concret honoré tel quel par route() -> le devis refuse proprement (pas de 500)
  const res = await post({ model: 'deepseek/deepseek-reasoner', messages: MSGS, max_tokens: 100 })
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.model, 'deepseek/deepseek-reasoner')
  assert.equal(j.quote, null)
  assert.equal(j.quote_unavailable, 'pricing_thinking')
  // pas de contrat signé sur une borne non garantie
  assert.equal(j.quote_token, undefined)
})

// ── Audit sécu : n et max_completion_tokens ne doivent pas contourner la borne ──

test('devis: n multiplie la borne de sortie (sinon sous-estimation d\'un facteur n)', async () => {
  const j1 = await (await post({ model: 'auto', messages: MSGS, max_tokens: 1000 })).json()
  const j3 = await (await post({ model: 'auto', messages: MSGS, max_tokens: 1000, n: 3 })).json()
  assert.equal(j1.quote.output_tokens_max, 1000)
  assert.equal(j3.quote.output_tokens_max, 3000)
  // le coût max suit (l'entrée diffère un peu via le JSON, on vérifie la borne de sortie)
  assert.ok(j3.quote.max_cost_usd > j1.quote.max_cost_usd)
})

test('devis: n invalide (0, negatif, non-entier) retombe a 1', async () => {
  for (const n of [0, -5, 2.5, 'x']) {
    const j = await (await post({ model: 'auto', messages: MSGS, max_tokens: 100, n })).json()
    assert.equal(j.quote.output_tokens_max, 100, `n=${n}`)
  }
})

test('devis: max_completion_tokens borne la sortie (ne peut pas contourner)', async () => {
  // sans max_tokens : max_completion_tokens fournit la borne
  let j = await (await post({ model: 'auto', messages: MSGS, max_completion_tokens: 500 })).json()
  assert.equal(j.quote.output_tokens_max, 500)
  // avec les deux : on prend le max (conservateur, borne haute sûre)
  j = await (await post({ model: 'auto', messages: MSGS, max_tokens: 200, max_completion_tokens: 900 })).json()
  assert.equal(j.quote.output_tokens_max, 900)
})

test('devis: plafond de tier ecrete aussi max_completion_tokens', async () => {
  process.env.OPENMULTI_MAX_TOKENS_BALANCED = '400'
  try {
    const j = await (await post({ model: 'auto', messages: MSGS, max_completion_tokens: 9000 })).json()
    assert.equal(j.quote.output_tokens_max, 400)
  } finally {
    delete process.env.OPENMULTI_MAX_TOKENS_BALANCED
  }
})
