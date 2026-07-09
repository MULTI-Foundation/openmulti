// E-1 (quote-pin, obligation 3 du gate de réfutation) — le devis devient un CONTRAT DE
// PAIEMENT : /v1/plan émet un jeton opaque signé (HMAC-SHA256, secret serveur dédié
// OPENMULTI_QUOTE_TOKEN_SECRET — refus d'émettre s'il est absent, jamais un HMAC sur
// '') qui lie :
//   - le DIGEST canonique de la requête (appel simple : enveloppe modèle + octets des
//     messages + bornes de sortie + intention openmulti ; programme : AST normalisé +
//     stdin_bytes) — un devis ne se transfère pas à une autre requête ;
//   - le SNAPSHOT DE CANDIDATS résolu au devis. Décision actée du réfuteur théorie :
//     le pin est l'ENSEMBLE de candidats, PAS un nom de modèle visible par l'appelant
//     (le jeton ne doit pas devenir une API d'épinglage de modèle déguisée) — la
//     sélection smart continue de tourner, DANS le snapshot (route(req, candidates)) ;
//   - les caps de sortie par étage, le facteur de marge, la version de la table de
//     prix (PRICING_TABLE_VERSION), le montant quoté, une expiration et un nonce.
// À l'exécution (/v1/chat/completions, openmulti.quote_token) : signature + expiration
// vérifiées (422), puis digest / contrainte de candidats / borne RECALCULÉE sous la
// table et la marge COURANTES (409 structuré) — un devis payé dont la borne recalculée
// dépasse le montant quoté (dérive prix/marge/routage) est refusé AVANT toute dépense :
// la fenêtre TOCTOU devis→run est fermée. Sur le rail x402, le montant payé doit
// couvrir le montant quoté du jeton et le contrat est pré-vérifié AVANT tout règlement
// (x402-gate.ts). Comparaison de MAC en temps constant (OM-04), comme x402.ts.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ChatRequest } from './types.js'
import type { Program } from './program-quote.js'

// ── Claims ──────────────────────────────────────────────────────────────────────

export interface QuoteTokenClaims {
  v: 1
  /** Surface quotée : appel simple ('chat') ou programme MULTI entier ('program'). */
  kind: 'chat' | 'program'
  /** Digest canonique de la requête couverte (cf chatQuoteDigest/programQuoteDigest). */
  digest: string
  /** Snapshot des modèles éligibles au moment du devis — la CONTRAINTE de routage. */
  candidates: string[]
  /** Caps de sortie (tokens) par étage : [outputMax] pour un appel simple. */
  caps: number[]
  /** E-8 (AX-CHAIN) : bornes d'ENTRÉE (tokens) par étage — les ι_i sous lesquels le
   * devis programme a été plié (input_tokens_max de chaque étage). Absent sur un
   * jeton chat ; REQUIS pour qu'un étage de programme passe la garde pré-spend
   * (un jeton programme sans ι est refusé — fail-closed, jamais optimiste). */
  inputs?: number[]
  /** Facteur de marge appliqué au devis (1 + pct/100). */
  margin: number
  /** Version (hash) de la table de prix effective au devis (PRICING_TABLE_VERSION). */
  table: string
  /** Montant maximum quoté, USD facturés. */
  usd: number
  /** Expiration epoch ms. */
  exp: number
  /** Anti-collision : deux devis identiques restent des jetons distincts. */
  nonce: string
}

export interface QuoteTokenInput {
  kind: 'chat' | 'program'
  digest: string
  candidates: string[]
  caps: number[]
  inputs?: number[]
  margin: number
  table: string
  usd: number
  ttlMs: number
}

const sign = (payload: string, secret: string) =>
  createHmac('sha256', secret).update(payload).digest('base64url')

