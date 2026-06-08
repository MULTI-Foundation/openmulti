// The Hono app (routes + middleware). Kept separate from index.ts so it can be
// imported by the contract tests without starting a server.

import { Hono } from 'hono'
import { auth } from './auth.js'
import { chat } from './routes/chat.js'
import { renderProm } from './metrics.js'
import type { AppEnv } from './types.js'

export const app = new Hono<AppEnv>()

app.get('/health', (c) => c.json({ status: 'ok', service: 'openmulti', version: '0.0.1' }))

// Prometheus metrics. Authed: it exposes per-project cost/token data, so a scraper
// must present a valid key (set its bearer_token in the scrape config).
app.use('/metrics', auth)
app.get('/metrics', (c) =>
  c.text(renderProm(), 200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' }),
)

// All /v1 routes require a valid API key.
app.use('/v1/*', auth)
app.route('/', chat)
