// Unit tests for the graceful shutdown handler (OM-10).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeShutdown } from '../src/shutdown.ts'

test('ferme le serveur puis exit(0)', () => {
  let closed = false
  let exited = -1
  const server = { close: (cb?: (e?: Error) => void) => { closed = true; cb?.() } }
  makeShutdown(server, (c) => { exited = c }, 10_000)()
  assert.equal(closed, true)
  assert.equal(exited, 0)
})

test('idempotent: un second signal ne re-ferme pas', () => {
  let n = 0
  const server = { close: (cb?: (e?: Error) => void) => { n++; cb?.() } }
  const h = makeShutdown(server, () => {}, 10_000)
  h()
  h()
  assert.equal(n, 1)
})
