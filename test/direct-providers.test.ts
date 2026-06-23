// Chemins d'accès directs OpenAI-compatibles DeepSeek / Mistral / Z.ai (spec
// multi-provider §3) + sémantique du registre généralisé (providers/index.ts).
// Upstream mocké (globalThis.fetch), aucun réseau. Tous parlent le même wire format :
// un seul jeu d'assertions paramétré couvre résolution opt-in, endpoint/auth, mapping
// d'id et synthèse de usage.cost. On verrouille aussi : le fallback silencieux quand la
// clé manque, et le failover de chemin (pathsFor).

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_API_KEYS ||= 'sk_direct_test'

// deepseek + mistral en direct, zai en smart (pour exercer l'arbitrage de chemin sur un
// vendor généralisé, pas seulement Moonshot).
process.env.OPENMULTI_PROVIDER_DEEPSEEK = 'direct'
process.env.DEEPSEEK_API_KEY = 'dsk-test'
process.env.OPENMULTI_PROVIDER_MISTRALAI = 'direct'
process.env.MISTRAL_API_KEY = 'mk-test'
process.env.OPENMULTI_PROVIDER_ZAI = 'smart'
process.env.ZAI_API_KEY = 'zk-test'
process.env.OPENMULTI_PROVIDER_QWEN = 'direct'
process.env.QWEN_API_KEY = 'qk-test'
// Flag posé MAIS clé absente -> doit retomber sur openrouter (fallback silencieux).
process.env.OPENMULTI_PROVIDER_OPENAI = 'direct'
delete process.env.OPENAI_API_KEY

const KEY = 'sk_direct_test'
let app: { fetch: (req: Request) => Promise<Response> }
let providerFor: (model: string) => { name: string }
let pathsFor: (model: string) => { name: string }[]
let recordRequest: typeof import('../src/metrics.ts')['recordRequest']
let _resetMetrics: () => void

let lastUrl: string
let lastInit: any

before(async () => {
  ;({ app } = await import('../src/app.ts'))
  ;({ providerFor, pathsFor } = await import('../src/providers/index.ts'))
  ;({ recordRequest, _resetMetrics } = await import('../src/metrics.ts'))
})

beforeEach(() => {
  _resetMetrics()
  globalThis.fetch = (async (url: any, init: any) => {
    lastUrl = String(url)
    lastInit = init
    return new Response(
      JSON.stringify({
        id: 'cmpl-1',
        choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000, total_tokens: 1_500_000 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as any
})

function post(body: any) {
  return app.fetch(
    new Request('http://test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    }),
  )
}

interface Case {
  vendor: string
  model: string
  nakedId: string
  baseHost: string
  bearer: string
  // 1M in + 0.5M out, en USD : input + 0.5*output
  expectedCost: number
}

const CASES: Case[] = [
  { vendor: 'deepseek', model: 'deepseek/deepseek-chat', nakedId: 'deepseek-chat', baseHost: 'https://api.deepseek.com/', bearer: 'Bearer dsk-test', expectedCost: 0.14 + 0.5 * 0.28 },
  { vendor: 'mistral', model: 'mistralai/mistral-small-latest', nakedId: 'mistral-small-latest', baseHost: 'https://api.mistral.ai/v1/', bearer: 'Bearer mk-test', expectedCost: 0.1 + 0.5 * 0.3 },
  { vendor: 'zai', model: 'z-ai/glm-4.6', nakedId: 'glm-4.6', baseHost: 'https://api.z.ai/api/paas/v4/', bearer: 'Bearer zk-test', expectedCost: 0.6 + 0.5 * 2.2 },
  { vendor: 'qwen', model: 'qwen/qwen-plus', nakedId: 'qwen-plus', baseHost: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/', bearer: 'Bearer qk-test', expectedCost: 0.4 + 0.5 * 1.2 },
]

for (const c of CASES) {
  test(`${c.vendor}: e2e endpoint/auth/modele mappe/cost synthetise`, async () => {
    const res = await post({ model: c.model, messages: [{ role: 'user', content: 'hi' }] })
    const j = await res.json()
    assert.equal(res.status, 200)
    assert.ok(lastUrl.startsWith(c.baseHost), `${c.vendor} url upstream: ${lastUrl}`)
    assert.equal(lastInit.headers.Authorization, c.bearer)
    assert.equal(JSON.parse(lastInit.body).model, c.nakedId)
    assert.ok(Math.abs(j.usage.cost - c.expectedCost) < 1e-9, `${c.vendor} cost: ${j.usage.cost} attendu ${c.expectedCost}`)
  })
}

// ── Sémantique du registre ───────────────────────────────────────────────────

test('opt-in par clé : flag pose mais clé absente -> fallback silencieux sur openrouter', () => {
  // OPENAI_API_KEY non défini -> openai/* reste sur openrouter malgré le flag direct.
  assert.equal(providerFor('openai/gpt-4.1').name, 'openrouter')
})

test('un vendor non déclaré reste sur openrouter', () => {
  assert.equal(providerFor('anthropic/claude-sonnet-4-5').name, 'openrouter')
  assert.equal(providerFor('google/gemini-2.5-pro').name, 'openrouter')
})

test('failover de chemin : un vendor direct expose [direct, openrouter]', () => {
  const paths = pathsFor('deepseek/deepseek-chat').map((p) => p.name)
  assert.deepEqual(paths, ['deepseek', 'openrouter'])
})

test('mode smart : les deux chemins sont éligibles et explorés à froid', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 8; i++) {
    const p = providerFor('z-ai/glm-4.6')
    seen.add(p.name)
    recordRequest({ key: 'k', model: 'z-ai/glm-4.6', provider: p.name, costUsd: 0.01 })
  }
  assert.deepEqual([...seen].sort(), ['openrouter', 'zai'])
  // et pathsFor doit proposer le failover dans les deux sens.
  assert.equal(pathsFor('z-ai/glm-4.6').length, 2)
})
