// Quarantaine (chemin d'accès, modèle) — vécu prod 2026-07-30 : openai/gpt-oss-120b:nitro
// élu en direct OpenAI (modèle absent du vendor) et qwen/qwen3-coder-plus en direct Qwen
// (quota) échouaient à 100 %, et la ré-exploration du bandit continuait d'y envoyer du
// trafic (alerte HighErrorRate). Un 4xx d'IDENTITÉ du chemin (401 clé, 403 quota/droits,
// 404 modèle absent) prouve que la paire (chemin, modèle) ne peut pas servir — inutile de
// re-payer l'aller-retour à chaque élection : la paire est écartée de l'élection pendant
// un TTL (OPENMULTI_PATH_QUARANTINE_TTL_S, défaut 600 s, 0 = coupé), puis re-sondée
// naturellement à l'expiration. Les 400/422 (forme de la requête, propre à CHAQUE
// requête — vécu prod 2026-07-17 : DeepSeek reasoning_content, Z.ai content parts) ne
// quarantainent PAS : le failover par requête (routes/chat.ts) les couvre déjà.
// OpenRouter n'est jamais quarantainé : c'est le chemin de référence — un 4xx là-bas
// incrimine la requête, pas le chemin.

import { log } from './log.js'
import { recordPathQuarantine } from './metrics.js'

const SEP = '␟'
const TTL_MS = Math.max(0, Number(process.env.OPENMULTI_PATH_QUARANTINE_TTL_S ?? 600)) * 1000
// Borne de cardinalité (leçon F8/F9) : `model` peut être un id épinglé par l'appelant,
// un flot d'ids uniques ne doit pas faire grossir la Map sans limite.
const MAX_ENTRIES = 500
// Statuts qui incriminent le CHEMIN (identité/droits/catalogue du vendor), pas la requête.
const PATH_STATUSES = new Set([401, 403, 404])

const until = new Map<string, number>()

/** Marque la paire (chemin, modèle) inservable si `status` incrimine le chemin.
 *  Renvoie true si la quarantaine a été posée. */
export function markPathUnservable(provider: string, model: string, status: number, now = Date.now()): boolean {
  if (TTL_MS === 0 || provider === 'openrouter' || !PATH_STATUSES.has(status)) return false
  const id = `${provider}${SEP}${model}`
  if (!until.has(id) && until.size >= MAX_ENTRIES) {
    const oldest = until.keys().next().value
    if (oldest !== undefined) until.delete(oldest)
  }
  until.set(id, now + TTL_MS)
  recordPathQuarantine(model, provider)
  log.warn('path_quarantined', { provider, model, status, ttlS: TTL_MS / 1000 })
  return true
}

export function isPathQuarantined(provider: string, model: string, now = Date.now()): boolean {
  const id = `${provider}${SEP}${model}`
  const t = until.get(id)
  if (t === undefined) return false
  if (now >= t) {
    until.delete(id)
    return false
  }
  return true
}

/** Réservé aux tests. */
export function _resetPathQuarantine(): void {
  until.clear()
}
