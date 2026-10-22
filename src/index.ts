// OpenMulti server bootstrap.

import { serve } from '@hono/node-server'
import { config } from './config.js'
import { app } from './app.js'
import { makeShutdown, type Closable } from './shutdown.js'
import { initStore } from './store.js'
import { initKeys } from './keys.js'
import { initCatalogOverrides } from './catalog-overrides.js'
import { initCouncilOverrides } from './council-overrides.js'
import { initBanditStore } from './bandit.js'
import { initPricingDrift } from './pricing-drift.js'
import { initVisionModels } from './vision.js'
import { log } from './log.js'

// Store partagé (metering durable + registre de clés + overrides catalog/council) —
// no-op sans REDIS_URL, jamais bloquant pour le boot.
initStore()
initKeys()
initCatalogOverrides()
initCouncilOverrides()
// R-1 : état du bandit partagé entre pods (reprise au boot, refresh périodique) —
// no-op sans store, jamais bloquant.
initBanditStore()
// Référentiel vision (feed OpenRouter, rafraîchi 1 h) — fail-open : sans données le
// routage n'est pas filtré, jamais bloquant pour le boot.
initVisionModels()
// Dérive de prix table vs feed OpenRouter (même cache que vision, 1 h) — signal only.
initPricingDrift()

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info('listening', { port: info.port })
})

// OM-10: drain in-flight requests on SIGTERM/SIGINT before exiting.
const shutdown = makeShutdown(server as unknown as Closable, (code) => process.exit(code))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
