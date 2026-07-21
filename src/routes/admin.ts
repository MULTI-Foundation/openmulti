// Routes d'administration (token ops strict, cf adminAuth) : lecture du metering
// durable (incrément B) et cycle de vie des clés + plafonds (incrément C). Tout vit
// dans le store partagé — sans REDIS_URL ces routes répondent 503, l'app fonctionne.

import { Hono } from 'hono'
import { readUsage, readAllUsage } from '../meter.js'
import { createKey, revokeKey, listKeys, setCap, listCaps, setMargin, listMargins, addCredits, balanceReport } from '../keys.js'
import { setCatalogSlot, deleteCatalogSlot, listCatalogOverrides } from '../catalog-overrides.js'
import { setCouncilSlot, deleteCouncilSlot, councilOverrides } from '../council-overrides.js'
import { effectiveCouncil } from '../council.js'
import { catalogFileSlots } from '../catalog-file.js'
import { candidatesFor, fastCandidates, imageCandidates, isTier } from '../catalog.js'
import { pricedModelIds } from '../pricing.js'
import { route, RouteRefusal } from '../router.js'
import { stageRequest } from '../program-quote.js'
import { log } from '../log.js'
import type { AppEnv, Tier } from '../types.js'

export const admin = new Hono<AppEnv>()

// GET /admin/usage?key=<projet>&days=<n>  (days: 1..366, défaut 30)
// Sans `key` : TOUS les projets connus (days plafonné à 31 — le batch de sync console).
admin.get('/admin/usage', async (c) => {
  const key = c.req.query('key')
  if (!key) {
    const days = Math.min(31, Math.max(1, Number(c.req.query('days') ?? 7) || 7))
    const all = await readAllUsage(days)
    if (!all) {
      return c.json({ error: { message: 'Durable metering disabled (set REDIS_URL)', type: 'metering_disabled' } }, 503)
    }
    return c.json({ days, projects: all })
  }
  const days = Math.min(366, Math.max(1, Number(c.req.query('days') ?? 30) || 30))
  const report = await readUsage(key, days)
  if (!report) {
    return c.json({ error: { message: 'Durable metering disabled (set REDIS_URL)', type: 'metering_disabled' } }, 503)
  }
  return c.json(report)
})

// ── Solde prépayé (le ledger console pousse les top-ups, le gateway décompte) ───
// POST /admin/credits/:project { usd, ref } -> top-up idempotent (ref = event Stripe).
// GET  /admin/balance -> { projet: { creditsUsd, spentUsd, balanceUsd } }.
// Un projet SANS crédits posés n'est jamais bloqué (MyMULTI, dev).

admin.post('/admin/credits/:project', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { usd?: number; ref?: string } | null
  if (!body?.usd || !body.ref) {
    return c.json({ error: { message: '`usd` (>0) and `ref` (idempotency key) are required', type: 'invalid_request_error' } }, 400)
  }
  const out = await addCredits(c.req.param('project'), body.usd, body.ref)
  if (out === null) {
    return c.json({ error: { message: 'Invalid project/usd/ref, or store disabled', type: 'invalid_request_error' } }, 400)
  }
  if (out === 'duplicate') {
    return c.json({ project: c.req.param('project'), duplicate: true }, 200) // webhook re-livre : no-op
  }
  log.info('admin_credits_added', { project: c.req.param('project'), usd: body.usd, ref: body.ref })
  return c.json({ project: c.req.param('project'), creditsUsd: out }, 201)
})

admin.get('/admin/balance', (c) => c.json({ balances: balanceReport() }))

// POST /admin/keys { project, capUsdPerDay?, name? } -> { key, id, project }
// Le secret n'est retourné QU'ICI, à la création — la liste est rédigée.
admin.post('/admin/keys', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { project?: string; capUsdPerDay?: number } | null
  if (!body?.project) {
    return c.json({ error: { message: '`project` is required', type: 'invalid_request_error' } }, 400)
  }
  const out = await createKey(body.project, body.capUsdPerDay, (body as { name?: string }).name)
  if ('error' in out) {
    const disabled = out.error.includes('REDIS_URL')
    return c.json({ error: { message: out.error, type: disabled ? 'keys_disabled' : 'invalid_request_error' } }, disabled ? 503 : 400)
  }
  log.info('admin_key_created', { id: out.id, project: out.project })
  return c.json(out, 201)
})

