// Tests du modèle de revenus (marge t% sur les tokens, décision du 2026-06-12).
// OPENMULTI_MARGIN_PCT=20 posé avant l'import (lu au boot). Verrouille : usage.cost
// margé en non-stream ET dans le chunk usage du stream, le coût BRUT préservé pour le
// bandit/metrics + billed séparé, l'exemption par projet (pct 0 → byte-identique),
// le plafond qui mord en dollars facturés, et l'API admin des marges.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_marge_test,sk_exempt_test'
process.env.OPENMULTI_METRICS_TOKEN = 'ops-token-test'
process.env.OPENMULTI_MARGIN_PCT = '20'

const { app } = await import('../src/app.ts')
const { renderProm, _resetMetrics } = await import('../src/metrics.ts')
const { _setStoreClientForTests } = await import('../src/store.ts')
const { _resetKeysForTests, refreshKeys, noteLocalSpend } = await import('../src/keys.ts')
const { readUsage, meterDay } = await import('../src/meter.ts')

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
    store,
    async hIncrBy(k: string, f: string, n: number) {
      hash(k).set(f, String(Number(hash(k).get(f) ?? 0) + n))
    },
    async hIncrByFloat(k: string, f: string, n: number) {
      hash(k).set(f, String(Number(hash(k).get(f) ?? 0) + n))
    },
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

const upstreamJson = {
  id: 'gen-1',
  choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.01 },
}

let respond: () => Response

beforeEach(() => {
  _resetMetrics()
  _resetKeysForTests()
  _setStoreClientForTests(fakeClient())
  respond = () =>
    new Response(JSON.stringify(upstreamJson), { status: 200, headers: { 'content-type': 'application/json' } })
  globalThis.fetch = (async () => respond()) as any
})

const OPS = { authorization: 'Bearer ops-token-test', 'content-type': 'application/json' }
const chat = (key: string, body: Record<string, unknown> = {}) =>
  app.fetch(new Request('http://test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], ...body }),
  }))

test('non-stream : usage.cost = cout x 1.2 ; metrics gardent le brut ET le facture', async () => {
  const res = await chat('sk_marge_test')
  const j = await res.json()
  assert.ok(Math.abs(j.usage.cost - 0.012) < 1e-12, `attendu 0.012, recu ${j.usage.cost}`)
  // les autres champs usage sont intacts
  assert.equal(j.usage.prompt_tokens, 10)
  const prom = renderProm()
  assert.match(prom, /openmulti_cost_usd_total\{key="marge",[^}]*\} 0\.01\b/)
  assert.match(prom, /openmulti_billed_usd_total\{key="marge",[^}]*\} 0\.012\b/)
})

test('stream : le chunk usage final est marge, le reste passe verbatim', async () => {
  const sse = [
    'data: {"id":"gen-1","choices":[{"delta":{"content":"Hi"}}]}',
    '',
    'data: {"id":"gen-1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.01}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  respond = () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })

  const res = await chat('sk_marge_test', { stream: true })
  const text = await res.text()
  assert.ok(text.includes('data: {"id":"gen-1","choices":[{"delta":{"content":"Hi"}}]}'), 'delta verbatim')
  assert.ok(text.includes('data: [DONE]'), '[DONE] verbatim')
  const usageLine = text.split('\n').find((l) => l.includes('"usage"'))!
  assert.ok(Math.abs(JSON.parse(usageLine.slice(6)).usage.cost - 0.012) < 1e-12)
  // le record interne retrouve le cout brut (bandit/metrics non fausses)
  assert.match(renderProm(), /openmulti_cost_usd_total\{key="marge",[^}]*\} 0\.01\b/)
})

test('exemption par projet : pct 0 -> reponse byte-identique a l upstream', async () => {
  const res0 = await app.fetch(new Request('http://test/admin/margins/exempt', {
    method: 'PUT', headers: OPS, body: JSON.stringify({ pct: 0 }),
  }))
  assert.equal(res0.status, 200)
  const res = await chat('sk_exempt_test')
  const j = await res.json()
  assert.deepEqual(j, upstreamJson) // pas un octet de plus : cout brut, pas de champ ajoute
})

test('admin margins : listing avec defaut + surcharges, validation, reset', async () => {
  await app.fetch(new Request('http://test/admin/margins/exempt', { method: 'PUT', headers: OPS, body: JSON.stringify({ pct: 0 }) }))
  let res = await app.fetch(new Request('http://test/admin/margins', { headers: OPS }))
  let j = await res.json()
  assert.equal(j.defaultPct, 20)
  assert.equal(j.overrides.exempt, 0)
  // reset au defaut via null
  await app.fetch(new Request('http://test/admin/margins/exempt', { method: 'PUT', headers: OPS, body: JSON.stringify({ pct: null }) }))
  await refreshKeys()
  j = await (await app.fetch(new Request('http://test/admin/margins', { headers: OPS }))).json()
  assert.equal(j.overrides.exempt, undefined)
  // validations
  assert.equal((await app.fetch(new Request('http://test/admin/margins/exempt', { method: 'PUT', headers: OPS, body: JSON.stringify({ pct: -5 }) }))).status, 400)
  assert.equal((await app.fetch(new Request('http://test/admin/margins/exempt', { method: 'PUT', headers: OPS, body: JSON.stringify({}) }))).status, 400)
  assert.equal((await app.fetch(new Request('http://test/admin/margins/exempt', { method: 'PUT', headers: { authorization: 'Bearer sk_marge_test', 'content-type': 'application/json' }, body: JSON.stringify({ pct: 0 }) }))).status, 401)
})

test('le plafond mord en dollars FACTURES (cap 1$, brut 0.9 -> facture 1.08 -> bloque)', async () => {
  await app.fetch(new Request('http://test/admin/caps/marge', { method: 'PUT', headers: OPS, body: JSON.stringify({ usdPerDay: 1 }) }))
  noteLocalSpend('marge', 0.9 * 1.2) // 0.9 brut deja depense aujourd hui, en facture
  const res = await chat('sk_marge_test')
  assert.equal(res.status, 429)
  assert.equal((await res.json()).error.type, 'spend_cap_exceeded')
})

test('le metering durable porte cost ET billed (la base du ledger console)', async () => {
  await chat('sk_marge_test')
  await new Promise((r) => setImmediate(r))
  const report = (await readUsage('marge', 1))!
  assert.ok(Math.abs(report.totals.costUsd - 0.01) < 1e-12)
  assert.ok(Math.abs(report.totals.billedUsd - 0.012) < 1e-12)
  assert.ok(report.byDay[meterDay()])
})
