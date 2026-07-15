// Gate x402 (B4, câblage) — le rail de paiement par requête pour les agents anonymes
// à wallet. Montée AVANT l'auth sur /v1/* : elle n'agit QUE si x402 est activé ET que
// la requête n'a pas d'Authorization (les clients à clé ne la voient jamais) ET que la
// route est la surface payante (POST /v1/chat/completions). Partout ailleurs :
// passe-plat strict, zéro changement de comportement.
//
// Flux :
//   1. Sans X-PAYMENT : devis EXPLAIN de CETTE requête (mêmes briques que /v1/plan)
//      -> 402 x402 v1 (montant max = devis, payTo = le multisig, devis lié en extra).
//      Devis impossible (pas de borne de sortie) -> 402 explicatif SANS accepts :
//      l'agent pose max_tokens et retente (jamais un montant inventé).
//   2. Avec X-PAYMENT : décode (borné) -> couverture (montant signé >= devis, via le
//      jeton lié si présenté, sinon devis recalculé) -> anti-rejeu (nonce consommé
//      AVANT tout règlement) -> verify PUIS settle via le seam facilitateur
//      (fail-closed : tout doute = refus, nonce relâché si le règlement échoue) ->
//      crédit du projet wallet (xw-<hash payeur>, ref = tx hash : l'idempotence Lua
//      du ledger couvre aussi ce rail) -> exécution de la requête COMME ce projet
//      (metering/marge/solde existants s'appliquent tels quels) -> reçu de règlement
//      en en-tête X-PAYMENT-RESPONSE.
//
// L'argent est encaissé AVANT de dépenser un token upstream (settle-then-serve) ; le
// trop-perçu (devis - coût réel facturé) reste en solde du projet wallet — visible
// via GET /v1/balance, réutilisable par le rail Stripe/console comme par x402.

import { createHash } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { config } from './config.js'
import { route } from './router.js'
import { computeQuote } from './plan.js'
import { PRICING_TABLE_VERSION } from './pricing.js'
import { chatQuoteDigest, checkPinnedQuote, decodeQuoteToken, stripQuoteToken } from './quote-token.js'
import { addCredits } from './keys.js'
import { microToUsd } from './micro-usd.js'
import { log } from './log.js'
import {
  KNOWN_NETWORKS, claimNonce, mintQuoteToken, paymentRequired, releaseNonce, usdToAtomic, verifyQuoteToken,
  type X402Network,
} from './x402.js'
import { crossVerifyFacilitator, httpFacilitator, type Facilitator } from './x402-facilitator.js'
import { cdpFacilitator } from './x402-cdp.js'
import type { AppEnv, ChatRequest } from './types.js'

export const WALLET_PROJECT_PREFIX = 'xw-'
const MAX_PAYMENT_HEADER_BYTES = 8192
const PAID_SURFACE = '/v1/chat/completions'

// ── Seam facilitateur (résolu au premier usage ; injectable pour les tests) ───────
let facilitator: Facilitator | null = null

function activeFacilitator(): Facilitator {
  if (!facilitator) {
    // Primaire = CDP (règlement Base à gas sponsorisé) dès que les creds sont présents ;
    // sinon facilitatorUrl générique (testnet public, etc.).
    const useCdp = config.x402.cdpApiKeyId && config.x402.cdpApiKeySecret
    const primary = useCdp
      ? cdpFacilitator(config.x402.cdpApiKeyId, config.x402.cdpApiKeySecret, {
          verifyTimeoutMs: config.x402.verifyTimeoutMs,
          settleTimeoutMs: config.x402.settleTimeoutMs,
        })
      : httpFacilitator({
          baseUrl: config.x402.facilitatorUrl,
          ...(config.x402.facilitatorToken ? { authHeaders: { Authorization: `Bearer ${config.x402.facilitatorToken}` } } : {}),
          verifyTimeoutMs: config.x402.verifyTimeoutMs,
          settleTimeoutMs: config.x402.settleTimeoutMs,
        })
    // Double vérification : chaque URL d'audit doit AUSSI valider (settle = primaire).
    // Les auditeurs ne font que /verify : seul le timeout de verify les concerne.
    const auditors = config.x402.verifyUrls.map((baseUrl) => httpFacilitator({ baseUrl, verifyTimeoutMs: config.x402.verifyTimeoutMs }))
    facilitator = crossVerifyFacilitator(primary, auditors)
  }
  return facilitator
}

