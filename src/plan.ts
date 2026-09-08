// Devis pour POST /v1/plan (brique B1 du chantier multi-lang, docs/MULTI-Interpreter-
// Plan-Implementation.md) : la borne de coût MAXIMUM d'un appel, calculable AVANT toute
// dépense. C'est le socle d'EXPLAIN côté interprète MULTI et, plus tard, du prépaiement
// (S1 du modèle de menace : un devis payé doit couvrir le pire cas). Donc jamais
// d'estimation optimiste : uniquement des bornes, ou pas de devis du tout.
//
// Bornes :
//   - entrée : octets UTF-8 du JSON de la requête. Un tokenizer BPE byte-level ne
//     produit jamais plus d'un token par octet, et le JSON complet (rôles, tools,
//     quotes, extension) majore ce que le provider tokenise réellement. Large (~4x sur
//     du texte latin) mais GARANTI — et l'entrée est la part bon marché du coût.
//   - sortie : max_tokens demandé, écrêté par le plafond de tier (OM-01, même règle que
//     buildUpstreamBody). Aucun des deux = pas de borne = pas de devis.
//   - prix : table pricing.ts ; modèle non tarifé = pas de devis (jamais un faux zéro,
//     même règle que computeCostUsd).
//
// Le devis est en dollars FACTURÉS (marge du projet incluse — c'est ce que paiera le
// client), arrondi au micro-dollar SUPÉRIEUR : une borne s'arrondit vers le haut.

import { computeCostUsd, priceFor } from './pricing.js'
import { completionCount, effectiveOutputCap } from './output-bounds.js'
import { audioDurationSeconds } from './audio-duration.js'
import type { ChatRequest } from './types.js'

export interface Quote {
  /** Borne haute de tokens d'entrée (octets UTF-8 du JSON de la requête). */
  input_tokens_max: number
  /** Borne de tokens de sortie (max_tokens effectif après plafond de tier). */
  output_tokens_max: number
  /** Coût maximum FACTURÉ en USD (marge incluse), arrondi au micro-dollar supérieur. */
  max_cost_usd: number
  /** Secondes d'audio en entrée bornées (content parts `input_audio`, durée lue dans le
   * conteneur, arrondie à la seconde supérieure). Absent sans audio. */
  audio_seconds_max?: number
}

/** Pourquoi aucun devis n'a pu être garanti (jamais de devis approximatif à la place).
 * pricing_tiered : le modèle est tarifé par palier de contexte/taux thinking et la table
 * ne porte que le palier de base (borne basse) — quoter dessus sous-estimerait (P0-1).
 * pricing_thinking : la sortie facturée du modèle dépend d'un toggle thinking non
 * décidable statiquement — le cap de sortie ne majore pas la CoT facturée (Q-1) ; quoter
 * dessus pourrait sous-estimer la sortie. */
export type QuoteUnavailable = 'unsupported_content' | 'no_output_bound' | 'pricing_unknown' | 'pricing_tiered' | 'pricing_thinking'

export type QuoteResult = { quote: Quote; unavailable?: undefined } | { quote: null; unavailable: QuoteUnavailable }

// Un devis ne se garantit que sur du TEXTE ou de l'AUDIO EN ENTRÉE (chantier x402
// audio 2026-09-08) : une image (en entrée comme en sortie) est tarifée hors tokens de
// texte, sa borne n'est pas calculable depuis les octets. L'audio, lui, est facturé à la
// SECONDE (pricing.audioInputPerSecond) et sa durée se lit dans le conteneur
// (audio-duration.ts) : format illisible = pas de devis.
interface AudioPart {
  data: string
  format: string
}
interface ContentScan {
  /** Contenu non bornable (image, part inconnue, contenu de forme inconnue). */
  unsupported: boolean
  audio: AudioPart[]
}
function scanContent(req: ChatRequest): ContentScan {
  const out: ContentScan = { unsupported: false, audio: [] }
  if (Array.isArray(req.modalities) && req.modalities.some((m) => m !== 'text')) out.unsupported = true
  for (const msg of req.messages) {
    const content = msg.content
    if (typeof content === 'string' || content === null || content === undefined) continue
    if (Array.isArray(content)) {
      for (const part of content) {
        const p = typeof part === 'object' && part !== null ? (part as Record<string, unknown>) : null
        const type = p?.type
        if (type === 'text') continue
        if (type === 'input_audio') {
          const ia = typeof p?.input_audio === 'object' && p.input_audio !== null ? (p.input_audio as Record<string, unknown>) : null
          if (typeof ia?.data === 'string' && typeof ia.format === 'string') {
            out.audio.push({ data: ia.data, format: ia.format })
            continue
          }
        }
        out.unsupported = true
      }
      continue
    }
    out.unsupported = true // contenu ni texte ni liste de parts : on refuse de borner à l'aveugle
  }
  return out
}

