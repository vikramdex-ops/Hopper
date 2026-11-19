// "Watch this folder": tell the user when files arrive, change or go in folders they chose.
// Each watched folder is listed (name + size + times, at most WATCH_MAX_ENTRIES entries) and the
// listings are compared (shared/folderwatch.ts). Change notifications only trigger an early
// listing; network folders are also listed every 30 s because SMB notifications get lost.
// A burst (a 300-file copy) becomes one notice once it settles. Paths this Hopper wrote are left
// out, and so is a folder's news while a Hopper job is still writing into it.
import type { FSWatcher } from 'node:fs'
import type { Entry } from '@shared/types'
import {
  Batcher, OwnPaths, WATCH_MAX_ENTRIES, WATCH_POLL_LOCAL_MS, WATCH_POLL_NETWORK_MS, batchBody, batchSize, batchTitle, cleanWatched, connectText,
  diffSnapshots, filterBatch, folderName, inQuietHours, isIgnoredName, isIgnoredPath, isWithin, snapshotOf,
  type FolderWatchEvent, type FolderWatchStatus, type SnapItem, type Snapshot, type WatchedFolder
} from '@shared/folderwatch'
import type { EngineCtx } from './index'
import { listRaw, walk } from './fsops'
import { watchTree } from './watch'

/** after a change notification, list again this soon (more notifications push it back) */
const NOTIFY_DELAY_MS = 1500
/** while a folder keeps changing it is listed this often */
const HOT_MS = 5000
const TICK_MS = 2500
const SAMPLE = 200

interface Rec {
  w: WatchedFolder
  snap: Snapshot | null
  partial: boolean
  entries: number
  error: string
  network: boolean
  watcher: FSWatcher | null
  /** "Who has it open" asked us to let go of the folder handle */
  released: boolean
  scanning: boolean
  again: boolean
  hot: boolean
  lastScan: number
  soon?: NodeJS.Timeout
  batcher: Batcher
}

let seq = 0

export class FolderWatch {
  private recs = new Map<string, Rec>()
  private own = new OwnPaths()
  private timer?: NodeJS.Timeout
  private drives: { root: string; kind: string }[] = []
  private drivesAt = 0
  private ctx: EngineCtx

  constructor(ctx: EngineCtx) {
    this.ctx = ctx
  }

  /** Paths this Hopper just wrote, moved or deleted: never reported as someone else's change. */
  noteOwn(paths: string[]) {
    this.own.add(paths, Date.now())
  }

