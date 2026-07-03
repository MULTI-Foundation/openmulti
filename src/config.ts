// Centralized env config. Fail fast on missing required secrets.

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required`)
  return v
}

export const config = {
  openrouter: {
    apiKey: required('OPENROUTER_API_KEY'),
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  },
  // Chemin d'accès direct Moonshot/Kimi (étape 3 de la spec multi-provider). La clé
  // est OPTIONNELLE : sans elle, tout passe par OpenRouter (défaut iso). Endpoint
  // vérifié 2026-06-10 : platform.kimi.ai/docs/api/chat.
  moonshot: {
    apiKey: process.env.MOONSHOT_API_KEY || '',
    baseUrl: process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.ai/v1',
  },
  // Autres chemins directs OpenAI-compatibles (spec multi-provider §3). Mêmes règles
  // que Moonshot : clé OPTIONNELLE (vide = fallback OpenRouter), activés par
  // OPENMULTI_PROVIDER_<VENDOR>=direct|smart. Endpoints/ids/prix vérifiés le 2026-06-22
  // contre les docs officielles (cf src/pricing.ts).
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  },
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    // Base SANS /v1 (canonique chez DeepSeek ; /chat/completions est ajouté par la fabrique).
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  },
  mistral: {
    apiKey: process.env.MISTRAL_API_KEY || '',
    baseUrl: process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1',
  },
  zai: {
    apiKey: process.env.ZAI_API_KEY || '',
    baseUrl: process.env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4',
  },
  // Qwen (Alibaba DashScope, mode OpenAI-compatible). Surface INTERNATIONALE (Singapour).
  // Endpoint/ids/prix vérifiés le 2026-06-23. Clé région-spécifique.
  qwen: {
    apiKey: process.env.QWEN_API_KEY || '',
    baseUrl: process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  },
  // Anthropic DIRECT (spec multi-provider §5) — seul provider NON OpenAI-shape : API
  // /v1/messages, auth x-api-key + anthropic-version, traduction OpenAI<->Anthropic.
  // max_tokens est REQUIS côté Anthropic : défaut quand l'appelant ne le pose pas.
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    version: process.env.ANTHROPIC_VERSION || '2023-06-01',
    defaultMaxTokens: Math.max(1, Number(process.env.OPENMULTI_ANTHROPIC_DEFAULT_MAX_TOKENS ?? 8192)),
  },
  // Attribution headers forwarded to the upstream provider.
  referer: process.env.OPENMULTI_REFERER || 'https://openmulti.ai',
  title: process.env.OPENMULTI_TITLE || 'OpenMulti',
  port: Number(process.env.PORT || 8080),
  // Static API key allowlist for v0. Each consuming project gets its own key.
  apiKeys: (process.env.OPENMULTI_API_KEYS || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean),
  // Max retries on a transient upstream failure (same model). 0 disables. Only ever
  // fires before any byte reaches the client, so it's safe for stream + non-stream.
  maxRetries: Math.max(0, Number(process.env.OPENMULTI_MAX_RETRIES ?? 2)),
  // Default selection strategy among a tier's candidates. 'default' = first candidate
  // (iso-comportement). Per-request override via openmulti.route. See select.ts.
  defaultRoute: (process.env.OPENMULTI_DEFAULT_ROUTE === 'smart' ? 'smart' : 'default') as 'default' | 'smart',
  // OM-02: reject a request whose declared Content-Length exceeds this (bytes). The
  // 8 MiB default is a safety net far above realistic proxy traffic; tune as needed.
  maxBodyBytes: Math.max(0, Number(process.env.OPENMULTI_MAX_BODY_BYTES ?? 8_388_608)),
  // OM-01: per-key request rate limit over a 60s window. 0 = disabled (default).
  rateLimitPerMin: Math.max(0, Number(process.env.OPENMULTI_RATE_LIMIT_PER_MIN ?? 0)),
  // OM-03: dedicated ops token for GET /metrics. Empty = fall back to caller-key auth
  // (current behavior). Set it in any deployed env to stop cross-tenant metric reads.
  metricsToken: process.env.OPENMULTI_METRICS_TOKEN || '',
  // audit #4 : token admin DISTINCT du token /metrics. Si posé, les routes /admin/*
  // l'exigent (le token /metrics ne donne plus l'écriture admin). Vide = repli sur
  // metricsToken (rétro-compat, zéro régression).
  adminToken: process.env.OPENMULTI_ADMIN_TOKEN || '',
  // Metering durable (Redis/Valkey, cf docs/PRODUCT-V1.md). Vide = désactivé : aucun
  // changement de comportement (dev local, tests).
  redisUrl: process.env.REDIS_URL || '',
  // Council / fusion (mixture-of-agents, opt-in via openmulti.council ou model:'council').
  // Panels = config d'exploitation (comme le catalogue), pilotables par env (CSV) ;
  // toujours surchargeables par requête. Vides = council utilisable seulement avec
  // panel+chair explicites dans la requête.
  council: {
    chair: process.env.OPENMULTI_COUNCIL_CHAIR || '',
    // Chair « flash » (synthétiseur rapide) pour le preset flash ; vide = retombe sur chair.
    chairFlash: process.env.OPENMULTI_COUNCIL_CHAIR_FLASH || '',
    defaultPreset: process.env.OPENMULTI_COUNCIL_DEFAULT_PRESET || 'quality',
    panelBudget: (process.env.OPENMULTI_COUNCIL_PANEL_BUDGET || '').split(',').map((s) => s.trim()).filter(Boolean),
    panelQuality: (process.env.OPENMULTI_COUNCIL_PANEL_QUALITY || '').split(',').map((s) => s.trim()).filter(Boolean),
    // Preset « flash » : panel + chair uniquement de modèles rapides -> réponse plus vite.
    panelFlash: (process.env.OPENMULTI_COUNCIL_PANEL_FLASH || '').split(',').map((s) => s.trim()).filter(Boolean),
  },
  // B2 (PRODUCT-V1) : signup self-service agent-natif. OPT-IN (OPENMULTI_SIGNUP=1),
  // défaut off = zéro régression. Fail-closed : exige le store partagé (REDIS_URL).
  // La vérification email est le seul clic humain ; tout le reste est scriptable.
  signup: {
    enabled: process.env.OPENMULTI_SIGNUP === '1',
    // Plafond par défaut du projet créé (USD facturés/jour) — minuscule volontairement,
    // relevable à chaud via PUT /admin/caps/:project.
    capUsdPerDay: Math.max(0.01, Number(process.env.OPENMULTI_SIGNUP_CAP_USD ?? 0.1)),
    // Garde-fou global : signups vérifiés max par jour UTC (borne le coût d'un abus
    // distribué que la limite par IP ne voit pas).
    perDay: Math.max(1, Number(process.env.OPENMULTI_SIGNUP_PER_DAY ?? 50)),
    // Limite par IP (fenêtre fixe 60s), plus stricte que le rate limit du trafic.
    ratePerMin: Math.max(1, Number(process.env.OPENMULTI_SIGNUP_RATE_PER_MIN ?? 3)),
    // Posture ZÉRO-AVANCE (B3) : un projet signup sans crédits posés reçoit 402 —
    // désactive le free tier d'essai (par défaut : essai plafonné, risque accepté).
    requireCredits: process.env.OPENMULTI_SIGNUP_REQUIRE_CREDITS === '1',
  },
  // B4 : rail x402 (paiement USDC par requête, agents anonymes à wallet). OPT-IN
  // strict — sans OPENMULTI_X402=1 rien ne change (la gate est un passe-plat).
  // Testnet d'abord (base-sepolia + facilitateur public) ; mainnet = payTo (le Safe
  // multisig), network=base, facilitateur CDP + sa clé. Voir src/x402*.ts.
  x402: {
    enabled: process.env.OPENMULTI_X402 === '1',
    payTo: process.env.OPENMULTI_X402_PAY_TO || '',
    network: process.env.OPENMULTI_X402_NETWORK || 'base-sepolia',
    // Contrat USDC : surcharge env prioritaire sur la table code (KNOWN_NETWORKS).
    usdcContract: process.env.OPENMULTI_X402_USDC || '',
    facilitatorUrl: process.env.OPENMULTI_X402_FACILITATOR_URL || 'https://x402.org/facilitator',
    // Auth du facilitateur (CDP mainnet l'exige) — posée en Authorization: Bearer.
    facilitatorToken: process.env.OPENMULTI_X402_FACILITATOR_TOKEN || '',
    // Vérificateurs d'AUDIT supplémentaires (CSV d'URLs de facilitateurs) : le
    // paiement doit être validé par le primaire ET par chacun d'eux (double
    // vérification, fail-closed). Le settle reste sur le primaire.
    verifyUrls: (process.env.OPENMULTI_X402_VERIFY_URLS || '').split(',').map((s) => s.trim()).filter(Boolean),
    // Secret HMAC du devis lié (S1). REQUIS quand x402 est activé (check au boot).
    quoteSecret: process.env.OPENMULTI_X402_QUOTE_SECRET || '',
    quoteTtlS: Math.max(30, Number(process.env.OPENMULTI_X402_QUOTE_TTL_S ?? 300)),
    // Timeouts facilitateur : verify = lecture (court), settle = soumission on-chain
    // (lent sur mainnet, cf 1er paiement mainnet). Réglables si un facilitateur traîne.
    verifyTimeoutMs: Math.max(1000, Number(process.env.OPENMULTI_X402_VERIFY_TIMEOUT_MS ?? 20000)),
    settleTimeoutMs: Math.max(1000, Number(process.env.OPENMULTI_X402_SETTLE_TIMEOUT_MS ?? 60000)),
    // Coinbase CDP comme facilitateur PRIMAIRE (règlement Base à gas sponsorisé) quand
    // les deux creds sont présents. Sinon on retombe sur facilitatorUrl. Les auditeurs
    // (verifyUrls, ex. notre Mogami) restent en double vérification par-dessus.
    cdpApiKeyId: process.env.CDP_API_KEY_ID || '',
    cdpApiKeySecret: process.env.CDP_API_KEY_SECRET || '',
  },
  // Lien de recharge PUBLIC (page console "payer pour un projet"), template avec
  // {project}. Exposé dans GET /v1/balance et les 402 insufficient_credits pour que
  // l'agent puisse tendre un lien de paiement à son humain. Vide = pas d'URL.
  topupUrl: process.env.OPENMULTI_TOPUP_URL || '',
  // Envoi d'email (vérification signup). 'log' = pas d'envoi, le code part dans les
  // logs (dev/staging) ; 'resend' = API Resend (RESEND_API_KEY requis).
  email: {
    provider: (process.env.OPENMULTI_EMAIL_PROVIDER === 'resend' ? 'resend' : 'log') as 'resend' | 'log',
    from: process.env.OPENMULTI_EMAIL_FROM || 'onboarding@openmulti.ai',
    resendApiKey: process.env.RESEND_API_KEY || '',
  },
  // Marge par défaut sur les tokens, en % (modèle de revenus : le client paie
  // coût × (1 + t/100), via usage.cost et le metering facturable). 0 = passthrough
  // byte-identique (iso, le défaut code) ; surcharge PAR PROJET via
  // PUT /admin/margins/:project (ex. 0 pour MyMULTI, qui a sa propre logique de plans).
  marginPct: Math.max(0, Number(process.env.OPENMULTI_MARGIN_PCT ?? 0)),
}

// Fail closed: an empty allowlist leaves every /v1 route open (see auth.ts). That's
// fine for local dev, but in a deployed env it's almost always a missing-config bug.
// Refuse to boot rather than start silently open.
if (process.env.NODE_ENV === 'production' && config.apiKeys.length === 0) {
  throw new Error('OPENMULTI_API_KEYS is required in production (refusing to start open)')
}

// x402 activé sans adresse de réception ou sans secret de devis = config cassée sur un
// chemin d'ARGENT : refus au boot (jamais un HMAC sur '' ni un payTo vide).
if (config.x402.enabled && (!config.x402.payTo || !config.x402.quoteSecret)) {
  throw new Error('OPENMULTI_X402=1 requires OPENMULTI_X402_PAY_TO and OPENMULTI_X402_QUOTE_SECRET')
}

// Timeouts (ms). Ported 1:1 from MyMULTI's proxy so v0 is iso-comportement.
export const TIMEOUTS = {
  connect: 30_000, // headers must arrive within 30s
  interChunk: 60_000, // abort if no byte for 60s mid-stream
} as const
