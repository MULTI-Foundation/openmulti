// F6 : le council fan-out jusqu'à ~2N+1 appels payés sous UN seul snapshot d'autorisation.
// On réserve le devis council COMPLET avant le fan-out, de sorte qu'une requête concurrente
// voie l'engagement en vol. Test bout en bout : un council (panel tarifé, quotable) réserve
// son devis et stationne sur l'upstream ; une requête concurrente au même projet est alors
// refusée par la réservation, puis libérée à la fin du council.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'x'
process.env.OPENMULTI_API_KEYS = 'sk_acme_static'
process.env.OPENMULTI_COUNCIL_CHAIR = 'deepseek/deepseek-chat'
process.env.OPENMULTI_COUNCIL_PANEL_QUALITY = 'deepseek/deepseek-chat,deepseek/deepseek-v4-flash'

const { app } = await import('../src/app.ts')
const { _setStoreClientForTests } = await import('../src/store.ts')
const { _resetKeysForTests, refreshKeys, checkBalance } = await import('../src/keys.ts')
const { _resetMetrics } = await import('../src/metrics.ts')

function fakeClient() {
  const store = new Map<string, Map<string, string>>()
  const hash = (k: string) => { let h = store.get(k); if (!h) { h = new Map(); store.set(k, h) } return h }
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

beforeEach(async () => {
  _resetMetrics()
  _resetKeysForTests()
  client = fakeClient()
  _setStoreClientForTests(client)
  await client.hSet('credits:microusd', 'acme', String(10_000)) // 0.01 $
  await refreshKeys()
})

test('F6: un council quotable réserve son devis complet -> une requête concurrente est refusée', async () => {
  let releaseUpstream!: () => void
  const barrier = new Promise<void>((r) => { releaseUpstream = r })
  globalThis.fetch = (async () => {
    await barrier
    return new Response(
      JSON.stringify({ id: 'g', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as any

  const council = app.fetch(new Request('http://test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer sk_acme_static', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'council', max_tokens: 500_000, messages: [{ role: 'user', content: 'hi' }], openmulti: { council: {} } }),
  }))

  await new Promise((r) => setTimeout(r, 20)) // le council a réservé et stationne sur le fan-out

  // Le devis council (panel tarifé + max_tokens) est bien réservé : le solde disponible est <= 0.
  assert.equal(checkBalance('acme').blocked, true, 'la réservation council doit peser sur le solde')

  const concurrent = await app.fetch(new Request('http://test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer sk_acme_static', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek/deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }),
  }))
  assert.equal(concurrent.status, 402, 'une requête concurrente doit être refusée pendant le fan-out council')

  releaseUpstream()
  const res = await council
  assert.equal(res.status, 200, 'le council aboutit')

  // Réservation libérée après le council : le solde ne reflète plus que les coûts réels.
  await new Promise((r) => setImmediate(r))
  assert.equal(checkBalance('acme').blocked, false, 'réservation council non libérée à la fin')
})