  /** Apply the watched-folder list from settings; unchanged folders keep their listing. */
  configure(raw: unknown) {
    const list = (Array.isArray(raw) ? raw : []).map(cleanWatched).filter((w): w is WatchedFolder => !!w)
    const want = new Map(list.map((w) => [w.id, w]))
    for (const [id, rec] of [...this.recs]) {
      const w = want.get(id)
      if (!w || w.path.toLowerCase() !== rec.w.path.toLowerCase() || w.subfolders !== rec.w.subfolders) this.drop(id)
      else rec.w = w // notify, quiet hours, Connect: take effect from the next notice
    }
    for (const w of list) if (!this.recs.has(w.id)) this.start(w)
    if (this.recs.size && !this.timer) this.timer = setInterval(() => void this.tick(), TICK_MS)
    if (!this.recs.size && this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.emitStatus()
  }

  status(): FolderWatchStatus[] {
    return [...this.recs.values()].map((r) => ({
      id: r.w.id,
      path: r.w.path,
      entries: r.entries,
      limited: r.partial,
      mode: r.watcher && !r.network ? 'notify' : 'poll',
      error: r.error,
      ready: !!r.snap
    }))
  }

  /** Close folder handles under these roots (lower case, no trailing slash); polling continues. */
  release(roots: string[]) {
    let n = 0
    for (const r of this.recs.values()) {
      if (!r.watcher || !roots.some((root) => isWithin(r.w.path, root) || isWithin(root, r.w.path))) continue
      r.watcher.close()
      r.watcher = null
      r.released = true
      n++
    }
    return n
  }

  private start(w: WatchedFolder) {
    const rec: Rec = { w, snap: null, partial: false, entries: 0, error: '', network: true, watcher: null, released: false, scanning: false, again: false, hot: false, lastScan: 0, batcher: new Batcher() }
    this.recs.set(w.id, rec)
    void this.isNetwork(w.path).then((net) => {
      rec.network = net
      this.listen(rec)
      void this.scan(rec)
    })
  }

  private listen(rec: Rec) {
    if (rec.released || rec.watcher || this.recs.get(rec.w.id) !== rec) return
    rec.watcher = watchTree(
      rec.w.path,
      rec.w.subfolders,
      (rel) => {
        if (rel && isIgnoredPath(rel)) return
        clearTimeout(rec.soon)
        rec.soon = setTimeout(() => void this.scan(rec), NOTIFY_DELAY_MS)
      },
      () => {
        rec.watcher = null
        this.emitStatus()
      }
    )
  }

  private drop(id: string) {
    const rec = this.recs.get(id)
    if (!rec) return
    clearTimeout(rec.soon)
    rec.watcher?.close()
    this.recs.delete(id)
  }

  private async isNetwork(path: string) {
    if (path.startsWith('\\\\')) return true
    if (Date.now() - this.drivesAt > 5 * 60_000) {
      try {
        this.drives = await this.ctx.shell.call<{ root: string; kind: string }[]>('drives', {}, 15_000)
        this.drivesAt = Date.now()
      } catch {
        /* keep the last list */
      }
    }
    const d = this.drives.find((x) => path.toUpperCase().startsWith(x.root.toUpperCase()))
    // unknown drive: assume the worst and poll
    return !d || d.kind === 'network'
  }

  private interval(rec: Rec) {
    if (rec.hot) return HOT_MS
    return rec.network || !rec.watcher ? WATCH_POLL_NETWORK_MS : WATCH_POLL_LOCAL_MS
  }

  private async tick() {
    const now = Date.now()
    for (const rec of this.recs.values()) {
      if (!rec.scanning && now - rec.lastScan >= this.interval(rec)) void this.scan(rec)
      if (rec.batcher.pending && rec.batcher.due(now) && !rec.scanning && !this.hopperBusy(rec, now)) this.flush(rec, now)
    }
    if (now % 60_000 < TICK_MS) this.own.prune(now)
  }

  /** A Hopper job is still writing into this folder: its files are recorded when it ends. */
  private hopperBusy(rec: Rec, now: number) {
    if (now - rec.batcher.lastChange > 10 * 60_000) return false
    return this.ctx.jobs.list().some((j) => ['queued', 'running', 'paused', 'waiting'].includes(j.state) && !!j.dest && isWithin(j.dest, rec.w.path))
  }

  /** List the folder, compare with the last listing, queue the differences. */
  private async scan(rec: Rec) {
    if (rec.scanning) {
      rec.again = true
      return
    }
    rec.scanning = true
    const started = Date.now()
    try {
      const { items, partial, failed } = await this.list(rec.w)
      if (this.recs.get(rec.w.id) !== rec) return
      const next = snapshotOf(items)
      // Subfolders that could not be listed this time keep their last listing: a share that
      // hiccups must not look like a mass deletion.
      if (rec.snap && failed.length) {
        for (const [k, p] of rec.snap) {
          if (next.has(k)) continue
          const abs = `${rec.w.path}\\${p.rel}`
          if (failed.some((f) => isWithin(abs, f) && abs.toLowerCase() !== f.toLowerCase())) next.set(k, p)
        }
      }
      if (rec.snap) {
        const d = diffSnapshots(rec.snap, next, partial || rec.partial ? { since: rec.lastScan } : undefined)
        const n = d.added.length + d.changed.length + d.removed.length
        rec.hot = n > 0
        if (n) rec.batcher.add(d, Date.now())
      }
      rec.snap = next
      rec.partial = partial
      rec.entries = items.length
      rec.error = ''
      // notifications that failed earlier (folder was unreachable) are tried again
      if (!rec.watcher) this.listen(rec)
    } catch (e: any) {
      // the folder is unreachable: keep the last listing and say so; nothing is reported as gone
      rec.error = String(e?.message ?? e).replace(/^Error:\s*/, '')
      rec.hot = false
    } finally {
      rec.lastScan = started
      rec.scanning = false
      this.emitStatus()
      if (rec.again) {
        rec.again = false
        void this.scan(rec)
      }
    }
  }

  private async list(w: WatchedFolder): Promise<{ items: SnapItem[]; partial: boolean; failed: string[] }> {
    const root = w.path.replace(/[\\/]+$/, '')
    const cut = root.length + 1
    const items: SnapItem[] = []
    const failed: string[] = []
    let partial = false
    const take = (e: Entry) => {
      if (items.length >= WATCH_MAX_ENTRIES) {
        partial = true
        return false
      }
      items.push({ rel: e.path.slice(cut), dir: e.dir, size: e.size, mtime: e.mtime, ctime: e.ctime })
      return true
    }
    if (!w.subfolders) {
      for (const e of await listRaw(this.ctx, w.path, 'bulk')) if (!isIgnoredName(e.name) && !take(e)) break
      return { items, partial, failed }
    }
    const ac = new AbortController()
    let rootError = ''
    await walk(
      this.ctx,
      w.path,
      (e) => {
        if (isIgnoredName(e.name)) return false
        if (!take(e)) {
          ac.abort()
          return false
        }
      },
      {
        signal: ac.signal,
        concurrency: 4,
        onError: (dir, m) => {
          if (dir.toLowerCase() === w.path.toLowerCase()) rootError = m
          else failed.push(dir)
        }
      }
    )
    if (rootError) throw new Error(rootError)
    return { items, partial, failed }
  }

  private flush(rec: Rec, now: number) {
    const raw = rec.batcher.take()
    const b = filterBatch(raw, rec.w, (abs) => this.own.has(abs, now))
    if (!batchSize(b)) return
    const name = folderName(rec.w.path)
    const abs = (rel: string) => `${rec.w.path.replace(/[\\/]+$/, '')}\\${rel}`
    const quiet = inQuietHours(rec.w.quiet, new Date(now))
    const ev: FolderWatchEvent = {
      id: `fw${now.toString(36)}${(++seq).toString(36)}`,
      watchId: rec.w.id,
      folder: rec.w.path,
      name,
      at: now,
      title: batchTitle(b, name),
      body: batchBody(b),
      counts: { added: b.added.length, changed: b.changed.length, removed: b.removed.length },
      added: b.added.slice(0, SAMPLE).map(abs),
      changed: b.changed.slice(0, SAMPLE).map(abs),
      removed: b.removed.slice(0, SAMPLE).map(abs),
      quiet
    }
    this.ctx.emit('folder-watch', ev)
    if (quiet) return
    // Windows notification (main) and, when asked for, a Dexterity Connect message (LAN process,
    // which knows whether Connect is configured). Connect gets the folder name and counts only.
    const one = batchSize(b) === 1 && !b.removed.length ? abs(b.added[0] ?? b.changed[0]) : ''
    process.parentPort.postMessage({ type: 'watch-notify', title: ev.title, body: ev.body, folder: rec.w.path, select: one, connect: rec.w.connect ? connectText(b, name) : '' })
  }

  private statusTimer?: NodeJS.Timeout
  private emitStatus() {
    clearTimeout(this.statusTimer)
    this.statusTimer = setTimeout(() => this.ctx.emit('folder-watch-status', this.status()), 200)
  }
}

export function folderWatchHandlers(ctx: EngineCtx & { folderWatch: FolderWatch }) {
  return {
    'folderWatch.status': () => ctx.folderWatch.status()
  }
}