/** Émet un jeton de devis signé. REFUSE d'émettre sans secret (jamais un HMAC sur ''). */
export function issueQuoteToken(input: QuoteTokenInput, secret: string, now = Date.now()): string {
  if (!secret) throw new Error('quote-token: OPENMULTI_QUOTE_TOKEN_SECRET manquant — refus d\'émettre')
  const claims: QuoteTokenClaims = {
    v: 1,
    kind: input.kind,
    digest: input.digest,
    candidates: input.candidates,
    caps: input.caps,
    ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
    margin: input.margin,
    table: input.table,
    usd: input.usd,
    exp: now + input.ttlMs,
    nonce: randomBytes(12).toString('base64url'),
  }
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

export type QuoteTokenVerdict =
  | { valid: true; claims: QuoteTokenClaims }
  | { valid: false; reason: 'malformed' | 'bad_signature' | 'expired' }

function isClaims(v: unknown): v is QuoteTokenClaims {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Record<string, unknown>
  return (
    c.v === 1 &&
    (c.kind === 'chat' || c.kind === 'program') &&
    typeof c.digest === 'string' &&
    Array.isArray(c.candidates) && c.candidates.every((m) => typeof m === 'string') &&
    Array.isArray(c.caps) && c.caps.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    (c.inputs === undefined ||
      (Array.isArray(c.inputs) && c.inputs.every((n) => typeof n === 'number' && Number.isFinite(n)))) &&
    typeof c.margin === 'number' && Number.isFinite(c.margin) &&
    typeof c.table === 'string' &&
    typeof c.usd === 'number' && Number.isFinite(c.usd) &&
    typeof c.exp === 'number' &&
    typeof c.nonce === 'string'
  )
}

/** Vérifie signature + expiration et rend les claims. Les vérifications de FOND
 * (digest, candidats, borne recalculée) sont dans checkPinnedQuote — elles exigent le
 * routage/devis de la requête présentée, pas seulement le jeton. */
export function decodeQuoteToken(token: string, secret: string, now = Date.now()): QuoteTokenVerdict {
  if (!secret) return { valid: false, reason: 'bad_signature' }
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return { valid: false, reason: 'malformed' }
  const payload = token.slice(0, dot)
  const mac = token.slice(dot + 1)
  const a = Buffer.from(mac)
  const b = Buffer.from(sign(payload, secret))
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reason: 'bad_signature' }
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'))
  } catch {
    return { valid: false, reason: 'malformed' }
  }
  if (!isClaims(claims)) return { valid: false, reason: 'malformed' }
  if (now > claims.exp) return { valid: false, reason: 'expired' }
  return { valid: true, claims }
}

// ── Digests canoniques ──────────────────────────────────────────────────────────

/** JSON canonique (clés triées récursivement, membres undefined omis) : le digest ne
 * dépend pas de l'ordre d'insertion des clés côté client. Exporté : c'est aussi la
 * sérialisation de la MESURE CANONIQUE d'un AST (H8, program-quote.ts) — même sortie
 * octet-pour-octet que `json.dumps(v, separators=(",", ":"), sort_keys=True,
 * ensure_ascii=False)` côté multi-lang (mêmes échappements JSON, non-ASCII brut). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const obj = v as Record<string, unknown>
  const parts = Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
  return `{${parts.join(',')}}`
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** Digest d'un appel simple : l'ENVELOPPE qui détermine le devis — modèle demandé,
 * longueur en octets des messages (le coût ne dépend que des longueurs, pas du texte),
 * bornes de sortie, n, modalités et l'intention openmulti de routage. Le jeton
 * lui-même (openmulti.quote_token) n'entre jamais dans le digest : la requête
 * d'exécution qui le porte reste couverte par le devis émis sans lui. */
export function chatQuoteDigest(req: ChatRequest): string {
  const om = req.openmulti
  return sha256(canonicalJson({
    kind: 'chat',
    model: req.model ?? 'auto',
    messages_bytes: Buffer.byteLength(JSON.stringify(req.messages ?? []), 'utf8'),
    max_tokens: req.max_tokens ?? null,
    max_completion_tokens: req.max_completion_tokens ?? null,
    n: req.n ?? null,
    modalities: req.modalities ?? null,
    tier: om?.tier ?? null,
    purpose: om?.purpose ?? null,
    allow: om?.allow ?? null,
    route: om?.route ?? null,
  }))
}

