// E-1 (devis programme) — surface PURE : validation stricte de l'AST (mêmes bornes/
// alphabet que le parseur de référence multi-lang, champs inconnus rejetés), mesure
// canonique H8, et le PLIAGE cap-de-sortie -> borne-d'entrée (mêmes briques que le
// devis d'appel simple : route + computeQuote). Le wiring /v1/plan est ailleurs.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_MODEL_BALANCED = 'moonshotai/kimi-k2.6'
process.env.OPENMULTI_MODEL_ECONOMY = 'deepseek/deepseek-chat'

const { validateProgram, computeProgramQuote, stageRequest, canonicalProgramBytes, CANONICAL_BYTES_FACTOR } =
  await import('../src/program-quote.ts')
const { computeQuote } = await import('../src/plan.ts')
const { canonicalJson } = await import('../src/quote-token.ts')

const HAIKU = 'anthropic/claude-haiku-4-5' // 1 / 5 par MTok (tarifé en prod)
const DEEPSEEK = 'deepseek/deepseek-chat' // 0.14 / 0.28
const stmt = (over: Record<string, unknown> = {}) => ({ source: null, stages: [{ target: HAIKU, prompt: 'x' }], sink: null, ...over })

// ── Validation stricte ───────────────────────────────────────────────────────────

test('validateProgram : accepte une forme valide et normalise la casse des cibles', () => {
  const v = validateProgram({ statements: [{ source: null, stages: [{ target: 'BALANCED', prompt: 'hi' }], sink: null }] })
  assert.ok('program' in v)
  if ('program' in v) assert.equal(v.program.statements[0]!.stages[0]!.target, 'balanced') // minusculisée
  // source/sink optionnels
  assert.ok('program' in validateProgram({ statements: [{ stages: [{ target: null, prompt: 'x' }] }] }))
})

test('validateProgram : rejets — champ inconnu, ident invalide, prompt vide, substitut isolé', () => {
  const cases: unknown[] = [
    { statements: [{ stages: [{ target: null, prompt: 'x' }], bogus: 1 }] }, // champ inconnu pipeline
    { statements: [{ stages: [{ target: null, prompt: 'x', extra: 1 }] }] }, // champ inconnu stage
    { statements: [{ stages: [{ target: 'bad id', prompt: 'x' }] }] }, // ident avec espace
    { statements: [{ stages: [{ target: 'trailing\n', prompt: 'x' }] }] }, // newline final d'ident (H8)
    { statements: [{ stages: [{ target: null, prompt: '  ' }] }] }, // prompt vide
    { statements: [{ stages: [{ target: null, prompt: 'lone \uD800 surrogate' }] }] }, // substitut UTF-16 isolé
    { statements: 'nope' }, // statements non-liste
  ]
  for (const input of cases) assert.ok('error' in validateProgram(input), JSON.stringify(input))
})

test('validateProgram : grammaire v0.2 — ident pointé intérieur admis, emoji (paire) admise', () => {
  assert.ok('program' in validateProgram({ statements: [stmt({ stages: [{ target: 'moonshotai/kimi-k2.6', prompt: 'x' }] })] }))
  assert.ok('program' in validateProgram({ statements: [stmt({ stages: [{ target: null, prompt: 'salut \u{1F600}' }] })] }))
  // point initial/final/doublé refusé
  for (const t of ['.x', 'x.', 'a..b']) {
    assert.ok('error' in validateProgram({ statements: [stmt({ stages: [{ target: t, prompt: 'x' }] })] }), t)
  }
})

test('canonicalProgramBytes : = octets UTF-8 de la sérialisation canonique', () => {
  const p = { statements: [stmt()] }
  assert.equal(canonicalProgramBytes(p), Buffer.byteLength(canonicalJson(p), 'utf8'))
  assert.ok(CANONICAL_BYTES_FACTOR > 1)
})

// ── Le pliage (computeProgramQuote) ──────────────────────────────────────────────

function quoteOf(programInput: unknown, opts: { marginFactor?: number; maxTokens?: number; stdinBytes?: number } = {}) {
  const v = validateProgram(programInput)
  assert.ok('program' in v, 'programme invalide dans le test')
  if (!('program' in v)) throw new Error('unreachable')
  return computeProgramQuote(v.program, { marginFactor: 1, maxTokens: 500, ...opts })
}

