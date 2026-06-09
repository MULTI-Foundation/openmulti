// Unit tests for headerSafe (OM-05): caller-influenced values reflected into response
// headers must not be able to inject headers (CR/LF/control chars).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { headerSafe } from '../src/sanitize.ts'

test('retire CR/LF -> plus de scission d en-tete possible', () => {
  const out = headerSafe('evil/x\r\nX-Injected: 1')
  assert.doesNotMatch(out, /[\r\n]/)
  assert.equal(out, 'evil/xX-Injected: 1')
})

test('garde un model id valide intact', () => {
  assert.equal(headerSafe('anthropic/claude-sonnet-4-5'), 'anthropic/claude-sonnet-4-5')
  assert.equal(headerSafe('moonshotai/kimi-k2.6'), 'moonshotai/kimi-k2.6')
})

test('retire les caracteres de controle et non-ASCII', () => {
  assert.equal(headerSafe('a\x00b\x7f\tcé'), 'abc')
})

test('cape la longueur', () => {
  assert.equal(headerSafe('x'.repeat(500)).length, 256)
})
