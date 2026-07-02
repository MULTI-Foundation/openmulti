// B2 (docs/PRODUCT-V1.md) : signup self-service agent-natif. Un agent (ou son humain)
// donne un email, reçoit un code, l'échange contre un projet + une clé sk_ plafonnée
// petit (OPENMULTI_SIGNUP_CAP_USD/jour). La vérification email est LE seul clic humain
// du parcours ; tout le reste est scriptable (pensé pour le MCP `signup` à terme).
//
// Postures de sécurité (modèle de menace, plan §Sécurité) :
//   - OPT-IN : OPENMULTI_SIGNUP=1, sinon les routes n'existent pas (404). Zéro régression.
//   - FAIL-CLOSED : sans store partagé sain, 503. On ne crée pas d'identités facturables
//     sur un état volatil (contraire des caps, fail-open, qui protègent un client connu).
//   - Anti-énumération : POST /signup répond la même chose que l'email soit connu ou non ;
//     les échecs de /verify sont un 400 générique unique (invalide, expiré, épuisé).
//   - Le code n'est JAMAIS stocké en clair (sha256), comparé en temps constant, TTL 15 min,
//     5 tentatives max, usage unique.
//   - L'email n'est JAMAIS persisté : seule son empreinte (sha256 normalisé) sert de clé
//     (dédup + mapping projet). Un dump Redis ne donne pas la liste des emails.
//   - Abus : rate limit par IP (fenêtre fixe 60s, plus stricte que le trafic) + plafond
//     GLOBAL d'envois/jour (borne le coût même si les IPs tournent). L'IP vient de
//     X-Forwarded-For (posé par l'ingress) : spoofable hors proxy — le plafond global
//     est le garde-fou de dernier ressort.
//   - Une identité email = UN projet, pour toujours : re-vérifier plus tard émet une
//     nouvelle clé du MÊME projet (rotation self-service, continuité de facturation),
//     jamais un projet neuf (sinon l'alias +tag ne servirait à rien).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { storeClient, storeHealthy, type StoreClient } from './store.js'
import { config } from './config.js'
import { createKey, listCaps, SIGNUP_PROJECT_PREFIX } from './keys.js'
import { sendEmail } from './email.js'
import { log } from './log.js'
import { windowId } from './ratelimit.js'

const PENDING_PREFIX = 'signup:pending:' // -> JSON { codeHash, attempts, exp } (EX)
const PROJECT_PREFIX = 'signup:project:' // empreinte email -> projet (persistant)
const COUNT_PREFIX = 'signup:count:' // jour UTC -> envois (EX 48h)
const RL_PREFIX = 'signup:rl:' // ip:fenêtre -> compteur (EX 2 min)

const CODE_TTL_S = 15 * 60
const MAX_ATTEMPTS = 5
// Alphabet sans ambiguïté (pas de 0/O/1/I/L) : un humain recopie depuis son mail.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LEN = 8 // ~39 bits — large pour 5 essais / 15 min

// RFC-lite volontairement conservateur : on préfère refuser un email exotique valide
// que laisser passer un vecteur d'injection vers le provider d'envoi.
const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,189}\.[a-z]{2,24}$/

interface Pending {
  codeHash: string
  attempts: number
  exp: number // epoch ms — TTL absolu, indépendant des réécritures (tentatives)
}

/** Normalisation d'affichage (envoi) : trim + minuscules. */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase()
  return EMAIL_RE.test(email) ? email : null
}

/** Identité de dédup : normalisé, SANS le +tag de la partie locale (sinon un même
 * humain fabrique des projets à l'infini avec user+1@, user+2@…). */
export function emailIdentity(email: string): string {
  const at = email.lastIndexOf('@')
  const local = email.slice(0, at).replace(/\+.*$/, '')
  return `${local}${email.slice(at)}`
}

const identityHash = (email: string) =>
  createHash('sha256').update(emailIdentity(email)).digest('hex').slice(0, 32)

function generateCode(): string {
  const bytes = randomBytes(CODE_LEN)
  let code = ''
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length]
  return code
}

const hashCode = (code: string) => createHash('sha256').update(code).digest('hex')

function safeHashEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** Le store utilisable pour le signup : sain ET doté des méthodes clé simple.
 * (get/set/del sont optionnelles sur StoreClient pour épargner les fakes de test ;
 * un client qui ne les a pas = store indisponible, fail-closed.) */
function signupStore(): (StoreClient & Required<Pick<StoreClient, 'get' | 'set' | 'del'>>) | null {
  const c = storeClient()
  if (!c || !storeHealthy() || !c.get || !c.set || !c.del) return null
  return c as StoreClient & Required<Pick<StoreClient, 'get' | 'set' | 'del'>>
}

export type SignupStart =
  | { ok: true }
  | { ok: false; status: 429 | 503; retryAfterS?: number }

export type SignupVerify =
  | { ok: true; key: string; project: string; capUsdPerDay: number }
  | { ok: false; status: 400 | 429 | 503 }

/** Fenêtre fixe 60s par IP et PAR ÉTAPE (start/verify : profils d'abus différents,
 * un parcours complet ne doit pas consommer le budget de l'autre étape), dans le
 * store (multi-pod). Fail-closed : erreur = refus. */
