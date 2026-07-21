// Résolution STRICTE des noms de modèles nus (sans '/') vers l'id canonique
// « vendeur/modele », plus la résolution de FAMILLE (« claude » → le meilleur Claude
// du catalogue courant). Le piège historique (fermé ici) : un nom nu n'était ni un pin
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
import { catalogModels, candidatesFor, fastCandidates, imageCandidates, visionCandidates, EMBEDDING_MODEL } from './catalog.js'

export type BareModelResolution =
  | { kind: 'resolved'; model: string }
  | { kind: 'ambiguous'; matches: string[] }
  | { kind: 'unknown' }

/** Modèles connus du gateway (catalogue ∪ tarifés ∪ image/embedding), dédupliqués. */
export function knownModelIds(): string[] {
  const s = new Set<string>(pricedModelIds())
  for (const e of catalogModels()) s.add(e.model)
  for (const m of imageCandidates()) s.add(m)
  // Les slots hors tiers (fast, vision) font partie des modèles servis : leurs
  // membres sont nommables (nom nu/famille) comme les autres.
  for (const m of fastCandidates() ?? []) s.add(m)
  for (const m of visionCandidates() ?? []) s.add(m)
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

/** Ordre de préférence « meilleur de la famille » : les candidats du catalogue du
 * tier le plus haut vers le plus bas, dans l'ordre de chaque slot (primaire d'abord).
 * C'est la curation courante qui définit « le meilleur Claude du moment » — pas une
 * table figée dans le code. */
export function familyRank(): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const tier of ['quality', 'balanced', 'economy'] as const) {
    for (const m of candidatesFor(tier)) {
      if (!seen.has(m)) {
        seen.add(m)
        out.push(m)
      }
    }
  }
  return out
}

/**
 * Résolution d'un nom de FAMILLE (« claude » → « anthropic/claude-opus-4.8 ») : match
 * de préfixe sur la partie modèle, borné à une frontière `-` ou `.` (« clau » ne
 * matche pas « claude-… », « claude » ne matche pas « claudex-1 »). Une seule
 * correspondance = résolue ; plusieurs = le mieux classé du catalogue courant gagne
 * (familyRank) ; plusieurs SANS aucun membre au catalogue = ambiguë (refus explicite,
 * jamais une devinette). Sensible à la casse, comme resolveBareModel.
 */
export function resolveFamilyModel(
  name: string,
  ids: readonly string[] = knownModelIds(),
  rank: readonly string[] = familyRank(),
): BareModelResolution {
  const matches = ids
    .filter((id) => {
      const slash = id.indexOf('/')
      if (slash <= 0) return false
      const model = id.slice(slash + 1)
      if (!model.startsWith(name)) return false
      const boundary = model[name.length]
      return boundary === undefined || boundary === '-' || boundary === '.'
    })
    .sort()
  if (matches.length === 0) return { kind: 'unknown' }
  if (matches.length === 1) return { kind: 'resolved', model: matches[0]! }
  for (const preferred of rank) if (matches.includes(preferred)) return { kind: 'resolved', model: preferred }
  return { kind: 'ambiguous', matches }
}
