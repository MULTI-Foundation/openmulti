// Devis PROGRAMME (WS2, obligation 2 du gate de réfutation) — la borne de coût maximum
// d'un programme MULTI ENTIER (AST spec §3.6 de multi-lang, la forme gelée de
// fixtures/golden.json), calculable AVANT toute dépense. C'est l'artefact central du
// papier P0 : `multi explain` n'imprime aujourd'hui qu'un « devis partiel >= » — la
// borne pipeline-entier n'existait nulle part.
//
// Le PLIAGE (cap de sortie -> borne d'entrée), généralisation du devis council E-5 :
// la borne d'entrée d'un étage = la borne octets de son GABARIT de requête (prompt +
// enveloppe JSON, rendu SANS l'entrée) + la borne de son entrée en TOKENS :
//   - pipe : le cap de sortie (tokens) de l'étage amont — un token généré se
//     re-tokenise en <= 1 token en aval (même hypothèse byte-BPE que council-quote.ts,
//     enveloppe de validité P0-2) : le chaînage token->token n'exige AUCUNE inflation
//     octets-par-token ;
//   - slot (`<< s`) : la borne enregistrée quand le slot a été stocké (`>> s`) = la
//     borne courante du pipeline producteur — les bornes se propagent d'instruction en
//     instruction ; rappeler un slot jamais stocké = erreur de validation (même règle
//     franche que le runtime) ;
//   - stdin : stdin_bytes si fourni (<= 1 token/octet), sinon 0 avec guaranteed=false —
//     le devis reste une borne SI stdin est vide, mais n'est jamais « garanti » sur une
//     entrée non bornée.
// Chaque étage résout sa cible EXACTEMENT comme la planification d'un appel simple :
// même traduction que le client multi-lang (§3.4, build_request), même route(), même
// computeQuote. Un seul étage non quotable (tiered / non tarifé / sans borne de
// sortie) = refus du programme ENTIER avec l'index de l'étage fautif — comme tout
// devis : des bornes ou rien.

import { computeQuote, type Quote, type QuoteUnavailable } from './plan.js'
import { route } from './router.js'
import { canonicalJson } from './quote-token.js'
import type { ChatRequest, OpenMultiExtension, Tier } from './types.js'

// ── Forme du programme (miroir strict de multi-lang parser.py / validate_program) ──

export interface ProgramStage {
  target: string | null
  prompt: string
}

export interface ProgramStatement {
  source: { recall: string } | null
  stages: ProgramStage[]
  sink: { store: string } | null
}

export interface Program {
  statements: ProgramStatement[]
}

/** Bornes anti-abus — les MÊMES défauts que le parseur de référence (parser.py Limits). */
export interface ProgramLimits {
  maxScriptBytes: number
  maxStatements: number
  maxStages: number
}

export const PROGRAM_LIMITS: ProgramLimits = { maxScriptBytes: 65_536, maxStatements: 128, maxStages: 32 }

// ── Mesure canonique (H8, obligation 10 — alignement de la comptabilité d'octets) ──
//
// LA mesure d'admission des DEUX portes (texte et AST) est la taille en octets UTF-8
// de la sérialisation JSON canonique de l'AST normalisé (clés triées, séparateurs
// compacts, non-ASCII brut) — identique octet-pour-octet à
// `canonical_program_bytes` du parseur de référence multi-lang (parser.py).
// Invariant (dérivé et testé côté multi-lang, tests/test_canonical.py) : pour tout
// script s non vide, canonical_bytes(parse(s)) <= 17 + 74*bytes_utf8(s)
// <= CANONICAL_BYTES_FACTOR * bytes_utf8(s). La porte AST admet donc TOUT programme
// issu de la porte texte (embedding one-sided), plus un surplus caractérisé :
// les AST de mesure canonique <= FACTOR * maxScriptBytes sans source textuelle <= max.
export const CANONICAL_BYTES_FACTOR = 91

