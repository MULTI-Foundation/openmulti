// Tests de GET /v1/models : auth obligatoire (la route vit sous /v1/*), inventaire
// fidèle au catalogue (tiers, purposes, image), alias d'intention listés, prix exposé
// uniquement quand il est vérifié dans la table (jamais un prix qu'on ne maîtrise pas).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_models_test'
process.env.OPENMULTI_MODEL_BALANCED = 'anthropic/claude-sonnet-4-5'
process.env.OPENMULTI_MODEL_ECONOMY = 'anthropic/claude-haiku-4-5'
process.env.OPENMULTI_MODEL_AGENT_BALANCED = 'moonshotai/kimi-k2.6'
process.env.OPENMULTI_MODEL_IMAGE = 'google/gemini-2.5-flash-image'

let app: { fetch: (req: Request) => Promise<Response> }

before(async () => {
  ;({ app } = await import('../src/app.ts'))
})

function get(key?: string) {
  const headers: Record<string, string> = {}
  if (key) headers.authorization = `Bearer ${key}`
  return app.fetch(new Request('http://test/v1/models', { headers }))
}

test('401 sans cle (la route est sous l\'auth /v1/*)', async () => {
  const res = await get()
  assert.equal(res.status, 401)
})

test('liste OpenAI: tiers, purposes, image et alias presents', async () => {
  const res = await get('sk_models_test')
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.object, 'list')
  const byId = new Map(j.data.map((m: any) => [m.id, m]))

  // alias d'intention découvrables
  assert.equal(byId.get('auto')?.openmulti.alias, true)
  assert.equal(byId.get('auto:economy')?.openmulti.resolves_to_tier, 'economy')

  // candidats de tier
  const sonnet = byId.get('anthropic/claude-sonnet-4-5')
  assert.ok(sonnet, 'modele balanced absent')
  assert.ok(sonnet.openmulti.tiers.includes('balanced'))
  assert.equal(sonnet.owned_by, 'anthropic')

  // purpose-aware: kimi est liste via purpose=agent, pas comme candidat de tier
  const kimi = byId.get('moonshotai/kimi-k2.6')
  assert.ok(kimi, 'modele agent absent')
  assert.ok(kimi.openmulti.purposes.includes('agent'))

  // modele image
  assert.ok(byId.get('google/gemini-2.5-flash-image')?.openmulti.purposes.includes('image'))
})

test('le prix n\'est expose que s\'il est verifie dans la table de synthese', async () => {
  const res = await get('sk_models_test')
  const j = await res.json()
  const byId = new Map(j.data.map((m: any) => [m.id, m]))
  // kimi-k2.6 est tarife dans pricing.ts (verifie au cablage Moonshot)
  const kimi = byId.get('moonshotai/kimi-k2.6')
  assert.deepEqual(kimi.openmulti.pricing, {
    input_per_mtok_usd: 0.95,
    output_per_mtok_usd: 4,
    source: 'direct',
  })
  // sonnet-4-5 est tarife depuis le comblement des trous du 2026-07-02
  assert.deepEqual(byId.get('anthropic/claude-sonnet-4-5').openmulti.pricing, {
    input_per_mtok_usd: 3,
    output_per_mtok_usd: 15,
    source: 'direct',
  })
  // un modele HORS table (image) -> pas de prix affiche (pas de mensonge)
  assert.equal(byId.get('google/gemini-2.5-flash-image').openmulti.pricing, null)
})