/** Digest d'un devis programme : l'AST NORMALISÉ (sorti de validateProgram, cibles en
 * minuscules) + les entrées qui pèsent sur la borne (stdin_bytes, max_tokens). */
export function programQuoteDigest(program: Program, stdinBytes?: number, maxTokens?: number): string {
  return sha256(canonicalJson({
    kind: 'program',
    program,
    stdin_bytes: stdinBytes ?? null,
    max_tokens: maxTokens ?? null,
  }))
}

/** La requête d'exécution SANS son jeton (ni l'index d'étage qui l'accompagne) : c'est
 * sur elle que la borne est recalculée (le jeton ajoute des octets au corps mais
 * n'atteint jamais le provider — l'inclure gonflerait la borne recalculée et ferait
 * rejeter des contrats honnêtes). Un bloc openmulti qui ne portait QUE le contrat
 * disparaît entièrement : la requête redevient octet-pour-octet celle qui a été quotée
 * par /v1/plan sans extension. */
export function stripQuoteToken(req: ChatRequest): ChatRequest {
  if (!req.openmulti || req.openmulti.quote_token === undefined) return req
  const { quote_token: _omit, quote_stage: _omitStage, ...rest } = req.openmulti
  if (Object.keys(rest).length === 0) {
    const { openmulti: _om, ...bare } = req
    return bare as ChatRequest
  }
  return { ...req, openmulti: rest }
}

// ── Vérification de fond (le contrat) ───────────────────────────────────────────

export type PinRejectCode = 'digest_mismatch' | 'candidate_set_mismatch' | 'quote_exceeded'

export type PinVerdict = { ok: true } | { ok: false; status: 409; code: PinRejectCode; message: string }

/**
 * Le cœur du contrat, PUR (testable sans HTTP ni env) : claims déjà authentifiés
 * (decodeQuoteToken) contre la requête présentée. Rejets structurés :
 *   (a) digest_mismatch        — le jeton couvre une AUTRE requête (ou une autre surface) ;
 *   (b) quote_exceeded         — la borne recalculée sous la table/marge COURANTES
 *                                dépasse le montant quoté (dérive prix/marge/routage),
 *                                ou la requête n'est plus quotable du tout ;
 *   (c) candidate_set_mismatch — le modèle résolu sort du snapshot de candidats épinglé.
 */
export function checkPinnedQuote(args: {
  claims: QuoteTokenClaims
  /** Digest canonique de LA requête présentée (chatQuoteDigest de l'exécution). */
  digest: string
  /** Modèle résolu par route(req, claims.candidates) — la sélection sous contrainte. */
  resolvedModel: string
  /** Borne max recalculée sous la table+marge COURANTES ; undefined = plus quotable. */
  currentBoundUsd: number | undefined
  /** PRICING_TABLE_VERSION courant (contexte du message de dérive). */
  tableVersion: string
}): PinVerdict {
  const { claims } = args
  if (claims.kind !== 'chat' || claims.digest !== args.digest) {
    return {
      ok: false, status: 409, code: 'digest_mismatch',
      message: 'quote token does not cover this request — request a fresh quote from /v1/plan',
    }
  }
  if (!claims.candidates.includes(args.resolvedModel)) {
    return {
      ok: false, status: 409, code: 'candidate_set_mismatch',
      message: `resolved model ${args.resolvedModel} is outside the quoted candidate set — request a fresh quote from /v1/plan`,
    }
  }
  const drift = claims.table === args.tableVersion ? '' : ` (price table drifted: ${claims.table} -> ${args.tableVersion})`
  if (args.currentBoundUsd === undefined) {
    return {
      ok: false, status: 409, code: 'quote_exceeded',
      message: `request is no longer quotable under the current price table${drift} — request a fresh quote from /v1/plan`,
    }
  }
  // Epsilon flottant : la borne recalculée à l'identique doit passer, jamais un rejet
  // pour un ULP. Toute dérive réelle dépasse largement 1e-9 USD.
  if (args.currentBoundUsd > claims.usd + 1e-9) {
    return {
      ok: false, status: 409, code: 'quote_exceeded',
      message: `current max cost ${args.currentBoundUsd} USD exceeds the quoted ${claims.usd} USD${drift} — request a fresh quote from /v1/plan`,
    }
  }
  return { ok: true }
}

