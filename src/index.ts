// OpenMulti server bootstrap.

import { serve } from '@hono/node-server'
import { config } from './config.js'
import { app } from './app.js'
import { makeShutdown, type Closable } from './shutdown.js'
import { initMeter } from './meter.js'
import { log } from './log.js'

// Metering durable (no-op sans REDIS_URL) — jamais bloquant pour le boot.
initMeter()

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info('listening', { port: info.port })
})

// OM-10: drain in-flight requests on SIGTERM/SIGINT before exiting.
const shutdown = makeShutdown(server as unknown as Closable, (code) => process.exit(code))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
