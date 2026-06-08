// Unit tests for the SSE usage scanner — the boundary case that motivated isolating
// it: a `data:` event split across two chunk reads must still be parsed once complete.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SseUsageScanner } from '../src/sse.ts'

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