async function ipAllowed(c: NonNullable<ReturnType<typeof signupStore>>, stage: 'start' | 'verify', ip: string): Promise<boolean> {
  const id = `${RL_PREFIX}${stage}:${ip}:${windowId(Date.now())}`
  const count = await c.incr(id)
  if (count === 1) await c.expire(id, 120)
  return count <= config.signup.ratePerMin
}

const utcDay = () => new Date().toISOString().slice(0, 10)

/** Étape 1 : email -> code envoyé. La réponse ne révèle jamais si l'email est connu. */
export async function startSignup(rawEmail: string, ip: string): Promise<SignupStart> {
  const email = normalizeEmail(rawEmail)
  // Email invalide : même réponse qu'un succès (anti-énumération du format aussi) —
  // rien à envoyer, rien à stocker, l'appelant honnête verra qu'aucun mail n'arrive.
  if (!email) return { ok: true }

  const c = signupStore()
  if (!c) return { ok: false, status: 503 }

  try {
    if (!(await ipAllowed(c, 'start', ip))) {
      log.warn('signup_rate_limited', { ip })
      return { ok: false, status: 429, retryAfterS: 60 }
    }

    // Plafond global d'envois par jour UTC (le garde-fou que la limite IP ne voit pas).
    const countKey = `${COUNT_PREFIX}${utcDay()}`
    const sent = await c.incr(countKey)
    if (sent === 1) await c.expire(countKey, 48 * 3600)
    if (sent > config.signup.perDay) {
      log.warn('signup_daily_cap_reached', { day: utcDay(), cap: config.signup.perDay })
      return { ok: false, status: 429, retryAfterS: 3600 }
    }

    const code = generateCode()
    const pending: Pending = { codeHash: hashCode(code), attempts: 0, exp: Date.now() + CODE_TTL_S * 1000 }
    await c.set(`${PENDING_PREFIX}${identityHash(email)}`, JSON.stringify(pending), { EX: CODE_TTL_S + 60 })

    const delivered = await sendEmail({
      to: email,
      subject: 'Your OpenMulti verification code',
      text: `Your OpenMulti verification code: ${code}\n\nIt expires in 15 minutes. If you did not request it, ignore this email.`,
    })
    if (!delivered) return { ok: false, status: 503 }

    log.info('signup_code_sent', { emailHash: identityHash(email) })
    return { ok: true }
  } catch (e) {
    log.warn('signup_store_error', { error: e instanceof Error ? e.message : String(e) })
    return { ok: false, status: 503 }
  }
}

/** Étape 2 : email + code -> projet + clé (le secret n'est retourné qu'ici). */
export async function verifySignup(rawEmail: string, rawCode: string, ip: string): Promise<SignupVerify> {
  const email = normalizeEmail(rawEmail)
  const code = rawCode.trim().toUpperCase()
  if (!email || !/^[A-Z2-9]{1,16}$/.test(code)) return { ok: false, status: 400 }

  const c = signupStore()
  if (!c) return { ok: false, status: 503 }

  try {
    if (!(await ipAllowed(c, 'verify', ip))) return { ok: false, status: 429 }

    const hash = identityHash(email)
    const pendingKey = `${PENDING_PREFIX}${hash}`
    const raw = await c.get(pendingKey)
    if (!raw) return { ok: false, status: 400 }

    let pending: Pending
    try {
      pending = JSON.parse(raw) as Pending
    } catch {
      await c.del(pendingKey)
      return { ok: false, status: 400 }
    }

    if (Date.now() > pending.exp || pending.attempts >= MAX_ATTEMPTS) {
      await c.del(pendingKey)
      return { ok: false, status: 400 }
    }

    if (!safeHashEqual(hashCode(code), pending.codeHash)) {
      pending.attempts += 1
      // Réécrit avec le TTL restant approximé par l'exp absolu (le champ exp fait foi).
      await c.set(pendingKey, JSON.stringify(pending), { EX: CODE_TTL_S + 60 })
      return { ok: false, status: 400 }
    }

    // Code bon : usage unique.
    await c.del(pendingKey)

    // Une identité email = un projet, pour toujours (nouvelle clé du même projet sinon).
    const projectKey = `${PROJECT_PREFIX}${hash}`
    let project = await c.get(projectKey)
    const isNewProject = !project
    if (!project) {
      project = `${SIGNUP_PROJECT_PREFIX}${randomBytes(5).toString('hex')}`
      await c.set(projectKey, project)
    }

    // Le cap par défaut n'est posé QU'À la création du projet : une re-vérification
    // (clé perdue -> rotation) ne doit pas écraser un plafond relevé par l'admin.
    const created = await createKey(project, isNewProject ? config.signup.capUsdPerDay : undefined, 'self-service signup')
    if ('error' in created) {
      log.error('signup_key_creation_failed', { project, error: created.error })
      return { ok: false, status: 503 }
    }

    log.info('signup_verified', { emailHash: hash, project })
    // Cap réellement en vigueur (une rotation n'a pas touché un cap relevé par l'admin).
    const capUsdPerDay = listCaps()[project] ?? config.signup.capUsdPerDay
    return { ok: true, key: created.key, project, capUsdPerDay }
  } catch (e) {
    log.warn('signup_store_error', { error: e instanceof Error ? e.message : String(e) })
    return { ok: false, status: 503 }
  }
}
