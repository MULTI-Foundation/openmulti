// Envoi d'email — seam minimal pour la vérification signup (B2). Deux providers :
//   - 'log' (défaut) : n'envoie rien, trace l'intention en log structuré. Suffisant en
//     dev/staging ; en prod c'est un mauvais choix (le code de vérification part dans
//     les logs) — poser OPENMULTI_EMAIL_PROVIDER=resend.
//   - 'resend' : API Resend (https://resend.com), RESEND_API_KEY requis.
// Injectable pour les tests (_setEmailSenderForTest) : la suite ne fait aucun réseau.

import { config } from './config.js'
import { log } from './log.js'

export interface EmailMessage {
  to: string
  subject: string
  text: string
}

export type EmailSender = (msg: EmailMessage) => Promise<boolean>

async function resendSender(msg: EmailMessage): Promise<boolean> {
  if (!config.email.resendApiKey) {
    log.error('email_resend_missing_key', {})
    return false
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.email.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: config.email.from, to: [msg.to], subject: msg.subject, text: msg.text }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      // Jamais le corps upstream en clair au-delà du log serveur (même règle qu'OM-07).
      log.warn('email_send_failed', { status: res.status })
      return false
    }
    return true
  } catch (e) {
    log.warn('email_send_error', { error: e instanceof Error ? e.message : String(e) })
    return false
  }
}

async function logSender(msg: EmailMessage): Promise<boolean> {
  // Le contenu (code inclus) part dans les logs : réservé au dev/staging.
  log.info('email_log_provider', { to: msg.to, subject: msg.subject, text: msg.text })
  return true
}

let sender: EmailSender | null = null

/** L'expéditeur actif (résolu au premier usage pour laisser les tests injecter avant). */
export function sendEmail(msg: EmailMessage): Promise<boolean> {
  if (!sender) sender = config.email.provider === 'resend' ? resendSender : logSender
  return sender(msg)
}

/** Injection test : remplace l'expéditeur (null = retour au réel). */
export function _setEmailSenderForTest(s: EmailSender | null): void {
  sender = s
}
