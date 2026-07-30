// POST /v1/chat/completions - OpenAI-compatible, plus the openmulti extension.
//
// Flow: route (intention -> concrete model) -> steer -> forward upstream -> pipe back.
// Streaming pipes the upstream SSE untouched (so the caller's own usage parsing keeps
// working) and adds an inter-chunk watchdog. The route decision is surfaced via
// X-OpenMulti-* headers (stream) and the `openmulti` block (non-stream).

import { Hono } from 'hono'
import { route, RouteRefusal } from '../router.js'
import { pathsFor, type UpstreamCall } from '../providers/index.js'
import { backoff, normalizedUpstreamError } from '../providers/shared.js'
import { TIMEOUTS, config } from '../config.js'
import { log } from '../log.js'
import { recordRequest, recordRetry, recordPathFallback, keyLabel, type RequestRecord } from '../metrics.js'
import { markPathUnservable } from '../path-quarantine.js'
import { meterUsage } from '../meter.js'
import { checkSpendCap, checkBalance, noteLocalSpend, secondsToUtcMidnight, marginFor, signupGate, topupUrlFor, reserveSpend, isMetered } from '../keys.js'
import { SseUsageScanner, sseLineTransform, mutateSseUsageLine } from '../sse.js'
import { headerSafe } from '../sanitize.js'
import { runCouncil } from '../council.js'
import { computeCouncilQuote } from '../council-quote.js'
import { computeQuote } from '../plan.js'
import { PRICING_TABLE_VERSION } from '../pricing.js'
import { chatQuoteDigest, checkPinnedProgramStage, checkPinnedQuote, decodeQuoteToken, stripQuoteToken, type QuoteTokenClaims } from '../quote-token.js'
import { measureStageInput } from '../stage-input-guard.js'
import type { AppEnv, ChatRequest } from '../types.js'

export const chat = new Hono<AppEnv>()

