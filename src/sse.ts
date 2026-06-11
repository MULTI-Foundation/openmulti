// Incremental scanner for the upstream SSE stream. The raw bytes are piped to the
// client untouched (see routes/chat.ts); this only extracts usage/provider for the
// cost/provider side-channel (logging + metrics). It buffers partial lines so a
// `data:` event split across two chunk reads is still parsed once complete — that
// boundary case is exactly what makes this worth isolating and unit-testing.

export interface SseUsage {
  prompt_tokens: number
  completion_tokens: number
  cost?: number
}

/**
 * Injecte un `usage.cost` synthétisé dans une ligne SSE `data: {...}` qui porte un
 * bloc usage SANS cost (cas des providers directs : Moonshot & co ne facturent pas
 * dans la réponse, contrairement à OpenRouter — or usage.cost est le point de
 * couplage #1 du contrat). Retourne la ligne réécrite, ou `null` si la ligne n'est
 * pas concernée (à transmettre telle quelle — c'est le cas de quasi tout le flux).
 * Pure : le calcul du coût est injecté en callback (pricing.ts reste découplé d'ici).
 */
export function injectCostIntoSseData(
  line: string,
  computeCost: (promptTokens: number, completionTokens: number) => number | undefined,
): string | null {
  if (!line.startsWith('data: ') || line.includes('[DONE]')) return null
  let parsed: { usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: unknown } }
  try {
    parsed = JSON.parse(line.slice(6))
  } catch {
    return null
  }
  if (!parsed.usage || typeof parsed.usage !== 'object' || typeof parsed.usage.cost === 'number') return null
  const cost = computeCost(parsed.usage.prompt_tokens ?? 0, parsed.usage.completion_tokens ?? 0)
  if (cost === undefined) return null // modèle non tarifé : ne rien inventer (cf pricing.ts)
  parsed.usage.cost = cost
  return `data: ${JSON.stringify(parsed)}`
}

export class SseUsageScanner {
  private buffer = ''
  usage: SseUsage | null = null
  provider: string | null = null

  /** Feed a decoded text chunk. Updates usage/provider as complete lines arrive. */
  push(text: string): void {
    this.buffer += text
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? '' // keep the trailing (possibly partial) line
    for (const line of lines) {
      if (!line.startsWith('data: ') || line.includes('[DONE]')) continue
      try {
        const parsed = JSON.parse(line.slice(6))
        if (parsed.usage) this.usage = parsed.usage
        if (parsed.provider) this.provider = parsed.provider
      } catch {
        // partial/non-JSON data line — ignore, the bytes still reach the client.
      }
    }
  }
}
