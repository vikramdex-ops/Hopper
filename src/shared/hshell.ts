// Client for native/HopperShell.exe (JSON lines over stdio). Node-only.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export class HopperShell {
  private proc?: ChildProcessWithoutNullStreams
  private seq = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>()
  private idleTimer?: NodeJS.Timeout

  /** idleMs: let the helper exit after this long with nothing to do (it restarts on the next call). */
  constructor(private exe: string, private idleMs = 0) {}

  private settled() {
    if (!this.idleMs || this.pending.size) return
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (!this.pending.size) this.dispose()
    }, this.idleMs)
    this.idleTimer.unref?.()
  }

  private start() {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return this.proc
    const proc = spawn(this.exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    proc.stdin.setDefaultEncoding('utf8')
    createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (p.timer) clearTimeout(p.timer)
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error))
      this.settled()
    })
    proc.on('exit', () => {
      // an idle helper that was let go must not take a newer one's calls with it
      if (this.proc !== proc) return
      for (const [, p] of this.pending) p.reject(new Error('HopperShell exited'))
      this.pending.clear()
      this.proc = undefined
    })
    proc.on('error', () => {})
    this.proc = proc
    return proc
  }

  call<T = any>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
    clearTimeout(this.idleTimer)
    const proc = this.start()
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const entry: { resolve: (v: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout } = { resolve, reject }
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`HopperShell ${cmd} timed out`))
          this.settled()
        }, timeoutMs)
      }
      this.pending.set(id, entry)
      proc.stdin.write(JSON.stringify({ id, cmd, args }) + '\n')
    })
  }

  dispose() {
    clearTimeout(this.idleTimer)
    this.proc?.stdin.end()
    this.proc = undefined
  }
}

/** Raw tuple returned by `list`: [name, attrs, size, mtime, ctime, atime, reparseTag] */
export type RawEntry = [string, number, number, number, number, number, number]
