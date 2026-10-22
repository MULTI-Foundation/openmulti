// R-1 : le script Lua d'observation (bandit.ts) contre un VRAI Redis/Valkey. Gated :
// sans OPENMULTI_TEST_REDIS_URL le fichier est sauté (pas de dépendance d'infra dans
// `npm test`). Localement : `docker run -d --rm -p 127.0.0.1:6399:6379 redis` puis
// `OPENMULTI_TEST_REDIS_URL=redis://127.0.0.1:6399 node --test test/bandit-redis.test.ts`.
// Verrouille l'ÉQUIVALENCE : la vue locale (observe en mémoire) et l'état partagé (Lua)
// calculent la même chose sur la même séquence — c'est ce qui autorise le refresh à
// remplacer l'une par l'autre.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_SMART_DECAY_WINDOW = '20'

const URL = process.env.OPENMULTI_TEST_REDIS_URL
const { createClient } = await import('redis')
const { _setStoreClientForTests } = await import('../src/store.ts')
type StoreClient = import('../src/store.ts').StoreClient
const { observe, modelAggregate, pathAggregate, refreshBanditFromStore, _resetBandit, _BANDIT_HASH_KEY_FOR_TESTS: HASH } =
  await import('../src/bandit.ts')

let c: ReturnType<typeof createClient>

before(async () => {
  if (!URL) return
  c = createClient({ url: URL })
  await c.connect()
  _setStoreClientForTests(c as unknown as StoreClient)
})
after(async () => {
  if (c) await c.quit()
})
beforeEach(async () => {
  _resetBandit()
  if (c) await c.del(HASH)
})

type Agg = { requests: number; errors: number; costUsd: number; lastErrorAt?: number }
const close = (x: Agg, y: Agg, what: string) => {
  assert.ok(Math.abs(x.requests - y.requests) < 1e-9, `${what} requests ${x.requests} vs ${y.requests}`)
  assert.ok(Math.abs(x.errors - y.errors) < 1e-9, `${what} errors ${x.errors} vs ${y.errors}`)
  assert.ok(Math.abs(x.costUsd - y.costUsd) < 1e-9, `${what} costUsd ${x.costUsd} vs ${y.costUsd}`)
  assert.equal(x.lastErrorAt, y.lastErrorAt, `${what} lastErrorAt`)
}

test('Lua == mémoire : décote globale, décote à portée, erreurs, coûts, horodatages', { skip: !URL && 'OPENMULTI_TEST_REDIS_URL absent' }, async () => {
  const seq = [
    { provider: 'openrouter', model: 'a/1', error: false, costUsd: 0.1, now: 1000 },
    { provider: 'moonshot', model: 'a/1', error: true, costUsd: 0.05, now: 2000 },
    { provider: 'openrouter', model: 'b/2', error: false, costUsd: 0.02, now: 3000, candidates: ['a/1', 'b/2'] },
    { provider: 'openrouter', model: 'c/3', error: true, costUsd: 0, now: 4000, candidates: ['c/3', 'd/4'] },
    { provider: 'openrouter', model: 'a/1', error: false, costUsd: 0.3, now: 5000 },
    { provider: 'openrouter', model: 'b/2', error: true, costUsd: 0.02, now: 6000, candidates: ['a/1', 'b/2'] },
  ]
  for (const o of seq) observe(o)
  const local = {
    a: modelAggregate('a/1'), b: modelAggregate('b/2'), c: modelAggregate('c/3'),
    aMoon: pathAggregate('moonshot', 'a/1'), aOr: pathAggregate('openrouter', 'a/1'),
  }
  // Les EVAL sont fire-and-forget mais ORDONNÉS sur la connexion : le HGETALL du refresh
  // les voit tous appliqués.
  await refreshBanditFromStore()
  close(modelAggregate('a/1'), local.a, 'a/1')
  close(modelAggregate('b/2'), local.b, 'b/2')
  close(modelAggregate('c/3'), local.c, 'c/3')
  close(pathAggregate('moonshot', 'a/1'), local.aMoon, 'moonshot|a/1')
  close(pathAggregate('openrouter', 'a/1'), local.aOr, 'openrouter|a/1')
  assert.equal(modelAggregate('a/1').lastErrorAt, 2000)
  assert.equal(modelAggregate('c/3').lastErrorAt, 4000)
  // c/3 : hors portée des observations à candidats (b/2), amorti UNE fois par
  // l'observation globale (a/1 sans candidats) -> 0.95, pas 0.95^2.
  assert.ok(Math.abs(modelAggregate('c/3').requests - 0.95) < 1e-9, `c/3 ${modelAggregate('c/3').requests}`)
})

test('Lua : purge des bras négligeables et atomicité sous écritures concurrentes', { skip: !URL && 'OPENMULTI_TEST_REDIS_URL absent' }, async () => {
  observe({ provider: 'openrouter', model: 'a/1', error: false, costUsd: 0, now: 1 })
  // Deux « pods » : la même séquence en mémoire ne voit que SA moitié ; le store voit tout.
  for (let i = 0; i < 200; i++) observe({ provider: 'openrouter', model: 'b/2', error: i % 2 === 0, costUsd: 0.01, now: 10 + i })
  await refreshBanditFromStore()
  const h = await c.hGetAll(HASH)
  assert.equal(h['openrouter|a/1'], undefined, 'bras amorti sous 1e-4 purgé du hash')
  const b = modelAggregate('b/2')
  // Point fixe d'un bras servi à chaque observation : requests -> WINDOW (20), ici 1-0.95^200 ≈ 20.
  assert.ok(Math.abs(b.requests - 20 * (1 - 0.95 ** 200)) < 1e-6, `requests ${b.requests}`)
  // Erreurs une observation sur deux (i pair) : rho + rho^3 + ... + rho^199 = rho(1-rho^200)/(1-rho^2).
  const expectedErrors = 0.95 * (1 - 0.95 ** 200) / (1 - 0.95 ** 2)
  assert.ok(Math.abs(b.errors - expectedErrors) < 1e-6, `errors ${b.errors} vs ${expectedErrors}`)
  assert.equal(b.lastErrorAt, 10 + 198)
})
