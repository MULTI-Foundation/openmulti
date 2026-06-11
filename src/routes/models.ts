// GET /v1/models — le catalogue servi, au format liste OpenAI (les SDKs standard
// peuvent itérer dessus), enrichi d'un bloc `openmulti` par modèle : tiers, purposes,
// et prix vérifié quand il existe dans la table de synthèse (chemins directs). Sur le
// chemin OpenRouter le coût réel arrive par réponse dans usage.cost — on n'affiche
// jamais un prix qu'on ne maîtrise pas (même règle que pricing.ts : pas de faux zéro).
//
// Les alias d'intention (`auto`, `auto:<tier>`) sont listés aussi : c'est l'interface
// recommandée, un client doit pouvoir les découvrir.

import { Hono } from 'hono'
import { catalogModels, DEFAULT_TIER } from '../catalog.js'
import { priceFor } from '../pricing.js'
import type { AppEnv, Tier } from '../types.js'

export const models = new Hono<AppEnv>()

const TIERS: Tier[] = ['economy', 'balanced', 'quality']

models.get('/v1/models', (c) => {
  const aliases = [
    { id: 'auto', object: 'model', owned_by: 'openmulti', openmulti: { alias: true, resolves_to_tier: DEFAULT_TIER } },
    ...TIERS.map((t) => ({
      id: `auto:${t}`,
      object: 'model',
      owned_by: 'openmulti',
      openmulti: { alias: true, resolves_to_tier: t },
    })),
  ]

  const concrete = catalogModels().map((e) => {
    const price = priceFor(e.model)
    return {
      id: e.model,
      object: 'model',
      owned_by: e.model.includes('/') ? e.model.slice(0, e.model.indexOf('/')) : 'unknown',
      openmulti: {
        tiers: e.tiers,
        purposes: e.purposes,
        pricing: price
          ? { input_per_mtok_usd: price.inputPerMTok, output_per_mtok_usd: price.outputPerMTok, source: 'direct' }
          : null,
      },
    }
  })

  return c.json({ object: 'list', data: [...aliases, ...concrete] })
})
