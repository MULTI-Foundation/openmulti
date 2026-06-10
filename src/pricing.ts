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

export interface ModelPrice {
  /** USD par million de tokens d'entrée. */
  inputPerMTok: number
  /** USD par million de tokens de sortie. */
  outputPerMTok: number
}

// Rempli provider par provider au câblage de son chemin direct, prix vérifiés à ce
// moment-là contre la page du vendor (jamais de prix de mémoire).
const DEFAULTS: Record<string, ModelPrice> = {
  // Moonshot direct — vérifié le 2026-06-10 sur platform.kimi.ai/docs/pricing/chat-k26.
  // Input = cache MISS ($0.95/MTok) : le cache hit ($0.16) n'est pas modélisé, le coût
  // synthétisé est donc une borne haute côté input.
  'moonshotai/kimi-k2.6': { inputPerMTok: 0.95, outputPerMTok: 4 },
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
        prices[model] = { inputPerMTok: price.inputPerMTok, outputPerMTok: price.outputPerMTok }
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

export function priceFor(model: string): ModelPrice | undefined {
  return registry.prices[model]
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
