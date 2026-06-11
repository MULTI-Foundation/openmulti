// Partagé entre adaptateurs provider — ce qui est commun à (presque) tous les
// upstreams HTTP, indépendamment de leur forme d'API.

// Transient upstream statuses worth retrying on the SAME model. 4xx (bad request,
// auth, unprocessable) are deterministic — retrying won't help — except 429, which
// is a rate-limit hiccup and honors Retry-After.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status)
}

// Backoff before a retry: exponential (200ms, 400ms, …) capped at 2s. Honor a sane
// Retry-After (seconds) from the upstream, capped so a request can't hang on it.
export function backoff(attempt: number, retryAfter?: string | null): Promise<void> {
  let ms = Math.min(200 * 2 ** (attempt - 1), 2000)
  if (retryAfter) {
    const secs = Number(retryAfter)
    if (Number.isFinite(secs) && secs > 0) ms = Math.min(secs * 1000, 5000)
  }
  return new Promise((resolve) => setTimeout(resolve, ms))
}
