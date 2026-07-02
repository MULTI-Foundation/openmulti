// B2 : signup self-service. Verrouille le parcours complet (email -> code -> clé) et
// chaque garde de sécurité : opt-in, fail-closed sans store, anti-énumération, code
// hashé usage unique + tentatives bornées + TTL, rate limit IP, plafond global/jour,
// cap par défaut appliqué (et jamais réécrasé à la rotation), identité email = un
// projet pour toujours (+tag inclus). Store et email fakés : aucun réseau.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'test-upstream-key'
process.env.OPENMULTI_SIGNUP = '1'
process.env.OPENMULTI_SIGNUP_CAP_USD = '0.1'
process.env.OPENMULTI_SIGNUP_PER_DAY = '5'
process.env.OPENMULTI_SIGNUP_RATE_PER_MIN = '3'
process.env.OPENMULTI_METRICS_TOKEN = 'ops-token-test'
process.env.OPENMULTI_ADMIN_TOKEN = 'ops-token-test'

const { app } = await import('../src/app.ts')
const { _setStoreClientForTests } = await import('../src/store.ts')
const { _resetKeysForTests } = await import('../src/keys.ts')
const { _setEmailSenderForTest } = await import('../src/email.ts')
const { _resetRateLimit } = await import('../src/ratelimit.ts')
const { normalizeEmail, emailIdentity } = await import('../src/signup.ts')

// ── Fakes ───────────────────────────────────────────────────────────────────────
function fakeClient() {
  const hashes = new Map<string, Map<string, string>>()
  const kv = new Map<string, string>()
  const counters = new Map<string, number>()
  const hash = (k: string) => {
    let h = hashes.get(k)
    if (!h) {
      h = new Map()
      hashes.set(k, h)
    }
    return h
  }
  return {
    hashes,
    kv,
    counters,
    async hIncrBy(k: string, f: string, n: number) {
      hash(k).set(f, String(Number(hash(k).get(f) ?? 0) + n))
    },
    async hIncrByFloat(k: string, f: string, n: number) {
      hash(k).set(f, String(Number(hash(k).get(f) ?? 0) + n))
    },
    async expire() {},
    async hGetAll(k: string) {
      return Object.fromEntries(hashes.get(k) ?? new Map())
    },
    async hSet(k: string, f: string, v: string) {
      const h = hash(k)
      const isNew = !h.has(f)
      h.set(f, v)
      return isNew ? 1 : 0
    },
    async hDel(k: string, f: string) {
      hash(k).delete(f)
    },
    async incr(k: string) {
      const n = (counters.get(k) ?? 0) + 1
      counters.set(k, n)
      return n
    },
    async get(k: string) {
      return kv.get(k) ?? null
    },
    async set(k: string, v: string) {
      kv.set(k, v)
    },
    async del(k: string) {
      kv.delete(k)
    },
  }
}

let client: ReturnType<typeof fakeClient>
let sentEmails: { to: string; text: string }[]
let emailOk = true

beforeEach(() => {
  _resetKeysForTests()
  _resetRateLimit()
  client = fakeClient()
  _setStoreClientForTests(client)
  sentEmails = []
  emailOk = true
  _setEmailSenderForTest(async (msg) => {
    if (!emailOk) return false
    sentEmails.push({ to: msg.to, text: msg.text })
    return true
  })
})

