// Tests du fichier de catalogue local (la tambouille interne, non versionnée — la
// fixture utilise des modèles fictifs). Verrouille : le chargement et la validation
// (slots invalides/vides ignorés sans crash), la précédence complète
// (override admin > fichier > env > défauts neutres), la découverte des purposes du
// fichier dans /v1/models, et l'exposition dans GET /admin/catalog.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_catfile_test'
process.env.OPENMULTI_METRICS_TOKEN = 'ops-token-test'
process.env.OPENMULTI_CATALOG_FILE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'catalog.json')
// env sur balanced : le FICHIER doit le battre
process.env.OPENMULTI_MODELS_BALANCED = 'env/should-lose'

const { _setStoreClientForTests } = await import('../src/store.ts')
const { candidatesFor } = await import('../src/catalog.ts')
const { _resetCatalogOverridesForTests } = await import('../src/catalog-overrides.ts')
const { app } = await import('../src/app.ts')

function fakeClient() {
  const store = new Map<string, Map<string, string>>()
  const hash = (k: string) => {
    let h = store.get(k)
    if (!h) {
      h = new Map()
      store.set(k, h)
    }
    return h
  }
  return {
    async hIncrBy() {},
    async hIncrByFloat() {},
    async expire() {},
    async hGetAll(k: string) {
      return Object.fromEntries(store.get(k) ?? new Map())
    },
    async hSet(k: string, f: string, v: string) {
      hash(k).set(f, v)
    },
    async hDel(k: string, f: string) {
      hash(k).delete(f)
    },
    async incr() {
      return 1
    },
  }
}

beforeEach(() => {
  _resetCatalogOverridesForTests()
  _setStoreClientForTests(fakeClient())
})

const OPS = { authorization: 'Bearer ops-token-test', 'content-type': 'application/json' }

test('le fichier sert les slots valides ; invalides/vides ignores sans crash', () => {
  assert.deepEqual(candidatesFor('economy'), ['file/eco-primary', 'file/eco-alt'])
  // slot "quality" vide dans la fixture -> ignore -> defaut neutre du code
  assert.deepEqual(candidatesFor('quality'), ['anthropic/claude-opus-4.8'])
})

test('precedence : fichier > env ; override admin > fichier', async () => {
  // le fichier bat l env pose sur balanced
  assert.deepEqual(candidatesFor('balanced'), ['file/bal-primary'])
  // l override admin bat le fichier
  const res = await app.fetch(new Request('http://test/admin/catalog/balanced', {
    method: 'PUT',
    headers: OPS,
    body: JSON.stringify({ models: ['admin/wins'] }),
  }))
  assert.equal(res.status, 200)
  assert.deepEqual(candidatesFor('balanced'), ['admin/wins'])
  // DELETE de l override -> retour au fichier (pas a l env)
  await app.fetch(new Request('http://test/admin/catalog/balanced', { method: 'DELETE', headers: OPS }))
  assert.deepEqual(candidatesFor('balanced'), ['file/bal-primary'])
})

test('slot par purpose du fichier : route et apparait dans /v1/models', async () => {
  assert.deepEqual(candidatesFor('quality', 'research'), ['file/research-model'])
  const res = await app.fetch(new Request('http://test/v1/models', { headers: { authorization: 'Bearer sk_catfile_test' } }))
  const j = await res.json()
  const m = j.data.find((x: any) => x.id === 'file/research-model')
  assert.ok(m, 'modele du fichier absent de /v1/models')
  assert.ok(m.openmulti.purposes.includes('research'))
})

test('GET /admin/catalog expose la vue fichier a cote des overrides et de l effectif', async () => {
  const res = await app.fetch(new Request('http://test/admin/catalog', { headers: OPS }))
  const cat = await res.json()
  assert.deepEqual(cat.file.economy, ['file/eco-primary', 'file/eco-alt'])
  assert.deepEqual(cat.effective.economy, ['file/eco-primary', 'file/eco-alt'])
  assert.equal(cat.file['bad slot!'], undefined, 'slot invalide ecarte au chargement')
})
