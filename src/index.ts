// OpenMulti server bootstrap.

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { config } from './config.js'
import { auth } from './auth.js'
import { chat } from './routes/chat.js'

const app = new Hono()

app.get('/health', (c) => c.json({ status: 'ok', service: 'openmulti', version: '0.0.1' }))

// All /v1 routes require a valid API key.
app.use('/v1/*', auth)
app.route('/', chat)

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[openmulti] listening on :${info.port}`)
})