// GET /admin/keys -> liste rédigée (id, projet, date, état, plafond) — jamais le secret.
admin.get('/admin/keys', (c) => c.json({ keys: listKeys() }))

// DELETE /admin/keys/:id -> révocation (effet immédiat sur ce pod, ≤ refresh ailleurs).
admin.delete('/admin/keys/:id', async (c) => {
  const ok = await revokeKey(c.req.param('id'))
  if (!ok) return c.json({ error: { message: 'Unknown key id (or registry disabled)', type: 'not_found' } }, 404)
  log.info('admin_key_revoked', { id: c.req.param('id') })
  return c.json({ revoked: c.req.param('id') })
})

// ── Catalogue « à la volée » ────────────────────────────────────────────────────
// GET  /admin/catalog              -> overrides actifs + sets effectifs par tier.
// PUT  /admin/catalog/:slot        -> { models: ["vendor/model", ...] } (1..8, le 1er = primaire)
// DELETE /admin/catalog/:slot      -> retombe sur env puis défauts du code.

admin.get('/admin/catalog', (c) => {
  const tiers: Tier[] = ['economy', 'balanced', 'quality']
  return c.json({
    overrides: listCatalogOverrides(),
    file: catalogFileSlots(),
    effective: Object.fromEntries([
      ...tiers.map((t) => [t, candidatesFor(t)]),
      ...tiers.map((t) => [`agent_${t}`, candidatesFor(t, 'agent')]),
      // Slot `fast` = la sélection MANUELLE de @fastest. [] = non configuré (et
      // @fastest répond par une erreur claire tant qu'il le reste).
      ['fast', fastCandidates() ?? []],
      // Slot `image` = le modèle de génération d'image (modalities:['image']) —
      // toujours non vide (défaut neutre intégré), le 1er est servi.
      ['image', imageCandidates()],
    ]),
    // Ids TARIFÉS (pricing.ts) : un modèle hors de cette liste sert les appels mais
    // fait REFUSER les devis (multi explain, /v1/plan) — la console badge « non
    // tarifé » les candidats concernés pour prévenir l'admin avant qu'il ne curate.
    priced: pricedModelIds().sort(),
  })
})

// GET /admin/resolve?target=@claude — testeur de résolution : traduit la cible
// EXACTEMENT comme une étape MULTI (stageRequest, règle §3.4) puis route(), sans
// aucune dépense ni appel provider. Sert la console admin (« que sert @best en ce
// moment ? ») ; RouteRefusal ressort en 400 structuré, comme sur toute surface.
admin.get('/admin/resolve', (c) => {
  const raw = (c.req.query('target') ?? '').trim()
  const word = (raw.startsWith('@') ? raw.slice(1) : raw).toLowerCase() // G12 : minuscules, comme le parseur
  if (!word) {
    return c.json({ error: { message: '`target` is required (e.g. ?target=@claude)', type: 'invalid_request_error' } }, 400)
  }
  try {
    const decision = route(stageRequest(word, 'x'))
    // Fidèle à l'exécution, le canal tier REPLIE un mot inconnu sur le tier par
    // défaut (contrat multi-lang) — un testeur doit le DIRE. Détection sans dupliquer
    // le routeur : le même mot, présenté comme `model`, est-il refusé inconnu ?
    // (Les tiers canoniques et `auto` sont exclus : légitimes sur le canal tier,
    // ils n'existent pas comme noms de modèle.)
    let fallback = false
    if (word !== 'auto' && !isTier(word)) {
      try {
        route({ model: word, messages: [] })
      } catch (e) {
        if (e instanceof RouteRefusal && e.code === 'model_unknown') fallback = true
        else if (!(e instanceof RouteRefusal)) throw e
      }
    }
    return c.json({
      target: word,
      model: decision.model,
      reason: decision.reason,
      candidates: decision.candidates ?? [decision.model],
      fallback,
    })
  } catch (e) {
    if (e instanceof RouteRefusal) {
      return c.json({ error: { message: e.message, type: 'invalid_request_error', code: e.code } }, e.status)
    }
    throw e
  }
})

