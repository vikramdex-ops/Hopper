// Startup tracing for diagnostics: set HOPPER_TRACE=<file> to append timestamped lines.
import { appendFileSync } from 'node:fs'

export function trace(msg: string) {
  const f = process.env.HOPPER_TRACE
  if (!f) return
  try {
    appendFileSync(f, `${new Date().toISOString()} [${process.pid}] ${msg}\n`)
  } catch {
    /* diagnostics only */
  }
}
