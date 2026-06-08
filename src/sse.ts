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