chat.post('/v1/chat/completions', async (c) => {
  const startedAt = Date.now()
  const key = keyLabel(c.get('apiKey'))

  // B3 : posture des projets signup (anonymes) - fail-closed si le store est down
  // (503), 402 sans crédits en mode zéro-avance. Les clients à clé de confiance ne
  // passent jamais par cette gate (fail-open historique préservé).
  const topup = topupUrlFor(key)
  const topupHint = topup ? ` Top up: ${topup}` : ''
  const gate = signupGate(key)
  if (gate.blocked) {
    return c.json(
      { error: { message: gate.status === 402 ? `${gate.message}.${topupHint}` : gate.message, type: gate.status === 402 ? 'insufficient_credits' : 'service_unavailable' } },
      gate.status as 402 | 503,
    )
  }

  // Plafond de dépense journalier du projet (incrément C) : purement mémoire (zéro
  // I/O ici), fail-open sans plafond/donnée. 429 explicite, Retry-After = minuit UTC.
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
    log.warn('spend_cap_blocked', { key, capUsd: cap.capUsd, spentUsd: cap.spentUsd })
    return c.json(
      { error: { message: `Daily spend cap reached (${cap.spentUsd?.toFixed(4)}/${cap.capUsd} USD)`, type: 'spend_cap_exceeded' } },
      429,
      { 'Retry-After': String(secondsToUtcMidnight()) },
    )
  }

  // OM-02: bound body size. The Content-Length middleware (app.ts) rejects honest
  // oversized clients before buffering; this catches a missing/lying Content-Length.
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

  // E-1 (quote-pin) : un jeton de devis présenté fait du devis un CONTRAT d'exécution.
  // Décodé ICI (signature + expiration -> 422 structuré) ; le digest, la contrainte de
  // candidats et la borne recalculée sont vérifiés APRÈS le routage, AVANT tout appel
  // upstream (jamais un refus après dépense). Fail-closed : secret absent = refus.
  let pin: QuoteTokenClaims | undefined
  if (req.openmulti && req.openmulti.quote_token !== undefined) {
    const token = req.openmulti.quote_token
    if (typeof token !== 'string' || req.openmulti.council || req.model === 'council') {
      return c.json({ error: { message: 'openmulti.quote_token must be a string on a plain (non-council) chat request', type: 'invalid_quote_token', code: 'malformed' } }, 422)
    }
    if (!config.quoteToken.secret) {
      return c.json({ error: { message: 'quote tokens are not enabled on this gateway (OPENMULTI_QUOTE_TOKEN_SECRET unset)', type: 'invalid_quote_token', code: 'not_enabled' } }, 422)
    }
    const verdict = decodeQuoteToken(token, config.quoteToken.secret)
    if (!verdict.valid) {
      return c.json({ error: { message: `invalid quote token (${verdict.reason}) - request a fresh quote from /v1/plan`, type: 'invalid_quote_token', code: verdict.reason } }, 422)
    }
    pin = verdict.claims
  }

  // Council / fusion (mixture-of-agents) - opt-in, NON-STREAM (MVP). L'orchestrateur
  // fan-out le panel via le routing interne (chemins directs + bandit) puis synthétise ;
  // chaque sous-appel s'enregistre lui-même (bandit/metering/caps), le coût agrégé est
  // dans usage.cost. Le flux historique ci-dessous reste inchangé pour les appels normaux.
  if (req.openmulti?.council || req.model === 'council') {
    if (req.stream === true) {
      return c.json({ error: { message: 'streaming is not supported with council yet', type: 'invalid_request_error' } }, 400)
    }
    const councilMargin = 1 + marginFor(key) / 100
    // F6 : le council fan-out jusqu'à ~2N+1 appels payés sous UN seul snapshot
    // d'autorisation. On réserve le devis council COMPLET avant le fan-out et on re-vérifie
    // solde/plafond, de sorte qu'un council concurrent voie l'engagement en cours (plus de
    // N councils simultanés qui dépassent chacun). Libéré après runCouncil (chaque sous-appel
    // a enregistré son coût réel via forward.ts). Non métré ou devis indisponible (membre
    // non quotable) → pas de réservation, même dégradation gracieuse que le chat.
    let releaseCouncil: () => void = () => {}
    if (isMetered(key)) {
      const cq = computeCouncilQuote(req, councilMargin)
      const reserveUsd = 'error' in cq ? 0 : cq.quote?.max_cost_usd ?? 0
      if (reserveUsd > 0) {
        const bal = checkBalance(key)
        if (bal.blocked) {
          return c.json(
            { error: { message: `Insufficient credits (balance: ${bal.balanceUsd?.toFixed(4)} USD) - top up your account.${topupHint}`, type: 'insufficient_credits' } },
            402,
          )
        }
        const cp = checkSpendCap(key)
        if (cp.blocked) {
          log.warn('spend_cap_blocked', { key, capUsd: cp.capUsd, spentUsd: cp.spentUsd })
          return c.json(
            { error: { message: `Daily spend cap reached (${cp.spentUsd?.toFixed(4)}/${cp.capUsd} USD)`, type: 'spend_cap_exceeded' } },
            429,
            { 'Retry-After': String(secondsToUtcMidnight()) },
          )
        }
        releaseCouncil = reserveSpend(key, reserveUsd)
      }
    }
    try {
      const { status, body } = await runCouncil(req, { key, marginFactor: councilMargin })
      return c.json(body, status as 200)
    } finally {
      releaseCouncil()
    }
  }

  // E-1 : le routage sous contrat est CONTRAINT au snapshot de candidats du devis -
  // la sélection (default/smart) tourne normalement, DANS le snapshot (router.ts).
  // Un `model` nu inconnu/ambigu est refusé ICI en 400 (RouteRefusal, model-alias.ts),
  // jamais servi sur le tier par défaut en silence.
  let decision: ReturnType<typeof route>
  try {
    decision = route(req, pin?.candidates)
  } catch (e) {
    if (e instanceof RouteRefusal) {
      return c.json({ error: { message: e.message, type: 'invalid_request_error', code: e.code } }, e.status)
    }
    throw e
  }
  // Chemins d'accès ordonnés : l'élu d'abord, puis les alternatives de fallback
  // (même modèle - la réponse est préservée ; cf providers/index.ts pathsFor).
  const paths = pathsFor(decision.model)
  let provider = paths[0]!
  const isStream = req.stream === true

  // Marge du projet (modèle de revenus) : le client paie coût x marginFactor, via
  // usage.cost (réponse + chunk final du stream) et le metering facturable. Facteur 1
  // (marge 0) = passthrough byte-identique, donc le contrat MyMULTI tient par
  // construction. Le bandit, lui, reste sur le coût BRUT (costUsd).
  const marginFactor = 1 + marginFor(key) / 100

  // E-1 : le fond du contrat - digest, appartenance au snapshot, et borne RECALCULÉE
  // sous la table de prix et la marge COURANTES (jamais celles du jeton) : une dérive
  // prix/marge/routage qui ferait dépasser le montant quoté est un 409 structuré AVANT
  // toute dépense (la fenêtre TOCTOU devis->run est fermée ici).
  if (pin) {
    const exec = stripQuoteToken(req) // le jeton n'entre ni dans le digest ni dans la borne
    const q = computeQuote(exec, decision.model, decision.maxTokensCeiling, marginFactor)
    if (pin.kind === 'program') {
      // Exécution ÉTAGÉE : chaque étage rejoue le MÊME jeton avec openmulti.quote_stage.
      // E-8 (AX-CHAIN) : la garde pré-spend mesure l'entrée réelle de l'étage - tokenizer
      // du provider si un pont est configuré (mesure serrée), sinon repli borne OCTETS
      // conservateur (jamais optimiste ; cf stage-input-guard.ts).
      const realInput = await measureStageInput(exec, decision.model)
      const contract = checkPinnedProgramStage({
        claims: pin,
        stage: req.openmulti?.quote_stage,
        resolvedModel: decision.model,
        currentOutputMax: q.quote?.output_tokens_max,
        marginFactor,
        tableVersion: PRICING_TABLE_VERSION,
        realInput,
      })
      if (!contract.ok) {
        log.warn('quote_pin_rejected', { key, code: contract.code, model: decision.model, stage: String(req.openmulti?.quote_stage), realInputTokens: realInput.tokens, realInputMethod: realInput.method })
        const type = contract.status === 422 ? 'invalid_quote_token' : 'quote_conflict'
        return c.json({ error: { message: contract.message, type, code: contract.code } }, contract.status)
      }
    } else {
      const contract = checkPinnedQuote({
        claims: pin,
        digest: chatQuoteDigest(exec),
        resolvedModel: decision.model,
        currentBoundUsd: q.quote?.max_cost_usd,
        tableVersion: PRICING_TABLE_VERSION,
      })
      if (!contract.ok) {
        log.warn('quote_pin_rejected', { key, code: contract.code, model: decision.model })
        return c.json({ error: { message: contract.message, type: 'quote_conflict', code: contract.code } }, contract.status)
      }
    }
  }

  // Une observation = deux écritures : Prometheus (monitoring, in-memory) et le
  // metering durable (facturation, Redis, fire-and-forget - cf meter.ts). `provider`
  // est mutable : l'helper capture toujours le chemin courant/final.
  const record = (r: Omit<RequestRecord, 'key' | 'model' | 'provider'>) => {
    const rec: RequestRecord = { key, model: decision.model, provider: provider.name, ...r }
    // P0-6 : != null, pas truthiness - un coût légitime de 0 doit produire billedUsd=0
    // (facturé/métré), pas être escamoté comme absent.
    if (rec.costUsd != null) rec.billedUsd = rec.costUsd * marginFactor
    recordRequest(rec)
    meterUsage(rec)
    if (rec.billedUsd != null) noteLocalSpend(key, rec.billedUsd) // le plafond mord en dollars FACTURÉS
  }

  log.info('request', { key, model: decision.model, provider: provider.name, reason: decision.reason, stream: isStream, messages: req.messages.length })

  // Bounded retry on transient upstream failures, SAME model. We retry to ride out a
  // hiccup (connect error, 429/5xx); on the LAST retry of a path, if an alternate
  // access path exists (incrément D), the request fails over - still the same model,
  // so the answer is preserved (cross-MODEL fallback would change it: out of scope).
  // Retries/fallbacks only ever happen before any byte reaches the client, so they
  // are safe for both stream and non-stream.
  let call!: UpstreamCall
  let failedOver = false

  // Bascule sur le chemin suivant : l'échec du chemin courant est observé (bandit +
  // metering voient l'erreur, le chemin malade perd son élection) et compté.
  const failOver = (next: (typeof paths)[number], why: string | number) => {
    record({ error: true, durationMs: Date.now() - startedAt })
    recordPathFallback(decision.model, provider.name, next.name)
    log.warn('path_fallback', { key, model: decision.model, from: provider.name, to: next.name, why: String(why) })
    failedOver = true
  }

  // F2/F4/F10 : réservation de dépense. Pour un projet MÉTRÉ (plafond ou solde prépayé), on
  // réserve le coût MAX estimé (le devis, marge incluse) AVANT le dispatch, après une
  // re-vérif au plus près : la fenêtre check-then-act est fermée car (vérif + réservation)
  // est atomique — aucun await ne les sépare du premier provider.call. La mienne n'est posée
  // qu'APRÈS la vérif, donc une requête solitaire passe (comportement historique), mais N
  // requêtes concurrentes voient chacune les réservations des précédentes. Non métré (clé de
  // confiance : MyMULTI, dev) → aucune réservation, fail-open préservé. Devis indisponible
  // (image, prix par palier/thinking) → pas de réservation : la race subsiste pour cette
  // classe étroite, jamais un blocage optimiste d'un coût non bornable.
  let releaseReservation: () => void = () => {}
  if (isMetered(key)) {
    const q = computeQuote(pin ? stripQuoteToken(req) : req, decision.model, decision.maxTokensCeiling, marginFactor)
    const reserveUsd = q.quote?.max_cost_usd ?? 0
    if (reserveUsd > 0) {
      const bal = checkBalance(key)
      if (bal.blocked) {
        return c.json(
          { error: { message: `Insufficient credits (balance: ${bal.balanceUsd?.toFixed(4)} USD) - top up your account.${topupHint}`, type: 'insufficient_credits' } },
          402,
        )
      }
      const cp = checkSpendCap(key)
      if (cp.blocked) {
        log.warn('spend_cap_blocked', { key, capUsd: cp.capUsd, spentUsd: cp.spentUsd })
        return c.json(
          { error: { message: `Daily spend cap reached (${cp.spentUsd?.toFixed(4)}/${cp.capUsd} USD)`, type: 'spend_cap_exceeded' } },
          429,
          { 'Retry-After': String(secondsToUtcMidnight()) },
        )
      }
      releaseReservation = reserveSpend(key, reserveUsd)
    }
  }

  // Observation TERMINALE : enregistre puis libère la réservation en vol (le coût réel vient
  // de remplacer l'estimation). failOver garde record() sans libérer — observation NON
  // terminale, la requête continue sur le chemin suivant et la réservation doit tenir.
  const settle = (r: Omit<RequestRecord, 'key' | 'model' | 'provider'>) => {
    record(r)
    releaseReservation()
  }

  pathLoop: for (let p = 0; p < paths.length; p++) {
    provider = paths[p]!
    const next = paths[p + 1]
    const body = provider.buildBody(req, decision.model, decision.maxTokensCeiling)
    let attempt = 0
    while (true) {
      try {
        call = await provider.call(body)
      } catch (e) {
        const reason = e instanceof Error && e.name === 'AbortError' ? 'upstream connect timeout' : 'upstream unreachable'
        // P0-11 : sous contrat (jeton de devis présenté), AU PLUS UN dispatch upstream.
        // Un échec transport APRÈS envoi (timeout, reset en cours de lecture) peut déjà
        // avoir été facturé côté provider ; un retry ou un failover re-facturerait le
        // même étage et pourrait dépasser le montant signé - le devis ne couvre chaque
        // étage qu'UNE fois. Direction sûre : refus structuré, zéro re-dispatch ;
        // l'appelant relance s'il le veut (nouvelle exécution, nouveau paiement).
        if (pin) {
          log.error('upstream_error_contract_no_retry', { key, model: decision.model, provider: provider.name, reason, durationMs: Date.now() - startedAt })
          settle({ error: true, durationMs: Date.now() - startedAt })
          return c.json({ error: { message: `${reason} - no retry under a quote contract: a re-dispatched stage could be billed twice and exceed the signed amount; re-quote and resubmit`, type: 'upstream_error', code: 'contract_no_retry' } }, 504)
        }
        if (attempt < config.maxRetries) {
          attempt++
          recordRetry(key, decision.model, provider.name)
          log.warn('upstream_retry', { key, model: decision.model, provider: provider.name, attempt, reason })
          await backoff(attempt)
          continue
        }
        if (next) {
          failOver(next, reason)
          continue pathLoop
        }
        log.error('upstream_error', { key, model: decision.model, reason, attempts: attempt + 1, durationMs: Date.now() - startedAt })
        settle({ error: true, durationMs: Date.now() - startedAt })
        return c.json({ error: { message: reason, type: 'upstream_error' } }, 504)
      }

      if (!call.response.ok && provider.isRetryable(call.response.status)) {
        // P0-11 : même règle sous contrat pour un statut transitoire REÇU (429/5xx) -
        // pas de retry ni de failover ; l'erreur upstream normalisée (OM-07) est
        // renvoyée telle quelle, statut conservé. Un seul dispatch a eu lieu.
        if (pin) break pathLoop
        if (attempt < config.maxRetries) {
          attempt++
          const retryAfter = call.response.headers.get('retry-after')
          await call.response.body?.cancel().catch(() => {}) // drain the failed body
          recordRetry(key, decision.model, provider.name)
          log.warn('upstream_retry', { key, model: decision.model, provider: provider.name, attempt, status: call.response.status })
          await backoff(attempt, retryAfter)
          continue
        }
        if (next) {
          await call.response.body?.cancel().catch(() => {})
          failOver(next, call.response.status)
          continue pathLoop
        }
      }
      // Un 4xx NON-retryable est déterministe POUR CE CHEMIN, pas forcément pour
      // l'autre : les API natives ont des exigences de forme propres qu'OpenRouter
      // normalise (vécu prod 2026-07-17 : DeepSeek V4 thinking exige le round-trip de
      // reasoning_content -> 400 ; Z.ai refuse les content parts ; Qwen 403 quota).
      // Une seule bascule, jamais de retry same-path (même corps -> même refus), et
      // pas sous contrat (P0-11 : au plus un dispatch). Si l'autre chemin refuse
      // aussi, son erreur est renvoyée normalement (la requête était en cause).
      if (!call.response.ok && call.response.status < 500 && !provider.isRetryable(call.response.status) && next && !pin) {
        const detail = await call.response.text().catch(() => '')
        // 401/403/404 = le CHEMIN est en cause (clé, quota, modèle absent du vendor) :
        // quarantaine de la paire pour que l'élection cesse de payer l'aller-retour perdu.
        markPathUnservable(provider.name, decision.model, call.response.status)
        failOver(next, `${call.response.status} ${detail.slice(0, 300)}`)
        continue pathLoop
      }
      break pathLoop
    }
  }

  // Trace le chemin d'accès quand il n'est pas celui par défaut, ou qu'un fallback a
  // eu lieu (reason = texte libre de l'extension ; le chemin OpenRouter nominal reste
  // byte-identique à l'historique).
  if (provider.name !== 'openrouter' || failedOver) {
    decision.reason = `${decision.reason}, via ${provider.name}${failedOver ? ` (fallback from ${paths[0]!.name})` : ''}`
  }

  const upstream = call.response
  if (!upstream.ok) {
    // Refus terminal d'identité de chemin (dernier chemin, contrat P0-11 ou fallback
    // coupé) : même quarantaine — le filtre de statut vit dans markPathUnservable.
    if (upstream.status < 500 && !provider.isRetryable(upstream.status)) {
      markPathUnservable(provider.name, decision.model, upstream.status)
    }
    // OM-07 : le corps d'erreur upstream n'est jamais relayé (divulgation provider/
    // routing/internals) - détail loggé côté serveur, schéma stable côté appelant,
    // statut conservé.
    const text = await upstream.text().catch(() => '')
    log.warn('upstream_not_ok', {
      key, model: decision.model, provider: provider.name, status: upstream.status, failedOver,
      upstreamBody: text.slice(0, 500), durationMs: Date.now() - startedAt,
    })
    settle({ error: true, durationMs: Date.now() - startedAt })
    return c.json(normalizedUpstreamError(upstream.status), upstream.status as 400)
  }

  // ── Streaming: pipe through + inter-chunk watchdog ─────────────────────────
  // Passthrough byte-à-byte sur le chemin OpenRouter (pas d'adaptStream) ; un provider
  // direct peut adapter le flux (injection du usage.cost synthétisé - le contrat
  // « le caller parse son usage dans le dernier chunk » vaut aussi en stream).
  if (isStream && upstream.body) {
    let upstreamBody = provider.adaptStream
      ? provider.adaptStream(upstream.body, decision.model)
      : upstream.body
    // Marge : le chunk usage final est réécrit (cost x facteur) APRÈS l'adaptation
    // provider (qui a pu injecter le coût brut). Facteur 1 : aucun transform, le flux
    // reste un passthrough byte-à-byte.
    if (marginFactor > 1) {
      upstreamBody = sseLineTransform(upstreamBody, (line) =>
        mutateSseUsageLine(line, (usage) => {
          if (typeof usage.cost !== 'number') return false
          usage.cost = usage.cost * marginFactor
          return true
        }),
      )
    }
    const reader = upstreamBody.getReader()
    const decoder = new TextDecoder()
    const scanner = new SseUsageScanner()
    let lastChunkAt = Date.now()
    let stalled = false
    // P0-7 : garantit UNE observation au plus, quelle que soit la sortie (fin upstream
    // ou cancel client) - l'ancien code n'enregistrait RIEN sur cancel, trou dans le
    // signal bandit/metering.
    let observed = false

    const watchdog = setInterval(() => {
      if (Date.now() - lastChunkAt > TIMEOUTS.interChunk) {
        stalled = true
        log.warn('upstream_stalled', { key, model: decision.model, provider: scanner.provider })
        call.abort.abort()
        clearInterval(watchdog)
      }
    }, 10_000)

    const stream = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
        lastChunkAt = Date.now()
        if (done) {
          clearInterval(watchdog)
          controller.close()
          // P0-8 : un stream tronqué mi-vol (scanner.errored via finish_reason 'error'
          // ou objet error) est une ERREUR pour le bandit, pas une fin normale.
          const errored = stalled || scanner.errored
          log.info('completed', {
            key, model: decision.model, provider: scanner.provider, stream: true, stalled, errored: scanner.errored,
            promptTokens: scanner.usage?.prompt_tokens, completionTokens: scanner.usage?.completion_tokens,
            cost: scanner.usage?.cost, durationMs: Date.now() - startedAt,
          })
          if (!observed) {
            observed = true
            settle({
              error: errored,
              promptTokens: scanner.usage?.prompt_tokens, completionTokens: scanner.usage?.completion_tokens,
              // le scanner lit le flux APRÈS la marge : on retrouve le coût brut
              costUsd: scanner.usage?.cost !== undefined ? scanner.usage.cost / marginFactor : undefined,
              durationMs: Date.now() - startedAt,
            })
          }
          return
        }
        controller.enqueue(value) // raw bytes to the client, untouched
        scanner.push(decoder.decode(value, { stream: true })) // side-channel: cost/provider
      },
      cancel(reason) {
        // Client disconnected (or the response was aborted downstream): stop the
        // watchdog and tear down the upstream call so we don't leak the timer or
        // the upstream connection.
        clearInterval(watchdog)
        call.abort.abort()
        reader.cancel(reason).catch(() => {})
        // P0-7 : enregistrer l'observation PARTIELLE (usage scanné jusqu'ici) - sinon
        // un cancel client laisse la requête invisible au bandit/metering. error:false :
        // un désabonnement client n'est pas une panne du modèle. Le champ `aborted` du
        // log distingue ce cas d'une fin normale (pas de champ RequestRecord dédié en
        // v0 - décision E-4/decision-log ultérieure).
        if (!observed) {
          observed = true
          log.info('completed', {
            key, model: decision.model, provider: scanner.provider, stream: true, aborted: true,
            promptTokens: scanner.usage?.prompt_tokens, completionTokens: scanner.usage?.completion_tokens,
            cost: scanner.usage?.cost, durationMs: Date.now() - startedAt,
          })
          settle({
            promptTokens: scanner.usage?.prompt_tokens, completionTokens: scanner.usage?.completion_tokens,
            costUsd: scanner.usage?.cost !== undefined ? scanner.usage.cost / marginFactor : undefined,
            durationMs: Date.now() - startedAt,
          })
        }
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-OpenMulti-Model': headerSafe(decision.model),
        'X-OpenMulti-Reason': headerSafe(decision.reason),
      },
    })
  }

  // ── Non-stream: parse, normalize (identity on the OpenRouter path), attach the
  // route decision, return ─────────────────────────────────────────────────────
  // F2/F4/F10 : un corps upstream malformé (json() jette) ne doit pas fuiter la réservation
  // en vol — on la libère avant de laisser l'exception remonter (comportement 500 inchangé).
  let upstreamJson: Record<string, unknown>
  try {
    upstreamJson = (await upstream.json()) as Record<string, unknown>
  } catch (e) {
    releaseReservation()
    throw e
  }
  let data = provider.normalizeResponse(upstreamJson, decision.model)
  const rawU = data.usage as { prompt_tokens: number; completion_tokens: number; cost?: number } | undefined
  // Marge : le client voit SON prix dans usage.cost (facteur 1 = objet intact).
  if (marginFactor > 1 && rawU && typeof rawU.cost === 'number') {
    data = { ...data, usage: { ...rawU, cost: rawU.cost * marginFactor } }
  }
  const u = rawU
  log.info('completed', {
    key, model: decision.model, provider: provider.name, stream: false,
    promptTokens: u?.prompt_tokens, completionTokens: u?.completion_tokens,
    cost: u?.cost, durationMs: Date.now() - startedAt,
  })
  settle({
    promptTokens: u?.prompt_tokens, completionTokens: u?.completion_tokens,
    costUsd: u?.cost, durationMs: Date.now() - startedAt,
  })
  // Only echo the routing decision when the caller opted into the extension.
  // Without it, the response stays byte-identical to the upstream provider, so a
  // plain OpenAI client (e.g. an agent proxied through us) sees no extra field.
  if (req.openmulti) {
    return c.json({ ...data, openmulti: { reason: decision.reason } })
  }
  return c.json(data)
})