// ── Vérification de fond, exécution ÉTAGÉE d'un programme (WS2) ─────────────────────
//
// Un jeton kind=program lie l'AST ENTIER (digest programQuoteDigest) et son montant
// TOTAL — mais l'exécution reste étagée : le client (multi-lang runtime) rejoue le MÊME
// jeton sur chaque appel /v1/chat/completions, avec openmulti.quote_stage = l'index
// PLAT de l'étage (ordre instruction puis étage, celui des stages du devis programme).
// La requête d'un étage ne peut PAS reproduire le digest du programme (elle contient la
// sortie réelle de l'amont, inconnue au devis) : la vérification par étage est donc
// STATELESS et porte sur ce que le gateway peut re-vérifier sans la provenance du texte
// pipé :
//   (a) l'index d'étage existe dans le contrat (0 <= quote_stage < caps.length) ;
//   (b) le modèle résolu reste DANS le snapshot de candidats (le routage est déjà
//       contraint par route(req, claims.candidates), ceci verrouille la sortie) ;
//   (c) la table de prix n'a pas dérivé — la borne TOTALE d'un programme ne se recalcule
//       pas depuis un seul étage, donc toute dérive de table tue le contrat (refus
//       CONSERVATEUR : jamais une exécution qui pourrait dépasser le montant payé) ;
//   (d) la marge courante du projet ne dépasse pas celle du devis (même TOCTOU que le
//       test de dérive de marge du contrat chat) ;
//   (e) le cap de sortie EFFECTIF de cet appel (max_tokens/n/plafond de tier recalculés)
//       ne dépasse pas le cap épinglé caps[quote_stage] — le levier de coût que le
//       gateway enforce à l'exécution ;
//   (f) E-8 (AX-CHAIN, amendement A3 de l'enveloppe) : le compte de tokens d'entrée
//       RÉEL de la valeur qui coule (mesuré par le tokenizer du provider résolu quand
//       il est disponible, sinon la borne octets du devis — conservateur, jamais
//       optimiste ; cf stage-input-guard.ts) ne dépasse pas la borne d'entrée épinglée
//       inputs[quote_stage] = ι_i sous laquelle le pliage a été calculé.
// (a)-(e) + le pliage du devis programme (program-quote.ts) donnent realized <= quoted
// sous les axiomes tokenizer de l'enveloppe (phase4/formal/ENVELOPE.md) À CONDITION
// que le folding token->token (AX-CHAIN, g=1) tienne ; (f) est le filet de sécurité
// qui rend le contrat sound MÊME SI AX-CHAIN est violé (pipe cross-tokenizer
// fragmentant) : un étage dont l'entrée réelle casse l'hypothèse du pliage est 409'é
// AVANT tout appel upstream — aucune dépense sur un étage hors-borne.

export type ProgramStageRejectCode = 'stage_required' | 'stage_input_exceeds_bound' | PinRejectCode

/** Mesure d'entrée réelle d'un étage (E-8) : tokens comptés par le tokenizer du
 * provider ('tokenizer') ou borne octets du même JSON que le devis ('byte_bound'). */
export interface StageInputMeasure {
  tokens: number
  method: 'tokenizer' | 'byte_bound'
}

