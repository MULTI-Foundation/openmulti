// Fondations x402 (B4 du plan interprète) — les parties PURES du rail de paiement
// agent-natif : devis lié à la requête, exigences de paiement 402, anti-rejeu. Le
// câblage HTTP (middleware sur les routes payantes) arrive avec l'adresse du multisig
// et le facilitateur ; rien ici n'est branché tant que OPENMULTI_X402=1 n'est pas posé.
//
// Modèle (protocole x402, initié par Coinbase 2025) :
//   1. requête sans paiement -> 402 + PaymentRequirements (montant MAX = le devis
//      EXPLAIN, USDC, réseau, payTo = le multisig, TTL).
//   2. l'agent signe une autorisation EIP-3009 (transferWithAuthorization) et rejoue
//      avec X-PAYMENT.
//   3. verify + settle via le seam facilitateur (x402-facilitator.ts) ; les fonds vont
//      DIRECTEMENT du wallet de l'agent au multisig — le facilitateur ne touche rien.
//   4. coût réel <= devis ; le trop-perçu est crédité au solde du projet wallet (B3).
//
// Sécurité (modèle de menace S1 + plan B4) :
//   - DEVIS LIÉ : le jeton de devis est un HMAC serveur sur (hash de la requête,
//     montant max, expiration). On exécute exactement ce qui a été payé — un devis ne
//     peut être ni transféré à une autre requête, ni gonflé, ni resservi après TTL.
//     Comparaison en temps constant (OM-04).
//   - ANTI-REJEU : le nonce EIP-3009 est unique ON-CHAIN, mais entre verify et le
//     règlement minier, le même X-PAYMENT pourrait financer deux exécutions : un
//     SET NX à TTL dans le store marque chaque nonce consommé AVANT d'exécuter.
//     Fail-closed : pas de store sain = pas de x402 (cohérent avec la posture B3
//     des anonymes).
//   - Le secret HMAC (OPENMULTI_X402_QUOTE_SECRET) est requis à l'activation ;
//     x402 activé sans secret = refus au boot (jamais un HMAC sur '').

import { createHmac, timingSafeEqual } from 'node:crypto'
import { storeClient, storeHealthy } from './store.js'

// ── Devis lié (S1) ────────────────────────────────────────────────────────────────

export interface QuoteClaims {
  /** sha256 hex de la requête exacte (corps canonique) que ce devis couvre. */
  requestHash: string
  /** Borne maximum FACTURÉE en USD (le devis EXPLAIN est un max garanti). */
  maxUsd: number
  /** Expiration epoch ms. */
  expiresAt: number
}

const sign = (payload: string, secret: string) =>
  createHmac('sha256', secret).update(payload).digest('base64url')

/** Jeton de devis : claims en clair + HMAC serveur. Le client le renvoie tel quel ;
 * il ne peut rien y changer sans invalider la signature. */
export function mintQuoteToken(claims: QuoteClaims, secret: string): string {
  if (!secret) throw new Error('x402: quote secret manquant')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

export type QuoteVerdict =
  | { valid: true; claims: QuoteClaims }
  | { valid: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'request_mismatch' }

/** Vérifie un jeton contre LA requête présentée (hash) — jamais l'inverse. */
export function verifyQuoteToken(token: string, requestHash: string, secret: string, now = Date.now()): QuoteVerdict {
  if (!secret) return { valid: false, reason: 'bad_signature' }
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return { valid: false, reason: 'malformed' }
  const payload = token.slice(0, dot)
  const mac = token.slice(dot + 1)
  const expected = sign(payload, secret)
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reason: 'bad_signature' }
  let claims: QuoteClaims
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as QuoteClaims
  } catch {
    return { valid: false, reason: 'malformed' }
  }
  if (typeof claims.requestHash !== 'string' || typeof claims.maxUsd !== 'number' || typeof claims.expiresAt !== 'number') {
    return { valid: false, reason: 'malformed' }
  }
  if (now > claims.expiresAt) return { valid: false, reason: 'expired' }
  if (claims.requestHash !== requestHash) return { valid: false, reason: 'request_mismatch' }
  return { valid: true, claims }
}

// ── Exigences de paiement (la réponse 402) ────────────────────────────────────────

// USDC : 6 décimales. Les montants x402 voyagent en unités ATOMIQUES (string).
const USDC_DECIMALS = 6

/** USD -> unités atomiques USDC, arrondi au dixième de micro-dollar SUPÉRIEUR (on ne
 * sous-facture jamais un max annoncé ; 1 unité = 1e-6 $, l'erreur max est 1e-6 $). */
export function usdToAtomic(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) throw new Error('x402: montant invalide')
  return String(Math.ceil(usd * 10 ** USDC_DECIMALS))
}

export interface X402Network {
  network: string // ex. 'base' | 'base-sepolia'
  usdcContract: string // adresse du contrat USDC sur ce réseau
}

// Contrats USDC officiels (Circle). Notés le 2026-07-02 ; à REVÉRIFIER sur
// developers.circle.com au moment de l'activation prod (config env prioritaire).
export const KNOWN_NETWORKS: Record<string, X402Network> = {
  base: { network: 'base', usdcContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  'base-sepolia': { network: 'base-sepolia', usdcContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
}

export interface PaymentRequirementsInput {
  maxUsd: number
  payTo: string // le multisig récepteur
  network: X402Network
  resource: string // URL de la ressource payée
  description: string
  quoteToken: string // le devis lié (rejoué par le client, revérifié au paiement)
  maxTimeoutSeconds?: number
}

/** Corps de la réponse 402 au format x402 v1. `accepts` est une liste : un seul mode
 * aujourd'hui (exact/USDC), le seam laisse la place à d'autres réseaux. */
export function paymentRequired(input: PaymentRequirementsInput): Record<string, unknown> {
  return {
    x402Version: 1,
    error: 'Payment required',
    accepts: [
      {
        scheme: 'exact',
        network: input.network.network,
        maxAmountRequired: usdToAtomic(input.maxUsd),
        resource: input.resource,
        description: input.description,
        mimeType: 'application/json',
        payTo: input.payTo,
        maxTimeoutSeconds: input.maxTimeoutSeconds ?? 300,
        asset: input.network.usdcContract,
        // le devis lié voyage dans extra : le client le renvoie avec son paiement,
        // le serveur revérifie hash/montant/TTL avant d'exécuter (S1).
        extra: { quoteToken: input.quoteToken },
      },
    ],
  }
}

// ── Anti-rejeu ────────────────────────────────────────────────────────────────────

const NONCE_PREFIX = 'x402:nonce:'
const NONCE_TTL_S = 3600 // >> maxTimeoutSeconds : couvre toute la fenêtre de validité

export type ReplayVerdict = 'fresh' | 'replayed' | 'store_unavailable'

/** Marque un nonce de paiement consommé AVANT l'exécution. Fail-closed : store
 * indisponible = on refuse (cohérent avec la posture B3 des anonymes). */
export async function claimNonce(nonce: string): Promise<ReplayVerdict> {
  if (!/^[a-zA-Z0-9x]{1,128}$/.test(nonce)) return 'replayed' // nonce difforme = refus
  const c = storeClient()
  if (!c || !storeHealthy()) return 'store_unavailable'
  const key = `${NONCE_PREFIX}${nonce}`
  // SET NX émulé portable : get puis set n'est PAS atomique, donc on passe par incr
  // (INCR est atomique et renvoie 1 au premier passage) + TTL.
  const count = await c.incr(key)
  if (count === 1) {
    await c.expire(key, NONCE_TTL_S)
    return 'fresh'
  }
  return 'replayed'
}
