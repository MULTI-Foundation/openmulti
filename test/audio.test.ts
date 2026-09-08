// Routage par modalité d'ENTRÉE, volet AUDIO (chantier 2026-09-08) : un vocal
// (content part `input_audio`, format OpenAI) doit atterrir sur un modèle qui
// ACCEPTE l'audio — jamais un modèle sourd servi en silence (400 upstream ou, pire,
// une réponse hallucinée facturée). Même mécanique que la vision (vision.test.ts) :
// détection (hasAudioInput), parseur strict du feed (parseAudioModelIds), filtre par
// tier, repli EXPLICITE sur le slot `audio`, refus (pin/allow/slot vide), mode dégradé
// fail-open, council refusé en AMONT, image + audio = les deux capacités, et le test
// de contrat sur toutes les formes de cible.

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'x'
process.env.OPENMULTI_API_KEYS = 'sk_audio_test'
process.env.OPENMULTI_MODEL_ECONOMY = 'vendort/text-eco'
process.env.OPENMULTI_MODELS_BALANCED = 'vendort/text-bal,vendora/aud-bal'
process.env.OPENMULTI_MODEL_QUALITY = 'vendora/aud-q'
process.env.OPENMULTI_COUNCIL_CHAIR = 'vendora/aud-q'

// Les référentiels des tests : la soupape env (remplace le feed, zéro réseau).
const AUDIO = 'vendora/aud-bal,vendora/aud-q,vendora/aud-slot,vendorb/both,google/gemini-3.1-flash-lite'
const VISION = 'vendorv/vis-only,vendorb/both'

let route: typeof import('../src/router.ts').route
let RouteRefusal: typeof import('../src/router.ts').RouteRefusal
let hasAudioInput: typeof import('../src/router.ts').hasAudioInput
let parseAudioModelIds: typeof import('../src/openrouter-catalog.ts').parseAudioModelIds
let runCouncil: typeof import('../src/council.ts').runCouncil
let computeCouncilQuote: typeof import('../src/council-quote.ts').computeCouncilQuote

before(async () => {
  ;({ route, RouteRefusal, hasAudioInput } = await import('../src/router.ts'))
  ;({ parseAudioModelIds } = await import('../src/openrouter-catalog.ts'))
  ;({ runCouncil } = await import('../src/council.ts'))
  ;({ computeCouncilQuote } = await import('../src/council-quote.ts'))
})

beforeEach(() => {
  process.env.OPENMULTI_AUDIO_MODELS = AUDIO
  process.env.OPENMULTI_VISION_MODELS = VISION
  delete process.env.OPENMULTI_MODELS_AUDIO
  delete process.env.OPENMULTI_MODELS_VISION
})

const AUD_MSGS = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'transcris ce vocal' },
      { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
    ],
  },
]
const IMG_MSGS = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'décris cette image' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,xxxx' } },
    ],
  },
]
const BOTH_MSGS = [
  {
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,xxxx' } },
      { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'mp3' } },
    ],
  },
]
const TXT_MSGS = [{ role: 'user', content: 'bonjour' }]

// ── Détection & parseur du feed (purs) ──────────────────────────────────────────

test('hasAudioInput: bloc input_audio détecté ; texte pur et image seule non', () => {
  assert.equal(hasAudioInput({ messages: AUD_MSGS } as never), true)
  assert.equal(hasAudioInput({ messages: TXT_MSGS } as never), false)
  assert.equal(hasAudioInput({ messages: IMG_MSGS } as never), false)
})

test('parseAudioModelIds: STRICT — input_modalities audio, format modality, info absente = pas audio', () => {
  const ids = parseAudioModelIds({
    data: [
      { id: 'a/aud', architecture: { input_modalities: ['text', 'audio'] } },
      { id: 'b/vis', architecture: { input_modalities: ['text', 'image'] } },
      { id: 'c/legacy-aud', architecture: { modality: 'text+audio->text' } },
      { id: 'd/legacy-txt', architecture: { modality: 'text->text' } },
      { id: 'e/sans-info' },
    ],
  })
  assert.deepEqual(ids, ['a/aud', 'c/legacy-aud'])
})

// ── Filtre par tier & repli slot ────────────────────────────────────────────────

