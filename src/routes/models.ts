// GET /v1/models — le catalogue servi, au format liste OpenAI (les SDKs standard
// peuvent itérer dessus), enrichi d'un bloc `openmulti` par modèle : tiers, purposes,
// et prix vérifié quand il existe dans la table de synthèse (chemins directs). Sur le
// chemin OpenRouter le coût réel arrive par réponse dans usage.cost — on n'affiche
// jamais un prix qu'on ne maîtrise pas (même règle que pricing.ts : pas de faux zéro).
//
// Les alias d'intention (`auto`, `auto:<tier>`) sont listés aussi : c'est l'interface
// recommandée, un client doit pouvoir les découvrir.
//
// `?all=1` (opt-in) ajoute l'inventaire complet réellement adressable — catalogue
// OpenRouter (caché 1 h, fail-open) ∪ modèles tarifés — après les entrées curées.
// Ces entrées d'inventaire portent tiers/purposes vides (elles ne sont candidates
// d'aucun slot) ; un id concret reste appelable qu'il soit listé ou non.

import { Hono } from 'hono'
import { catalogModels, DEFAULT_TIER } from '../catalog.js'
import { fetchModelIds } from '../openrouter-catalog.js'
import { priceFor, pricedModelIds } from '../pricing.js'
import type { AppEnv, Tier } from '../types.js'

export const models = new Hono<AppEnv>()

const TIERS: Tier[] = ['economy', 'balanced', 'quality']

function vendorOf(model: string): string {
  return model.includes('/') ? model.slice(0, model.indexOf('/')) : 'unknown'
}

models.get('/v1/models', async (c) => {
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
      owned_by: vendorOf(e.model),
      openmulti: {
        tiers: e.tiers,
        purposes: e.purposes,
        pricing: price
          ? { input_per_mtok_usd: price.inputPerMTok, output_per_mtok_usd: price.outputPerMTok, source: 'direct' }
          : null,
      },
    }
  })

  // Opt-in : la liste par défaut reste la vitrine curée, à l'identique.
  const all = c.req.query('all')
  if (all !== '1' && all !== 'true') {
    return c.json({ object: 'list', data: [...aliases, ...concrete] })
  }

  const curated = new Set(concrete.map((m) => m.id))
  const inventory = [...new Set([...(await fetchModelIds()), ...pricedModelIds()])]
    .filter((id) => !curated.has(id))
    .sort()
    .map((id) => {
      const price = priceFor(id)
      return {
        id,
        object: 'model',
        owned_by: vendorOf(id),
        openmulti: {
          tiers: [] as Tier[],
          purposes: [] as string[],
          pricing: price
            ? { input_per_mtok_usd: price.inputPerMTok, output_per_mtok_usd: price.outputPerMTok, source: 'direct' }
            : null,
        },
      }
    })

  return c.json({ object: 'list', data: [...aliases, ...concrete, ...inventory] })
})
