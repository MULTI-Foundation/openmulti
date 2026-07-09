// Council / fusion (mixture-of-agents). Fonctions pures + orchestration (forward injecté,
// déterministe) + e2e wiring (handler + fetch mocké). Verrouille : agrégation du coût,
// modes fuse/deliberate, échec partiel gracieux (panel/chair), anti-récursion (sous-appels
// sans openmulti), trace openmulti seulement si l'appelant a opté, stream refusé (MVP).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'x'
process.env.OPENMULTI_API_KEYS ||= 'sk_council_test'
process.env.OPENMULTI_COUNCIL_CHAIR = 'm/chair'
process.env.OPENMULTI_COUNCIL_PANEL_QUALITY = 'm/a,m/b'
process.env.OPENMULTI_COUNCIL_PANEL_BUDGET = 'm/cheap1,m/cheap2,m/cheap3'
process.env.OPENMULTI_COUNCIL_PANEL_FLASH = 'm/f1,m/f2'
process.env.OPENMULTI_COUNCIL_CHAIR_FLASH = 'm/fchair'

const KEY = 'sk_council_test'
let P: typeof import('../src/council-prompts.ts')
let C: typeof import('../src/council.ts')
let app: { fetch: (req: Request) => Promise<Response> }

before(async () => {
  P = await import('../src/council-prompts.ts')
  C = await import('../src/council.ts')
  ;({ app } = await import('../src/app.ts'))
})

// ── Fonctions pures ──────────────────────────────────────────────────────────

