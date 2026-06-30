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

// Timeouts (ms). Ported 1:1 from MyMULTI's proxy so v0 is iso-comportement.
export const TIMEOUTS = {
  connect: 30_000, // headers must arrive within 30s
  interChunk: 60_000, // abort if no byte for 60s mid-stream
} as const
