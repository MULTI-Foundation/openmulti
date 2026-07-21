// GET /admin/resolve — le testeur de résolution de la console admin : même traduction
// qu'une étape MULTI (stageRequest §3.4) + route(), zéro dépense. Verrouille : la
// résolution des cibles du langage (niveau, objectif, famille, nom nu, id concret),
// la normalisation (@ optionnel, casse), les refus structurés (inconnu, fastest), la
// garde du token ops, et le champ `priced` de GET /admin/catalog (badge console).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'x'
process.env.OPENMULTI_API_KEYS = 'sk_resolve_test'
process.env.OPENMULTI_ADMIN_TOKEN = 'admin-tok-resolve'
process.env.OPENMULTI_MODEL_ECONOMY = 'anthropic/claude-haiku-4-5'
process.env.OPENMULTI_MODEL_BALANCED = 'moonshotai/kimi-k2.6'
process.env.OPENMULTI_MODEL_QUALITY = 'anthropic/claude-opus-4.8'

let app: { fetch: (req: Request) => Promise<Response> }

before(async () => {
  ;({ app } = await import('../src/app.ts'))
})

function resolve(target: string, tok = 'admin-tok-resolve') {
  return app.fetch(
    new Request(`http://t/admin/resolve?target=${encodeURIComponent(target)}`, {
      headers: { authorization: `Bearer ${tok}` },
    }),
  )
}

test('resolve: cibles du langage -> modèle + raison, sans dépense', async () => {
  for (const [target, model] of [
    ['@best', 'anthropic/claude-opus-4.8'],
    ['light', 'anthropic/claude-haiku-4-5'],
    ['@auto', 'moonshotai/kimi-k2.6'],
    ['@claude', 'anthropic/claude-opus-4.8'], // famille -> le mieux classé du catalogue
    ['kimi-k2.6', 'moonshotai/kimi-k2.6'], // nom nu -> pin résolu
    ['moonshotai/kimi-k2.6', 'moonshotai/kimi-k2.6'], // id concret honoré tel quel
  ] as const) {
    const res = await resolve(target)
    assert.equal(res.status, 200, target)
    const body = (await res.json()) as { model: string; reason: string; candidates: string[]; fallback: boolean }
    assert.equal(body.model, model, target)
    assert.ok(body.reason.length > 0)
    assert.ok(body.candidates.includes(model))
    assert.equal(body.fallback, false, target)
  }
})

test('resolve: mot inconnu -> 200 FIDÈLE au langage (repli tier par défaut) mais fallback:true', async () => {
  const res = await resolve('ghost-model-xyz')
  assert.equal(res.status, 200)
  const body = (await res.json()) as { model: string; fallback: boolean }
  assert.equal(body.model, 'moonshotai/kimi-k2.6') // primaire balanced = DEFAULT_TIER
  assert.equal(body.fallback, true)
})

test('resolve: les tiers canoniques ne sont PAS marqués fallback', async () => {
  const res = await resolve('economy')
  assert.equal(res.status, 200)
  const body = (await res.json()) as { model: string; fallback: boolean }
  assert.equal(body.model, 'anthropic/claude-haiku-4-5')
  assert.equal(body.fallback, false)
})

test('resolve: la casse est normalisée comme dans le langage (G12)', async () => {
  const res = await resolve('@BEST')
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as { model: string }).model, 'anthropic/claude-opus-4.8')
})

test('resolve: fastest -> refus structuré, target manquant -> 400', async () => {
  const fastest = await resolve('@fastest')
  assert.equal(fastest.status, 400)
  assert.equal(((await fastest.json()) as { error: { code: string } }).error.code, 'objective_unavailable')

  const missing = await app.fetch(new Request('http://t/admin/resolve', { headers: { authorization: 'Bearer admin-tok-resolve' } }))
  assert.equal(missing.status, 400)
})

test('resolve: protégé par le token ops (mauvais token -> 401/403, jamais une résolution)', async () => {
  const res = await resolve('@best', 'mauvais-token')
  assert.ok(res.status === 401 || res.status === 403)
})

test('/admin/catalog: expose `priced` (badge « non tarifé ») et le slot `fast` ([] = non configuré)', async () => {
  const res = await app.fetch(
    new Request('http://t/admin/catalog', { headers: { authorization: 'Bearer admin-tok-resolve' } }),
  )
  assert.equal(res.status, 200)
  const body = (await res.json()) as { priced: string[]; effective: Record<string, string[]> }
  assert.ok(Array.isArray(body.priced))
  assert.ok(body.priced.includes('moonshotai/kimi-k2.6'))
  assert.deepEqual(body.effective.fast, [])
  // Slot `image` : jamais vide (défaut neutre intégré), le 1er est servi aux
  // appels modalities:['image'].
  assert.deepEqual(body.effective.image, ['google/gemini-2.5-flash-image'])
})

test('routage image: le slot `image` (env) pilote modalities:[image]', async () => {
  const { route } = await import('../src/router.ts')
  process.env.OPENMULTI_MODELS_IMAGE = 'vendori/pix-1,vendori/pix-2'
  try {
    const d = route({ model: 'auto', messages: [], modalities: ['image'] })
    assert.equal(d.model, 'vendori/pix-1') // le 1er est servi — pas de bandit sur l'image
    assert.deepEqual(d.candidates, ['vendori/pix-1', 'vendori/pix-2'])
  } finally {
    delete process.env.OPENMULTI_MODELS_IMAGE
  }
  // Sans override : le défaut neutre historique, inchangé (contrat MyMULTI).
  assert.equal(route({ model: 'auto', messages: [], modalities: ['image'] }).model, 'google/gemini-2.5-flash-image')
})

test('setCatalogSlot: le slot `fast` passe la validation de nom (piloté par l\'admin)', async () => {
  const { setCatalogSlot } = await import('../src/catalog-overrides.ts')
  // Sans store le refus est « disabled », jamais « invalid slot » — la forme du nom est validée AVANT.
  const err = await setCatalogSlot('fast', ['vendorf/rapid-1'])
  assert.ok(err === null || !err.includes('invalid slot'), String(err))
  // Le slot s'appelle `fast` — `fastest` (le mot du langage) n'est PAS un nom de slot.
  assert.match(String(await setCatalogSlot('fastest', ['x/y'])), /invalid slot/)
  // `image` est un slot valide lui aussi (génération d'image pilotée par l'admin).
  const errImg = await setCatalogSlot('image', ['google/gemini-2.5-flash-image'])
  assert.ok(errImg === null || !errImg.includes('invalid slot'), String(errImg))
})
