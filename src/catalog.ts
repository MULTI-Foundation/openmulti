// The catalog: tier -> candidate models. Le PREMIER candidat de chaque slot est le
// primaire (stratégie 'default') ; les suivants ne servent que le bandit ('smart').
//
// La VRAIE correspondance tier→modèles est de la tambouille interne — une partie de
// la valeur d'OpenMulti — et ne vit PAS dans ce repo : elle est portée par un fichier
// de catalogue local NON versionné (OPENMULTI_CATALOG_FILE, cf catalog-file.ts ;
// monté en ConfigMap créée hors manifeste en cluster) et ajustée à chaud par l'API
// admin. Les défauts ci-dessous sont un fallback MINIMAL et neutre : de quoi servir
// chaque tier sans fichier, sans révéler la curation courante.
//
// Précédence par slot : override admin (catalog-overrides.ts, Redis, à la volée)
// > fichier local (catalog-file.ts) > env pluriel > env singulier > défauts ci-dessous.

import { catalogOverride, listCatalogOverrides } from './catalog-overrides.js'
import { catalogFileSlot, catalogFileSlots } from './catalog-file.js'
import type { Tier } from './types.js'

const TIER_DEFAULT: Record<Tier, string[]> = {
  economy: ['anthropic/claude-haiku-4-5'],
  balanced: ['anthropic/claude-sonnet-4-5'],
  quality: ['anthropic/claude-opus-4.8'],
}

// Routing par tache: certaines taches ont un modele plus adapte que le defaut du tier.
// 'agent' = generation de code longue (containers OpenClaw). Le floor max_tokens Kimi
// et le steering provider de buildUpstreamBody se declenchent pour ces appels.
const PURPOSE_DEFAULT: Record<string, Partial<Record<Tier, string[]>>> = {
  agent: {
    balanced: ['moonshotai/kimi-k2.6'],
    quality: ['moonshotai/kimi-k2.6'],
  },
}

function envList(name: string): string[] | undefined {
  const v = process.env[name]
  if (!v) return undefined
  const list = v.split(',').map((s) => s.trim()).filter(Boolean)
  return list.length ? list : undefined
}

const envName = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '_')

/**
 * Ordered candidate models for a (tier, purpose). The FIRST is the primary — the
 * 'default' strategy always picks it, so behavior is unchanged unless a caller opts
 * into 'smart' (see select.ts). Config precedence per slot:
 *   1. admin override (catalog-overrides.ts — Redis, modifiable à la volée sans deploy)
 *   2. plural env OPENMULTI_MODELS_[PURPOSE_]TIER (comma-separated) -> the full set
 *   3. singular env OPENMULTI_MODEL_[PURPOSE_]TIER (back-compat) -> a one-model set
 *   4. built-in default
 * A purpose with no model of its own falls through to the tier candidates.
 */
export function candidatesFor(tier: Tier, purpose?: string): string[] {
  const T = envName(tier)
  if (purpose) {
    const slotName = `${purpose.toLowerCase()}_${tier}`
    const dynamic = catalogOverride(slotName) ?? catalogFileSlot(slotName)
    if (dynamic) return dynamic
    const slot = `${envName(purpose)}_${T}`
    const plural = envList(`OPENMULTI_MODELS_${slot}`)
    if (plural) return plural
    const single = process.env[`OPENMULTI_MODEL_${slot}`]
    if (single) return [single]
    const builtIn = PURPOSE_DEFAULT[purpose]?.[tier]
    if (builtIn) return builtIn
  }
  return (
    catalogOverride(tier) ??
    catalogFileSlot(tier) ??
    envList(`OPENMULTI_MODELS_${T}`) ??
    (process.env[`OPENMULTI_MODEL_${T}`] ? [process.env[`OPENMULTI_MODEL_${T}`]!] : TIER_DEFAULT[tier])
  )
}

/**
 * Candidats de l'objectif `@fastest` — sélection MANUELLE (décision 2026-07-21) : le
 * gateway n'observe pas encore la latence, donc « le plus rapide » est une curation
 * d'exploitation, comme les tiers. Slot `fast` : override admin > fichier local >
 * env (pluriel puis singulier). AUCUN défaut intégré : non configuré = null, et
 * @fastest reste refusé avec une erreur claire (router.ts) — jamais un routage
 * mensonger vers un modèle qui n'a rien de rapide.
 */
export function fastCandidates(): string[] | null {
  return (
    catalogOverride('fast') ??
    catalogFileSlot('fast') ??
    envList('OPENMULTI_MODELS_FAST') ??
    (process.env.OPENMULTI_MODEL_FAST ? [process.env.OPENMULTI_MODEL_FAST] : null)
  )
}

