// Routes d'administration (token ops strict, cf adminAuth) : lecture du metering
// durable (incrément B) et cycle de vie des clés + plafonds (incrément C). Tout vit
// dans le store partagé — sans REDIS_URL ces routes répondent 503, l'app fonctionne.

import { Hono } from 'hono'
import { readUsage } from '../meter.js'
import { createKey, revokeKey, listKeys, setCap } from '../keys.js'
import { log } from '../log.js'
import type { AppEnv } from '../types.js'

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
