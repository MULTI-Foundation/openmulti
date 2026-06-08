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
  // Attribution headers forwarded to the upstream provider.
  referer: process.env.OPENMULTI_REFERER || 'https://openmulti.ai',
  title: process.env.OPENMULTI_TITLE || 'OpenMulti',
  port: Number(process.env.PORT || 8080),
  // Static API key allowlist for v0. Each consuming project gets its own key.
  apiKeys: (process.env.OPENMULTI_API_KEYS || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean),
}

// Timeouts (ms). Ported 1:1 from MyMULTI's proxy so v0 is iso-comportement.
export const TIMEOUTS = {
  connect: 30_000, // headers must arrive within 30s
  interChunk: 60_000, // abort if no byte for 60s mid-stream
} as const
