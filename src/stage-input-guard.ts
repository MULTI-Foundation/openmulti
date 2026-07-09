// E-8 (AX-CHAIN, amendement A3 de phase4/formal/ENVELOPE.md) — garde PRÉ-SPEND du
// compte de tokens d'entrée d'un étage exécuté sous contrat programme.
//
// Le pliage du devis programme (program-quote.ts) chaîne les étages token->token :
// un token de sortie amont est SUPPOSÉ se re-tokeniser en <= 1 token aval (g = 1).
// Cette hypothèse est fausse en général cross-tokenizer (un token amont peut rendre
// des octets que le tokenizer aval fragmente en plusieurs tokens) et n'était gardée
// par AUCUN check runtime. Ce module mesure le compte de tokens d'entrée RÉEL de la
// requête d'étage telle qu'elle arrive (valeur pipée / slot rappelé / stdin déjà
// collés dans les messages), pour le modèle résolu de l'étage :
//   - tokenizer du provider disponible (registre en process, ou pont externe vers les
//     loaders offline du harnais d'axiomes — OPENMULTI_TOKENIZER_BRIDGE_CMD) : le
//     compte mesuré est la vérité terrain ;
//   - sinon : repli sur la borne OCTETS du même JSON que le devis (AX-TOK) —
//     CONSERVATEUR, jamais optimiste : le repli peut refuser un flux bénin verbeux,
//     il ne laisse jamais passer un flux qui pourrait dépasser la borne.
// Le verdict est consommé par checkPinnedProgramStage (quote-token.ts, check (f)) :
// mesure > ι_i épinglé => 409 stage_input_exceeds_bound AVANT tout appel upstream.
//
// La surface mesurée est EXACTEMENT celle du devis : JSON.stringify de la requête
// d'exécution SANS son jeton (stripQuoteToken) — la même chaîne dont le devis a
// compté les octets. Comparer tokens(chaîne) à ι (= octets(gabarit) + borne tokens de
// l'entrée) est sound : le provider ne tokenise jamais plus que cette sérialisation
// (même majorisation qu'AX-TOK), et sous AX-CHAIN un pipe bénin same-tokenizer reste
// sous ι (gabarit <= ses octets, valeur <= son cap amont).

import { execFile } from 'node:child_process'
import { config } from './config.js'
import { log } from './log.js'
import type { ChatRequest } from './types.js'
import type { StageInputMeasure } from './quote-token.js'

/** Compteur de tokens pour une famille de providers : rend le compte, ou undefined si
 * ce texte/modèle n'est pas comptable (=> repli borne octets, jamais optimiste). */
export type StageInputTokenizer = (text: string, model: string) => number | undefined | Promise<number | undefined>

// Registre en process (famille de provider -> compteur). Prioritaire sur le pont
// externe ; c'est aussi le seam des tests (aucun subprocess requis pour tester la
// logique de garde).
const registry = new Map<string, StageInputTokenizer>()

/** Famille de provider d'un id de la table de prix : le préfixe avant '/'. */
export function providerFamilyOf(model: string): string {
  const slash = model.indexOf('/')
  return (slash > 0 ? model.slice(0, slash) : model).toLowerCase()
}

export function registerStageInputTokenizer(family: string, fn: StageInputTokenizer): void {
  registry.set(family.toLowerCase(), fn)
}

export function _resetStageInputTokenizersForTests(): void {
  registry.clear()
  bridgeCmdOverride = undefined
}

// Pont externe : une commande (binaire + args, séparés par des espaces) qui reçoit
// {"model": "...", "text": "..."} sur stdin et écrit {"tokens": <entier>} (ou
// {"tokens": null} = pas de tokenizer pour ce modèle) sur stdout. Implémentation de
// référence : phase4/formal/axiom-harness/bridge/count_tokens.py (réutilise les
// loaders offline du harnais WS3). Toute erreur/timeout => undefined => repli octets.
let bridgeCmdOverride: string | undefined
export function _setStageInputBridgeForTests(cmd: string | undefined): void {
  bridgeCmdOverride = cmd
}

function bridgeCmd(): string {
  return bridgeCmdOverride ?? config.stageInputGuard.bridgeCmd
}

function countViaBridge(cmd: string, model: string, text: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const [bin, ...args] = cmd.split(/\s+/).filter(Boolean)
    if (!bin) return resolve(undefined)
    const child = execFile(
      bin, args,
      { timeout: config.stageInputGuard.bridgeTimeoutMs, maxBuffer: 1_048_576 },
      (err, stdout) => {
        if (err) {
          log.warn('stage_input_bridge_failed', { model, error: String(err).slice(0, 200) })
          return resolve(undefined)
        }
        try {
          const out = JSON.parse(stdout) as { tokens?: unknown }
          const n = out.tokens
          resolve(typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.ceil(n) : undefined)
        } catch {
          log.warn('stage_input_bridge_failed', { model, error: 'unparseable bridge output' })
          resolve(undefined)
        }
      },
    )
    child.stdin?.on('error', () => {}) // pont mort en cours d'écriture : le callback rendra err
    child.stdin?.end(JSON.stringify({ model, text }))
  })
}

/**
 * Mesure l'entrée réelle d'une requête d'étage pour le modèle résolu — la valeur qui
 * coule est déjà DANS req (le runtime a collé prompt\n\ninput) ; le jeton doit avoir
 * été retiré par l'appelant (stripQuoteToken), comme pour la borne recalculée.
 * Jamais optimiste : tokenizer indisponible/en échec => borne octets du devis.
 */
export async function measureStageInput(req: ChatRequest, model: string): Promise<StageInputMeasure> {
  const serialized = JSON.stringify(req)
  const byteBound = Buffer.byteLength(serialized, 'utf8')
  const family = providerFamilyOf(model)
  const counter = registry.get(family)
  try {
    if (counter) {
      const n = await counter(serialized, model)
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return { tokens: Math.ceil(n), method: 'tokenizer' }
    } else if (bridgeCmd()) {
      const n = await countViaBridge(bridgeCmd(), model, serialized)
      if (n !== undefined) return { tokens: n, method: 'tokenizer' }
    }
  } catch (e) {
    log.warn('stage_input_tokenizer_failed', { model, error: String(e).slice(0, 200) })
  }
  return { tokens: byteBound, method: 'byte_bound' }
}
