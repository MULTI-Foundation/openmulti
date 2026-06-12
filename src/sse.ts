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

export interface SseUsageBlock {
  prompt_tokens?: number
  completion_tokens?: number
  cost?: unknown
}

/**
 * Applique un mutateur au bloc `usage` d'une ligne SSE `data: {...}`. Retourne la
 * ligne réécrite si le mutateur a rendu `true`, sinon `null` (ligne à transmettre
 * telle quelle — le cas de quasi tout le flux : deltas, [DONE], commentaires).
 * Pure et générique : sert à la fois à l'injection du coût synthétisé (providers
 * directs) et à l'application de la marge (modèle de revenus).
 */
export function mutateSseUsageLine(
  line: string,
  mutate: (usage: SseUsageBlock) => boolean,
): string | null {
  if (!line.startsWith('data: ') || line.includes('[DONE]')) return null
  let parsed: { usage?: SseUsageBlock }
  try {
    parsed = JSON.parse(line.slice(6))
  } catch {
    return null
  }
  if (!parsed.usage || typeof parsed.usage !== 'object') return null
  if (!mutate(parsed.usage)) return null
  return `data: ${JSON.stringify(parsed)}`
}

/**
 * Injecte un `usage.cost` synthétisé dans une ligne SSE qui porte un bloc usage SANS
 * cost (providers directs : Moonshot & co ne facturent pas dans la réponse, or
 * usage.cost est le point de couplage #1 du contrat).
 */
export function injectCostIntoSseData(
  line: string,
  computeCost: (promptTokens: number, completionTokens: number) => number | undefined,
): string | null {
  return mutateSseUsageLine(line, (usage) => {
    if (typeof usage.cost === 'number') return false
    const cost = computeCost(usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0)
    if (cost === undefined) return false // modèle non tarifé : ne rien inventer (cf pricing.ts)
    usage.cost = cost
    return true
  })
}

/**
 * Transforme un flux SSE ligne à ligne : chaque ligne complète passe par `perLine`
 * (null = inchangée) ; le découpage tolère un événement coupé entre deux chunks
 * (même précaution que SseUsageScanner). Tout ce qui n'est pas réécrit passe
 * verbatim. Plomberie partagée entre adaptateurs de provider et marge.
 */
export function sseLineTransform(
  upstream: ReadableStream<Uint8Array>,
  perLine: (line: string) => string | null,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // garde la ligne (potentiellement) partielle
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${perLine(line) ?? line}\n`))
      }
    },
    flush(controller) {
      buffer += decoder.decode()
      if (buffer) controller.enqueue(encoder.encode(buffer))
    },
  })

  return upstream.pipeThrough(transform)
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