/** Octets UTF-8 de la sérialisation canonique — la mesure d'admission d'un AST. */
export function canonicalProgramBytes(program: unknown): number {
  return Buffer.byteLength(canonicalJson(program), 'utf8')
}

// Même alphabet d'identifiants que le parseur de référence (_IDENT_START/_IDENT_CONT) :
// une lettre puis lettres/chiffres/-/_//. Le `/` permet les ids concrets vendor/model.
// `$` de JS (sans flag `m`) n'ancre qu'en TOUTE fin — un `"openai\n"` est donc refusé,
// comme le `\Z` de la porte AST de référence (H8, classe « trailing-newline ident »).
// Grammaire v0.2 (migration 2026-07-06, docs/MULTI-Grammar-v0.2-Migration.md) : « . »
// admis en position INTÉRIEURE seulement — ni initial, ni final, ni consécutif (le
// groupe (?:\.[A-Za-z0-9_/-]+)* impose un caractère non-point après chaque point).
// MÊME règle exacte que le scanner texte de référence (ident_dot_malformed) et que
// _IDENT_RE de sa porte AST (multi-lang runtime.py). Les ids réels à point
// (gpt-4.1, glm-4.5, kimi-k2.6…) deviennent nommables — et donc REFUSABLES proprement
// par l'enveloppe au devis (pricing_thinking/pricing_tiered), plus jamais masqués.
const IDENT_RE = /^[A-Za-z][A-Za-z0-9_/-]*(?:\.[A-Za-z0-9_/-]+)*$/

// Substitut UTF-16 ISOLÉ (haut sans bas, ou bas sans haut) : une chaîne mal formée n'a
// pas de sérialisation UTF-8 valide. Côté référence Python, json.dumps(...).encode()
// lèverait — les deux portes la REJETTENT (un prompt doit être du texte valide ; H8,
// classe de divergence « lone surrogate »). Un caractère astral bien formé (emoji) est
// une PAIRE complète et ne matche pas.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function unknownKey(obj: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(obj).find((k) => !allowed.includes(k))
}

export type ProgramValidation = { program: Program } | { error: string }

/**
 * Valide la FORME d'un AST fourni de l'EXTÉRIEUR (on ne fait jamais confiance au
 * client — S5, même posture que validate_program côté multi-lang) : mêmes bornes,
 * même alphabet, cibles normalisées en minuscules, et champs INCONNUS rejetés (un
 * champ non spécifié pourrait porter une sémantique que la borne ne couvre pas).
 * Retourne un programme NEUF (jamais l'objet reçu) ou { error }.
 */
