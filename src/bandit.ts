// Vue « bandit » (stats amorties par bras), nourrit la stratégie 'smart' de select.ts.
// Extraite de metrics.ts (R-1) : les compteurs Prometheus restent MONOTONES et locaux
// au pod ; le bandit, lui, est un ÉTAT D'APPRENTISSAGE qui doit être PARTAGÉ entre les
// replicas (prod = 2 pods) et SURVIVRE aux rollouts — sinon apprentissage split-brain
// et cold start à chaque déploiement (ENGINEERING_BACKLOG R-1).
//
// Mécanique (inchangée, bandit amorti par observation) : à chaque observation, les bras
// en PORTÉE sont multipliés par RHO = 1 - 1/OPENMULTI_SMART_DECAY_WINDOW, puis
// l'observation est ajoutée au bras servi. Effets : le récent pèse plus que l'ancien ;
// le décompte amorti d'un bras délaissé glisse vers 0 et re-déclenche l'exploration.
//
// Portée de la décote (R-2) : quand l'observation connaît son ensemble de candidats
// (`candidates`, la décision de routage), seuls les bras de CES modèles (tous chemins)
// sont amortis — le trafic d'un tier n'accélère plus l'oubli des autres. Sans
// candidats (images, embeddings, enregistrements legacy) : décote globale, comme avant.
//
// Partage (R-1) : même philosophie que keys.ts / catalog-overrides.ts — zéro I/O sur le
// chemin chaud. Chaque observation est appliquée EN MÉMOIRE (immédiat, et seul
// comportement sans REDIS_URL) ET poussée fire-and-forget au store via un script Lua
// atomique (décote + ajout en un pas, pas de race multi-pod). Un refresh périodique
// remplace la vue mémoire par l'état partagé (convergence ≤ un refresh ; au boot, le
// premier refresh = pas de cold start). Store down : on garde la vue locale.
//
// Chaque bras porte aussi l'horodatage de sa DERNIÈRE ERREUR : select.ts s'en sert pour
// re-sonder un bras malade après un délai (sonde de guérison temporelle) — à faible
// trafic, attendre que son décompte amorti retombe sous le plancher prendrait des
// semaines (~600 observations à WINDOW=200).

import { storeClient, storeHealthy } from './store.js'
import { log } from './log.js'

export interface ModelAggregate {
  requests: number
  errors: number
  costUsd: number
  /** Horodatage (ms epoch) de la dernière erreur observée sur ce bras, absent si jamais. */
  lastErrorAt?: number
}

export interface BanditObservation {
  provider: string
  /** Label de modèle DÉJÀ borné (metrics.ts labelModel). */
  model: string
  error: boolean
  costUsd: number
  /** Modèles comparés par la décision de routage (labels bornés). Absent = décote globale. */
  candidates?: string[]
  /** Horodatage de l'observation (injectable pour les tests). */
  now?: number
}

// OPENMULTI_SMART_DECAY_WINDOW est l'horizon effectif en nombre de requêtes
// (RHO = 1 - 1/window) ; 0 = pas d'amortissement (stats à vie, comportement legacy).
export const DECAY_WINDOW = Math.max(0, Number(process.env.OPENMULTI_SMART_DECAY_WINDOW ?? 200))
const RHO = DECAY_WINDOW > 0 ? 1 - 1 / DECAY_WINDOW : 1

// Partage via le store : actif dès qu'un client existe, OPENMULTI_BANDIT_SHARED=0 le coupe
// (vue par pod, comportement historique).
const SHARED = process.env.OPENMULTI_BANDIT_SHARED !== '0'
const REFRESH_MS = Math.max(1000, Number(process.env.OPENMULTI_KEYS_REFRESH_MS ?? 10_000))
const HASH_KEY = 'bandit:arms'
// Séparateur chemin|modèle dans le champ du hash. '|' est hors charset des ids de modèle
// (catalog-overrides MODEL_RE) et des noms de chemin ; le label 'other' n'en porte pas.
const FIELD_SEP = '|'
// En deçà, un bras amorti est purgé du hash (bornage de sa taille) ; la vue mémoire fait
// de même pour rester identique à l'état partagé.
const PRUNE_BELOW = 1e-4

