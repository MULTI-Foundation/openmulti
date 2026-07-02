// GET /v1/balance — la vue compte de l'APPELANT (et de lui seul : le projet vient de
// sa clé, jamais d'un paramètre). C'est la brique d'auto-conscience budgétaire d'un
// agent : solde prépayé, plafond du jour, et le lien de recharge à tendre à son humain
// (rail Stripe ; le rail x402 s'y branchera aussi). Zéro I/O : mêmes caches mémoire
// que les gardes du chemin chaud, donc ce que l'agent voit = ce qui l'autorise.

import { Hono } from 'hono'
import { keyLabel } from '../metrics.js'
import { projectAccount, topupUrlFor } from '../keys.js'
import type { AppEnv } from '../types.js'

export const account = new Hono<AppEnv>()

account.get('/v1/balance', (c) => {
  const project = keyLabel(c.get('apiKey'))
  const acct = projectAccount(project)
  const topupUrl = topupUrlFor(project)
  return c.json({
    object: 'balance',
    project,
    prepaid: acct.prepaid,
    ...(acct.creditsUsd !== undefined ? { credits_usd: acct.creditsUsd, spent_usd: acct.spentUsd, balance_usd: acct.balanceUsd } : {}),
    ...(acct.capUsdPerDay !== undefined ? { cap_usd_per_day: acct.capUsdPerDay, spent_today_usd: acct.spentTodayUsd } : {}),
    ...(topupUrl ? { topup_url: topupUrl } : {}),
  })
})
