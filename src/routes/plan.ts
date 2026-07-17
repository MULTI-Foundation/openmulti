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
import { route, RouteRefusal } from '../router.js'
import { providerFor } from '../providers/index.js'
import { computeQuote } from '../plan.js'
import { computeProgramQuote, validateProgram } from '../program-quote.js'
import { computeCouncilQuote } from '../council-quote.js'
import { chatQuoteDigest, issueQuoteToken, programQuoteDigest } from '../quote-token.js'
import { PRICING_TABLE_VERSION } from '../pricing.js'
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
  // WS2 : devis PROGRAMME — un AST MULTI complet (openmulti.program, forme gelée §3.6)
  // est quoté en bloc, étage par étage, avec le pliage cap-de-sortie -> borne-d'entrée
  // (program-quote.ts). Pas de `messages` ici, le programme EST la requête.
  if (req.openmulti?.program !== undefined) {
    const stdinRaw = req.openmulti.stdin_bytes
    if (stdinRaw !== undefined && !(typeof stdinRaw === 'number' && Number.isInteger(stdinRaw) && stdinRaw >= 0)) {
      return c.json({ error: { message: 'openmulti.stdin_bytes must be a non-negative integer', type: 'invalid_request_error' } }, 400)
    }
    const stdinBytes: number | undefined = stdinRaw
    const validated = validateProgram(req.openmulti.program)
    if ('error' in validated) {
      return c.json({ error: { message: validated.error, type: 'invalid_request_error' } }, 400)
    }
    const maxTokens = typeof req.max_tokens === 'number' && Number.isInteger(req.max_tokens) && req.max_tokens > 0
      ? req.max_tokens
      : undefined
    const marginFactor = 1 + marginFor(key) / 100
    const pq = computeProgramQuote(validated.program, {
      marginFactor,
      ...(stdinBytes !== undefined ? { stdinBytes } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    })
    // Slot inconnu / AST difforme = erreur de VALIDATION (400), jamais un devis muet.
    if ('error' in pq) {
      return c.json({ error: { message: pq.error, type: 'invalid_request_error' } }, 400)
    }
    const stageCount = validated.program.statements.reduce((a, s) => a + s.stages.length, 0)
    const reason = `program: ${validated.program.statements.length} statement(s), ${stageCount} stage(s)`
    // Un seul étage non quotable = refus du programme ENTIER, avec l'index fautif.
    if ('refused' in pq) {
      log.info('plan', { key, model: 'program', provider: 'program', unavailable: pq.refused.reason, stage: `${pq.refused.statement}.${pq.refused.stage}` })
      return c.json({
        object: 'plan', model: 'program', provider: 'program', reason,
        quote: null, quote_unavailable: pq.refused.reason,
        refused_stage: pq.refused,
      })
    }
    // E-1 : jeton signé seulement si le devis est GARANTI — un contrat de paiement sur
    // une borne non garantie (stdin non borné) pourrait être dépassé à l'exécution.
    let quoteToken: string | undefined
    if (config.quoteToken.secret && pq.guaranteed) {
      quoteToken = issueQuoteToken({
        kind: 'program',
        digest: programQuoteDigest(validated.program, stdinBytes, maxTokens),
        candidates: pq.candidates,
        caps: pq.stages.map((s) => s.output_tokens_max),
        // E-8 : les bornes d'entrée ι_i sous lesquelles le pliage a quoté chaque étage —
        // le matériau de la garde pré-spend AX-CHAIN (stage-input-guard.ts, tranche E-8).
        inputs: pq.stages.map((s) => s.input_tokens_max),
        margin: marginFactor,
        table: PRICING_TABLE_VERSION,
        usd: pq.quote.max_cost_usd,
        ttlMs: config.quoteToken.ttlS * 1000,
      }, config.quoteToken.secret)
    }
    log.info('plan', { key, model: 'program', provider: 'program', maxCostUsd: pq.quote.max_cost_usd, stages: stageCount, guaranteed: pq.guaranteed })
    return c.json({
      object: 'plan', model: 'program', provider: 'program', reason,
      stages: pq.stages,
      quote: pq.quote,
      guaranteed: pq.guaranteed,
      ...(quoteToken ? { quote_token: quoteToken } : {}),
    })
  }

  if (!Array.isArray(req.messages)) {
    return c.json({ error: { message: '`messages` is required', type: 'invalid_request_error' } }, 400)
  }
  // Council (E-5) : devis agrégé = Σ des bornes des N+1 (fuse) / 2N+1 (deliberate)
  // sous-appels, dérivées du panel/chair résolus et des caps de sortie par appel.
  if (req.openmulti?.council || req.model === 'council') {
    const marginFactor = 1 + marginFor(key) / 100
    const cq = computeCouncilQuote(req, marginFactor)
    if ('error' in cq) {
      return c.json({ error: { message: cq.error, type: 'invalid_request_error' } }, 400)
    }
    log.info('plan', { key, model: 'council', provider: 'council', maxCostUsd: cq.quote?.max_cost_usd, unavailable: cq.unavailable })
    return c.json({
      object: 'plan',
      model: 'council',
      provider: 'council',
      reason: cq.reason,
      quote: cq.quote,
      ...(cq.unavailable ? { quote_unavailable: cq.unavailable } : {}),
      council: { mode: cq.mode, panel: cq.panel, chair: cq.chair, calls: cq.calls },
    })
  }

  // Même refus qu'à l'exécution (chat.ts) : un devis sur un nom nu inconnu/ambigu
  // serait un devis pour le MAUVAIS modèle — 400 explicite, cohérent avec le run.
  let decision: ReturnType<typeof route>
  try {
    decision = route(req)
  } catch (e) {
    if (e instanceof RouteRefusal) {
      return c.json({ error: { message: e.message, type: 'invalid_request_error', code: e.code } }, e.status)
    }
    throw e
  }
  const provider = providerFor(decision.model)
  const marginFactor = 1 + marginFor(key) / 100
  const q = computeQuote(req, decision.model, decision.maxTokensCeiling, marginFactor)

  log.info('plan', {
    key, model: decision.model, provider: provider.name,
    maxCostUsd: q.quote?.max_cost_usd, unavailable: q.unavailable,
  })

  // E-1 (quote-pin) : jeton de devis signé — rejoué à l'exécution, il fait du devis un
  // CONTRAT (digest, snapshot de candidats, borne revérifiée sous la table courante).
  // Pas de secret configuré = pas de jeton (refus d'émission, jamais un HMAC sur '').
  let quoteToken: string | undefined
  if (config.quoteToken.secret && q.quote) {
    quoteToken = issueQuoteToken({
      kind: 'chat',
      digest: chatQuoteDigest(req),
      // Le pin est le SNAPSHOT DE CANDIDATS résolu au devis, jamais le seul modèle élu :
      // la sélection smart garde sa liberté DANS le snapshot.
      candidates: decision.candidates ?? [decision.model],
      caps: [q.quote.output_tokens_max],
      margin: marginFactor,
      table: PRICING_TABLE_VERSION,
      usd: q.quote.max_cost_usd,
      ttlMs: config.quoteToken.ttlS * 1000,
    }, config.quoteToken.secret)
  }

  return c.json({
    object: 'plan',
    model: decision.model,
    provider: provider.name,
    reason: decision.reason,
    quote: q.quote,
    ...(q.unavailable ? { quote_unavailable: q.unavailable } : {}),
    ...(quoteToken ? { quote_token: quoteToken } : {}),
  })
})