export function _setFacilitatorForTest(f: Facilitator | null): void {
  facilitator = f
}

// ── Aides ──────────────────────────────────────────────────────────────────────────

function network(): X402Network | null {
  const known = KNOWN_NETWORKS[config.x402.network]
  // Le domaine EIP-712 vient de la table code (lu on-chain, cf x402.ts) : un réseau
  // inconnu n'est pas devinable — config cassée, la gate répondra 503.
  if (!known) return null
  return {
    network: config.x402.network,
    usdcContract: config.x402.usdcContract || known.usdcContract,
    eip712: known.eip712,
  }
}

const sha256hex = (text: string) => createHash('sha256').update(text).digest('hex')

/** Origin publique de la requête : derrière l'ingress, le pod voit http — on honore
 * X-Forwarded-Proto (posé par traefik) pour que `resource` reflète l'URL réelle
 * (un client x402 strict peut la comparer à celle qu'il a appelée). */
function publicOrigin(c: { req: { url: string; header: (n: string) => string | undefined } }): string {
  const url = new URL(c.req.url)
  const proto = c.req.header('x-forwarded-proto')
  if (proto === 'https' || proto === 'http') url.protocol = `${proto}:`
  return url.origin
}

/** Projet wallet : identité stable dérivée de l'adresse payeuse (jamais l'adresse en
 * clair dans les labels de métriques/metering — même règle que l'email du signup). */
export function walletProject(payer: string): string {
  return `${WALLET_PROJECT_PREFIX}${sha256hex(payer.toLowerCase()).slice(0, 10)}`
}

interface DecodedPayment {
  payload: Record<string, unknown>
  from: string
  valueAtomic: string
  nonce: string
}