test('anonymizeResponses: étiquette A/B/C sans nommer le modèle', () => {
  const out = P.anonymizeResponses(['foo', 'bar'])
  assert.match(out, /### Response A\nfoo/)
  assert.match(out, /### Response B\nbar/)
  assert.ok(!/gpt|claude|model/i.test(out))
})

test('aggregateUsage: somme tokens+coût ; coût absent si aucun sous-appel n\'en a', () => {
  const u = P.aggregateUsage([
    { prompt_tokens: 10, completion_tokens: 20, cost: 0.01 },
    { prompt_tokens: 5, completion_tokens: 5, cost: 0.02 },
  ])
  assert.equal(u.prompt_tokens, 15)
  assert.equal(u.completion_tokens, 25)
  assert.equal(u.total_tokens, 40)
  assert.equal(u.cost, 0.03)
  const noCost = P.aggregateUsage([{ prompt_tokens: 1, completion_tokens: 1 }])
  assert.equal(noCost.cost, undefined)
})

test('responseText: extrait le contenu assistant', () => {
  assert.equal(P.responseText({ choices: [{ message: { content: 'hi' } }] }), 'hi')
})

test('resolveCouncil: preset par défaut + override de requête', () => {
  const def = C.resolveCouncil({ messages: [], openmulti: { council: {} } } as any) as any
  assert.deepEqual(def.panel, ['m/a', 'm/b']) // preset quality (config)
  assert.equal(def.chair, 'm/chair')
  assert.equal(def.mode, 'fuse')
  const budget = C.resolveCouncil({ messages: [], openmulti: { council: { preset: 'budget' } } } as any) as any
  assert.deepEqual(budget.panel, ['m/cheap1', 'm/cheap2', 'm/cheap3'])
  // preset flash -> panel flash + chair flash (synthétiseur rapide)
  const flash = C.resolveCouncil({ messages: [], openmulti: { council: { preset: 'flash' } } } as any) as any
  assert.deepEqual(flash.panel, ['m/f1', 'm/f2'])
  assert.equal(flash.chair, 'm/fchair')
  const override = C.resolveCouncil({ messages: [], openmulti: { council: { panel: ['x/1'], chair: 'x/2', mode: 'deliberate' } } } as any) as any
  assert.deepEqual(override.panel, ['x/1'])
  assert.equal(override.chair, 'x/2')
  assert.equal(override.mode, 'deliberate')
})

test('resolveCouncil: le panel appelant est valide (MODEL_RE) — les ids poubelle sont filtres', () => {
  // audit sécu : un membre non conforme ne doit pas partir en sous-requête à l'aveugle
  const r = C.resolveCouncil({
    messages: [],
    openmulti: { council: { panel: ['ok/model', 'bad id with spaces', '../evil', 'x\r\ninject'] } },
  } as any) as any
  assert.deepEqual(r.panel, ['ok/model'])
  // un panel entièrement invalide -> pas de panel -> erreur claire (pas de routage)
  const empty = C.resolveCouncil({ messages: [], openmulti: { council: { panel: ['a b', '!!'] } } } as any) as any
  assert.ok('error' in empty)
})

// ── Orchestration (forward injecté) ──────────────────────────────────────────

function stub(opts: { failModels?: string[]; chairFails?: boolean } = {}) {
  return async (req: any) => {
    const model = req.model as string
    if (opts.failModels?.includes(model)) return { ok: false, status: 502, model, provider: 'stub', reason: '' }
    const isChair = model === 'm/chair' || model === 'x/2'
    if (isChair && opts.chairFails) return { ok: false, status: 502, model, provider: 'stub', reason: '' }
    const last = String(req.messages[req.messages.length - 1]?.content ?? '')
    const isReview = last.includes('one reviewer')
    const content = isChair ? 'FINAL' : isReview ? `review:${model}` : `answer:${model}`
    const cost = isChair ? 0.05 : isReview ? 0.01 : 0.02
    return {
      ok: true,
      status: 200,
      model,
      provider: 'stub',
      reason: '',
      costUsd: cost,
      data: { choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 20, cost } },
    }
  }
}

test('fuse: panel + chair -> reponse synthetisee, cost agrege', async () => {
  const req: any = { messages: [{ role: 'user', content: 'q' }], openmulti: { council: {} } }
  const out = await C.runCouncil(req, { key: KEY, marginFactor: 1 }, { forward: stub() } as any)
  assert.equal(out.status, 200)
  assert.equal((out.body.choices as any)[0].message.content, 'FINAL')
  // 2 panel (0.02) + chair (0.05) = 0.09
  assert.ok(Math.abs((out.body.usage as any).cost - 0.09) < 1e-9)
  assert.equal((out.body.openmulti as any).council.mode, 'fuse')
  assert.deepEqual((out.body.openmulti as any).council.panel, ['m/a', 'm/b'])
})

test('deliberate: panel + revues + chair, cost inclut les revues', async () => {
  const req: any = { messages: [{ role: 'user', content: 'q' }], openmulti: { council: { mode: 'deliberate' } } }
  const out = await C.runCouncil(req, { key: KEY, marginFactor: 1 }, { forward: stub() } as any)
  // 2 panel (0.02) + 2 revues (0.01) + chair (0.05) = 0.11
  assert.ok(Math.abs((out.body.usage as any).cost - 0.11) < 1e-9)
  assert.equal((out.body.openmulti as any).council.mode, 'deliberate')
})

test('echec partiel : un membre du panel echoue -> on continue avec le reste', async () => {
  const req: any = { messages: [{ role: 'user', content: 'q' }], openmulti: { council: {} } }
  const out = await C.runCouncil(req, { key: KEY, marginFactor: 1 }, { forward: stub({ failModels: ['m/a'] }) } as any)
  assert.equal(out.status, 200)
  assert.equal((out.body.openmulti as any).council.members, 1)
  // 1 panel (0.02) + chair (0.05) = 0.07
  assert.ok(Math.abs((out.body.usage as any).cost - 0.07) < 1e-9)
})

test('tout le panel echoue -> 502', async () => {
  const req: any = { messages: [{ role: 'user', content: 'q' }], openmulti: { council: {} } }
  const out = await C.runCouncil(req, { key: KEY, marginFactor: 1 }, { forward: stub({ failModels: ['m/a', 'm/b'] }) } as any)
  assert.equal(out.status, 502)
})

test('chair echoue -> degradation gracieuse (meilleure reponse du panel)', async () => {
  const req: any = { messages: [{ role: 'user', content: 'q' }], openmulti: { council: {} } }
  const out = await C.runCouncil(req, { key: KEY, marginFactor: 1 }, { forward: stub({ chairFails: true }) } as any)
  assert.equal(out.status, 200)
  assert.equal((out.body.choices as any)[0].message.content, 'answer:m/a')
  assert.equal((out.body.openmulti as any).council.chair, null)
})

test('P0-3 deliberate : la ronde de review ne touche QUE les survivants de l\'etape 1', async () => {
  // Panel budget (3 membres) en mode deliberate, m/cheap2 mort des l'etape 1.
  // Avant le fix, la review mappait sur `panel` complet -> un appel gaspille sur le
  // membre mort. Apres, elle mappe sur okPanel -> zero appel sur cheap2 en review.
  const calls: { model: string; review: boolean }[] = []
  const forward = async (req: any) => {
    const model = req.model as string
    const last = String(req.messages[req.messages.length - 1]?.content ?? '')
    const isReview = last.includes('one reviewer')
    calls.push({ model, review: isReview })
    if (model === 'm/cheap2') return { ok: false, status: 502, model, provider: 'stub', reason: '' }
    const isChair = model === 'm/chair'
    const content = isChair ? 'FINAL' : isReview ? `review:${model}` : `answer:${model}`
    const cost = isChair ? 0.05 : isReview ? 0.01 : 0.02
    return { ok: true, status: 200, model, provider: 'stub', reason: '', costUsd: cost,
      data: { choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 20, cost } } }
  }
  const req: any = { messages: [{ role: 'user', content: 'q' }], openmulti: { council: { preset: 'budget', mode: 'deliberate' } } }
  const out = await C.runCouncil(req, { key: KEY, marginFactor: 1 }, { forward } as any)
  assert.equal(out.status, 200)
  const cheap2Calls = calls.filter((c) => c.model === 'm/cheap2')
  assert.equal(cheap2Calls.length, 1, 'le membre mort ne doit etre appele qu\'a l\'etape 1, jamais en review')
  assert.equal(cheap2Calls[0]!.review, false)
  const reviewers = calls.filter((c) => c.review).map((c) => c.model).sort()
  assert.deepEqual(reviewers, ['m/cheap1', 'm/cheap3'])
})

