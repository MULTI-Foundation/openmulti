// Mode council `compare` (le COMPARE du langage MULTI, v0.3) : panel SANS chair, les
// réponses survivantes mises en regard sous leur modèle résolu — aucune synthèse,
// aucun appel de plus. Verrouille : le format pur, la résolution (chair ignoré), la
// non-dépense du chair (forward jamais appelé pour lui), le devis N appels (moins cher
// que fuse), le cap de RÉPONSE (response_tokens_max) des trois modes et l'effet
// d'extraInputTokens (l'entrée de pipe du devis programme).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'x'
process.env.OPENMULTI_API_KEYS ||= 'sk_compare_test'
process.env.OPENMULTI_COUNCIL_CHAIR = 'moonshotai/kimi-k2.6'
process.env.OPENMULTI_COUNCIL_PANEL_QUALITY = 'm/a,m/b'
process.env.OPENMULTI_MODEL_BALANCED = 'moonshotai/kimi-k2.6'

let P: typeof import('../src/council-prompts.ts')
let C: typeof import('../src/council.ts')
let computeCouncilQuote: typeof import('../src/council-quote.ts').computeCouncilQuote

before(async () => {
  P = await import('../src/council-prompts.ts')
  C = await import('../src/council.ts')
  ;({ computeCouncilQuote } = await import('../src/council-quote.ts'))
})

const KEY = 'sk_compare_test'

// ── Fonction pure ────────────────────────────────────────────────────────────

test('formatComparison: chaque réponse SOUS son modèle, séparées par ---', () => {
  const out = P.formatComparison(['m/a', 'm/b'], ['réponse A', 'réponse B'])
  assert.match(out, /### m\/a\n\nréponse A/)
  assert.match(out, /### m\/b\n\nréponse B/)
  assert.match(out, /\n\n---\n\n/)
})

// ── Résolution ───────────────────────────────────────────────────────────────

test('resolveCouncil compare: pas de chair requis, un chair configuré est IGNORÉ', () => {
  const r = C.resolveCouncil({ messages: [], openmulti: { council: { mode: 'compare' } } } as never)
  assert.ok(!('error' in r))
  const resolved = r as { chair: string; mode: string }
  assert.equal(resolved.mode, 'compare')
  assert.equal(resolved.chair, '')
})

// ── Orchestration (forward injecté) ──────────────────────────────────────────

function stub(opts: { failModels?: string[] } = {}) {
  const calls: string[] = []
  const forward = async (req: { model: string }) => {
    const model = req.model
    calls.push(model)
    if (opts.failModels?.includes(model)) return { ok: false, status: 502, model, provider: 'stub', reason: '' }
    return {
      ok: true,
      status: 200,
      model,
      provider: 'stub',
      reason: '',
      costUsd: 0.02,
      data: { choices: [{ message: { role: 'assistant', content: `answer:${model}` } }], usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.02 } },
    }
  }
  return { forward, calls }
}

test('compare: sorties en regard, AUCUN appel chair, coût = panel seul', async () => {
  const req = { messages: [{ role: 'user', content: 'q' }], openmulti: { council: { mode: 'compare' } } }
  const s = stub()
  const out = await C.runCouncil(req as never, { key: KEY, marginFactor: 1 } as never, { forward: s.forward } as never)
  assert.equal(out.status, 200)
  const content = (out.body.choices as [{ message: { content: string } }])[0].message.content
  assert.match(content, /### m\/a\n\nanswer:m\/a/)
  assert.match(content, /### m\/b\n\nanswer:m\/b/)
  assert.deepEqual(s.calls, ['m/a', 'm/b']) // jamais le chair
  assert.ok(Math.abs((out.body.usage as { cost: number }).cost - 0.04) < 1e-9)
  const trace = out.body.openmulti as { council: { mode: string; chair: unknown }; reason: string }
  assert.equal(trace.council.mode, 'compare')
  assert.equal(trace.council.chair, null)
  assert.equal(trace.reason, 'council compare: 2 panel')
})

test('compare: échec partiel -> la mise en regard ne contient que les survivants', async () => {
  const req = { messages: [{ role: 'user', content: 'q' }], openmulti: { council: { mode: 'compare' } } }
  const s = stub({ failModels: ['m/a'] })
  const out = await C.runCouncil(req as never, { key: KEY, marginFactor: 1 } as never, { forward: s.forward } as never)
  assert.equal(out.status, 200)
  const content = (out.body.choices as [{ message: { content: string } }])[0].message.content
  assert.ok(!content.includes('m/a'))
  assert.match(content, /### m\/b/)
  assert.equal((out.body.openmulti as { council: { members: number } }).council.members, 1)
})

// ── Devis ────────────────────────────────────────────────────────────────────

const MSGS = [{ role: 'user', content: 'bonjour' }]
const PANEL = ['moonshotai/kimi-k2.6', 'deepseek/deepseek-chat']

function quoteFor(mode: 'fuse' | 'compare', extra = 0) {
  const req = { model: 'council', messages: MSGS, max_tokens: 100, openmulti: { council: { panel: PANEL, mode } } }
  const cq = computeCouncilQuote(req as never, 1, extra)
  assert.ok(!('error' in cq), JSON.stringify(cq))
  return cq as Exclude<typeof cq, { error: string }>
}

test('devis compare: N appels sans chair, strictement moins cher que fuse', () => {
  const compare = quoteFor('compare')
  const fuse = quoteFor('fuse')
  assert.equal(compare.calls, 2)
  assert.equal(fuse.calls, 3)
  assert.ok(compare.quote && fuse.quote)
  assert.ok(compare.quote.max_cost_usd < fuse.quote.max_cost_usd)
})

test('devis compare: cap de réponse = somme des caps du panel + gabarit', () => {
  const cq = quoteFor('compare')
  assert.ok(cq.quote)
  // 2 membres à cap 100 : la réponse dépasse 200 (gabarit d\'étiquettes) mais reste
  // bornée — jamais la somme facturée (qui compte aussi les entrées).
  assert.ok(cq.response_tokens_max! > 200)
  assert.ok(cq.response_tokens_max! < 200 + 1000)
})

test('devis fuse: cap de réponse = max(chair, panel) — couvre la dégradation gracieuse', () => {
  const cq = quoteFor('fuse')
  assert.ok(cq.quote)
  assert.equal(cq.response_tokens_max, 100) // tous les caps valent max_tokens=100
})

test('devis: extraInputTokens (entrée de pipe) renchérit chaque sous-appel', () => {
  const sans = quoteFor('compare')
  const avec = quoteFor('compare', 1_000)
  assert.ok(avec.quote!.input_tokens_max >= sans.quote!.input_tokens_max + 2_000) // 2 membres x 1000
  assert.ok(avec.quote!.max_cost_usd > sans.quote!.max_cost_usd)
})

test('devis: candidates = union des snapshots des sous-appels (matériau du pin)', () => {
  const cq = quoteFor('compare')
  assert.ok(cq.candidates!.includes('moonshotai/kimi-k2.6'))
  assert.ok(cq.candidates!.includes('deepseek/deepseek-chat'))
})
