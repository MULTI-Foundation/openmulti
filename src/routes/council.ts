// GET /v1/council/presets — expose la composition des presets de council (panels par
// défaut budget/quality/flash + chairs) et la liste des modèles SÉLECTIONNABLES, pour
// que la console pré-remplisse l'éditeur de panel et propose un menu déroulant. Lecture
// produit (comme /v1/models) : auth par clé appelante. Rien de secret (ce sont des ids
// de modèle ; les clés/chemins d'accès restent internes).
//
// Les modèles sélectionnables = le catalogue OpenRouter COMPLET (≈300+, tout ce qui est
// adressable) ∪ les modèles tarifés ∪ ceux des presets/chairs (toujours choisissables).
// OpenRouter injoignable -> on retombe sur tarifés ∪ presets (fail-open).

import { Hono } from 'hono'
import { config } from '../config.js'
import { pricedModelIds } from '../pricing.js'
import { fetchModelIds } from '../openrouter-catalog.js'
import type { AppEnv } from '../types.js'

export const council = new Hono<AppEnv>()

council.get('/v1/council/presets', async (c) => {
  const presets = {
    flash: config.council.panelFlash,
    budget: config.council.panelBudget,
    quality: config.council.panelQuality,
  }
  const catalog = await fetchModelIds()
  const set = new Set<string>([...catalog, ...pricedModelIds()])
  for (const p of Object.values(presets)) for (const m of p) set.add(m)
  if (config.council.chair) set.add(config.council.chair)
  if (config.council.chairFlash) set.add(config.council.chairFlash)

  return c.json({
    defaultPreset: config.council.defaultPreset,
    presets,
    chair: config.council.chair,
    chairFlash: config.council.chairFlash,
    models: [...set].sort(),
  })
})
