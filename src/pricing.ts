// Table de prix par modèle (docs/MULTI-PROVIDER-SPEC.md §5) — la pièce qui permettra
// aux providers DIRECTS de synthétiser `usage.cost` (point de contrat MyMULTI + signal
// du bandit). Sur le chemin OpenRouter, le cost vient d'OpenRouter et cette table ne
// sert pas : elle n'est branchée sur rien tant que l'étape 3 (premier provider direct)
// n'est pas là.
//
// Règles (spec §5) :
//   - modèle absent de la table → `undefined`, JAMAIS un faux zéro (le bandit lirait
//     « gratuit » → biais dangereux) ; c'est l'appelant qui logge/compte le trou.
//   - statique versionnée (DEFAULTS) + override env OPENMULTI_PRICING_JSON pour
//     corriger un prix sans release. L'override gagne, entrée par entrée.
//   - les DEFAULTS restent vides tant qu'aucun provider direct n'est branché : chaque
//     prix sera ajouté à l'étape 3, vérifié contre la page du vendor au moment du
//     câblage (règle projet : ne rien affirmer sans vérifier — un prix inventé ici
//     serait exactement ça).

import { createHash } from 'node:crypto'

export interface ModelPrice {
  /** USD par million de tokens d'entrée. */
  inputPerMTok: number
  /** USD par million de tokens de sortie. */
  outputPerMTok: number
  /** Tarification par PALIER de contexte et/ou taux thinking : la table porte le palier
   * de base, qui est une borne BASSE (gros contexte ou thinking = plus cher). La
   * facturation reste best-effort sur ce prix ; le devis (computeQuote) REFUSE ces
   * modèles — un devis « garanti » ne peut pas s'appuyer sur une borne basse (P0-1).
   * Retirer le flag seulement avec un prix vérifié constant sur tous les paliers. */
  tiered?: true
  /** Sortie facturée dépendant d'un toggle THINKING non décidable statiquement depuis la
   * requête (ENVELOPE §3 AX-OUT classe C, deltas E1/E2) : le cap de sortie ne majore pas
   * la CoT facturée. Facturation best-effort au taux de base ; le devis REFUSE (Q-1). */
  thinking?: true
}