export type ProgramStageVerdict =
  | { ok: true }
  | { ok: false; status: 409 | 422; code: ProgramStageRejectCode; message: string }

export function checkPinnedProgramStage(args: {
  claims: QuoteTokenClaims
  /** openmulti.quote_stage tel que reçu (non validé). */
  stage: unknown
  /** Modèle résolu par route(req, claims.candidates). */
  resolvedModel: string
  /** Borne de sortie recalculée de CET appel (computeQuote) ; undefined = plus quotable. */
  currentOutputMax: number | undefined
  /** Facteur de marge COURANT du projet. */
  marginFactor: number
  /** PRICING_TABLE_VERSION courant. */
  tableVersion: string
  /** E-8 : compte de tokens d'entrée RÉEL de la requête d'étage présentée (jeton
   * exclu), mesuré AVANT tout appel upstream — cf measureStageInput. */
  realInput: StageInputMeasure
}): ProgramStageVerdict {
  const { claims } = args
  if (claims.kind !== 'program') {
    return {
      ok: false, status: 409, code: 'digest_mismatch',
      message: 'quote token does not cover a staged program execution — request a program quote from /v1/plan',
    }
  }
  const stage = args.stage
  if (!(typeof stage === 'number' && Number.isInteger(stage) && stage >= 0 && stage < claims.caps.length)) {
    return {
      ok: false, status: 422, code: 'stage_required',
      message: `a program quote token covers a staged execution — pass openmulti.quote_stage in [0, ${claims.caps.length})`,
    }
  }
  if (!claims.candidates.includes(args.resolvedModel)) {
    return {
      ok: false, status: 409, code: 'candidate_set_mismatch',
      message: `resolved model ${args.resolvedModel} is outside the quoted candidate set — request a fresh quote from /v1/plan`,
    }
  }
  if (claims.table !== args.tableVersion) {
    return {
      ok: false, status: 409, code: 'quote_exceeded',
      message: `price table drifted (${claims.table} -> ${args.tableVersion}) — the program bound cannot be re-verified per stage, request a fresh quote from /v1/plan`,
    }
  }
  if (args.marginFactor > claims.margin + 1e-9) {
    return {
      ok: false, status: 409, code: 'quote_exceeded',
      message: `project margin increased since the quote (${claims.margin} -> ${args.marginFactor}) — request a fresh quote from /v1/plan`,
    }
  }
  const cap = claims.caps[stage]!
  if (args.currentOutputMax === undefined) {
    return {
      ok: false, status: 409, code: 'quote_exceeded',
      message: 'stage is no longer quotable under the current price table — request a fresh quote from /v1/plan',
    }
  }
  if (args.currentOutputMax > cap) {
    return {
      ok: false, status: 409, code: 'quote_exceeded',
      message: `stage output bound ${args.currentOutputMax} tokens exceeds the pinned cap ${cap} for stage ${stage} — request a fresh quote from /v1/plan`,
    }
  }
  // (f) E-8 — garde pré-spend AX-CHAIN : l'entrée réelle de l'étage ne doit pas
  // dépasser la borne d'entrée ι sous laquelle le pliage a quoté cet étage. Un jeton
  // programme sans bornes d'entrée épinglées ne peut PAS être vérifié : refus
  // conservateur (fail-closed), jamais une exécution non gardée.
  const iota = claims.inputs?.[stage]
  if (iota === undefined) {
    return {
      ok: false, status: 409, code: 'stage_input_exceeds_bound',
      message: 'quote token carries no pinned per-stage input bound — request a fresh quote from /v1/plan',
    }
  }
  if (args.realInput.tokens > iota) {
    return {
      ok: false, status: 409, code: 'stage_input_exceeds_bound',
      message: `stage real input ${args.realInput.tokens} tokens (${args.realInput.method}) exceeds the pinned input bound ${iota} for stage ${stage} — the fold assumption does not hold for this flowing value, request a fresh quote from /v1/plan`,
    }
  }
  return { ok: true }
}
