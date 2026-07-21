// Routage par modalité d'ENTRÉE (chantier vision, constat client mesuré en prod le
// 2026-07-21 : image + auto/tier -> modèle aveugle -> réponse vide FACTURÉE, ou 404
// upstream — le repli silencieux, version modalités). Verrouille : la détection
// (hasImageInput), le parseur strict du feed (parseVisionModelIds), le filtre par
// tier, le repli EXPLICITE sur le slot `vision`, les refus (pin/allow/slot vide), le
// mode dégradé fail-open (aucune donnée = aucun filtrage), le council refusé en AMONT,
// et le test de contrat : une requête avec image n'est JAMAIS routée vers un modèle
// non-vision, quelle que soit la forme de la cible.

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'x'
process.env.OPENMULTI_API_KEYS = 'sk_vision_test'
process.env.OPENMULTI_MODEL_ECONOMY = 'vendort/text-eco'
process.env.OPENMULTI_MODELS_BALANCED = 'vendort/text-bal,vendorv/vis-bal'
process.env.OPENMULTI_MODEL_QUALITY = 'vendorv/vis-q'
process.env.OPENMULTI_COUNCIL_CHAIR = 'vendorv/vis-q'

// Le référentiel vision des tests : la soupape env (remplace le feed, zéro réseau).
const VISION = 'vendorv/vis-bal,vendorv/vis-q,vendorv/vis-slot,anthropic/claude-sonnet-4-5'

let route: typeof import('../src/router.ts').route
let RouteRefusal: typeof import('../src/router.ts').RouteRefusal
let hasImageInput: typeof import('../src/router.ts').hasImageInput
let parseVisionModelIds: typeof import('../src/openrouter-catalog.ts').parseVisionModelIds
let runCouncil: typeof import('../src/council.ts').runCouncil
let computeCouncilQuote: typeof import('../src/council-quote.ts').computeCouncilQuote

before(async () => {
  ;({ route, RouteRefusal, hasImageInput } = await import('../src/router.ts'))
  ;({ parseVisionModelIds } = await import('../src/openrouter-catalog.ts'))
  ;({ runCouncil } = await import('../src/council.ts'))
  ;({ computeCouncilQuote } = await import('../src/council-quote.ts'))
})

beforeEach(() => {
  process.env.OPENMULTI_VISION_MODELS = VISION
  delete process.env.OPENMULTI_MODELS_VISION
})

const IMG_MSGS = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'décris cette image' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,xxxx' } },
    ],
  },
]
const TXT_MSGS = [{ role: 'user', content: 'bonjour' }]

// ── Détection & parseur du feed (purs) ──────────────────────────────────────────

test('hasImageInput: bloc image_url détecté, texte pur non', () => {
  assert.equal(hasImageInput({ messages: IMG_MSGS } as never), true)
  assert.equal(hasImageInput({ messages: TXT_MSGS } as never), false)
  assert.equal(hasImageInput({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] } as never), false)
})

test('parseVisionModelIds: STRICT — input_modalities image, format modality, info absente = pas vision', () => {
  const ids = parseVisionModelIds({
    data: [
      { id: 'a/vis', architecture: { input_modalities: ['text', 'image'] } },
      { id: 'b/txt', architecture: { input_modalities: ['text'] } },
      { id: 'c/legacy-vis', architecture: { modality: 'text+image->text' } },
      { id: 'd/legacy-txt', architecture: { modality: 'text->text' } },
      { id: 'e/sans-info' },
    ],
  })
  assert.deepEqual(ids, ['a/vis', 'c/legacy-vis'])
})

// ── Filtre par tier & repli slot ────────────────────────────────────────────────

test('image + tier balanced: les candidats aveugles sont écartés, reason le dit', () => {
  const d = route({ model: 'auto', messages: IMG_MSGS as never, openmulti: { tier: 'balanced' } })
  assert.equal(d.model, 'vendorv/vis-bal')
  assert.deepEqual(d.candidates, ['vendorv/vis-bal'])
  assert.match(d.reason, /vision-capable only/)
})

test('image + tier SANS candidat vision: repli EXPLICITE sur le slot vision', () => {
  process.env.OPENMULTI_MODELS_VISION = 'vendorv/vis-slot'
  const d = route({ model: 'auto', messages: IMG_MSGS as never, openmulti: { tier: 'economy' } })
  assert.equal(d.model, 'vendorv/vis-slot')
  assert.match(d.reason, /vision fallback \(slot vision\)/)
})

