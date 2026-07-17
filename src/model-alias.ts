// Résolution STRICTE des noms de modèles nus (sans '/') vers l'id canonique
// « vendeur/modele ». Le piège historique (fermé ici) : un nom nu n'était ni un pin
// (looksConcrete exige un '/') ni un alias de tier, et retombait EN SILENCE sur le
// tier par défaut — l'appelant demandait « kimi-k2.6 », recevait le primaire balanced,
// et était facturé sans aucune erreur. Désormais : correspondance UNIQUE sur le
// suffixe d'un modèle connu = pin résolu ; zéro ou plusieurs correspondances = refus
// explicite (RouteRefusal → 400 dans router.ts), jamais un repli silencieux.
//
// Périmètre des modèles « connus » = catalogue (tous tiers/purposes) ∪ modèles
// tarifés ∪ image/embedding — le même ensemble que l'allowlist de labels de
// metrics.ts. Pas de cache : le chemin nom-nu est l'exception (un pin court, ou une
// erreur) et le catalogue bouge à chaud (overrides admin ≤10s) — on recalcule à la
// demande, la résolution reste pure et testable via le paramètre `ids`.

import { pricedModelIds } from './pricing.js'
import { catalogModels, IMAGE_MODEL, EMBEDDING_MODEL } from './catalog.js'

export type BareModelResolution =
  | { kind: 'resolved'; model: string }
  | { kind: 'ambiguous'; matches: string[] }
  | { kind: 'unknown' }

/** Modèles connus du gateway (catalogue ∪ tarifés ∪ image/embedding), dédupliqués. */
export function knownModelIds(): string[] {
  const s = new Set<string>(pricedModelIds())
  for (const e of catalogModels()) s.add(e.model)
  s.add(IMAGE_MODEL)
  s.add(EMBEDDING_MODEL)
  return [...s]
}

/**
 * Résout un nom nu contre les ids connus : match exact sur le suffixe après le
 * premier '/' (« kimi-k2.6 » → « moonshotai/kimi-k2.6 »). Sensible à la casse —
 * un refus explicite vaut mieux qu'une devinette sur un id approximatif.
 */
export function resolveBareModel(name: string, ids: readonly string[] = knownModelIds()): BareModelResolution {
  const matches = ids
    .filter((id) => {
      const slash = id.indexOf('/')
      return slash > 0 && id.slice(slash + 1) === name
    })
    .sort()
  if (matches.length === 1) return { kind: 'resolved', model: matches[0]! }
  if (matches.length > 1) return { kind: 'ambiguous', matches }
  return { kind: 'unknown' }
}
