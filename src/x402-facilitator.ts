// Seam facilitateur x402 (B4) — même philosophie que le seam providers : une interface
// étroite (verify/settle), des implémentations interchangeables. Décision Julien
// 2026-07-02 : facilitateur Coinbase (CDP) d'abord, vérification on-chain maison
// ensuite derrière CETTE interface (contre-audit ou remplacement).
//
// Le facilitateur ne touche JAMAIS les fonds : l'autorisation EIP-3009 est signée vers
// NOTRE adresse (le multisig). Au pire il ment (dit « valide » sans régler) ou censure ;
// c'est le risque que la vérif maison viendra borner. Ses réponses sont donc traitées
// comme NON fiables par défaut : settle doit confirmer avant d'exécuter quoi que ce
// soit, et un échec/timeout = refus (fail-closed, on ne sert pas un paiement douteux).

import { log } from './log.js'

/** Le X-PAYMENT décodé (opaque pour nous : le facilitateur seul l'interprète). */
export type PaymentPayload = Record<string, unknown>
/** L'entrée `accepts[0]` de la réponse 402 correspondante. */
export type PaymentRequirements = Record<string, unknown>

export interface VerifyResult {
  isValid: boolean
  invalidReason?: string
  /** L'adresse du payeur, récupérée par le facilitateur (l'identité wallet du B3). */
  payer?: string
}

export interface SettleResult {
  success: boolean
  errorReason?: string
  transaction?: string
  network?: string
  payer?: string
}

export interface Facilitator {
  name: string
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResult>
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResult>
}

/** Transport injectable (tests sans réseau). `timeoutMs` : borne par appel. */
export type FacilitatorTransport = (url: string, body: unknown, headers: Record<string, string>, timeoutMs?: number) => Promise<{ status: number; data: unknown }>

async function defaultTransport(url: string, body: unknown, headers: Record<string, string>, timeoutMs?: number): Promise<{ status: number; data: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS),
  })
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    // corps illisible : data reste null, le statut décide
  }
  return { status: res.status, data }
}

/** Double vérification (décision Julien 2026-07-03 : « croiser deux facilitateurs ») :
 * le paiement n'est accepté que si le PRIMAIRE **et tous les auditeurs** le valident —
 * un facilitateur menteur ou compromis ne suffit plus à faire servir une requête.
 * Le settle reste sur le primaire seul (les auditeurs n'ont besoin ni de clé ni de gas).
 * Fail-closed par construction : un auditeur injoignable = verify invalide. */
export function crossVerifyFacilitator(primary: Facilitator, auditors: Facilitator[]): Facilitator {
  if (auditors.length === 0) return primary
  return {
    name: `${primary.name}+${auditors.length}audit`,
    async verify(payload, requirements) {
      const results = await Promise.all([
        primary.verify(payload, requirements),
        ...auditors.map((a) => a.verify(payload, requirements)),
      ])
      const idx = results.findIndex((v) => !v.isValid)
      if (idx >= 0) {
        const bad = results[idx]!
        log.warn('x402_cross_verify_rejected', { by: idx === 0 ? 'primary' : `auditor_${idx}`, reason: bad.invalidReason ?? '' })
        return bad
      }
      return results[0]!
    },
    settle: (payload, requirements) => primary.settle(payload, requirements),
  }
}

// Un /verify est une LECTURE (rapide) ; un /settle SOUMET une tx on-chain et attend son
// inclusion — sur mainnet c'est nettement plus long (vu au 1er paiement mainnet 2026-07-03 :
// settle Dexter > 20s => timeout, l'argent n'avait pas bougé). D'où deux budgets distincts,
// le settle bien plus large.
const DEFAULT_VERIFY_TIMEOUT_MS = 20_000
const DEFAULT_SETTLE_TIMEOUT_MS = 60_000

export interface HttpFacilitatorConfig {
  baseUrl: string // ex. https://x402.org/facilitator (testnet) ou le facilitateur CDP
  /** En-têtes d'auth (le facilitateur CDP mainnet exige une clé API CDP). */
  authHeaders?: Record<string, string>
  /** En-têtes d'auth calculés PAR opération et À CHAQUE appel (ex. CDP : JWT signé, à
   * durée de vie courte, scopé au chemin /verify vs /settle). Fusionnés par-dessus
   * `authHeaders`. Une exception ici = appel en échec = fail-closed (try/catch de `call`). */
  authHeadersFor?: (op: 'verify' | 'settle') => Promise<Record<string, string>>
  transport?: FacilitatorTransport
  /** Timeout du /verify (lecture). Défaut 20s. */
  verifyTimeoutMs?: number
  /** Timeout du /settle (soumission on-chain, lent sur mainnet). Défaut 60s. */
  settleTimeoutMs?: number
}

/** Facilitateur HTTP générique (spec x402 : POST /verify et /settle). Toute réponse
 * anormale (statut != 200, corps difforme, exception) = INVALIDE — jamais un défaut
 * optimiste sur un chemin d'argent. */
export function httpFacilitator(cfg: HttpFacilitatorConfig): Facilitator {
  const base = cfg.baseUrl.replace(/\/$/, '')
  const transport = cfg.transport ?? defaultTransport
  const headers = cfg.authHeaders ?? {}
  const verifyTimeout = cfg.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS
  const settleTimeout = cfg.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS

  async function call(op: 'verify' | 'settle', payload: PaymentPayload, requirements: PaymentRequirements, timeoutMs: number): Promise<Record<string, unknown> | null> {
    const path = `/${op}`
    try {
      const h = cfg.authHeadersFor ? { ...headers, ...(await cfg.authHeadersFor(op)) } : headers
      const { status, data } = await transport(`${base}${path}`, { x402Version: 1, paymentPayload: payload, paymentRequirements: requirements }, h, timeoutMs)
      if (status !== 200 || typeof data !== 'object' || data === null) {
        log.warn('x402_facilitator_bad_response', { path, status })
        return null
      }
      return data as Record<string, unknown>
    } catch (e) {
      log.warn('x402_facilitator_error', { path, error: e instanceof Error ? e.message : String(e) })
      return null
    }
  }

  return {
    name: 'http',
    async verify(payload, requirements) {
      const data = await call('verify', payload, requirements, verifyTimeout)
      if (!data || typeof data.isValid !== 'boolean') return { isValid: false, invalidReason: 'facilitator_unavailable' }
      return {
        isValid: data.isValid,
        ...(typeof data.invalidReason === 'string' ? { invalidReason: data.invalidReason } : {}),
        ...(typeof data.payer === 'string' ? { payer: data.payer } : {}),
      }
    },
    async settle(payload, requirements) {
      const data = await call('settle', payload, requirements, settleTimeout)
      if (!data || typeof data.success !== 'boolean') return { success: false, errorReason: 'facilitator_unavailable' }
      return {
        success: data.success,
        ...(typeof data.errorReason === 'string' ? { errorReason: data.errorReason } : {}),
        ...(typeof data.transaction === 'string' ? { transaction: data.transaction } : {}),
        ...(typeof data.network === 'string' ? { network: data.network } : {}),
        ...(typeof data.payer === 'string' ? { payer: data.payer } : {}),
      }
    },
  }
}