/** Secondes d'audio bornées : somme des durées lues, arrondie à la seconde supérieure
 * (les providers facturent la seconde entamée). null = une part illisible. */
function audioSecondsMax(parts: AudioPart[]): number | null {
  let total = 0
  for (const part of parts) {
    const bytes = Buffer.from(part.data, 'base64')
    const d = audioDurationSeconds(bytes, part.format)
    if (d === null) return null
    total += d
  }
  return Math.ceil(total)
}

/** La requête sans les octets audio (base64) : ce que le provider TOKENISE comme texte.
 * Les octets audio sont bornés à part, en secondes — les compter en tokens de texte
 * gonflerait le devis d'un facteur 100 sans rien garantir de plus. */
function textOnlyRequest(req: ChatRequest): ChatRequest {
  const messages = req.messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg
    const content = (msg.content as unknown[]).map((part) => {
      const p = typeof part === 'object' && part !== null ? (part as Record<string, unknown>) : null
      if (p?.type !== 'input_audio') return part
      return { ...p, input_audio: { ...(p.input_audio as Record<string, unknown>), data: '' } }
    })
    return { ...msg, content }
  })
  return { ...req, messages }
}

/**
 * Calcule le devis (borne de coût maximum) pour une requête déjà routée.
 * Pure : aucune I/O, aucun état — testable sans HTTP (cf test/plan.test.ts).
 */
export function computeQuote(
  req: ChatRequest,
  model: string,
  maxTokensCeiling: number | undefined,
  marginFactor: number,
  extraInputTokens = 0,
): QuoteResult {
  const scan = scanContent(req)
  if (scan.unsupported) return { quote: null, unavailable: 'unsupported_content' }
  const audioSeconds = scan.audio.length > 0 ? audioSecondsMax(scan.audio) : 0
  if (audioSeconds === null) return { quote: null, unavailable: 'unsupported_content' }

  // Tarification par palier (P0-1) : la table porte une borne BASSE, pas un max — refus,
  // même règle qu'un modèle non tarifé (la facturation, elle, reste best-effort).
  const price = priceFor(model)
  if (price?.tiered) return { quote: null, unavailable: 'pricing_tiered' }
  // Toggle thinking non décidable statiquement (Q-1) : le cap de sortie n'est pas
  // prouvablement une borne sur la CoT facturée — refus, même posture que tiered.
  if (price?.thinking) return { quote: null, unavailable: 'pricing_thinking' }

  // Borne de sortie par complétion (prend en compte max_completion_tokens ET le plafond
  // de tier), multipliée par n : c'est le total de tokens de sortie que l'exécution du
  // MÊME modèle épinglé peut facturer au pire (audit sécu : n et max_completion_tokens
  // contournaient la borne).
  const perCompletion = effectiveOutputCap(req, maxTokensCeiling)
  if (perCompletion === undefined) return { quote: null, unavailable: 'no_output_bound' }
  const outputMax = perCompletion * completionCount(req)

  // `extraInputTokens` : tokens d'entrée à ajouter à la borne octets — utilisé par le
  // pliage du devis programme (E-5/program-quote) pour compter la valeur qui coule
  // (bornée en TOKENS par le cap de sortie amont, pas en octets).
  const inputMax = Buffer.byteLength(JSON.stringify(audioSeconds > 0 ? textOnlyRequest(req) : req), 'utf8') + extraInputTokens
  const textMax = computeCostUsd(model, inputMax, outputMax)
  if (textMax === undefined) return { quote: null, unavailable: 'pricing_unknown' }
  // Audio en entrée : facturé à la seconde, borne = secondes lues x prix vérifié du
  // modèle ; modèle sans prix audio = pas de devis (jamais un faux zéro).
  let audioMax = 0
  if (audioSeconds > 0) {
    const perSecond = price?.audioInputPerSecond
    if (perSecond === undefined) return { quote: null, unavailable: 'pricing_unknown' }
    audioMax = audioSeconds * perSecond
  }
  const rawMax = textMax + audioMax

  return {
    quote: {
      input_tokens_max: inputMax,
      output_tokens_max: outputMax,
      max_cost_usd: Math.ceil(rawMax * marginFactor * 1_000_000) / 1_000_000,
      ...(audioSeconds > 0 ? { audio_seconds_max: audioSeconds } : {}),
    },
  }
}
