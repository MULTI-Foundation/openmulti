// OM-10: graceful shutdown. On SIGTERM/SIGINT, stop accepting connections and let
// in-flight requests (including SSE streams) finish, then exit. A timeout guards
// against a stuck connection holding the process open forever.
//
// The handler is built here as a pure function so it can be unit-tested without
// spawning a real server or sending real signals.

export interface Closable {
  close(cb?: (err?: Error) => void): void
}

export function makeShutdown(server: Closable, exit: (code: number) => void, timeoutMs = 10_000): () => void {
  let called = false
  return () => {
    if (called) return // idempotent: a second signal must not double-close
    called = true
    const timer = setTimeout(() => exit(0), timeoutMs)
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
    server.close(() => {
      clearTimeout(timer)
      exit(0)
    })
  }
}
