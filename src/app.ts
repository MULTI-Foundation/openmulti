// The Hono app (routes + middleware). Kept separate from index.ts so it can be
// imported by the contract tests without starting a server.

import { Hono } from 'hono'
import { auth } from './auth.js'
import { chat } from './routes/chat.js'

export const app = new Hono()

app.get('/health', (c) => c.json({ status: 'ok', service: 'openmulti', version: '0.0.1' }))

// All /v1 routes require a valid API key.
app.use('/v1/*', auth)
app.route('/', chat)
