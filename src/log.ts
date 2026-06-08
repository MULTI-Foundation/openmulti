// Structured logging: one JSON object per line, machine-parseable. Replaces the
// scattered console.log strings so logs can be shipped/queried, and so the same
// fields that get logged also feed the metrics registry (see metrics.ts).
//
// Keep it dependency-free and synchronous: a request handler must never block on
// logging. Log shippers add ingestion time; we stamp `ts` too for self-contained lines.

type Fields = Record<string, unknown>

function emit(level: 'info' | 'warn' | 'error', msg: string, fields: Fields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, service: 'openmulti', msg, ...fields })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const log = {
  info: (msg: string, fields: Fields = {}) => emit('info', msg, fields),
  warn: (msg: string, fields: Fields = {}) => emit('warn', msg, fields),
  error: (msg: string, fields: Fields = {}) => emit('error', msg, fields),
}
