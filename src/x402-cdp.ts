// Facilitateur x402 Coinbase CDP (règlement Base mainnet à GAS SPONSORISÉ).
// Décision Julien 2026-07-03 : après le retrait de Base par Dexter, CDP règle (settle)
// — Coinbase avance le gas, on ne détient donc aucun ETH — et notre Mogami auto-hébergé
// reste l'AUDITEUR (verify) de la double vérification. Le facilitateur ne touche jamais
// les fonds : l'autorisation EIP-3009 envoie l'USDC du payeur vers NOTRE multisig.
//
// CDP exige une auth par requête : un JWT signé (clé API CDP), à durée de vie courte et
// SCOPÉ au chemin (/verify vs /settle). Le SDK @coinbase/x402 produit ces en-têtes,
// keyés par opération. On les recalcule à CHAQUE appel (jamais de JWT mis en cache) via
// le seam `authHeadersFor` de httpFacilitator — tout le reste (parsing fail-closed,
// timeouts verify/settle) est réutilisé tel quel.

import { httpFacilitator, type Facilitator, type FacilitatorTransport } from './x402-facilitator.js'

const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402'

/** En-têtes d'auth CDP par opération, ex. { verify: { Authorization }, settle: {...} }. */
type CdpAuthHeaders = Record<string, Record<string, string>>

export interface CdpFacilitatorDeps {
  /** Transport injectable (tests sans réseau). */
  transport?: FacilitatorTransport
  /** Fournisseur d'en-têtes d'auth. Défaut : le SDK @coinbase/x402 (JWT signé à partir
   * de la clé API). Injectable pour tester sans clé ni réseau. */
  authHeadersProvider?: () => Promise<CdpAuthHeaders>
}

export interface CdpFacilitatorOpts {
  verifyTimeoutMs?: number
  settleTimeoutMs?: number
}

/** Construit le facilitateur CDP (verify + settle authentifiés). La clé n'est lue qu'ici,
 * et le SDK n'est chargé (import dynamique) que si CDP est réellement activé. */
export function cdpFacilitator(apiKeyId: string, apiKeySecret: string, opts: CdpFacilitatorOpts = {}, deps: CdpFacilitatorDeps = {}): Facilitator {
  const provider: () => Promise<CdpAuthHeaders> =
    deps.authHeadersProvider ??
    (async () => {
      const { createFacilitatorConfig } = await import('@coinbase/x402')
      const cfg = createFacilitatorConfig(apiKeyId, apiKeySecret)
      if (!cfg.createAuthHeaders) throw new Error('cdp: createAuthHeaders indisponible')
      // createAuthHeaders() : JWT frais scopé par opération, à chaque appel.
      return (await cfg.createAuthHeaders()) as CdpAuthHeaders
    })

  return httpFacilitator({
    baseUrl: CDP_FACILITATOR_URL,
    authHeadersFor: async (op) => {
      const all = await provider()
      return all[op] ?? {}
    },
    ...(deps.transport ? { transport: deps.transport } : {}),
    ...(opts.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: opts.verifyTimeoutMs } : {}),
    ...(opts.settleTimeoutMs !== undefined ? { settleTimeoutMs: opts.settleTimeoutMs } : {}),
  })
}