export function validateProgram(input: unknown, limits: ProgramLimits = PROGRAM_LIMITS): ProgramValidation {
  const fail = (why: string): ProgramValidation => ({ error: `invalid program: ${why}` })
  if (!isPlainObject(input)) return fail('objet {statements: [...]} attendu')
  const extraTop = unknownKey(input, ['statements'])
  if (extraTop) return fail(`champ inconnu: ${extraTop}`)
  const rawStatements = input.statements
  if (!Array.isArray(rawStatements)) return fail('statements doit être une liste')
  if (rawStatements.length > limits.maxStatements) return fail('trop d\'instructions')

  const statements: ProgramStatement[] = []
  for (const pipeline of rawStatements) {
    if (!isPlainObject(pipeline)) return fail('pipeline non-objet')
    const extra = unknownKey(pipeline, ['source', 'stages', 'sink'])
    if (extra) return fail(`champ inconnu dans un pipeline: ${extra}`)

    const source = pipeline.source ?? null
    if (source !== null) {
      if (!isPlainObject(source) || unknownKey(source, ['recall']) || typeof source.recall !== 'string' || !IDENT_RE.test(source.recall)) {
        return fail('source.recall invalide')
      }
    }
    const sink = pipeline.sink ?? null
    if (sink !== null) {
      if (!isPlainObject(sink) || unknownKey(sink, ['store']) || typeof sink.store !== 'string' || !IDENT_RE.test(sink.store)) {
        return fail('sink.store invalide')
      }
    }
    const rawStages = pipeline.stages
    if (!Array.isArray(rawStages) || rawStages.length > limits.maxStages) return fail('stages invalides ou trop nombreuses')
    const stages: ProgramStage[] = []
    for (const stage of rawStages) {
      if (!isPlainObject(stage)) return fail('stage non-objet')
      const extraStage = unknownKey(stage, ['target', 'prompt'])
      if (extraStage) return fail(`champ inconnu dans une stage: ${extraStage}`)
      const target = stage.target ?? null
      if (target !== null && !(typeof target === 'string' && IDENT_RE.test(target))) return fail('target invalide')
      const prompt = stage.prompt
      if (typeof prompt !== 'string' || !prompt.trim()) return fail('prompt vide ou manquant')
      if (LONE_SURROGATE.test(prompt)) return fail('prompt mal formé (substitut UTF-16 isolé)')
      stages.push({ target: typeof target === 'string' ? target.toLowerCase() : null, prompt })
    }
    if (source === null && stages.length === 0) return fail('pipeline sans source ni stage')
    statements.push({
      source: source ? { recall: (source as { recall: string }).recall } : null,
      stages,
      sink: sink ? { store: (sink as { store: string }).store } : null,
    })
  }
  // H8 : la mesure d'admission est la MESURE CANONIQUE de l'AST normalisé — la même
  // que celle des deux portes du parseur de référence (remplace l'ancienne somme
  // d'octets des prompts seuls, qui divergeait de la porte texte).
  const program: Program = { statements }
  if (canonicalProgramBytes(program) > CANONICAL_BYTES_FACTOR * limits.maxScriptBytes) {
    return fail('AST trop volumineux (mesure canonique)')
  }
  return { program }
}

// ── Traduction d'un étage en requête (règle §3.4, verrouillée par test) ────────────

/**
 * MÊME traduction que le client multi-lang (client.py build_request) :
 *   - cible absente ou `auto`  -> model "auto" (tier par défaut du serveur) ;
 *   - cible contenant `/`      -> id concret honoré tel quel ;
 *   - toute autre cible        -> model "auto" + openmulti.tier = la cible telle quelle
 *     (tier inconnu = fallback serveur, comme à l'exécution).
 * Le gabarit est rendu avec le séparateur `\n\n` de la règle de collage
 * `prompt\n\ninput` mais SANS l'entrée : l'entrée est comptée à part, en tokens, via
 * extraInputTokens (une entrée vide à l'exécution donne un gabarit plus COURT de deux
 * octets — la borne reste une borne).
 */
export function stageRequest(target: string | null, prompt: string, maxTokens?: number): ChatRequest {
  const req: ChatRequest = { messages: [{ role: 'user', content: `${prompt}\n\n` }] }
  const openmulti: OpenMultiExtension = {}
  if (target === null || target === 'auto') {
    req.model = 'auto'
  } else if (target.includes('/')) {
    req.model = target
  } else {
    req.model = 'auto'
    openmulti.tier = target as Tier // tier inconnu = fallback serveur (isTier dans route())
  }
  req.openmulti = openmulti
  if (maxTokens !== undefined) req.max_tokens = maxTokens
  return req
}

// ── Le devis programme ─────────────────────────────────────────────────────────────

export interface ProgramStageQuote {
  /** Index de l'instruction (0-based) puis de l'étage dans l'instruction. */
  statement: number
  stage: number
  target: string | null
  /** Modèle concret résolu — même résolution que la planification d'un appel simple. */
  model: string
  input_tokens_max: number
  output_tokens_max: number
  max_cost_usd: number
  /** false = la borne suppose une entrée stdin VIDE (stdin_bytes non fourni). */
  guaranteed: boolean
}