// Clé mémoire : `${provider}|${model}` — le bandit distingue les chemins d'accès
// (étape 4 : arbitrer moonshot-direct vs openrouter pour un même modèle).
let arms = new Map<string, ModelAggregate>()
// Horloge du bandit (horodatages d'erreur, sonde temporelle de select.ts) — UNE seule
// source, injectable, pour que les tests en boucle fermée soient déterministes.
let clock = () => Date.now()
export function banditNow(): number {
  return clock()
}
/** Test helper : horloge injectée (null = retour à Date.now). */
export function _setBanditClockForTests(c: (() => number) | null): void {
  clock = c ?? (() => Date.now())
}
let timer: ReturnType<typeof setInterval> | null = null
let pushDrops = 0

const armId = (provider: string, model: string) => `${provider}${FIELD_SEP}${model}`
const armModel = (id: string) => id.slice(id.indexOf(FIELD_SEP) + 1)

/** Stats amorties d'un modèle, tous projets ET chemins d'accès confondus (vue de la
 * sélection de modèle par tier — le tier ne se soucie pas du chemin). */
export function modelAggregate(model: string): ModelAggregate {
  const out: ModelAggregate = { requests: 0, errors: 0, costUsd: 0 }
  for (const [id, b] of arms) {
    if (armModel(id) === model) {
      out.requests += b.requests
      out.errors += b.errors
      out.costUsd += b.costUsd
      if (b.lastErrorAt != null && (out.lastErrorAt == null || b.lastErrorAt > out.lastErrorAt)) out.lastErrorAt = b.lastErrorAt
    }
  }
  return out
}

/** Stats amorties d'un (chemin d'accès, modèle) précis — la vue de l'arbitrage de
 * chemin (providers/index.ts, mode 'smart'). */
export function pathAggregate(provider: string, model: string): ModelAggregate {
  const b = arms.get(armId(provider, model))
  return b ? { ...b } : { requests: 0, errors: 0, costUsd: 0 }
}

/** Observations perdues côté store (push Lua en échec). Exposé sur /metrics. */
export function banditPushDrops(): number {
  return pushDrops
}

export function observe(o: BanditObservation): void {
  const scope = o.candidates ? new Set(o.candidates) : null
  const id = armId(o.provider, o.model)
  if (RHO < 1) {
    for (const [k, b] of arms) {
      if (k !== id && scope && !scope.has(armModel(k))) continue
      b.requests *= RHO
      b.errors *= RHO
      b.costUsd *= RHO
      if (k !== id && b.requests < PRUNE_BELOW) arms.delete(k)
    }
  }
  let b = arms.get(id)
  if (!b) {
    b = { requests: 0, errors: 0, costUsd: 0 }
    arms.set(id, b)
  }
  b.requests += 1
  if (o.error) {
    b.errors += 1
    b.lastErrorAt = o.now ?? banditNow()
  }
  if (o.costUsd) b.costUsd += o.costUsd
  pushToStore(o, id)
}