test('image + aucun candidat vision + slot vide: RouteRefusal no_vision_model', () => {
  assert.throws(
    () => route({ model: 'auto', messages: IMG_MSGS as never, openmulti: { tier: 'economy' } }),
    (e: unknown) => e instanceof RouteRefusal && e.code === 'no_vision_model' && /"vision" catalog slot/.test(e.message),
  )
})

// ── Pins & allowlist ────────────────────────────────────────────────────────────

test('image + pin concret non-vision: RouteRefusal model_not_vision (fini la réponse vide facturée)', () => {
  assert.throws(
    () => route({ model: 'vendort/text-eco', messages: IMG_MSGS as never }),
    (e: unknown) => e instanceof RouteRefusal && e.code === 'model_not_vision',
  )
  // Le même pin SANS image passe (le filtre ne concerne que les entrées image).
  assert.equal(route({ model: 'vendort/text-eco', messages: TXT_MSGS as never }).model, 'vendort/text-eco')
})

test('image + pin concret vision: honoré tel quel', () => {
  assert.equal(route({ model: 'anthropic/claude-sonnet-4-5', messages: IMG_MSGS as never }).model, 'anthropic/claude-sonnet-4-5')
})

test('image + allowlist: premier membre VISION élu ; tout-aveugle -> refus', () => {
  const d = route({ model: 'auto', messages: IMG_MSGS as never, openmulti: { allow: ['vendort/text-eco', 'vendorv/vis-q'] } })
  assert.equal(d.model, 'vendorv/vis-q')
  assert.throws(
    () => route({ model: 'auto', messages: IMG_MSGS as never, openmulti: { allow: ['vendort/text-eco'] } }),
    (e: unknown) => e instanceof RouteRefusal && e.code === 'model_not_vision',
  )
})

// ── Mode dégradé (amendement 2) ────────────────────────────────────────────────

test('AUCUNE donnée vision: aucun filtrage, comportement historique (fail-open)', () => {
  delete process.env.OPENMULTI_VISION_MODELS // feed jamais chargé en test -> référentiel null
  const d = route({ model: 'auto', messages: IMG_MSGS as never, openmulti: { tier: 'economy' } })
  assert.equal(d.model, 'vendort/text-eco') // pas filtré — le mode dégradé est un choix documenté
  assert.equal(route({ model: 'vendort/text-eco', messages: IMG_MSGS as never }).model, 'vendort/text-eco')
})

// ── Council : refus en AMONT, jamais une dégradation silencieuse ───────────────

test('council + image: panéliste aveugle -> 400 AVANT toute dépense (exécution ET devis)', async () => {
  const req = {
    model: 'council',
    messages: IMG_MSGS,
    max_tokens: 50,
    openmulti: { council: { panel: ['vendort/text-bal', 'vendorv/vis-q'], chair: 'vendorv/vis-q' } },
  }
  let forwards = 0
  const out = await runCouncil(req as never, { key: 'sk_vision_test', marginFactor: 1 } as never, {
    forward: async () => {
      forwards++
      throw new Error('no forward expected')
    },
  } as never)
  assert.equal(out.status, 400)
  assert.equal((out.body.error as { code: string }).code, 'model_not_vision')
  assert.equal(forwards, 0) // zéro dépense

  const cq = computeCouncilQuote(req as never, 1)
  assert.ok('error' in cq)
  assert.match((cq as { error: string }).error, /vendort\/text-bal/)
})

// ── Test de contrat : jamais un modèle aveugle, quelle que soit la cible ────────

test('CONTRAT: une requête avec image n\'est jamais routée vers un modèle non-vision (toutes formes de cible)', () => {
  process.env.OPENMULTI_MODELS_VISION = 'vendorv/vis-slot'
  const visionSet = new Set(VISION.split(',').concat('vendorv/vis-slot'))
  const targets: Array<Record<string, unknown>> = [
    { model: 'auto' },
    { model: 'auto', openmulti: { tier: 'economy' } },
    { model: 'auto', openmulti: { tier: 'balanced' } },
    { model: 'auto', openmulti: { tier: 'quality' } },
    { model: 'light' },
    { model: 'mid' },
    { model: 'max' },
    { model: 'best' },
    { model: 'cheapest' },
    { model: 'vis-q' }, // nom nu -> résolu vendorv/vis-q (vision, passe)
    { model: 'auto', openmulti: { tier: 'vis-bal' } },
  ]
  for (const t of targets) {
    const d = route({ ...t, messages: IMG_MSGS } as never)
    assert.ok(visionSet.has(d.model), `${JSON.stringify(t)} -> ${d.model} (aveugle !)`)
    for (const c of d.candidates ?? []) assert.ok(visionSet.has(c), `candidat aveugle épinglé: ${c}`)
  }
})
