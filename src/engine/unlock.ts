// Engine side of "Who has it open": reading lock files (never changing them) and the "Wait and
// retry" job that finishes a blocked rename, delete, move or copy once the file is closed.
import { promises as fsp } from 'node:fs'
import { basename } from 'node:path'
import { parseLock, type LockOwner } from '@shared/locks'
import { isBusyError, type UnlockOp } from '@shared/unlock'
import type { EngineCtx } from './index'
import type { JobCtl } from './jobs'
import { exists, moveOne } from './fsutil'
import { walk } from './fsops'
import { runTransfer } from './transfer'

const RETRY_MS = 10_000

async function readLock(p: string): Promise<LockOwner | null> {
  const fh = await fsp.open(p, 'r')
  try {
    const buf = Buffer.alloc(4096)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return parseLock(basename(p), buf.subarray(0, bytesRead))
  } finally {
    await fh.close()
  }
}

type Attempt = { left: UnlockOp | null; busy: string[]; error?: string }

export function unlockHandlers(ctx: EngineCtx & { labels: { moved(pairs: [string, string][]): Promise<void> } }) {
  const nudges = new Map<string, () => void>()

  /** One try. Busy files stay in `left`; anything else that fails ends the job with an error. */
  async function attempt(op: UnlockOp, ctl: JobCtl): Promise<Attempt> {
    switch (op.kind) {
      case 'rename':
        try {
          if (op.from.toLowerCase() !== op.to.toLowerCase() && (await exists(op.to))) return { left: op, busy: [], error: `"${basename(op.to)}" already exists` }
          await moveOne(op.from, op.to)
          ctx.undo.record({ kind: 'rename', label: `Rename ${basename(op.from)}`, pairs: [[op.from, op.to]] })
          void ctx.labels.moved([[op.from, op.to]])
          ctl.add(0, 1)
          return { left: null, busy: [] }
        } catch (e: any) {
          const m = String(e?.message ?? e)
          return isBusyError(m) ? { left: op, busy: [op.from] } : { left: op, busy: [], error: m }
        }
      case 'delete': {
        const left: string[] = []
        for (const p of op.paths) {
          try {
            await fsp.rm(p, { recursive: true, force: true, maxRetries: 1 })
            ctl.add(0, 1)
          } catch (e: any) {
            const m = String(e?.message ?? e)
            if (!isBusyError(m)) return { left: { kind: 'delete', paths: [p, ...left] }, busy: [], error: m }
            left.push(p)
          }
        }
        return { left: left.length ? { kind: 'delete', paths: left } : null, busy: left }
      }
      case 'recycle': {
        // the Recycle Bin is Hopper's window's job: wait until no program on this PC holds the files
        const files: string[] = []
        for (const p of op.paths) {
          const st = await fsp.stat(p).catch(() => null)
          if (st?.isFile()) files.push(p)
          else if (st?.isDirectory()) {
            await walk(ctx, p, (e) => {
              if (!e.dir && files.length < 2000) files.push(e.path)
            }, { signal: ctl.signal })
          }
        }
        if (!files.length) return { left: null, busy: [] }
        const held = await ctx.bulkShell.call<{ path: string }[]>('rmHolders', { paths: files.slice(0, 2000) }, 120_000).catch(() => [])
        return held.length ? { left: op, busy: [...new Set(held.map((h) => h.path || op.paths[0]))] } : { left: null, busy: [] }
      }
      case 'transfer': {
        const left: { src: string; destDir: string }[] = []
        for (const it of op.items) {
          await ctl.checkpoint()
          if (!(await exists(it.src))) {
            ctl.add(0, 1) // moved or deleted meanwhile
            continue
          }
          const errs: { path: string; message: string }[] = []
          const sub: JobCtl = { ...ctl, fail: (path, message) => void errs.push({ path, message }), add: () => {}, setTotal: () => {}, setCurrent: () => {}, ask: ctl.ask, checkpoint: () => ctl.checkpoint() }
          try {
            await runTransfer(ctx, sub, { op: op.op, sources: [it.src], dest: it.destDir, policy: 'overwrite' })
          } catch (e: any) {
            errs.push({ path: it.src, message: String(e?.message ?? e) })
          }
          if (!errs.length) {
            ctl.add(0, 1)
            continue
          }
          if (!errs.every((x) => isBusyError(x.message))) return { left: { kind: 'transfer', op: op.op, items: [it, ...left] }, busy: [], error: errs[0].message }
          left.push(it)
        }
        return { left: left.length ? { kind: 'transfer', op: op.op, items: left } : null, busy: left.map((i) => i.src) }
      }
    }
  }

  const count = (op: UnlockOp) => (op.kind === 'rename' ? 1 : op.kind === 'transfer' ? op.items.length : op.paths.length)

  const title = (op: UnlockOp) => {
    const n = count(op)
    const first = basename(op.kind === 'rename' ? op.from : op.kind === 'transfer' ? op.items[0].src : op.paths[0])
    const what = n === 1 ? first : `${n} items`
    switch (op.kind) {
      case 'rename': return `Waiting to rename ${what}`
      case 'delete':
      case 'recycle': return `Waiting to delete ${what}`
      case 'transfer': return `Waiting to ${op.op} ${what}`
    }
  }

  return {
    /** lock owner per lock-file path (lower case); null when the file could not be read */
    'locks.read': async (paths: string[]) => {
      const out: Record<string, LockOwner | null> = {}
      await Promise.all(
        (Array.isArray(paths) ? paths.slice(0, 500) : []).map(async (p) => {
          out[p.toLowerCase()] = await readLock(p).catch(() => null)
        })
      )
      return out
    },
    /** Keep trying `op` every 10 s (and whenever nudged) until it works, fails otherwise, or `minutes` pass. */
    'unlock.wait': (op: UnlockOp, opts: { minutes?: number } = {}) => {
      const minutes = Math.max(1, Math.min(240, Number(opts.minutes) || 10))
      let id = ''
      id = ctx.jobs.create('wait', title(op), async (ctl) => {
        const deadline = Date.now() + minutes * 60_000
        let pending: UnlockOp = op
        ctl.setTotal(0, count(op))
        try {
          for (;;) {
            await ctl.checkpoint()
            const r = await attempt(pending, ctl)
            if (!r.left) return op.kind === 'recycle' ? 'recycle-ready' : undefined
            if (r.error) throw new Error(r.error)
            pending = r.left
            ctl.setCurrent(r.busy[0] ?? '')
            if (Date.now() >= deadline) throw new Error(`Still open after ${minutes} min: ${basename(r.busy[0] ?? '')}`)
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(t)
                ctl.signal.removeEventListener('abort', done)
                nudges.delete(id)
                resolve()
              }
              const t = setTimeout(done, Math.min(RETRY_MS, Math.max(0, deadline - Date.now())))
              ctl.signal.addEventListener('abort', done)
              nudges.set(id, done)
            })
          }
        } finally {
          nudges.delete(id)
        }
      }, { immediate: true })
      return id
    },
    /** holders reported "closed": try again now */
    'unlock.nudge': (id: string) => {
      nudges.get(id)?.()
      return true
    }
  }
}