// Script Lua : décote des bras en portée + ajout de l'observation, en un pas atomique.
// Valeur d'un champ : `requests|errors|costUsd|lastErrorAt` (lastErrorAt vide si jamais).
// ARGV : rho, bras, erreur (0/1), coût, now (ms), portée ('*' = tous, sinon modèles
// séparés par des virgules), seuil de purge.
const OBSERVE_LUA = `
local key = KEYS[1]
local rho = tonumber(ARGV[1])
local arm = ARGV[2]
local err = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local now = ARGV[5]
local scope = ARGV[6]
local prune = tonumber(ARGV[7])
local scoped = nil
if scope ~= '*' then
  scoped = {}
  for m in string.gmatch(scope, '[^,]+') do scoped[m] = true end
end
local all = redis.call('HGETALL', key)
local cur = nil
local sets = {}
for i = 1, #all, 2 do
  local f = all[i]
  local r, e, c, le = string.match(all[i + 1], '^([^|]*)|([^|]*)|([^|]*)|(.*)$')
  r = tonumber(r) or 0
  e = tonumber(e) or 0
  c = tonumber(c) or 0
  le = le or ''
  if f == arm then
    cur = { r = r, e = e, c = c, le = le }
  else
    local model = string.match(f, '^[^|]*|(.*)$') or f
    if scoped == nil or scoped[model] then
      r = r * rho
      e = e * rho
      c = c * rho
      if r < prune then
        redis.call('HDEL', key, f)
      else
        sets[#sets + 1] = f
        sets[#sets + 1] = string.format('%.17g|%.17g|%.17g|%s', r, e, c, le)
      end
    end
  end
end
if cur == nil then cur = { r = 0, e = 0, c = 0, le = '' } end
local le = cur.le
if err > 0 then le = now end
sets[#sets + 1] = arm
sets[#sets + 1] = string.format('%.17g|%.17g|%.17g|%s', cur.r * rho + 1, cur.e * rho + err, cur.c * rho + cost, le)
for i = 1, #sets, 2 do
  redis.call('HSET', key, sets[i], sets[i + 1])
end
return #sets / 2
`

function pushToStore(o: BanditObservation, id: string): void {
  if (!SHARED) return
  const c = storeClient()
  if (!c || !c.eval || !storeHealthy()) return
  const scope = o.candidates ? o.candidates.join(',') : '*'
  c.eval(OBSERVE_LUA, {
    keys: [HASH_KEY],
    arguments: [String(RHO), id, o.error ? '1' : '0', String(o.costUsd || 0), String(o.now ?? banditNow()), scope || '*', String(PRUNE_BELOW)],
  }).catch((e: unknown) => {
    pushDrops += 1
    log.warn('bandit_store_push_failed', { error: e instanceof Error ? e.message : String(e) })
  })
}

/** Remplace la vue mémoire par l'état partagé. Fail-open : store absent/malade = on garde
 * la vue locale. Exporté pour les tests (le timer l'appelle toutes les REFRESH_MS). */
export async function refreshBanditFromStore(): Promise<void> {
  if (!SHARED) return
  const c = storeClient()
  if (!c || !storeHealthy()) return
  try {
    const hash = await c.hGetAll(HASH_KEY)
    const next = new Map<string, ModelAggregate>()
    for (const [id, v] of Object.entries(hash)) {
      const [r, e, cost, le] = v.split('|')
      const requests = Number(r)
      const errors = Number(e)
      const costUsd = Number(cost)
      if (!Number.isFinite(requests) || !Number.isFinite(errors) || !Number.isFinite(costUsd)) {
        log.warn('bandit_store_bad_entry', { arm: id })
        continue
      }
      const agg: ModelAggregate = { requests, errors, costUsd }
      const lastErrorAt = Number(le)
      if (le && Number.isFinite(lastErrorAt)) agg.lastErrorAt = lastErrorAt
      next.set(id, agg)
    }
    arms = next
  } catch (e) {
    log.warn('bandit_store_refresh_failed', { error: e instanceof Error ? e.message : String(e) })
  }
}

/** Boot : premier refresh (reprise de l'état après rollout) + rafraîchissement périodique
 * (unref : ne retient pas le process). No-op sans store ou si le partage est coupé. */
export function initBanditStore(): void {
  if (!SHARED || !storeClient()) return
  void refreshBanditFromStore()
  timer = setInterval(() => void refreshBanditFromStore(), REFRESH_MS)
  timer.unref()
}

/** Test helper : vide la vue mémoire et arrête le timer. */
export function _resetBandit(): void {
  arms = new Map()
  clock = () => Date.now()
  pushDrops = 0
  if (timer) clearInterval(timer)
  timer = null
}

/** Test helper : le script Lua tel qu'envoyé au store (pour le vérifier contre un vrai Redis). */
export const _OBSERVE_LUA_FOR_TESTS = OBSERVE_LUA
export const _BANDIT_HASH_KEY_FOR_TESTS = HASH_KEY