test('P0-4 chair echoue : fallback sur la reponse survivante la PLUS LONGUE', async () => {
  // m/a (premier dans l'ordre de config) repond court, m/b repond long. L'ancien
  // fallback rendait texts[0] = 'court' ; le fix rend la plus longue (signal de contenu).
  const forward = async (req: any) => {
    const model = req.model as string
    if (model === 'm/chair') return { ok: false, status: 502, model, provider: 'stub', reason: '' }
    const content = model === 'm/a' ? 'court' : 'une reponse nettement plus longue et detaillee'
    return { ok: true, status: 200, model, provider: 'stub', reason: '', costUsd: 0.02,
      data: { choices: [{ message: { role: 'assistant', content } }], usage: { cost: 0.02 } } }
  }
  const req: any = { messages: [{ role: 'user', content: 'q' }], openmulti: { council: {} } }
  const out = await C.runCouncil(req, { key: KEY, marginFactor: 1 }, { forward } as any)
  assert.equal(out.status, 200)
  assert.equal((out.body.choices as any)[0].message.content, 'une reponse nettement plus longue et detaillee')
  assert.equal((out.body.openmulti as any).council.chair, null)
})

test('marge appliquee au cout agrege ; pas de trace openmulti sans extension', async () => {
  const withExt: any = { messages: [{ role: 'user', content: 'q' }], openmulti: { council: {} } }
  const a = await C.runCouncil(withExt, { key: KEY, marginFactor: 1.2 }, { forward: stub() } as any)
  assert.ok(Math.abs((a.body.usage as any).cost - 0.09 * 1.2) < 1e-9)
  // model 'council' sans openmulti -> reponse pure-OpenAI (pas de bloc openmulti)
  const noExt: any = { model: 'council', messages: [{ role: 'user', content: 'q' }] }
  const b = await C.runCouncil(noExt, { key: KEY, marginFactor: 1 }, { forward: stub() } as any)
  assert.equal(b.body.openmulti, undefined)
})

test('anti-récursion : les sous-requetes ne portent jamais openmulti', async () => {
  const seen: any[] = []
  const spy = async (r: any) => {
    seen.push(r)
    return { ok: true, status: 200, model: r.model, provider: 'stub', reason: '', costUsd: 0.01, data: { choices: [{ message: { content: r.model === 'm/chair' ? 'F' : 'a' } }], usage: { cost: 0.01 } } }
  }
  await C.runCouncil({ messages: [{ role: 'user', content: 'q' }], openmulti: { council: {} } } as any, { key: KEY, marginFactor: 1 }, { forward: spy } as any)
  assert.ok(seen.length >= 3)
  for (const r of seen) assert.equal(r.openmulti, undefined)
})

// ── e2e wiring (handler + fetch mocké) ───────────────────────────────────────

test('e2e: council via le handler -> 200, cost agrege, trace openmulti', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'X' } }], usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.01 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as any
  const res = await app.fetch(
    new Request('http://test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: 'auto', openmulti: { council: {} }, messages: [{ role: 'user', content: 'q' }] }),
    }),
  )
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.model, 'council')
  assert.equal(typeof j.choices[0].message.content, 'string')
  // 2 panel + chair = 3 appels * 0.01
  assert.ok(Math.abs(j.usage.cost - 0.03) < 1e-9, `cost=${j.usage.cost}`)
  assert.ok(j.openmulti.council)
})

test('GET /v1/council/presets : panels par défaut + catalogue OpenRouter sélectionnable', async () => {
  // Catalogue OpenRouter mocké (le endpoint le fetch désormais) — offline, déterministe.
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('/models')) {
      return new Response(
        JSON.stringify({ data: [{ id: 'or/alpha', architecture: { output_modalities: ['text'] } }, { id: 'or/beta' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('{}', { status: 200 })
  }) as any
  const res = await app.fetch(new Request('http://test/v1/council/presets', { headers: { authorization: `Bearer ${KEY}` } }))
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.deepEqual(j.presets.quality, ['m/a', 'm/b'])
  assert.deepEqual(j.presets.flash, ['m/f1', 'm/f2'])
  assert.equal(j.chair, 'm/chair')
  assert.equal(j.chairFlash, 'm/fchair')
  assert.ok(Array.isArray(j.models))
  // les modèles des presets sont toujours sélectionnables (même hors table de prix)…
  for (const m of ['m/a', 'm/b', 'm/f1', 'm/cheap1']) assert.ok(j.models.includes(m), m)
  // …et le catalogue OpenRouter complet est exposé
  for (const m of ['or/alpha', 'or/beta']) assert.ok(j.models.includes(m), m)
})

test('e2e: stream + council -> 400 (non supporte en MVP)', async () => {
  const res = await app.fetch(
    new Request('http://test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: 'council', stream: true, messages: [{ role: 'user', content: 'q' }] }),
    }),
  )
  assert.equal(res.status, 400)
})