test('audio + tier balanced: les candidats sourds sont écartés, reason le dit', () => {
  const d = route({ model: 'auto', messages: AUD_MSGS as never, openmulti: { tier: 'balanced' } })
  assert.equal(d.model, 'vendora/aud-bal')
  assert.deepEqual(d.candidates, ['vendora/aud-bal'])
  assert.match(d.reason, /audio-capable only/)
})

test('audio + tier SANS candidat audio: repli EXPLICITE sur le slot audio', () => {
  process.env.OPENMULTI_MODELS_AUDIO = 'vendora/aud-slot'
  const d = route({ model: 'auto', messages: AUD_MSGS as never, openmulti: { tier: 'economy' } })
  assert.equal(d.model, 'vendora/aud-slot')
  assert.match(d.reason, /audio fallback \(slot audio\)/)
})

test('audio + aucun candidat audio + slot vide: RouteRefusal no_audio_model', () => {
  assert.throws(
    () => route({ model: 'auto', messages: AUD_MSGS as never, openmulti: { tier: 'economy' } }),
    (e: unknown) => e instanceof RouteRefusal && e.code === 'no_audio_model' && /"audio" catalog slot/.test(e.message),
  )
})

test('audio: le filtre vision ne s\'applique pas (un modèle audio sans vision passe)', () => {
  // vendora/aud-q n'est PAS dans le référentiel vision : sans image, aucune raison de l'écarter.
  assert.equal(route({ model: 'auto', messages: AUD_MSGS as never, openmulti: { tier: 'quality' } }).model, 'vendora/aud-q')
})

// ── Pins & allowlist ────────────────────────────────────────────────────────────

test('audio + pin concret sourd: RouteRefusal model_not_audio', () => {
  assert.throws(
    () => route({ model: 'vendort/text-eco', messages: AUD_MSGS as never }),
    (e: unknown) => e instanceof RouteRefusal && e.code === 'model_not_audio' && /audio-capable/.test(e.message),
  )
  // Le même pin SANS audio passe (le filtre ne concerne que les entrées audio).
  assert.equal(route({ model: 'vendort/text-eco', messages: TXT_MSGS as never }).model, 'vendort/text-eco')
})

test('audio + pin concret audio: honoré tel quel', () => {
  assert.equal(route({ model: 'google/gemini-3.1-flash-lite', messages: AUD_MSGS as never }).model, 'google/gemini-3.1-flash-lite')
})

test('audio + allowlist: premier membre AUDIO élu ; tout-sourd -> refus', () => {
  const d = route({ model: 'auto', messages: AUD_MSGS as never, openmulti: { allow: ['vendort/text-eco', 'vendora/aud-q'] } })
  assert.equal(d.model, 'vendora/aud-q')
  assert.throws(
    () => route({ model: 'auto', messages: AUD_MSGS as never, openmulti: { allow: ['vendort/text-eco'] } }),
    (e: unknown) => e instanceof RouteRefusal && e.code === 'model_not_audio',
  )
})

// ── Image + audio : les DEUX capacités ──────────────────────────────────────────

test('image + audio: seul un modèle vision ET audio est élu (tier, allowlist, pin)', () => {
  process.env.OPENMULTI_MODELS_BALANCED = 'vendort/text-bal,vendorv/vis-only,vendora/aud-bal,vendorb/both'
  try {
    const d = route({ model: 'auto', messages: BOTH_MSGS as never, openmulti: { tier: 'balanced' } })
    assert.equal(d.model, 'vendorb/both')
    assert.deepEqual(d.candidates, ['vendorb/both'])
    assert.match(d.reason, /vision-capable only, audio-capable only/)

    const a = route({ model: 'auto', messages: BOTH_MSGS as never, openmulti: { allow: ['vendorv/vis-only', 'vendora/aud-bal', 'vendorb/both'] } })
    assert.equal(a.model, 'vendorb/both')
    assert.throws(
      () => route({ model: 'auto', messages: BOTH_MSGS as never, openmulti: { allow: ['vendorv/vis-only'] } }),
      (e: unknown) => e instanceof RouteRefusal && e.code === 'model_not_audio',
    )
    // Pin vision-seulement + audio -> refusé sur l'audio ; pin audio-seulement -> refusé sur la vision.
    assert.throws(
      () => route({ model: 'vendorv/vis-only', messages: BOTH_MSGS as never }),
      (e: unknown) => e instanceof RouteRefusal && e.code === 'model_not_audio',
    )
    assert.throws(
      () => route({ model: 'vendora/aud-bal', messages: BOTH_MSGS as never }),
      (e: unknown) => e instanceof RouteRefusal && e.code === 'model_not_vision',
    )
  } finally {
    process.env.OPENMULTI_MODELS_BALANCED = 'vendort/text-bal,vendora/aud-bal'
  }
})

