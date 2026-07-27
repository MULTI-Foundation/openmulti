// F2/F4/F10 : réservation de dépense. Ferme la fenêtre check-then-act — le coût MAX estimé
// d'une requête admise est RÉSERVÉ avant le dispatch et compté par les gardes solde/plafond,
// de sorte que N requêtes concurrentes ne voient plus le même état pré-dépense. Tests :
//   1. le mécanisme d'accounting (reserveSpend + checkBalance/checkSpendCap) — déterministe ;
//   2. l'idempotence du releaser (le wiring settle en dépend) ;
//   3. le fail-open des projets non métrés ;
//   4. bout en bout : deux requêtes concurrentes sur un solde qui n'en couvre qu'une — la
//      2e est refusée (402) parce qu'elle voit la réservation de la 1re, encore en vol.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_acme_static'

const { app } = await import('../src/app.ts')
const { _setStoreClientForTests } = await import('../src/store.ts')
const { _resetKeysForTests, refreshKeys, reserveSpend, isMetered, checkBalance, checkSpendCap } = await import('../src/keys.ts')
const { _resetMetrics } = await import('../src/metrics.ts')

function fakeClient() {
  const store = new Map<string, Map<string, string>>()
  const hash = (k: string) => {
    let h = store.get(k)
    if (!h) { h = new Map(); store.set(k, h) }
    return h
  }
  return {
    store,
    async hIncrBy(k: string, f: string, n: number) { hash(k).set(f, String(Number(hash(k).get(f) ?? 0) + n)) },
    async hIncrByFloat(k: string, f: string, n: number) { hash(k).set(f, String(Number(hash(k).get(f) ?? 0) + n)) },
    async expire() {},
    async hGetAll(k: string) { return Object.fromEntries(store.get(k) ?? new Map()) },
    async hSet(k: string, f: string, v: string) { const h = hash(k); const isNew = !h.has(f); h.set(f, v); return isNew ? 1 : 0 },
    async hDel(k: string, f: string) { hash(k).delete(f) },
    async incr() { return 1 },
  }
}

let client: ReturnType<typeof fakeClient>

beforeEach(() => {
  _resetMetrics()
  _resetKeysForTests()
  client = fakeClient()
  _setStoreClientForTests(client)
})

/** Pose un solde prépayé (µ$) pour un projet et rafraîchit les caches mémoire. */
async function credit(project: string, usd: number) {
  await client.hSet('credits:microusd', project, String(Math.round(usd * 1_000_000)))
  await refreshKeys()
}
async function setCap(project: string, usdPerDay: number) {
  await client.hSet('caps:usd_per_day', project, String(usdPerDay))
  await refreshKeys()
}

test('F2/F4/F10: une réservation compte contre le solde (checkBalance)', async () => {
  await credit('acme', 1.0)
  assert.equal(isMetered('acme'), true)
  assert.equal(checkBalance('acme').blocked, false)

  const release = reserveSpend('acme', 1.0) // réserve tout le solde
  assert.equal(checkBalance('acme').blocked, true, 'plus de budget pour admettre une requête de plus')

  release()
  assert.equal(checkBalance('acme').blocked, false, 'libéré')
})

test('F2/F4/F10: une réservation compte contre le plafond journalier (checkSpendCap)', async () => {
  await setCap('acme', 0.1)
  assert.equal(checkSpendCap('acme').blocked, false)

  const release = reserveSpend('acme', 0.1) // réserve = plafond
  assert.equal(checkSpendCap('acme').blocked, true)

  release()
  assert.equal(checkSpendCap('acme').blocked, false)
})

test('F2/F4/F10: le releaser est idempotent (le wiring settle en dépend)', async () => {
  await credit('acme', 1.0)
  const r1 = reserveSpend('acme', 0.5)
  const r2 = reserveSpend('acme', 0.5) // 1.0 réservé -> solde 0
  assert.equal(checkBalance('acme').blocked, true)

  r1(); r1(); r1() // triple appel : ne libère que 0.5, une fois
  assert.ok(Math.abs((checkBalance('acme').balanceUsd ?? 0) - 0.5) < 1e-9, 'sur-libération sur double appel')

  r2()
  assert.ok(Math.abs((checkBalance('acme').balanceUsd ?? 0) - 1.0) < 1e-9)
})

test('F2/F4/F10: un projet NON métré ne réserve rien (fail-open préservé)', async () => {
  await refreshKeys()
  assert.equal(isMetered('free'), false)
  const release = reserveSpend('free', 100) // no-op
  assert.equal(checkBalance('free').blocked, false)
  release() // ne jette pas
})

test('F2/F4/F10: deux requêtes concurrentes, un solde pour une seule -> la 2e est refusée (402)', async () => {
  // Solde 0.01 $ ; chaque requête quotable réserve ~0.28 $ (deepseek-chat, max_tokens 1e6).
  // La 1re passe (solde > 0 avant sa propre réservation), pose sa réservation, puis stationne
  // sur l'upstream ; la 2e voit alors solde <= 0 et est refusée AVANT tout dispatch.
  await credit('acme', 0.01)

  let releaseUpstream!: () => void
  const barrier = new Promise<void>((r) => { releaseUpstream = r })
  globalThis.fetch = (async () => {
    await barrier // les requêtes admises stationnent ici, réservation en vol
    return new Response(
      JSON.stringify({ id: 'g', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as any

  const send = () => app.fetch(new Request('http://test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer sk_acme_static', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek/deepseek-chat', max_tokens: 1_000_000, messages: [{ role: 'user', content: 'hi' }] }),
  }))

  const p1 = send() // démarre, réserve, stationne sur l'upstream
  await new Promise((r) => setTimeout(r, 20)) // laisse p1 atteindre l'upstream parké (réservation posée)

  const r2 = await send() // p2 tourne entièrement : voit la réservation de p1 -> 402
  assert.equal(r2.status, 402, 'la 2e requête concurrente doit être refusée par la réservation')
  assert.equal((await r2.json()).error.type, 'insufficient_credits')

  releaseUpstream()
  const res1 = await p1
  assert.equal(res1.status, 200, 'la 1re requête, elle, aboutit')

  // Après complétion de p1 : la réservation est libérée, seul le coût RÉEL (0.001) est décompté.
  await new Promise((r) => setImmediate(r))
  const bal = checkBalance('acme').balanceUsd ?? 0
  assert.ok(bal > 0.008 && bal < 0.01, `réservation non libérée après complétion (solde ${bal})`)
})