// Rempli provider par provider au câblage de son chemin direct, prix vérifiés à ce
// moment-là contre la page du vendor (jamais de prix de mémoire).
// Les clés sont les ids de CATALOGUE (style OpenRouter, vendor/model) — c'est l'id que
// reçoit computeCostUsd, pas l'id nu envoyé au provider. Input = cache MISS quand un
// vendor tarife le cache (borne haute côté input). Tout prix peut être corrigé sans
// release via OPENMULTI_PRICING_JSON (l'override gagne, entrée par entrée), et un id
// hors table = pas de cost (warning + métrique), jamais un faux zéro.
const DEFAULTS: Record<string, ModelPrice> = {
  // Moonshot direct — vérifié le 2026-06-10 sur platform.kimi.ai/docs/pricing/chat-k26.
  // Input = cache MISS ($0.95/MTok) : le cache hit ($0.16) n'est pas modélisé, le coût
  // synthétisé est donc une borne haute côté input.
  'moonshotai/kimi-k2.6': { inputPerMTok: 0.95, outputPerMTok: 4 },

  // OpenAI direct — vérifié le 2026-06-22 sur developers.openai.com/api/docs/pricing.
  'openai/gpt-5.5': { inputPerMTok: 5, outputPerMTok: 30 },
  'openai/gpt-5.4': { inputPerMTok: 2.5, outputPerMTok: 15 },
  'openai/gpt-5.4-mini': { inputPerMTok: 0.75, outputPerMTok: 4.5 },
  'openai/gpt-5.4-nano': { inputPerMTok: 0.2, outputPerMTok: 1.25 },
  'openai/gpt-5': { inputPerMTok: 1.25, outputPerMTok: 10 },
  'openai/gpt-4.1': { inputPerMTok: 2, outputPerMTok: 8 },
  'openai/gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  // gpt-oss-120b (open-weight, multi-provider OpenRouter) — vérifié le 2026-07-21 sur
  // openrouter.ai/api/v1/models/openai/gpt-oss-120b/endpoints. BORNE = pire provider
  // du pool (input 0.35 Cerebras, output 0.95 SambaNova) : notre steering
  // provider.sort=throughput peut élire n'importe lequel, le devis doit couvrir le
  // pire cas. La variante `:nitro` (tri débit côté OpenRouter) sert le MÊME pool aux
  // mêmes prix par provider — même borne.
  'openai/gpt-oss-120b': { inputPerMTok: 0.35, outputPerMTok: 0.95 },
  'openai/gpt-oss-120b:nitro': { inputPerMTok: 0.35, outputPerMTok: 0.95 },

  // DeepSeek direct — vérifié le 2026-06-22 sur api-docs.deepseek.com/quick_start/pricing
  // (prix = cache MISS). deepseek-chat/-reasoner mappent v4-flash.
  'deepseek/deepseek-chat': { inputPerMTok: 0.14, outputPerMTok: 0.28 },
  // reasoner : la sortie facturée inclut la CoT (thinking), non bornée par le cap de
  // sortie demandé → non quotable (Q-1), même prix best-effort pour la facturation.
  'deepseek/deepseek-reasoner': { inputPerMTok: 0.14, outputPerMTok: 0.28, thinking: true },
  'deepseek/deepseek-v4-flash': { inputPerMTok: 0.14, outputPerMTok: 0.28 },
  'deepseek/deepseek-v4-pro': { inputPerMTok: 0.435, outputPerMTok: 0.87 },

  // Mistral direct — vérifié le 2026-06-22 sur mistral.ai/pricing.
  'mistralai/mistral-large-latest': { inputPerMTok: 0.5, outputPerMTok: 1.5 },
  'mistralai/mistral-medium-latest': { inputPerMTok: 1.5, outputPerMTok: 7.5 },
  'mistralai/mistral-small-latest': { inputPerMTok: 0.1, outputPerMTok: 0.3 },
  'mistralai/codestral-latest': { inputPerMTok: 0.3, outputPerMTok: 0.9 },
  'mistralai/devstral-latest': { inputPerMTok: 0.4, outputPerMTok: 2 },

  // Z.ai (GLM) direct — vérifié le 2026-06-22 sur docs.z.ai/guides/overview/pricing.
  // (Les variantes gratuites glm-*-flash sont volontairement hors table : un « 0 »
  // ferait croire au bandit à un chemin gratuit illimité.)
  'z-ai/glm-4.6': { inputPerMTok: 0.6, outputPerMTok: 2.2 },
  'z-ai/glm-4.5': { inputPerMTok: 0.6, outputPerMTok: 2.2 },
  'z-ai/glm-4.5-air': { inputPerMTok: 0.2, outputPerMTok: 1.1 },
  'z-ai/glm-4.5-x': { inputPerMTok: 2.2, outputPerMTok: 8.9 },
  'z-ai/glm-4.5-airx': { inputPerMTok: 1.1, outputPerMTok: 4.5 },

  // Qwen (Alibaba DashScope, international) — vérifié le 2026-06-23 sur
  // alibabacloud.com/help/en/model-studio/model-pricing. Plusieurs modèles sont tarifés
  // PAR PALIER de contexte : on prend le palier de base (borne basse pour les gros
  // contextes). qwen-plus : output = tarif NON-thinking (le thinking, plus cher, n'est
  // pas activé par ce câblage de base).
  // tiered : la table porte le PALIER DE BASE de contexte (borne basse) — un gros
  // contexte facture plus, donc pas de devis garanti dessus (P0-1) ; le prix de base
  // reste utilisé pour la facturation best-effort.
  'qwen/qwen3-max': { inputPerMTok: 1.2, outputPerMTok: 6, tiered: true },
  'qwen/qwen-max': { inputPerMTok: 1.6, outputPerMTok: 6.4, tiered: true },
  'qwen/qwen-plus': { inputPerMTok: 0.4, outputPerMTok: 1.2, tiered: true },
  'qwen/qwen-flash': { inputPerMTok: 0.05, outputPerMTok: 0.4, tiered: true },
  'qwen/qwen3.5-plus': { inputPerMTok: 0.4, outputPerMTok: 2.4, tiered: true },
  'qwen/qwen3.5-flash': { inputPerMTok: 0.1, outputPerMTok: 0.4, tiered: true },
  'qwen/qwen-turbo': { inputPerMTok: 0.05, outputPerMTok: 0.2, tiered: true },
  'qwen/qwen3-235b-a22b': { inputPerMTok: 0.7, outputPerMTok: 2.8, tiered: true },

  // Anthropic direct — vérifié le 2026-06-23 via la référence officielle (claude-api).
  // Input = plein tarif (le cache hit, ~0.1x, n'est pas modélisé → borne haute).
  'anthropic/claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'anthropic/claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'anthropic/claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'anthropic/claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'anthropic/claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'anthropic/claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },

  // Trous découverts au smoke du 2026-07-02 : modèles du catalogue d'exploitation sans
  // entrée ici — sur un chemin DIRECT le coût n'est pas synthétisé et le bandit croit
  // le modèle gratuit (donc le sur-exploite). Prix vérifiés le 2026-07-02 via l'API
  // publique OpenRouter (/api/v1/models ; cohérente avec les entrées vendeur déjà
  // vérifiées : opus 5/25, sonnet 3/15). Anthropic en DEUX graphies : OpenRouter
  // utilise le point (claude-sonnet-4.5), l'API Anthropic directe le tiret — le
  // catalogue d'exploitation a mélangé les deux, la table couvre les deux.
  'openai/gpt-5.1': { inputPerMTok: 1.25, outputPerMTok: 10 },
  'openai/gpt-5-mini': { inputPerMTok: 0.25, outputPerMTok: 2 },
  'z-ai/glm-5': { inputPerMTok: 0.6, outputPerMTok: 1.92 },
  'qwen/qwen3-coder-plus': { inputPerMTok: 0.65, outputPerMTok: 3.25, tiered: true },
  'google/gemini-3.1-flash-lite': { inputPerMTok: 0.25, outputPerMTok: 1.5, thinking: true },
  'anthropic/claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'anthropic/claude-sonnet-4.5': { inputPerMTok: 3, outputPerMTok: 15 },
  'anthropic/claude-opus-4.8': { inputPerMTok: 5, outputPerMTok: 25 },
}