test('un étage unique : mêmes briques que le devis d\'appel simple (stageRequest + computeQuote)', () => {
  const r = quoteOf({ statements: [{ source: null, stages: [{ target: HAIKU, prompt: 'résume ceci' }], sink: null }] })
  assert.ok('stages' in r)
  if (!('stages' in r)) return
  assert.equal(r.stages.length, 1)
  assert.equal(r.stages[0]!.model, HAIKU)
  // reproduit EXACTEMENT le devis d'appel simple de cet étage (entrée = octets seuls, stdin vide)
  const direct = computeQuote(stageRequest(HAIKU, 'résume ceci', 500), HAIKU, undefined, 1, 0)
  assert.ok(direct.quote)
  assert.equal(r.stages[0]!.input_tokens_max, direct.quote!.input_tokens_max)
  assert.equal(r.stages[0]!.output_tokens_max, direct.quote!.output_tokens_max)
  assert.equal(r.stages[0]!.max_cost_usd, direct.quote!.max_cost_usd)
  assert.equal(r.stages[0]!.guaranteed, false) // lit stdin (absent) -> non garanti
})

test('pipe : la borne d\'entrée de l\'étage aval = son gabarit + le cap de sortie de l\'amont (token->token)', () => {
  const r = quoteOf({ statements: [{ source: null, stages: [
    { target: HAIKU, prompt: 'étape 1' },
    { target: DEEPSEEK, prompt: 'étape 2' },
  ], sink: null }] })
  assert.ok('stages' in r)
  if (!('stages' in r)) return
  const upstreamCap = r.stages[0]!.output_tokens_max // = 500
  // l'étage aval : octets de SON gabarit + le cap amont ajouté en tokens (extraInputTokens)
  const foldExpected = computeQuote(stageRequest(DEEPSEEK, 'étape 2', 500), DEEPSEEK, undefined, 1, upstreamCap)
  assert.ok(foldExpected.quote)
  assert.equal(r.stages[1]!.input_tokens_max, foldExpected.quote!.input_tokens_max)
  assert.equal(r.stages[1]!.input_tokens_max, Buffer.byteLength(JSON.stringify(stageRequest(DEEPSEEK, 'étape 2', 500)), 'utf8') + upstreamCap)
  // total = somme des étages
  assert.ok(Math.abs(r.quote.max_cost_usd - (r.stages[0]!.max_cost_usd + r.stages[1]!.max_cost_usd)) < 1e-9)
})

test('slots : >> enregistre la borne courante, << la rappelle ; slot inconnu = erreur', () => {
  const ok = quoteOf({ statements: [
    { source: null, stages: [{ target: HAIKU, prompt: 'produis' }], sink: { store: 'buf' } },
    { source: { recall: 'buf' }, stages: [{ target: DEEPSEEK, prompt: 'consomme' }], sink: null },
  ] })
  assert.ok('stages' in ok)
  if ('stages' in ok) {
    // l'étage qui rappelle 'buf' voit la borne enregistrée (cap de l'étage producteur) en entrée
    const recallStage = ok.stages.find((s) => s.statement === 1)!
    assert.ok(recallStage.input_tokens_max > Buffer.byteLength(JSON.stringify(stageRequest(DEEPSEEK, 'consomme', 500)), 'utf8'))
    assert.equal(recallStage.guaranteed, true) // la borne du slot vient d'un cap enforcé
  }
  // rappeler un slot jamais stocké -> erreur franche
  const bad = quoteOf({ statements: [{ source: { recall: 'jamais' }, stages: [{ target: HAIKU, prompt: 'x' }], sink: null }] })
  assert.ok('error' in bad)
})

test('refus honnête avec l\'index de l\'étage fautif : modèle non tarifé', () => {
  const r = quoteOf({ statements: [
    { source: null, stages: [{ target: HAIKU, prompt: 'ok' }], sink: null },
    { source: null, stages: [{ target: 'unknown/model', prompt: 'boom' }], sink: null },
  ] })
  assert.ok('refused' in r)
  if ('refused' in r) {
    assert.equal(r.refused.statement, 1)
    assert.equal(r.refused.stage, 0)
    assert.equal(r.refused.reason, 'pricing_unknown')
  }
})

test('stdin borné -> guaranteed=true ; total arrondi reste une borne', () => {
  const r = quoteOf({ statements: [{ source: null, stages: [{ target: HAIKU, prompt: 'x' }], sink: null }] }, { stdinBytes: 1234 })
  assert.ok('stages' in r)
  if ('stages' in r) {
    assert.equal(r.guaranteed, true)
    assert.equal(r.stages[0]!.guaranteed, true)
    // stdin compté dans l'entrée du premier étage
    assert.equal(r.stages[0]!.input_tokens_max, Buffer.byteLength(JSON.stringify(stageRequest(HAIKU, 'x', 500)), 'utf8') + 1234)
  }
})
