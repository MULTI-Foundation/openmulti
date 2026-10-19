// POST /v1/images - pass-through vers l'endpoint images d'OpenRouter (/api/v1/images,
// verifie le 2026-10-19). Depuis l'automne 2026 la plupart des modeles d'image
// (GPT Image, FLUX, Qwen, Seedream, Recraft...) refusent /chat/completions et ne
// sont servis que la ; les Gemini image y sont aussi. Memes regles que /v1/embeddings :
//   - model:'auto' -> premier modele du slot image (catalog), id concret honore tel quel ;
//   - le bloc `openmulti` est strippe avant le forward, reponse byte-identique sans extension ;
//   - retry borne same-model sur panne transitoire ; plafond de depense projet applique ;
//   - usage/cout enregistres (Prometheus + metering durable).
// Difference : la generation peut durer plus d'une minute avant le premier octet
// (Seedream Pro, Qwen Image 3), d'ou un delai d'attente de 240 s au lieu de 30 s.

import { Hono } from 'hono'
import { config } from '../config.js'
import { imageCandidates } from '../catalog.js'
import { isRetryableStatus, backoff, pickAllowedFields, normalizedUpstreamError, ALLOWED_IMAGES_FIELDS } from '../providers/shared.js'
import { log } from '../log.js'
import { recordRequest, recordRetry, keyLabel, type RequestRecord } from '../metrics.js'
import { meterUsage } from '../meter.js'
import { checkSpendCap, checkBalance, noteLocalSpend, secondsToUtcMidnight, marginFor, signupGate, topupUrlFor } from '../keys.js'
import type { AppEnv } from '../types.js'

export const images = new Hono<AppEnv>()

/** Delai max avant les en-tetes de reponse upstream (la generation est synchrone). */
const IMAGE_UPSTREAM_TIMEOUT_MS = 240_000

images.post('/v1/images', async (c) => {
  const startedAt = Date.now()
  const key = keyLabel(c.get('apiKey'))

  // B3 : posture des projets signup (anonymes) - même gate que chat.ts.
  const topup = topupUrlFor(key)
  const topupHint = topup ? ` Top up: ${topup}` : ''
  const gate = signupGate(key)
  if (gate.blocked) {
    return c.json(
      { error: { message: gate.status === 402 ? `${gate.message}.${topupHint}` : gate.message, type: gate.status === 402 ? 'insufficient_credits' : 'service_unavailable' } },
      gate.status as 402 | 503,
    )
  }

  // Solde prépayé (console) : épuisé -> 402, le client doit re-créditer.
  const balance = checkBalance(key)
  if (balance.blocked) {
    return c.json(
      { error: { message: `Insufficient credits (balance: ${balance.balanceUsd?.toFixed(4)} USD) - top up your account.${topupHint}`, type: 'insufficient_credits' } },
      402,
    )
  }
  const cap = checkSpendCap(key)
  if (cap.blocked) {
    return c.json(
      { error: { message: `Daily spend cap reached (${cap.spentUsd?.toFixed(4)}/${cap.capUsd} USD)`, type: 'spend_cap_exceeded' } },
      429,
      { 'Retry-After': String(secondsToUtcMidnight()) },
    )
  }

  // P0-5 : on RE-MESURE le body bufferisé (comme chat.ts:63-66). Le middleware
  // Content-Length (app.ts) rejette les clients honnêtes trop gros avant buffering ;
  // ceci attrape un Content-Length absent/menteur (sinon la limite est contournée).
  const raw = await c.req.text().catch(() => '')
  if (config.maxBodyBytes > 0 && Buffer.byteLength(raw) > config.maxBodyBytes) {
    return c.json({ error: { message: 'Request body too large', type: 'invalid_request_error' } }, 413)
  }
  let req: Record<string, unknown>
  try {
    req = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400)
  }
  if (typeof req.prompt !== 'string' || !req.prompt.trim()) {
    return c.json({ error: { message: '`prompt` is required', type: 'invalid_request_error' } }, 400)
  }

  const openmulti = req.openmulti
  // OM-06 : seuls les champs images connus passent ; openmulti strippe comme partout.
  const rest = pickAllowedFields(req, ALLOWED_IMAGES_FIELDS)
  const model = typeof rest.model === 'string' && rest.model !== 'auto' ? rest.model : imageCandidates()[0]!
  const body = { ...rest, model }

  const marginFactor = 1 + marginFor(key) / 100
  const record = (r: Omit<RequestRecord, 'key' | 'model' | 'provider'>) => {
    const rec: RequestRecord = { key, model, provider: 'openrouter', ...r }
    // P0-6 : != null, pas truthiness - un coût légitime de 0 doit produire billedUsd=0
    // (facturé/compté), pas être escamoté comme absent.
    if (rec.costUsd != null) rec.billedUsd = rec.costUsd * marginFactor
    recordRequest(rec)
    meterUsage(rec)
    if (rec.billedUsd != null) noteLocalSpend(key, rec.billedUsd)
  }

  log.info('images_request', { key, model })

  let upstream!: Response
  let attempt = 0
  while (true) {
    const abort = new AbortController()
    const connectTimer = setTimeout(() => abort.abort(), IMAGE_UPSTREAM_TIMEOUT_MS)
    try {
      upstream = await fetch(`${config.openrouter.baseUrl}/images`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openrouter.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': config.referer,
          'X-Title': config.title,
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      })
    } catch (e) {
      clearTimeout(connectTimer)
      const reason = e instanceof Error && e.name === 'AbortError' ? 'upstream connect timeout' : 'upstream unreachable'
      if (attempt < config.maxRetries) {
        attempt++
        recordRetry(key, model)
        await backoff(attempt)
        continue
      }
      record({ error: true, durationMs: Date.now() - startedAt })
      return c.json({ error: { message: reason, type: 'upstream_error' } }, 504)
    }
    clearTimeout(connectTimer)

    if (!upstream.ok && isRetryableStatus(upstream.status) && attempt < config.maxRetries) {
      attempt++
      const retryAfter = upstream.headers.get('retry-after')
      await upstream.body?.cancel().catch(() => {})
      recordRetry(key, model)
      await backoff(attempt, retryAfter)
      continue
    }
    break
  }

  if (!upstream.ok) {
    // OM-07 : détail loggé serveur, schéma stable côté appelant, statut conservé.
    const text = await upstream.text().catch(() => '')
    log.warn('images_upstream_not_ok', { key, model, status: upstream.status, upstreamBody: text.slice(0, 500) })
    record({ error: true, durationMs: Date.now() - startedAt })
    return c.json(normalizedUpstreamError(upstream.status), upstream.status as 400)
  }

  let data = (await upstream.json()) as Record<string, unknown>
  const u = data.usage as { prompt_tokens?: number; completion_tokens?: number; cost?: number } | undefined
  // Marge : le client voit son prix (facteur 1 = objet intact, byte-identique).
  if (marginFactor > 1 && u && typeof u.cost === 'number') {
    data = { ...data, usage: { ...u, cost: u.cost * marginFactor } }
  }
  log.info('images_completed', { key, model, cost: u?.cost, durationMs: Date.now() - startedAt })
  record({ promptTokens: u?.prompt_tokens, completionTokens: u?.completion_tokens, costUsd: u?.cost, durationMs: Date.now() - startedAt })

  // Même règle de contrat que le chat : sans extension, réponse byte-identique.
  if (openmulti) {
    return c.json({ ...data, openmulti: { reason: rest.model === model ? 'caller pinned a concrete model' : 'default image model' } })
  }
  return c.json(data)
})
