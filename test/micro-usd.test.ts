// E-4 : comptabilité interne en micro-USD ENTIERS. Verrouille (1) les conversions de
// frontière, (2) l'absence de dérive flottante sur un cumul, (3) la DOUBLE-LECTURE des
// ledgers (legacy USD flottants + nouveaux micro entiers additionnés au refresh — les
// soldes pré-migration restent justes).

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'

const { usdToMicro, microToUsd } = await import('../src/micro-usd.ts')
const { _setStoreClientForTests } = await import('../src/store.ts')
const { _resetKeysForTests, refreshKeys, checkBalance, projectAccount } = await import('../src/keys.ts')

test('usdToMicro/microToUsd : conversions de frontière + round-trip exact sur entiers atomiques', () => {
  assert.equal(usdToMicro(1), 1_000_000)
  assert.equal(usdToMicro(0.05), 50_000)
  assert.equal(usdToMicro(0), 0)
  assert.equal(microToUsd(50_000), 0.05)
  // round-trip depuis une valeur atomique entière (USDC) : sans perte
  for (const atomic of [1, 7, 123456, 10_000_000]) {
    assert.equal(usdToMicro(microToUsd(atomic)), atomic)
  }
  // arrondi au plus proche (erreur max 0.5 µ$), pas de troncature
  assert.equal(usdToMicro(0.0000004), 0) // 0.4 µ$ -> 0
  assert.equal(usdToMicro(0.0000006), 1) // 0.6 µ$ -> 1
})

test('pas de dérive : 1000 cumuls entiers restent EXACTS (là où le float dérive)', () => {
  let micro = 0
  let float = 0
  for (let i = 0; i < 1000; i++) {
    micro += usdToMicro(0.07) // 70_000 µ$ chacun, cumul entier
    float += 0.07 // cumul flottant IEEE
  }
  assert.equal(micro, 70_000_000) // exact, aucun epsilon
  assert.equal(microToUsd(micro), 70)
  // le cumul flottant, lui, s'éloigne de 70 par un epsilon (raison d'être d'E-4) —
  // on ne dépend pas du sens de l'écart, juste du fait que l'entier NE dérive pas.
  assert.ok(Math.abs(float - 70) < 1e-6)
})

// ── Double-lecture des ledgers (backward-compat migration) ──────────────────────

function fakeStore(hashes: Record<string, Record<string, string>>) {
  const store = new Map<string, Map<string, string>>()
  for (const [k, h] of Object.entries(hashes)) store.set(k, new Map(Object.entries(h)))
  return {
    async hGetAll(k: string) {
      return Object.fromEntries(store.get(k) ?? new Map())
    },
    async hSet() { return 1 },
    async hDel() {},
    async hIncrBy() {},
    async hIncrByFloat() {},
    async expire() {},
    async incr() { return 1 },
  }
}

beforeEach(() => {
  _resetKeysForTests()
})

test('double-lecture : un projet avec crédit legacy (USD float) ET micro est sommé correctement', async () => {
  // acme : 4 $ hérités (credits:usd) + 6 $ posés après migration (credits:microusd) = 10 $.
  //        dépense : 1.5 $ legacy (spent:usd) + 0.5 $ micro (spent:microusd) = 2 $. Solde 8 $.
  _setStoreClientForTests(fakeStore({
    'credits:usd': { acme: '4' },
    'credits:microusd': { acme: '6000000' },
    'spent:usd': { acme: '1.5' },
    'spent:microusd': { acme: '500000' },
    'caps:usd_per_day': {},
    'margins:pct': {},
    'keys:registry': {},
  }) as never)
  await refreshKeys()

  const bal = checkBalance('acme')
  assert.equal(bal.blocked, false)
  assert.ok(Math.abs(bal.balanceUsd! - 8) < 1e-9, `solde=${bal.balanceUsd}`)

  const acct = projectAccount('acme')
  assert.equal(acct.prepaid, true)
  assert.ok(Math.abs(acct.creditsUsd! - 10) < 1e-9)
  assert.ok(Math.abs(acct.spentUsd! - 2) < 1e-9)
  assert.ok(Math.abs(acct.balanceUsd! - 8) < 1e-9)
})

test('double-lecture : un projet purement legacy (aucun champ micro) reste posé et juste', async () => {
  _setStoreClientForTests(fakeStore({
    'credits:usd': { old: '3.25' },
    'credits:microusd': {},
    'spent:usd': {},
    'spent:microusd': {},
    'caps:usd_per_day': {},
    'margins:pct': {},
    'keys:registry': {},
  }) as never)
  await refreshKeys()
  const bal = checkBalance('old')
  assert.equal(bal.blocked, false)
  assert.ok(Math.abs(bal.balanceUsd! - 3.25) < 1e-9)
})
