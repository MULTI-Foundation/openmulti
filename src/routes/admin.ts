// Routes d'administration (token ops strict, cf adminAuth). Première brique : la
// lecture du metering durable — ce que MyMULTI (ou l'opérateur) consulte pour
// facturer un projet. Le cycle de vie des clés (incrément C) arrivera ici aussi.

import { Hono } from 'hono'
import { readUsage } from '../meter.js'
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
