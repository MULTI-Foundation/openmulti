// Partagé entre adaptateurs provider — ce qui est commun à (presque) tous les
// upstreams HTTP, indépendamment de leur forme d'API.

// Transient upstream statuses worth retrying on the SAME model. 4xx (bad request,
// auth, unprocessable) are deterministic — retrying won't help — except 429, which
// is a rate-limit hiccup and honors Retry-After.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status)
}