admin.put('/admin/catalog/:slot', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { models?: string[] } | null
  if (!body?.models) {
    return c.json({ error: { message: '`models` is required (ordered array, first = primary)', type: 'invalid_request_error' } }, 400)
  }
  const err = await setCatalogSlot(c.req.param('slot'), body.models)
  if (err) {
    const disabled = err.includes('REDIS_URL')
    return c.json({ error: { message: err, type: disabled ? 'catalog_disabled' : 'invalid_request_error' } }, disabled ? 503 : 400)
  }
  log.info('admin_catalog_set', { slot: c.req.param('slot'), models: body.models })
  return c.json({ slot: c.req.param('slot'), models: body.models })
})

admin.delete('/admin/catalog/:slot', async (c) => {
  const ok = await deleteCatalogSlot(c.req.param('slot'))
  if (!ok) return c.json({ error: { message: 'No override on this slot (or store disabled)', type: 'not_found' } }, 404)
  log.info('admin_catalog_cleared', { slot: c.req.param('slot') })
  return c.json({ cleared: c.req.param('slot') })
})

// ── Council « à la volée » (panels par preset + chairs + preset par défaut) ─────
// GET  /admin/council            -> overrides actifs + config effective (override > env).
// PUT  /admin/council/:slot      -> panel* : { value: ["vendor/model", ...] } (1..8)
//                                   chair|chairFlash : { value: "vendor/model" }
//                                   defaultPreset : { value: "flash|budget|quality" }
// DELETE /admin/council/:slot    -> retombe sur l'env.

admin.get('/admin/council', (c) =>
  c.json({ overrides: councilOverrides(), effective: effectiveCouncil() }),
)

admin.put('/admin/council/:slot', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { value?: unknown } | null
  if (body === null || body.value === undefined) {
    return c.json({ error: { message: '`value` is required (array for panels, string for chair/preset)', type: 'invalid_request_error' } }, 400)
  }
  const err = await setCouncilSlot(c.req.param('slot'), body.value)
  if (err) {
    const disabled = err.includes('REDIS_URL')
    return c.json({ error: { message: err, type: disabled ? 'council_disabled' : 'invalid_request_error' } }, disabled ? 503 : 400)
  }
  log.info('admin_council_set', { slot: c.req.param('slot'), value: body.value })
  return c.json({ slot: c.req.param('slot'), value: body.value })
})

admin.delete('/admin/council/:slot', async (c) => {
  const ok = await deleteCouncilSlot(c.req.param('slot'))
  if (!ok) return c.json({ error: { message: 'No override on this slot (or store disabled)', type: 'not_found' } }, 404)
  log.info('admin_council_cleared', { slot: c.req.param('slot') })
  return c.json({ cleared: c.req.param('slot') })
})

// ── Marge sur les tokens (modèle de revenus) ────────────────────────────────────
// GET /admin/margins -> defaut global + surcharges ; PUT { pct } (null = retour au
// defaut). Le client paie cout x (1 + pct/100), visible dans usage.cost.

admin.get('/admin/margins', (c) => c.json(listMargins()))

admin.put('/admin/margins/:project', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { pct?: number | null } | null
  if (body === null || body.pct === undefined) {
    return c.json({ error: { message: '`pct` is required (number, or null to reset to default)', type: 'invalid_request_error' } }, 400)
  }
  const ok = await setMargin(c.req.param('project'), body.pct)
  if (!ok) return c.json({ error: { message: 'Invalid project/pct (0..500), or store disabled', type: 'invalid_request_error' } }, 400)
  log.info('admin_margin_set', { project: c.req.param('project'), pct: body.pct })
  return c.json({ project: c.req.param('project'), pct: body.pct })
})

// GET /admin/caps -> plafonds journaliers par projet (USD facturés).
admin.get('/admin/caps', (c) => c.json({ overrides: listCaps() }))

// PUT /admin/caps/:project { usdPerDay } -> plafond journalier du projet (0 = retire).
admin.put('/admin/caps/:project', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { usdPerDay?: number } | null
  if (body?.usdPerDay === undefined) {
    return c.json({ error: { message: '`usdPerDay` is required (0 removes the cap)', type: 'invalid_request_error' } }, 400)
  }
  const ok = await setCap(c.req.param('project'), body.usdPerDay)
  if (!ok) return c.json({ error: { message: 'Invalid project/usdPerDay, or registry disabled', type: 'invalid_request_error' } }, 400)
  log.info('admin_cap_set', { project: c.req.param('project'), usdPerDay: body.usdPerDay })
  return c.json({ project: c.req.param('project'), usdPerDay: body.usdPerDay })
})
