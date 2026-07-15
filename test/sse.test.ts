// Unit tests for the SSE usage scanner — the boundary case that motivated isolating
// it: a `data:` event split across two chunk reads must still be parsed once complete.
// Also covers injectCostIntoSseData, the pure half of the direct-provider stream
// adaptation (cost synthesis into the usage chunk).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SseUsageScanner, injectCostIntoSseData } from '../src/sse.ts'

test('parse usage et provider sur des lignes completes', () => {
  const s = new SseUsageScanner()
  s.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n')
  s.push('data: {"provider":"anthropic","usage":{"prompt_tokens":5,"completion_tokens":2,"cost":0.01}}\n')
  assert.equal(s.provider, 'anthropic')
  assert.equal(s.usage?.cost, 0.01)
  assert.equal(s.usage?.prompt_tokens, 5)
})

test('une ligne data: coupee entre deux chunks est parsee une fois complete', () => {
  const s = new SseUsageScanner()
  // moitie 1 : pas encore de \n -> rien ne doit etre parse
  s.push('data: {"usage":{"prompt_tokens":7,"comple')
  assert.equal(s.usage, null)
  // moitie 2 : complete la ligne + \n -> parse
  s.push('tion_tokens":3,"cost":0.02}}\n')
  assert.equal(s.usage?.completion_tokens, 3)
  assert.equal(s.usage?.cost, 0.02)
})

test('[DONE] et lignes non-data sont ignores sans casser', () => {
  const s = new SseUsageScanner()
  s.push(': keep-alive comment\n')
  s.push('data: [DONE]\n')
  assert.equal(s.usage, null)
  assert.equal(s.provider, null)
})

test('P0-8 : errored passe a true sur un objet error OU un finish_reason error', () => {
  const s1 = new SseUsageScanner()
  s1.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n')
  assert.equal(s1.errored, false)
  s1.push('data: {"error":{"message":"upstream stream truncated"}}\n')
  assert.equal(s1.errored, true)

  const s2 = new SseUsageScanner()
  s2.push('data: {"choices":[{"index":0,"finish_reason":"error"}],"usage":{}}\n')
  assert.equal(s2.errored, true)

  // fin normale : jamais errored
  const s3 = new SseUsageScanner()
  s3.push('data: {"choices":[{"finish_reason":"stop"}]}\n')
  s3.push('data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0.01}}\n')
  assert.equal(s3.errored, false)
})

test('injectCost: enrichit uniquement l\'event usage sans cost, laisse tout le reste', () => {
  const cb = () => 2.5
  // injecte la ou il faut
  const out = injectCostIntoSseData('data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}', cb)
  assert.ok(out)
  assert.equal(JSON.parse(out.slice(6)).usage.cost, 2.5)
  // ne touche a rien d'autre : delta, [DONE], commentaire, cost deja present, JSON invalide
  assert.equal(injectCostIntoSseData('data: {"choices":[{"delta":{"content":"hi"}}]}', cb), null)
  assert.equal(injectCostIntoSseData('data: [DONE]', cb), null)
  assert.equal(injectCostIntoSseData(': keep-alive', cb), null)
  assert.equal(injectCostIntoSseData('data: {"usage":{"cost":0.01}}', cb), null)
  assert.equal(injectCostIntoSseData('data: {oops', cb), null)
})

test('injectCost: modele non tarife (callback undefined) -> ligne inchangee, pas de faux zero', () => {
  const out = injectCostIntoSseData('data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}', () => undefined)
  assert.equal(out, null)
})