export interface PricingParse {
  prices: Record<string, ModelPrice>
  /** Entrées rejetées (JSON invalide → ['*'], sinon les ids de modèle fautifs). */
  invalid: string[]
}

function isValidPrice(v: unknown): v is ModelPrice {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Record<string, unknown>
  return (
    typeof p.inputPerMTok === 'number' && Number.isFinite(p.inputPerMTok) && p.inputPerMTok >= 0 &&
    typeof p.outputPerMTok === 'number' && Number.isFinite(p.outputPerMTok) && p.outputPerMTok >= 0
  )
}

/** Construit le registre : defaults + override JSON (l'override gagne par modèle).
 * Pure — toute la logique d'entrée est ici pour être testable sans jouer avec l'env. */
export function buildPricing(defaults: Record<string, ModelPrice>, overrideJson?: string): PricingParse {
  const prices: Record<string, ModelPrice> = { ...defaults }
  const invalid: string[] = []
  if (overrideJson) {
    let parsed: unknown
    try {
      parsed = JSON.parse(overrideJson)
    } catch {
      return { prices, invalid: ['*'] }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { prices, invalid: ['*'] }
    }
    for (const [model, price] of Object.entries(parsed)) {
      if (isValidPrice(price)) {
        prices[model] = {
          inputPerMTok: price.inputPerMTok,
          outputPerMTok: price.outputPerMTok,
          // Un override peut marquer un modèle tiered/thinking (refus de devis) sans release.
          ...(price.tiered ? { tiered: true } : {}),
          ...(price.thinking ? { thinking: true } : {}),
        }
      } else {
        invalid.push(model)
      }
    }
  }
  return { prices, invalid }
}

const registry = buildPricing(DEFAULTS, process.env.OPENMULTI_PRICING_JSON)

/** Entrées d'override rejetées au boot (loggées par l'appelant au câblage, étape 3). */
export const pricingInvalid: readonly string[] = registry.invalid

/** Version (hash court) de la table EFFECTIVE (defaults + override env) — épinglée dans
 * le jeton de devis (E-1) : à l'exécution, une table qui a dérivé depuis le devis est
 * détectable (le contrat programme la refuse, le contrat chat recalcule la borne). */
export const PRICING_TABLE_VERSION: string = createHash('sha256')
  .update(JSON.stringify(registry.prices))
  .digest('hex')
  .slice(0, 12)

export function priceFor(model: string): ModelPrice | undefined {
  return registry.prices[model]
}

/** Ids de modèle tarifés (triés) — base de la liste sélectionnable du council. */
export function pricedModelIds(): string[] {
  return Object.keys(registry.prices).sort()
}

/** Coût USD synthétisé depuis les tokens — `undefined` si le modèle n'est pas tarifé
 * (jamais un faux zéro, cf en-tête). */
export function computeCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number | undefined {
  const p = priceFor(model)
  if (!p) return undefined
  return (promptTokens * p.inputPerMTok + completionTokens * p.outputPerMTok) / 1_000_000
}
