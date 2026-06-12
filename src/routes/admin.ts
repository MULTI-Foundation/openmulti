// Routes d'administration (token ops strict, cf adminAuth) : lecture du metering
// durable (incrément B) et cycle de vie des clés + plafonds (incrément C). Tout vit
// dans le store partagé — sans REDIS_URL ces routes répondent 503, l'app fonctionne.

import { Hono } from 'hono'
import { readUsage } from '../meter.js'
import { createKey, revokeKey, listKeys, setCap, setMargin, listMargins } from '../keys.js'
import { setCatalogSlot, deleteCatalogSlot, listCatalogOverrides } from '../catalog-overrides.js'
import { catalogFileSlots } from '../catalog-file.js'
import { candidatesFor } from '../catalog.js'
import { log } from '../log.js'
import type { AppEnv, Tier } from '../types.js'

export const admin = new Hono<AppEnv>()

// GET /admin/usage?key=<projet>&days=<n>  (days: 1..366, défaut 30)
admin.get('/admin/usage', async (c) => {
  const key = c.req.query('key')
  if (!key) {
    return c.json({ error: { message: '`key` query param is required (project label)', type: 'invalid_request_error' } }, 400)
  }
  const days = Math.min(366, Math.max(1, Number(c.req.query('days') ?? 30) || 30))
  const report = await readUsage(key, days)
  if (!report) {
    return c.json({ error: { message: 'Durable metering disabled (set REDIS_URL)', type: 'metering_disabled' } }, 503)
  }
  return c.json(report)
})

// POST /admin/keys { project, capUsdPerDay? } -> { key, id, project }
// Le secret n'est retourné QU'ICI, à la création — la liste est rédigée.
admin.post('/admin/keys', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { project?: string; capUsdPerDay?: number } | null
  if (!body?.project) {
    return c.json({ error: { message: '`project` is required', type: 'invalid_request_error' } }, 400)
  }
  const out = await createKey(body.project, body.capUsdPerDay)
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
    ]),
  })
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
