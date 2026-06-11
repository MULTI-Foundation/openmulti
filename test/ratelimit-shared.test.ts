// Tests du rate-limit sur l'état partagé (incrément F) : avec le store, le compteur
// de fenêtre vit dans Valkey — la limite vaut pour TOUS les replicas ; store en panne
// = repli sur le compteur mémoire historique (jamais plus dur, jamais coupé).
// Astuce anti-flake : quand un test sème un compteur, il sème la fenêtre courante ET
// la suivante, pour survivre à un changement de minute en plein test.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_rl_test'
process.env.OPENMULTI_RATE_LIMIT_PER_MIN = '2'

const KEY = 'sk_rl_test' // label projet: 'rl'

const { app } = await import('../src/app.ts')
const { windowId, windowRetryAfter, _resetRateLimit } = await import('../src/ratelimit.ts')
const { _setStoreClientForTests } = await import('../src/store.ts')

function fakeStore() {
  const counters = new Map<string, number>()
  const expires = new Map<string, number>()
  return {
    counters,
    expires,
    async hIncrBy() {},
    async hIncrByFloat() {},
    async expire(k: string, s: number) {
      expires.set(k, s)
    },
    async hGetAll() {
      return {}
    },
    async hSet() {},
    async hDel() {},
    async incr(k: string) {
      const v = (counters.get(k) ?? 0) + 1
      counters.set(k, v)
      return v
    },
  }
}

let store: ReturnType<typeof fakeStore>

beforeEach(() => {
  _resetRateLimit()
  store = fakeStore()
  _setStoreClientForTests(store)
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: 'g', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as any
})

const chat = () =>
  app.fetch(new Request('http://test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
  }))

test('le store est la source de verite : le trafic des autres pods compte', async () => {
  // un "autre pod" a deja consomme la limite dans cette fenetre (et la suivante,
  // pour la robustesse au changement de minute)
  const id = windowId(Date.now())
  store.counters.set(`rl:rl:${id}`, 2)
  store.counters.set(`rl:rl:${id + 1}`, 2)
  const res = await chat()
  assert.equal(res.status, 429)
  const retryAfter = Number(res.headers.get('retry-after'))
  assert.ok(retryAfter >= 1 && retryAfter <= 60, String(retryAfter))
})

test('sous la limite : passe, compte dans le store, TTL pose a l\'ouverture de fenetre', async () => {
  const res = await chat()
  assert.equal(res.status, 200)
  const rlKeys = [...store.counters.keys()].filter((k) => k.startsWith('rl:rl:'))
  assert.equal(rlKeys.length, 1)
  assert.equal(store.counters.get(rlKeys[0]!), 1)
  assert.equal(store.expires.get(rlKeys[0]!), 120)
})

test('store en panne (incr jette) : repli memoire — meme limite, jamais bloque a tort', async () => {
  store.incr = async () => {
    throw new Error('connection lost')
  }
  assert.equal((await chat()).status, 200)
  assert.equal((await chat()).status, 200)
  assert.equal((await chat()).status, 429) // la limite memoire (2/min) prend le relais
})

test('sans store : comportement memoire historique inchange', async () => {
  _setStoreClientForTests(null)
  assert.equal((await chat()).status, 200)
  assert.equal((await chat()).status, 200)
  assert.equal((await chat()).status, 429)
})

test('helpers purs : fenetre et Retry-After bornes', () => {
  const t = Date.UTC(2026, 5, 11, 10, 30, 45) // hh:30:45
  assert.equal(windowId(t), Math.floor(t / 60000))
  assert.equal(windowRetryAfter(t), 15) // jusqu'a hh:31:00
  assert.equal(windowRetryAfter(Date.UTC(2026, 5, 11, 10, 30, 0)), 60)
})
