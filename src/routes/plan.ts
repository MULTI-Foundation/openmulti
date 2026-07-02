// POST /v1/plan — dry-run de routage : résout la décision (route + chemin d'accès)
// et calcule le devis maximum SANS appeler l'upstream. C'est la brique serveur
// d'EXPLAIN pour l'interprète MULTI (B1), et le futur support du prépaiement.
//
// Garanties :
//   - zéro effet de bord : pas d'appel provider, pas de metering, pas de dépense
//     locale — un appel plan est gratuit et peut être fait même plafond atteint
//     (un agent doit pouvoir consulter le coût avant de re-créditer) ;
//   - zéro fuite : la réponse ne dérive que de la requête de l'appelant, du catalogue
//     et de la table de prix (déjà exposés par GET /v1/models) ;
//   - la route vit sous /v1/* : auth par clé + rate limit s'appliquent (DoS borné).
//
// Le modèle retourné est CONCRET : un client qui veut que l'exécution honore ce devis
// épingle ce modèle (model ou openmulti.allow) à l'appel suivant — en mode smart, une
// nouvelle résolution pourrait élire un autre candidat.

import { Hono } from 'hono'
import { route } from '../router.js'
import { providerFor } from '../providers/index.js'
import { computeQuote } from '../plan.js'
import { marginFor } from '../keys.js'
import { keyLabel } from '../metrics.js'
import { config } from '../config.js'
import { log } from '../log.js'
import type { AppEnv, ChatRequest } from '../types.js'

export const plan = new Hono<AppEnv>()

plan.post('/v1/plan', async (c) => {
  const key = keyLabel(c.get('apiKey'))

  // OM-02 : même garde que chat.ts (Content-Length absent ou menteur).
  const raw = await c.req.text().catch(() => '')
  if (config.maxBodyBytes > 0 && Buffer.byteLength(raw) > config.maxBodyBytes) {
    return c.json({ error: { message: 'Request body too large', type: 'invalid_request_error' } }, 413)
  }
  let req: ChatRequest
  try {
    req = JSON.parse(raw) as ChatRequest
  } catch {
    return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400)
  }
  if (!Array.isArray(req.messages)) {
    return c.json({ error: { message: '`messages` is required', type: 'invalid_request_error' } }, 400)
  }
  // Le council fan-out N+1 appels : son coût ne se borne pas comme un appel simple.
  // Refus explicite plutôt qu'un devis faux.
  if (req.openmulti?.council || req.model === 'council') {
    return c.json({ error: { message: 'plan does not support council requests', type: 'invalid_request_error' } }, 400)
  }

  const decision = route(req)
  const provider = providerFor(decision.model)
  const marginFactor = 1 + marginFor(key) / 100
  const q = computeQuote(req, decision.model, decision.maxTokensCeiling, marginFactor)

  log.info('plan', {
    key, model: decision.model, provider: provider.name,
    maxCostUsd: q.quote?.max_cost_usd, unavailable: q.unavailable,
  })

  return c.json({
    object: 'plan',
    model: decision.model,
    provider: provider.name,
    reason: decision.reason,
    quote: q.quote,
    ...(q.unavailable ? { quote_unavailable: q.unavailable } : {}),
  })
})
