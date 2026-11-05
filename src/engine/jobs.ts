// One queue for every long operation. Jobs report bytes, can pause/resume/cancel,
// and can ask the UI to resolve conflicts. Progress events are throttled.
import type { Conflict, ConflictAnswer, JobInfo, JobKind } from '@shared/types'

export class Cancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

export interface JobCtl {
  info: JobInfo
  /** throws Cancelled; waits while paused */
  checkpoint(): Promise<void>
  add(bytes: number, files?: number): void
  setCurrent(path: string): void
  setTotal(bytes: number, files: number): void
  fail(path: string, message: string): void
  ask(c: Omit<Conflict, 'jobId' | 'conflictId'>): Promise<{ answer: ConflictAnswer; all: boolean }>
  readonly cancelled: boolean
  signal: AbortSignal
}

type Runner = (ctl: JobCtl) => Promise<string | void>

interface Internal {
  info: JobInfo
  run: Runner
  abort: AbortController
  paused: boolean
  resume?: () => void
  conflicts: Map<string, (a: { answer: ConflictAnswer; all: boolean }) => void>
  /** jobs in the same lane run one at a time (e.g. per destination drive) */
  lane: string
}

let seq = 0

export class JobQueue {
  private jobs = new Map<string, Internal>()
  private running = new Map<string, number>() // lane -> count
  private lastEmit = new Map<string, number>()
  private timer?: NodeJS.Timeout
  private dirty = new Set<string>()

  constructor(private emit: (event: string, data: unknown) => void, private laneLimit = 2) {}

  list() {
    return [...this.jobs.values()].map((j) => j.info)
  }

  create(kind: JobKind, title: string, run: Runner, opts: { lane?: string; dest?: string; immediate?: boolean } = {}) {
    const id = `j${Date.now().toString(36)}${(++seq).toString(36)}`
    const info: JobInfo = {
      id, kind, title, state: 'queued', done: 0, total: 0, files: 0, filesTotal: 0, rate: 0,
      startedAt: Date.now(), errors: [], dest: opts.dest
    }
    const job: Internal = { info, run, abort: new AbortController(), paused: false, conflicts: new Map(), lane: opts.immediate ? `solo:${id}` : opts.lane ?? 'default' }
    this.jobs.set(id, job)
    this.touch(id, true)
    this.pump()
    return id
  }

  private pump() {
    for (const job of this.jobs.values()) {
      if (job.info.state !== 'queued') continue
      const n = this.running.get(job.lane) ?? 0
      // Transfers to the same volume run one at a time (best throughput on disks and shares).
      if (n >= (job.lane.startsWith('vol:') ? 1 : this.laneLimit)) continue
      this.running.set(job.lane, n + 1)
      void this.exec(job)
    }
  }

  private async exec(job: Internal) {
    const info = job.info
    info.state = 'running'
    info.startedAt = Date.now()
    let windowStart = Date.now()
    let windowBytes = 0
    const ctl: JobCtl = {
      info,
      signal: job.abort.signal,
      get cancelled() {
        return job.abort.signal.aborted
      },
      checkpoint: async () => {
        if (job.abort.signal.aborted) throw new Cancelled()
        if (job.paused) {
          info.state = 'paused'
          this.touch(info.id, true)
          await new Promise<void>((r) => (job.resume = r))
          info.state = 'running'
          this.touch(info.id, true)
          if (job.abort.signal.aborted) throw new Cancelled()
        }
      },
      add: (bytes, files = 0) => {
        info.done += bytes
        info.files += files
        windowBytes += bytes
        const now = Date.now()
        const dt = now - windowStart
        if (dt >= 500) {
          const inst = (windowBytes * 1000) / dt
          info.rate = info.rate ? info.rate * 0.6 + inst * 0.4 : inst
          windowStart = now
          windowBytes = 0
        }
        this.touch(info.id)
      },
      setCurrent: (p) => {
        info.current = p
        this.touch(info.id)
      },
      setTotal: (bytes, files) => {
        info.total = bytes
        info.filesTotal = files
        this.touch(info.id)
      },
      fail: (path, message) => {
        if (info.errors.length < 500) info.errors.push({ path, message })
        this.touch(info.id)
      },
      ask: (c) =>
        new Promise((resolve) => {
          const conflictId = `c${++seq}`
          job.conflicts.set(conflictId, resolve)
          info.state = 'waiting'
          this.touch(info.id, true)
          this.emit('conflict', { ...c, jobId: info.id, conflictId } satisfies Conflict)
        }).then((a: any) => {
          info.state = 'running'
          this.touch(info.id, true)
          return a
        })
    }
    try {
      const out = await job.run(ctl)
      if (out) info.output = out
      info.state = info.errors.length && info.files === 0 ? 'failed' : 'done'
    } catch (e: any) {
      if (e instanceof Cancelled || job.abort.signal.aborted) info.state = 'cancelled'
      else {
        info.state = 'failed'
        info.error = String(e?.message ?? e)
      }
    } finally {
      info.endedAt = Date.now()
      info.current = undefined
      info.rate = 0
      this.running.set(job.lane, (this.running.get(job.lane) ?? 1) - 1)
      this.touch(info.id, true)
      this.emit('job-finished', info)
      this.pump()
    }
  }

  pause(id: string) {
    const j = this.jobs.get(id)
    if (j && (j.info.state === 'running' || j.info.state === 'queued')) {
      j.paused = true
      if (j.info.state === 'queued') j.info.state = 'paused'
      this.touch(id, true)
    }
  }

  resume(id: string) {
    const j = this.jobs.get(id)
    if (!j) return
    j.paused = false
    if (j.info.state === 'paused' && !j.resume) j.info.state = 'queued'
    j.resume?.()
    j.resume = undefined
    this.touch(id, true)
    this.pump()
  }

  cancel(id: string) {
    const j = this.jobs.get(id)
    if (!j) return
    j.abort.abort()
    for (const r of j.conflicts.values()) r({ answer: 'cancel', all: true })
    j.conflicts.clear()
    if (j.info.state === 'queued' || j.info.state === 'paused') {
      j.info.state = 'cancelled'
      j.info.endedAt = Date.now()
      j.resume?.()
    }
    this.touch(id, true)
  }

  resolve(jobId: string, conflictId: string, answer: ConflictAnswer, all: boolean) {
    const j = this.jobs.get(jobId)
    const r = j?.conflicts.get(conflictId)
    if (!r) return
    j!.conflicts.delete(conflictId)
    r({ answer, all })
  }

  clearFinished() {
    for (const [id, j] of this.jobs) if (['done', 'failed', 'cancelled'].includes(j.info.state)) this.jobs.delete(id)
    this.emit('jobs', this.list())
  }

  /** Batch progress updates to at most ~8 per second per job. */
  private touch(id: string, now = false) {
    this.dirty.add(id)
    const last = this.lastEmit.get(id) ?? 0
    if (now || Date.now() - last > 125) {
      this.flush()
      return
    }
    this.timer ??= setTimeout(() => this.flush(), 125)
  }

  private flush() {
    clearTimeout(this.timer)
    this.timer = undefined
    const out: JobInfo[] = []
    for (const id of this.dirty) {
      const j = this.jobs.get(id)
      if (j) out.push({ ...j.info, errors: j.info.errors.slice(-20) })
      this.lastEmit.set(id, Date.now())
    }
    this.dirty.clear()
    if (out.length) this.emit('job', out)
  }
}
