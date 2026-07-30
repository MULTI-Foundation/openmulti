// Tests de la quarantaine (chemin d'accès, modèle) — vécu prod 2026-07-30 : un chemin
// direct qui refuse en 401/403/404 (clé, quota, modèle absent du vendor) est écarté de
// l'élection pendant un TTL, au lieu de re-payer un aller-retour perdu à chaque requête.
// Les 400/422 (forme de la requête) gardent le failover PAR REQUÊTE sans quarantaine
// (vécu prod 2026-07-17). Upstreams mockés par URL, comme fallback.test.ts.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS = 'sk_pq_test'
process.env.MOONSHOT_API_KEY = 'msk-test'
process.env.OPENMULTI_PROVIDER_MOONSHOTAI = 'direct'
process.env.OPENMULTI_MAX_RETRIES = '0'

const KEY = 'sk_pq_test'
const MODEL = 'moonshotai/kimi-k2.6'

const { app } = await import('../src/app.ts')
const { providerFor } = await import('../src/providers/index.ts')
const { markPathUnservable, isPathQuarantined, _resetPathQuarantine } = await import('../src/path-quarantine.ts')
const { renderProm, _resetMetrics } = await import('../src/metrics.ts')

let moonshotCalls = 0
let onMoonshot: () => Response | never
let onOpenRouter: () => Response | never

const ok = (cost = 0.01) =>
  new Response(JSON.stringify({ id: 'gen-1', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
const status = (s: number) => new Response(JSON.stringify({ error: 'upstream says no' }), { status: s, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  _resetMetrics()
  _resetPathQuarantine()
  moonshotCalls = 0
  onMoonshot = () => ok()
  onOpenRouter = () => ok()
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.includes('moonshot')) {
      moonshotCalls++
      return onMoonshot()
    }
    return onOpenRouter()
  }) as any
})

const chat = (body: Record<string, unknown> = {}) =>
  app.fetch(new Request('http://test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], openmulti: { tier: 'balanced' }, ...body }),
  }))

test('unité : seuls les statuts d\'identité de chemin quarantainent, jamais openrouter, TTL borné', () => {
  assert.equal(markPathUnservable('moonshot', MODEL, 400), false, '400 = forme de la requête, pas le chemin')
  assert.equal(markPathUnservable('moonshot', MODEL, 429), false)
  assert.equal(markPathUnservable('moonshot', MODEL, 503), false)
  assert.equal(markPathUnservable('openrouter', MODEL, 404), false, 'openrouter est le chemin de référence')
  assert.equal(isPathQuarantined('moonshot', MODEL), false)

  assert.equal(markPathUnservable('moonshot', MODEL, 404, 1_000), true)
  assert.equal(isPathQuarantined('moonshot', MODEL, 1_000), true)
  assert.equal(isPathQuarantined('moonshot', 'moonshotai/kimi-k3', 1_000), false, 'la quarantaine est par (chemin, modèle)')
  // TTL par défaut 600 s : expirée, la paire redevient éligible (re-sonde naturelle).
  assert.equal(isPathQuarantined('moonshot', MODEL, 1_000 + 600_000), false)
})

test('élection : une paire quarantainée élit openrouter d\'office, les autres modèles du vendor restent directs', () => {
  assert.equal(providerFor(MODEL).name, 'moonshot')
  markPathUnservable('moonshot', MODEL, 404)
  assert.equal(providerFor(MODEL).name, 'openrouter')
  assert.equal(providerFor('moonshotai/kimi-k3').name, 'moonshot')
})

test('variante OpenRouter (:nitro, :free) : jamais de chemin direct, même vendor actif', () => {
  assert.equal(providerFor(`${MODEL}:nitro`).name, 'openrouter')
  assert.equal(providerFor(`${MODEL}:free`).name, 'openrouter')
})

test('bout en bout : 404 direct -> failover + quarantaine, la requête suivante part directement sur openrouter', async () => {
  onMoonshot = () => status(404)
  const r1 = await chat()
  assert.equal(r1.status, 200)
  assert.match((await r1.json()).openmulti.reason, /via openrouter \(fallback from moonshot\)/)
  assert.equal(moonshotCalls, 1)

  const r2 = await chat()
  assert.equal(r2.status, 200)
  assert.equal(moonshotCalls, 1, 'la paire quarantainée ne doit plus être appelée')
  assert.doesNotMatch((await r2.json()).openmulti.reason, /fallback/)
  assert.match(renderProm(), /openmulti_path_quarantine_total\{model="moonshotai\/kimi-k2\.6",provider="moonshot"\} 1\b/)
})

test('bout en bout : 400 (forme) -> failover par requête, PAS de quarantaine', async () => {
  onMoonshot = () => status(400)
  const r1 = await chat()
  assert.equal(r1.status, 200)
  const r2 = await chat()
  assert.equal(r2.status, 200)
  assert.equal(moonshotCalls, 2, 'sans quarantaine, le direct reste élu et re-testé à chaque requête')
  assert.doesNotMatch(renderProm(), /openmulti_path_quarantine_total\{/)
})
