// Markup natif de tool-call fuité en clair (vécu prod 2026-08-25 : deepseek-v4-pro
// membre d'un panel COMPARE émet un bloc DSML brut au lieu de répondre, affiché tel
// quel dans le chat MyMULTI). Verrouille : le strip pur (bloc complet, bloc tronqué,
// tags orphelins, texte sain inchangé) et l'orchestration (un membre qui n'a produit
// QUE ce markup est un membre en échec, écarté du compare, jamais du garbage rendu).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'x'
process.env.OPENMULTI_API_KEYS ||= 'sk_markup_test'
process.env.OPENMULTI_COUNCIL_CHAIR = 'moonshotai/kimi-k2.6'
process.env.OPENMULTI_COUNCIL_PANEL_QUALITY = 'm/a,m/b'
process.env.OPENMULTI_MODEL_BALANCED = 'moonshotai/kimi-k2.6'

let P: typeof import('../src/council-prompts.ts')
let C: typeof import('../src/council.ts')

before(async () => {
  P = await import('../src/council-prompts.ts')
  C = await import('../src/council.ts')
})

const KEY = 'sk_markup_test'

// Échantillon réel (forme) du leak prod : bloc complet avec invoke + parameter.
const DSML_BLOCK = [
  '<｜｜DSML｜｜tool_calls>',
  '<｜｜DSML｜｜invoke name="bash">',
  '<｜｜DSML｜｜parameter name="command" string="true">pwd && ls -la</｜｜DSML｜｜parameter>',
  '</｜｜DSML｜｜invoke>',
  '</｜｜DSML｜｜tool_calls>',
].join('\n')

// ── Fonction pure ────────────────────────────────────────────────────────────

test('stripLeakedToolMarkup: retire un bloc DSML complet, garde le texte autour', () => {
  const out = P.stripLeakedToolMarkup(`Avant.\n${DSML_BLOCK}\nAprès.`)
  assert.ok(!out.includes('DSML'))
  assert.ok(out.includes('Avant.'))
  assert.ok(out.includes('Après.'))
})

test('stripLeakedToolMarkup: bloc tronqué en fin de sortie (pas de tag fermant) retiré', () => {
  const out = P.stripLeakedToolMarkup('Réponse utile.\n<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="bash">pwd')
  assert.equal(out.trim(), 'Réponse utile.')
})

test('stripLeakedToolMarkup: tags orphelins retirés, texte sain inchangé', () => {
  assert.equal(P.stripLeakedToolMarkup('x </｜｜DSML｜｜invoke> y'), 'x  y')
  const sain = 'Le sigle DSML signifie quelque chose ; 2 < 3 et a > b.'
  assert.equal(P.stripLeakedToolMarkup(sain), sain)
})

test('responseText: applique le strip (le leak ne sort jamais du council)', () => {
  const data = { choices: [{ message: { role: 'assistant', content: `ok\n${DSML_BLOCK}` } }] }
  assert.equal(P.responseText(data).trim(), 'ok')
})

// ── Orchestration (forward injecté) ──────────────────────────────────────────

test('compare: un membre qui ne rend QUE du markup DSML est un membre en échec', async () => {
  const forward = async (req: { model: string }) => ({
    ok: true,
    status: 200,
    model: req.model,
    provider: 'stub',
    reason: '',
    costUsd: 0.02,
    data: {
      choices: [{ message: { role: 'assistant', content: req.model === 'm/a' ? DSML_BLOCK : 'vraie réponse' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.02 },
    },
  })
  const req = { messages: [{ role: 'user', content: 'q' }], openmulti: { council: { mode: 'compare' } } }
  const out = await C.runCouncil(req as never, { key: KEY, marginFactor: 1 } as never, { forward } as never)
  assert.equal(out.status, 200)
  const content = (out.body.choices as [{ message: { content: string } }])[0].message.content
  assert.ok(!content.includes('DSML'))
  assert.ok(!content.includes('### m/a'), 'le membre sans réponse ne doit pas apparaître')
  assert.match(content, /### m\/b\n\nvraie réponse/)
  const trace = out.body.openmulti as { council: { members: number; panel: string[] } }
  assert.equal(trace.council.members, 1)
  assert.deepEqual(trace.council.panel, ['m/b'])
})