// Image generation is a /v1/chat/completions call with modalities:['image','text']
// (OpenRouter contract). When a caller asks for image output via `auto` (rather than
// pinning a concrete image model), the router resolves to the image slot — a text tier
// would be wrong. Image gen is part of bloc A (OpenMulti owns it), cf ARCHITECTURE.md.
/**
 * Candidats du REPLI VISION — slot `vision` : quand une requête porte une image en
 * ENTRÉE et qu'AUCUN candidat du tier n'est vision-capable, le routeur retombe
 * EXPLICITEMENT ici (jamais un modèle aveugle en silence — le bug mesuré en prod
 * 2026-07-21 : réponse vide facturée). Même précédence que `fast`, AUCUN défaut
 * intégré (la curation est de la config d'exploitation) : slot vide + aucun candidat
 * vision = RouteRefusal('no_vision_model'), erreur claire.
 */
export function visionCandidates(): string[] | null {
  return (
    catalogOverride('vision') ??
    catalogFileSlot('vision') ??
    envList('OPENMULTI_MODELS_VISION') ??
    (process.env.OPENMULTI_MODEL_VISION ? [process.env.OPENMULTI_MODEL_VISION] : null)
  )
}

/**
 * Candidats de la génération d'image — slot `image`, même précédence que `fast` :
 * override admin (à chaud) > fichier catalogue > env pluriel > env singulier
 * (OPENMULTI_MODEL_IMAGE, le nom historique) > défaut neutre. Le PREMIER est servi
 * (sélection déterministe : pas de bandit coût/santé sur la qualité d'image).
 */
export function imageCandidates(): string[] {
  return (
    catalogOverride('image') ??
    catalogFileSlot('image') ??
    envList('OPENMULTI_MODELS_IMAGE') ??
    [process.env.OPENMULTI_MODEL_IMAGE || 'google/gemini-2.5-flash-image']
  )
}

// Modèle d'embeddings par défaut quand l'appelant envoie model:'auto' sur
// /v1/embeddings. Id vérifié sur openrouter.ai/collections/embedding-models
// (2026-06-11) : le standard le moins cher ($0.02/MTok input).
export const EMBEDDING_MODEL = process.env.OPENMULTI_MODEL_EMBEDDING || 'openai/text-embedding-3-small'

export const DEFAULT_TIER: Tier = 'balanced'

export function isTier(v: unknown): v is Tier {
  return v === 'economy' || v === 'balanced' || v === 'quality'
}

const TIERS: Tier[] = ['economy', 'balanced', 'quality']

export interface CatalogEntry {
  model: string
  /** Tiers où ce modèle apparaît comme candidat (hors purpose). */
  tiers: Tier[]
  /** Purposes où ce modèle apparaît ('image' = le modèle de génération d'image). */
  purposes: string[]
}

/**
 * Inventaire des modèles servis (pour GET /v1/models) : candidats de chaque tier,
 * modèles par purpose (intégrés + pilotés par env), et le modèle image. Les purposes
 * découverts via l'env sont dé-manglés par approximation (AGENT -> agent,
 * EDIT_HTML_BLOCK -> edit-html-block) — exact pour les purposes kebab-case
 * conventionnels, cf envName().
 */
export function catalogModels(): CatalogEntry[] {
  const map = new Map<string, CatalogEntry>()
  const add = (model: string, tier?: Tier, purpose?: string) => {
    let e = map.get(model)
    if (!e) {
      e = { model, tiers: [], purposes: [] }
      map.set(model, e)
    }
    if (tier && !e.tiers.includes(tier)) e.tiers.push(tier)
    if (purpose && !e.purposes.includes(purpose)) e.purposes.push(purpose)
  }

  for (const tier of TIERS) for (const m of candidatesFor(tier)) add(m, tier)

  const purposes = new Set<string>(Object.keys(PURPOSE_DEFAULT))
  for (const k of Object.keys(process.env)) {
    const m = /^OPENMULTI_MODELS?_([A-Z0-9_]+)_(ECONOMY|BALANCED|QUALITY)$/.exec(k)
    if (m) purposes.add(m[1]!.toLowerCase().replace(/_/g, '-'))
  }
  for (const slot of [...Object.keys(listCatalogOverrides()), ...Object.keys(catalogFileSlots())]) {
    const m = /^(.+)_(economy|balanced|quality)$/.exec(slot)
    if (m) purposes.add(m[1]!)
  }
  for (const purpose of purposes) {
    for (const tier of TIERS) {
      // Ne lister que les purposes qui ont VRAIMENT un modèle propre sur ce tier
      // (candidatesFor retombe sur le tier sinon, ce qui dupliquerait tout).
      const own = candidatesFor(tier, purpose)
      const base = candidatesFor(tier)
      if (own.join(',') !== base.join(',')) for (const m of own) add(m, undefined, purpose)
    }
  }

  for (const m of imageCandidates()) add(m, undefined, 'image')
  add(EMBEDDING_MODEL, undefined, 'embedding')
  return [...map.values()]
}