const post = (path: string, body: unknown, ip = '203.0.113.7') =>
  app.fetch(new Request(`http://test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  }))

/** Extrait le code du dernier email envoyé (fake). */
function lastCode(): string {
  const m = sentEmails.at(-1)?.text.match(/code: ([A-Z2-9]+)/)
  assert.ok(m?.[1], 'code absent du mail')
  return m[1]
}

async function fullSignup(email: string, ip?: string): Promise<{ key: string; project: string; capUsdPerDay: number }> {
  assert.equal((await post('/signup', { email }, ip)).status, 200)
  const res = await post('/signup/verify', { email, code: lastCode() }, ip)
  assert.equal(res.status, 201)
  return res.json()
}

// ── Parcours nominal ────────────────────────────────────────────────────────────

test('parcours complet : email -> code -> projet + clé plafonnée qui fonctionne', async () => {
  const out = await fullSignup('agent@example.com')
  assert.match(out.key, /^sk_ag-[0-9a-f]{10}_[0-9a-f]{48}$/)
  assert.match(out.project, /^ag-[0-9a-f]{10}$/)
  assert.equal(out.capUsdPerDay, 0.1)
  // le cap par défaut est réellement posé dans le store
  assert.equal(client.hashes.get('caps:usd_per_day')?.get(out.project), '0.1')
  // la clé créée passe l'auth /v1 (upstream mocké)
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: 'x', choices: [], usage: { cost: 0.001 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
  const chat = await app.fetch(new Request('http://test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${out.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
  }))
  assert.equal(chat.status, 200)
})

test('le code est à usage unique : rejouer le même code échoue', async () => {
  await post('/signup', { email: 'once@example.com' })
  const code = lastCode()
  assert.equal((await post('/signup/verify', { email: 'once@example.com', code })).status, 201)
  assert.equal((await post('/signup/verify', { email: 'once@example.com', code })).status, 400)
})

test('rotation : re-signup du même email = nouvelle clé, MÊME projet, cap admin intact', async () => {
  const first = await fullSignup('rotate@example.com')
  // l'admin relève le cap entre-temps
  await client.hSet('caps:usd_per_day', first.project, '5')
  const second = await fullSignup('rotate@example.com')
  assert.equal(second.project, first.project)
  assert.notEqual(second.key, first.key)
  assert.equal(client.hashes.get('caps:usd_per_day')?.get(first.project), '5', 'cap admin écrasé')
  assert.equal(second.capUsdPerDay, 5)
})

test("identité email : le +tag ne fabrique pas un nouveau projet", async () => {
  const a = await fullSignup('same@example.com')
  const b = await fullSignup('same+bis@example.com')
  assert.equal(b.project, a.project)
  assert.equal(normalizeEmail('  User@EXAMPLE.com '), 'user@example.com')
  assert.equal(emailIdentity('user+x@example.com'), 'user@example.com')
})

// ── Gardes de sécurité ──────────────────────────────────────────────────────────

test('opt-in : OPENMULTI_SIGNUP absent -> 404 (les routes n\'existent pas)', async (t) => {
  const { config } = await import('../src/config.ts')
  const was = config.signup.enabled
  ;(config.signup as { enabled: boolean }).enabled = false
  t.after(() => { (config.signup as { enabled: boolean }).enabled = was })
  assert.equal((await post('/signup', { email: 'x@example.com' })).status, 404)
  assert.equal((await post('/signup/verify', { email: 'x@example.com', code: 'AAAA' })).status, 404)
})

test('fail-closed : store absent ou malade -> 503, jamais de signup fantôme', async () => {
  _setStoreClientForTests(null)
  assert.equal((await post('/signup', { email: 'x@example.com' })).status, 503)
  _setStoreClientForTests(client, false) // présent mais malade
  assert.equal((await post('/signup', { email: 'x@example.com' })).status, 503)
  assert.equal(sentEmails.length, 0)
})

test('anti-énumération : email invalide et email déjà inscrit répondent comme un succès', async () => {
  const bad = await post('/signup', { email: 'pas-un-email' })
  assert.equal(bad.status, 200)
  assert.equal(sentEmails.length, 0, 'rien envoyé pour un email invalide')
  const done = await fullSignup('known@example.com')
  assert.ok(done.key)
  const again = await post('/signup', { email: 'known@example.com' })
  assert.equal(again.status, 200)
  assert.equal((await bad.json()).status, (await again.json()).status)
})

test('verify : échecs indistincts (inconnu, code faux, expiré) = même 400 générique', async () => {
  // email jamais inscrit
  const unknown = await post('/signup/verify', { email: 'ghost@example.com', code: 'ABCDEFGH' })
  assert.equal(unknown.status, 400)
  // code faux
  await post('/signup', { email: 'v@example.com' })
  const wrong = await post('/signup/verify', { email: 'v@example.com', code: 'WRONGONE' })
  assert.equal(wrong.status, 400)
  // expiré (TTL absolu dans le JSON pending)
  const pendingKey = [...client.kv.keys()].find((k) => k.startsWith('signup:pending:'))!
  const pending = JSON.parse(client.kv.get(pendingKey)!)
  pending.exp = Date.now() - 1000
  client.kv.set(pendingKey, JSON.stringify(pending))
  const expired = await post('/signup/verify', { email: 'v@example.com', code: lastCode() })
  assert.equal(expired.status, 400)
  const [ju, jw, je] = [await unknown.json(), await wrong.json(), await expired.json()]
  assert.deepEqual(ju, jw)
  assert.deepEqual(jw, je)
})

test('brute force : 5 tentatives max puis le pending est détruit (le bon code ne passe plus)', async () => {
  await post('/signup', { email: 'brute@example.com' })
  const good = lastCode()
  for (let i = 0; i < 5; i++) {
    assert.equal((await post('/signup/verify', { email: 'brute@example.com', code: 'AAAAAAAA' }, `198.51.100.${i}`)).status, 400)
  }
  // 6e essai avec le BON code : trop tard
  assert.equal((await post('/signup/verify', { email: 'brute@example.com', code: good }, '198.51.100.9')).status, 400)
})

test('rate limit par IP : 3/min puis 429 + Retry-After ; une autre IP passe', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await post('/signup', { email: `a${i}@example.com` })).status, 200)
  const limited = await post('/signup', { email: 'a4@example.com' })
  assert.equal(limited.status, 429)
  assert.ok(limited.headers.get('retry-after'))
  assert.equal((await post('/signup', { email: 'a5@example.com' }, '203.0.113.99')).status, 200)
})

test('plafond global/jour : au-delà de OPENMULTI_SIGNUP_PER_DAY -> 429 même sur des IPs neuves', async () => {
  for (let i = 0; i < 5; i++) {
    assert.equal((await post('/signup', { email: `g${i}@example.com` }, `192.0.2.${i}`)).status, 200)
  }
  const capped = await post('/signup', { email: 'g9@example.com' }, '192.0.2.200')
  assert.equal(capped.status, 429)
})

test('échec d\'envoi email -> 503 (pas de succès silencieux sans code délivrable)', async () => {
  emailOk = false
  assert.equal((await post('/signup', { email: 'x@example.com' })).status, 503)
})

test('le code n\'est jamais stocké en clair ; l\'email jamais persisté', async () => {
  await post('/signup', { email: 'secret@example.com' })
  const code = lastCode()
  const dump = JSON.stringify([...client.kv.entries()]) + JSON.stringify([...client.hashes.entries()].map(([k, v]) => [k, [...v.entries()]]))
  assert.equal(dump.includes(code), false, 'code en clair dans le store')
  assert.equal(dump.includes('secret@example.com'), false, 'email en clair dans le store')
})

// ── Posture B3 : prépayé anonyme (fail-closed), confiance (fail-open) ───────────

const chatWith = (key: string) =>
  app.fetch(new Request('http://test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
  }))

function mockUpstreamOk() {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: 'x', choices: [], usage: { cost: 0.001 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

test('B3 fail-closed : store down -> 503 pour un projet signup, 200 pour une clé de confiance', async (t) => {
  process.env.OPENMULTI_API_KEYS = 'sk_trusted_static'
  const { config } = await import('../src/config.ts')
  const wasKeys = config.apiKeys
  config.apiKeys.push('sk_trusted_static')
  t.after(() => { config.apiKeys.length = 0; config.apiKeys.push(...wasKeys) })

  const out = await fullSignup('posture@example.com')
  mockUpstreamOk()
  // store sain : les deux passent
  assert.equal((await chatWith(out.key)).status, 200)
  assert.equal((await chatWith('sk_trusted_static')).status, 200)
  // store malade : l'anonyme est coupé (503), le client de confiance continue (fail-open)
  _setStoreClientForTests(client, false)
  const blocked = await chatWith(out.key)
  assert.equal(blocked.status, 503)
  assert.equal((await blocked.json()).error.type, 'service_unavailable')
  assert.equal((await chatWith('sk_trusted_static')).status, 200)
  // embeddings : même gate
  const emb = await app.fetch(new Request('http://test/v1/embeddings', {
    method: 'POST',
    headers: { authorization: `Bearer ${out.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', input: 'x' }),
  }))
  assert.equal(emb.status, 503)
})

test('B3 zéro-avance : REQUIRE_CREDITS=1 -> 402 sans crédits, 200 après top-up ; confiance intacte', async (t) => {
  const { config } = await import('../src/config.ts')
  ;(config.signup as { requireCredits: boolean }).requireCredits = true
  t.after(() => { (config.signup as { requireCredits: boolean }).requireCredits = false })

  const out = await fullSignup('prepaid@example.com')
  mockUpstreamOk()
  const refused = await chatWith(out.key)
  assert.equal(refused.status, 402)
  assert.equal((await refused.json()).error.type, 'insufficient_credits')

  // top-up -> le compte s'ouvre (crédits posés + refresh du cache)
  const { addCredits } = await import('../src/keys.ts')
  assert.equal(typeof (await addCredits(out.project, 1, 'topup_1')), 'number')
  assert.equal((await chatWith(out.key)).status, 200)
})

test('corps invalide ou champs manquants -> 400', async () => {
  assert.equal((await post('/signup', {})).status, 400)
  assert.equal((await post('/signup/verify', { email: 'x@example.com' })).status, 400)
  const raw = await app.fetch(new Request('http://test/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: 'pas du json',
  }))
  assert.equal(raw.status, 400)
})