test('image + audio: le slot de repli d\'une modalité est encore filtré par l\'autre', () => {
  // economy = text-eco (ni vision ni audio). Repli vision -> slot vision ; il doit
  // ensuite passer le filtre audio : vis-only est écarté, both reste.
  process.env.OPENMULTI_MODELS_VISION = 'vendorv/vis-only,vendorb/both'
  const d = route({ model: 'auto', messages: BOTH_MSGS as never, openmulti: { tier: 'economy' } })
  assert.equal(d.model, 'vendorb/both')
  assert.match(d.reason, /vision fallback \(slot vision\), audio-capable only/)
  // Slot vision tout-sourd + slot audio vide -> refus audio explicite.
  process.env.OPENMULTI_MODELS_VISION = 'vendorv/vis-only'
  assert.throws(
    () => route({ model: 'auto', messages: BOTH_MSGS as never, openmulti: { tier: 'economy' } }),
    (e: unknown) => e instanceof RouteRefusal && e.code === 'no_audio_model',
  )
})

// ── Mode dégradé ────────────────────────────────────────────────────────────────

test('AUCUNE donnée audio: aucun filtrage, comportement historique (fail-open)', () => {
  delete process.env.OPENMULTI_AUDIO_MODELS // feed jamais chargé en test -> référentiel null
  const d = route({ model: 'auto', messages: AUD_MSGS as never, openmulti: { tier: 'economy' } })
  assert.equal(d.model, 'vendort/text-eco') // pas filtré — le mode dégradé est un choix documenté
  assert.equal(route({ model: 'vendort/text-eco', messages: AUD_MSGS as never }).model, 'vendort/text-eco')
})

// ── Council : refus en AMONT ────────────────────────────────────────────────────

test('council + audio: panéliste sourd -> 400 AVANT toute dépense (exécution ET devis)', async () => {
  const req = {
    model: 'council',
    messages: AUD_MSGS,
    max_tokens: 50,
    openmulti: { council: { panel: ['vendort/text-bal', 'vendora/aud-q'], chair: 'vendora/aud-q' } },
  }
  let forwards = 0
  const out = await runCouncil(req as never, { key: 'sk_audio_test', marginFactor: 1 } as never, {
    forward: async () => {
      forwards++
      throw new Error('no forward expected')
    },
  } as never)
  assert.equal(out.status, 400)
  assert.equal((out.body.error as { code: string }).code, 'model_not_audio')
  assert.equal(forwards, 0) // zéro dépense

  const cq = computeCouncilQuote(req as never, 1)
  assert.ok('error' in cq)
  assert.match((cq as { error: string }).error, /vendort\/text-bal/)
})

// ── Test de contrat ─────────────────────────────────────────────────────────────

test('CONTRAT: une requête avec audio n\'est jamais routée vers un modèle sourd (toutes formes de cible)', () => {
  process.env.OPENMULTI_MODELS_AUDIO = 'vendora/aud-slot'
  const audioSet = new Set(AUDIO.split(','))
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
    { model: 'aud-q' }, // nom nu -> résolu vendora/aud-q (audio, passe)
    { model: 'auto', openmulti: { tier: 'aud-bal' } },
  ]
  for (const t of targets) {
    const d = route({ ...t, messages: AUD_MSGS } as never)
    assert.ok(audioSet.has(d.model), `${JSON.stringify(t)} -> ${d.model} (sourd !)`)
    for (const c of d.candidates ?? []) assert.ok(audioSet.has(c), `candidat sourd épinglé: ${c}`)
  }
})
