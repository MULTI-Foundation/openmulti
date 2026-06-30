// audit #7 : keyLabel ne doit pas être sensible à la casse (sinon `sk_Foo_…` -> label
// `Foo` ≠ projet registre `foo`, et les lookups cap/solde sensibles à la casse sont évadés).

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'x'
const { keyLabel } = await import('../src/metrics.ts')

test('keyLabel : projet minuscules OK, casse mixte -> hash (pas d\'attribution projet)', () => {
  assert.equal(keyLabel('sk_foo_secret'), 'foo')
  assert.equal(keyLabel('sk_my-proj_secret'), 'my-proj')
  // `sk_Foo_…` ne doit JAMAIS être attribué à `Foo` ni à `foo` -> retombe sur le hash
  const mixed = keyLabel('sk_Foo_secret')
  assert.notEqual(mixed, 'Foo')
  assert.notEqual(mixed, 'foo')
  assert.match(mixed, /^[0-9a-f]{8}$/) // hash sha256 tronqué
  assert.equal(keyLabel(undefined), 'anon')
})