/** Décode X-PAYMENT (base64 JSON, borné). null = difforme, quel que soit le détail. */
export function decodePaymentHeader(header: string): DecodedPayment | null {
  if (header.length > MAX_PAYMENT_HEADER_BYTES) return null
  let payload: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(Buffer.from(header, 'base64').toString('utf-8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    payload = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const inner = payload.payload
  if (typeof inner !== 'object' || inner === null) return null
  const auth = (inner as Record<string, unknown>).authorization
  if (typeof auth !== 'object' || auth === null) return null
  const a = auth as Record<string, unknown>
  const from = a.from
  const value = a.value
  const nonce = a.nonce
  if (typeof from !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(from)) return null
  if (typeof value !== 'string' || !/^[0-9]{1,15}$/.test(value)) return null
  if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 128) return null
  return { payload, from, valueAtomic: value, nonce }
}

/** Devis maximum FACTURÉ de la requête (mêmes briques que /v1/plan). Marge par défaut :
 * le payeur est inconnu au moment du devis, et les projets wallet n'ont pas de
 * surcharge de marge. undefined = requête non bornable. */
function quoteUsd(req: ChatRequest): number | undefined {
  if (req.openmulti?.council || req.model === 'council') return undefined
  const decision = route(req)
  const q = computeQuote(req, decision.model, decision.maxTokensCeiling, 1 + config.marginPct / 100)
  const maxUsd = q.quote?.max_cost_usd
  if (maxUsd === undefined) return undefined
  // Plancher (quoteMinUsd) : CDP rejette les micro-devis (amount_too_low). Appliqué
  // ICI pour couvrir d'un seul point le 402, le jeton lié, le contrôle de couverture
  // et les requirements re-présentés au facilitateur.
  return Math.max(maxUsd, config.x402.quoteMinUsd)
}

const err = (message: string, type: string) => ({ error: { message, type } })

// ── La gate ────────────────────────────────────────────────────────────────────────

export const x402Gate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!config.x402.enabled) return next()
  if (c.req.header('authorization')) return next() // client à clé : chemin historique
  if (c.req.method !== 'POST' || c.req.path !== PAID_SURFACE) return next()

  // Corps borné (le middleware Content-Length d'app.ts est déjà passé ; ceci couvre
  // l'en-tête absent/menteur, comme chat.ts) puis parsé. Hono met le texte en cache :
  // le handler chat relira le même corps.
  const raw = await c.req.text().catch(() => '')
  if (config.maxBodyBytes > 0 && Buffer.byteLength(raw) > config.maxBodyBytes) {
    return c.json(err('Request body too large', 'invalid_request_error'), 413)
  }
  let req: ChatRequest
  try {
    req = JSON.parse(raw) as ChatRequest
  } catch {
    return c.json(err('Invalid JSON body', 'invalid_request_error'), 400)
  }
  const requestHash = sha256hex(raw)
  const net = network()
  if (!net || !net.usdcContract) {
    log.error('x402_network_unconfigured', { network: config.x402.network })
    return c.json(err('x402 network not configured', 'service_unavailable'), 503)
  }

  const payment = c.req.header('x-payment')

  // ── 1. Pas de paiement : le devis, sous forme de 402 x402 ────────────────────────
  if (!payment) {
    const maxUsd = quoteUsd(req)
    if (maxUsd === undefined) {
      // Pas de borne = pas de prix honnête. L'agent pose max_tokens et retente.
      return c.json(
        { x402Version: 1, accepts: [], ...err('unpriceable request: set max_tokens (or use a capped tier) to get a payable quote', 'invalid_request_error') },
        402,
      )
    }
    const token = mintQuoteToken(
      { requestHash, maxUsd, expiresAt: Date.now() + config.x402.quoteTtlS * 1000 },
      config.x402.quoteSecret,
    )
    return c.json(
      paymentRequired({
        maxUsd,
        payTo: config.x402.payTo,
        network: net,
        resource: publicOrigin(c) + PAID_SURFACE,
        description: 'OpenMulti chat completion (max quote, overpay credited to your wallet balance)',
        quoteToken: token,
        maxTimeoutSeconds: config.x402.quoteTtlS,
      }),
      402,
    )
  }

  // ── 2. Paiement présenté ─────────────────────────────────────────────────────────
  const decoded = decodePaymentHeader(payment)
  if (!decoded) return c.json(err('Malformed X-PAYMENT header', 'invalid_payment'), 402)

  // Couverture : le jeton de devis lié s'il est présenté (déterministe, S1), sinon
  // devis recalculé sur CE corps (client x402 vanilla). Dans les deux cas le montant
  // signé doit couvrir le max.
  let requiredUsd: number
  const quoteHeader = c.req.header('x-openmulti-quote')
  const isCouncil = Boolean(req.openmulti?.council) || req.model === 'council'
  const pinToken = !isCouncil && typeof req.openmulti?.quote_token === 'string' ? req.openmulti.quote_token : undefined
  if (quoteHeader) {
    const v = verifyQuoteToken(quoteHeader, requestHash, config.x402.quoteSecret)
    if (!v.valid) return c.json(err(`Invalid quote token (${v.reason}) — request a fresh 402 quote`, 'invalid_payment'), 402)
    requiredUsd = v.claims.maxUsd
  } else if (pinToken && config.quoteToken.secret) {
    // E-1 sur le rail x402 : le paiement doit couvrir le montant QUOTÉ du jeton, et le
    // CONTRAT (digest, snapshot de candidats, borne recalculée sous table+marge
    // courantes) est PRÉ-VÉRIFIÉ ICI — un contrat mort (dérive) est un 409 AVANT tout
    // verify/settle : l'argent ne bouge jamais sur un devis dépassé.
    const v = decodeQuoteToken(pinToken, config.quoteToken.secret)
    if (!v.valid) return c.json(err(`Invalid quote token (${v.reason}) — request a fresh quote from /v1/plan`, 'invalid_payment'), 402)
    const exec = stripQuoteToken(req)
    const decision = route(exec, v.claims.candidates)
    const q = computeQuote(exec, decision.model, decision.maxTokensCeiling, 1 + config.marginPct / 100)
    const contract = checkPinnedQuote({
      claims: v.claims,
      digest: chatQuoteDigest(exec),
      resolvedModel: decision.model,
      currentBoundUsd: q.quote?.max_cost_usd,
      tableVersion: PRICING_TABLE_VERSION,
    })
    if (!contract.ok) return c.json({ error: { message: contract.message, type: 'quote_conflict', code: contract.code } }, 409)
    requiredUsd = v.claims.usd
  } else {
    const recomputed = quoteUsd(req)
    if (recomputed === undefined) {
      return c.json(err('unpriceable request: set max_tokens to get a payable quote', 'invalid_request_error'), 402)
    }
    requiredUsd = recomputed
  }
  // E-4 : les unités atomiques USDC SONT des micro-USD (6 décimales) — la conversion est
  // exacte et le round-trip vers le ledger interne l'est aussi (usdToMicro(microToUsd(x)) = x),
  // aucune perte flottante sur le chemin devis -> settlement -> crédit.
  const paidUsd = microToUsd(Number(decoded.valueAtomic))
  if (BigInt(decoded.valueAtomic) < BigInt(usdToAtomic(requiredUsd))) {
    return c.json(err(`Payment too small: ${paidUsd} USD signed, quote max is ${requiredUsd} USD`, 'invalid_payment'), 402)
  }

  // Anti-rejeu AVANT tout règlement. Store down = 503 (fail-closed, rien n'a bougé).
  const replay = await claimNonce(decoded.nonce)
  if (replay === 'store_unavailable') return c.json(err('Payment rail temporarily unavailable', 'service_unavailable'), 503)
  if (replay === 'replayed') return c.json(err('Payment already used', 'invalid_payment'), 402)

  // Les requirements re-présentés au facilitateur : mêmes valeurs que le 402 d'origine
  // (la signature EIP-3009 ne couvre pas ce bloc ; le facilitateur y vérifie payTo/
  // asset/réseau/montant contre l'autorisation signée).
  const requirements = (paymentRequired({
    maxUsd: requiredUsd,
    payTo: config.x402.payTo,
    network: net,
    resource: publicOrigin(c) + PAID_SURFACE,
    description: 'OpenMulti chat completion (max quote, overpay credited to your wallet balance)',
    quoteToken: quoteHeader ?? '',
    maxTimeoutSeconds: config.x402.quoteTtlS,
  }).accepts as Record<string, unknown>[])[0]!

  const f = activeFacilitator()
  const verdict = await f.verify(decoded.payload, requirements)
  if (!verdict.isValid) {
    await releaseNonce(decoded.nonce)
    return c.json(err(`Payment verification failed${verdict.invalidReason ? `: ${verdict.invalidReason}` : ''}`, 'invalid_payment'), 402)
  }

  const settled = await f.settle(decoded.payload, requirements)
  if (!settled.success) {
    await releaseNonce(decoded.nonce) // l'argent n'a pas bougé : le client peut retenter
    return c.json(err(`Payment settlement failed${settled.errorReason ? `: ${settled.errorReason}` : ''}`, 'invalid_payment'), 402)
  }

  // Argent encaissé. Crédit du projet wallet (ref = tx hash : idempotent) puis
  // exécution COMME ce projet — metering, marge et solde existants font le reste.
  const payer = settled.payer ?? verdict.payer ?? decoded.from
  const project = walletProject(payer)
  const ref = `x402:${settled.transaction ?? decoded.nonce}`
  const credited = await addCredits(project, paidUsd, ref)
  if (credited === null) {
    // Store retombé APRÈS l'encaissement : on sert quand même (l'argent est là) et on
    // trace tout ce qu'il faut pour réconcilier le ledger à la main.
    log.error('x402_credit_failed_after_settle', { project, paidUsd, ref })
  }
  log.info('x402_paid', { project, paidUsd, requiredUsd, tx: settled.transaction ?? '' })

  c.set('apiKey', `sk_${project}_x402paid`)
  await next()

  // Reçu de règlement (spec x402) — posé après coup, n'altère jamais le corps.
  c.res.headers.set(
    'X-PAYMENT-RESPONSE',
    Buffer.from(JSON.stringify({ success: true, transaction: settled.transaction ?? '', network: net.network, payer })).toString('base64'),
  )
}