export type ProgramQuoteResult =
  | { stages: ProgramStageQuote[]; quote: Quote; guaranteed: boolean; candidates: string[] }
  | { refused: { statement: number; stage: number; target: string | null; model: string; reason: QuoteUnavailable } }
  | { error: string }

/**
 * Plie le programme en une borne de coût maximum, étage par étage. Pure (aucune I/O
 * au-delà de la lecture du catalogue/table en mémoire) : testable sans HTTP.
 *   - `stdinBytes` : borne d'octets du stdin du run — absent = les instructions qui
 *     lisent stdin sont quotées à VIDE et marquées guaranteed=false ;
 *   - `maxTokens` : cap de sortie par étage demandé par l'appelant (même rôle que
 *     max_tokens d'un appel simple) — sans lui, la borne de sortie vient du plafond de
 *     tier OM-01, et sans plafond le devis refuse (no_output_bound).
 * `candidates` : union des snapshots de candidats de chaque étage — le matériau du
 * jeton E-1 (le pin est l'ensemble de candidats, jamais un nom de modèle).
 */
export function computeProgramQuote(
  program: Program,
  opts: { marginFactor: number; stdinBytes?: number; maxTokens?: number },
): ProgramQuoteResult {
  const slots = new Map<string, { tokens: number; guaranteed: boolean }>()
  const stages: ProgramStageQuote[] = []
  const candidateSet = new Set<string>()
  const total: Quote = { input_tokens_max: 0, output_tokens_max: 0, max_cost_usd: 0 }
  let allGuaranteed = true

  for (let si = 0; si < program.statements.length; si++) {
    const stmt = program.statements[si]!

    // L'entrée du pipeline : slot rappelé (borne enregistrée) ou stdin du programme.
    let current: { tokens: number; guaranteed: boolean }
    if (stmt.source) {
      const recorded = slots.get(stmt.source.recall)
      if (!recorded) return { error: `unknown slot: ${stmt.source.recall} (nothing stored there yet)` }
      current = recorded
    } else {
      current = { tokens: opts.stdinBytes ?? 0, guaranteed: opts.stdinBytes !== undefined }
    }

    for (let ki = 0; ki < stmt.stages.length; ki++) {
      const st = stmt.stages[ki]!
      const req = stageRequest(st.target, st.prompt, opts.maxTokens)
      const decision = route(req)
      const q = computeQuote(req, decision.model, decision.maxTokensCeiling, opts.marginFactor, current.tokens)
      if (!q.quote) {
        return { refused: { statement: si, stage: ki, target: st.target, model: decision.model, reason: q.unavailable } }
      }
      for (const cand of decision.candidates ?? []) candidateSet.add(cand)
      candidateSet.add(decision.model)

      const guaranteed = current.guaranteed
      allGuaranteed &&= guaranteed
      stages.push({ statement: si, stage: ki, target: st.target, model: decision.model, ...q.quote, guaranteed })
      total.input_tokens_max += q.quote.input_tokens_max
      total.output_tokens_max += q.quote.output_tokens_max
      total.max_cost_usd += q.quote.max_cost_usd

      // Le pliage : la borne d'entrée de l'étage suivant = le cap de sortie de
      // celui-ci (token -> token ; le cap est ENFORCÉ à l'exécution par max_tokens /
      // le clamp de tier OM-01, donc la borne aval est garantie même si stdin ne l'est pas).
      current = { tokens: q.quote.output_tokens_max, guaranteed: true }
    }

    // `>> slot` est un tee : il enregistre la borne COURANTE du pipeline (celle du
    // dernier étage, ou l'entrée telle quelle pour un pipeline sans étage, G13).
    if (stmt.sink) slots.set(stmt.sink.store, current)
  }

  // Somme de bornes déjà arrondies au micro-dollar SUPÉRIEUR : reste une borne (E-5).
  total.max_cost_usd = Math.round(total.max_cost_usd * 1_000_000) / 1_000_000
  return { stages, quote: total, guaranteed: allGuaranteed, candidates: [...candidateSet].sort() }
}
