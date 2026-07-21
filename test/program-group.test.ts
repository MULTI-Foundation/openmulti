// Étages GROUPE v0.3 (`@a AND @b "prompt" FUSION|COMPARE`) dans le devis programme :
// la porte AST (validateProgram, mêmes règles que runtime.py), la traduction en UN
// appel council (groupStageRequest), le pliage aval par le cap de RÉPONSE, et la
// non-contractabilité (devis servi, jeton E-1 JAMAIS émis — chat.ts refuse les
// quote_token sur un council, un jeton invérifiable serait un faux contrat).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'x'
process.env.OPENMULTI_API_KEYS = 'sk_group_test'
process.env.OPENMULTI_MODEL_BALANCED = 'moonshotai/kimi-k2.6'
process.env.OPENMULTI_COUNCIL_CHAIR = 'moonshotai/kimi-k2.6'
process.env.OPENMULTI_QUOTE_TOKEN_SECRET = 'group-test-secret'

let app: { fetch: (req: Request) => Promise<Response> }
let PQ: typeof import('../src/program-quote.ts')

before(async () => {
  ;({ app } = await import('../src/app.ts'))
  PQ = await import('../src/program-quote.ts')
})

const PANEL = ['moonshotai/kimi-k2.6', 'deepseek/deepseek-chat']

function stmt(stages: unknown[], source: unknown = null, sink: unknown = null) {
  return { source, stages, sink }
}
const prog = (stages: unknown[]) => ({ statements: [stmt(stages)] })
const group = (combine: string, targets: string[] = PANEL) => ({ targets, prompt: 'x', combine })

// ── Porte AST ────────────────────────────────────────────────────────────────

test('validateProgram: étage groupe accepté et normalisé (cibles en minuscules)', () => {
  const v = PQ.validateProgram(prog([{ targets: ['Claude', 'GPT'], prompt: 'x', combine: 'fusion' }]))
  assert.ok(!('error' in v), JSON.stringify(v))
  const st = (v as { program: { statements: [{ stages: [unknown] }] } }).program.statements[0].stages[0]
  assert.deepEqual(st, { targets: ['claude', 'gpt'], prompt: 'x', combine: 'fusion' })
})

test('validateProgram: refus des formes de groupe difformes', () => {
  for (const bad of [
    { targets: ['a'], prompt: 'x', combine: 'fusion' }, // < 2 cibles
    { targets: PANEL, prompt: 'x', combine: 'vote' }, // combinateur inconnu
    { targets: PANEL, prompt: 'x' }, // combinateur absent
    { targets: [...'abcdefghi'].map((c) => `v/${c}`), prompt: 'x', combine: 'fusion' }, // > 8
    { targets: ['a', '.b'], prompt: 'x', combine: 'fusion' }, // ident invalide
    { targets: PANEL, target: 'a', prompt: 'x', combine: 'fusion' }, // forme mixte
    { targets: PANEL, prompt: 'x', combine: 'fusion', extra: 1 }, // champ inconnu
  ]) {
    const v = PQ.validateProgram(prog([bad]))
    assert.ok('error' in v, `accepté à tort: ${JSON.stringify(bad)}`)
  }
})

// ── Devis programme ──────────────────────────────────────────────────────────

const OPTS = { marginFactor: 1, stdinBytes: 0, maxTokens: 100 }

function quoteOf(stages: unknown[]) {
  const v = PQ.validateProgram(prog(stages))
  assert.ok(!('error' in v), JSON.stringify(v))
  const pq = PQ.computeProgramQuote((v as { program: never }).program, OPTS)
  assert.ok('quote' in pq, JSON.stringify(pq))
  return pq as Extract<typeof pq, { quote: unknown }>
}

test('devis: étage groupe = UN étage council, étiqueté par ses cibles', () => {
  const pq = quoteOf([group('fusion')])
  assert.equal(pq.stages.length, 1)
  assert.equal(pq.stages[0]!.model, 'council')
  assert.equal(pq.stages[0]!.target, 'moonshotai/kimi-k2.6 AND deepseek/deepseek-chat')
  assert.ok(pq.quote.max_cost_usd > 0)
})

test('devis: compare (N appels) moins cher que fusion (N + chair)', () => {
  const compare = quoteOf([group('compare')])
  const fusion = quoteOf([group('fusion')])
  assert.ok(compare.quote.max_cost_usd < fusion.quote.max_cost_usd)
})

test('devis: le pliage aval utilise le cap de RÉPONSE du groupe, pas la somme facturée', () => {
  const seul = quoteOf([{ target: 'best', prompt: 'resume' }])
  const apresFusion = quoteOf([group('fusion'), { target: 'best', prompt: 'resume' }])
  const apresCompare = quoteOf([group('compare'), { target: 'best', prompt: 'resume' }])
  const inputOf = (pq: ReturnType<typeof quoteOf>) => pq.stages.at(-1)!.input_tokens_max
  // fusion : la réponse est la synthèse du chair (cap 100) — l'aval voit ~100 tokens
  // de plus que l'étage isolé, JAMAIS la somme des sous-appels.
  assert.equal(inputOf(apresFusion), inputOf(seul) + 100)
  // compare : la réponse est la concaténation bornée (2 x 100 + gabarit) — plus grosse
  // que la synthèse, mais bornée elle aussi.
  assert.ok(inputOf(apresCompare) > inputOf(apresFusion))
  assert.ok(inputOf(apresCompare) < inputOf(seul) + 1_500)
})

test('devis: candidats du groupe dans l\'union, contractable=false', () => {
  const pq = quoteOf([group('fusion')])
  for (const m of PANEL) assert.ok(pq.candidates.includes(m))
  assert.equal(pq.contractable, false)
  assert.equal(quoteOf([{ target: 'best', prompt: 'x' }]).contractable, true)
})

test('devis: membre de groupe inconnu -> erreur franche, jamais un devis silencieux', () => {
  const v = PQ.validateProgram(prog([group('fusion', ['ghost-model', 'moonshotai/kimi-k2.6'])]))
  assert.ok(!('error' in v))
  const pq = PQ.computeProgramQuote((v as { program: never }).program, OPTS)
  assert.ok('error' in pq)
  assert.match((pq as { error: string }).error, /ghost-model/)
})

// ── Surface /v1/plan ─────────────────────────────────────────────────────────

function planProgram(stages: unknown[]) {
  return app.fetch(
    new Request('http://test/v1/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk_group_test' },
      body: JSON.stringify({ model: 'auto', messages: [], max_tokens: 100, openmulti: { program: prog(stages), stdin_bytes: 0 } }),
    }),
  )
}

test('/v1/plan: programme avec groupe -> devis servi mais JAMAIS de quote_token', async () => {
  const res = await planProgram([group('fusion'), { target: 'best', prompt: 'resume' }])
  assert.equal(res.status, 200)
  const body = (await res.json()) as { quote: unknown; guaranteed: boolean; quote_token?: string }
  assert.ok(body.quote)
  assert.equal(body.guaranteed, true)
  assert.equal(body.quote_token, undefined)
})

test('/v1/plan: même programme SANS groupe -> le jeton est bien émis (le verrou est ciblé)', async () => {
  const res = await planProgram([{ target: 'best', prompt: 'resume' }])
  assert.equal(res.status, 200)
  const body = (await res.json()) as { quote: unknown; quote_token?: string }
  assert.ok(body.quote)
  assert.equal(typeof body.quote_token, 'string')
})
