// OM-05: neutralize header injection. The streaming response reflects the resolved
// model and the route reason into X-OpenMulti-* headers, and both can carry
// caller-influenced data (a pinned concrete model id; the purpose echoed in reason).
// We strip anything outside printable ASCII (drops CR/LF and control chars, which is
// what enables response splitting) and cap the length. Sanitizing on output rather
// than rejecting on input keeps valid-but-unusual requests working.

export function headerSafe(value: string, max = 256): string {
  return value.replace(/[^\x20-\x7E]/g, '').slice(0, max)
}
