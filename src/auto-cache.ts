// Auto-marquage `cache_control` (prompt caching Anthropic) — OPT-IN par objectif d'appel.
// Par défaut OpenMulti ne pose jamais le marqueur : l'écriture de cache coûte 1.25x et
// seul l'appelant sait s'il relira le préfixe. Mais un appel `purpose: agent` (boucle
// d'outils : même system, mêmes tools, conversation qui s'allonge) relit son préfixe à
// chaque tour — le marqueur y est presque toujours rentable (relecture 0.1x).
//
// OPENMULTI_ANTHROPIC_AUTO_CACHE = liste d'objectifs (CSV, ex. `agent`) ou `*` (tous) ;
// vide/absent = désactivé. Ne s'applique QUE si l'appelant n'a posé aucun marqueur
// lui-même (sa stratégie prime), et seulement sur le chemin direct Anthropic
// (anthropic-translate.ts). Le devis (plan.ts) borne alors l'entrée au tarif d'écriture.

import type { ChatRequest } from './types.js'

const RAW = (process.env.OPENMULTI_ANTHROPIC_AUTO_CACHE ?? '').trim()
const ALL = RAW === '*'
const PURPOSES = new Set(RAW.split(',').map((s) => s.trim()).filter((s) => s && s !== '*'))

export function autoCacheEnabled(): boolean {
  return ALL || PURPOSES.size > 0
}

/** L'auto-marquage s'applique-t-il à cette requête ? (objectif opt-in, aucun marqueur posé par l'appelant) */
export function autoCacheApplies(req: ChatRequest): boolean {
  if (!autoCacheEnabled()) return false
  const purpose = req.openmulti?.purpose
  if (!ALL && (!purpose || !PURPOSES.has(purpose))) return false
  // Détection textuelle large (même critère que le devis) : un marqueur de l'appelant,
  // où qu'il soit, désactive l'auto-marquage.
  const r = req as unknown as Record<string, unknown>
  return !JSON.stringify({ messages: r.messages, tools: r.tools }).includes('"cache_control"')
}
