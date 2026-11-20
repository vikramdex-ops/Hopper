// Predictive Storage Intelligence: the measuring side. Every few hours (Settings > Storage) this
// records the used space of each fixed/network drive and the size of each tracked folder and of its
// immediate subfolders, keeps that history in <data>\storage-history.json, and judges it with the
// plain arithmetic in shared/storage.ts. A folder growing unusually fast, or a drive that the trend
// fills within 30 days, raises one alert: a toast, a Windows notification and - for the people named
// on the tracked folder - a Dexterity Connect message. Nothing is guessed: the alert carries the
// numbers it was decided on.
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { DriveInfo, Entry } from '@shared/types'
import {
  DAY, FULL_WARN_DAYS, REALERT_MS, analyse, cleanStorageSettings, compactHistory, dailySeries, daysToFull, fillingAlert, unusualAlert,
  type StorageAlert, type StorageSample, type StorageSeriesView, type StorageSettings, type TrackedFolder
} from '@shared/storage'
import type { EngineCtx } from './index'
import { walk } from './fsops'

/** one walk never reads more than this many entries (a whole file server is not a "folder") */
const MAX_ENTRIES = 3_000_000
const MAX_WALK_MS = 45 * 60_000
const FIRST_SCAN_MS = 3 * 60_000
const CHECK_MS = 10 * 60_000

interface Series {
  kind: 'drive' | 'folder' | 'child'
  path: string
  label: string
  folderId?: string
  total?: number
  free?: number
  partial?: boolean
  samples: StorageSample[]
}

interface HistoryFile {
  version: 1
  lastScan: number
  series: Record<string, Series>
  /** key -> when it was last alerted, and the score/days it was alerted at */
  alerted: Record<string, { at: number; level: number }>
}

const empty = (): HistoryFile => ({ version: 1, lastScan: 0, series: {}, alerted: {} })

export class StorageIntel {
  private ctx: EngineCtx
  private cfg: StorageSettings = cleanStorageSettings(undefined)
  private hist: HistoryFile = empty()
  private loaded = false
  private timer?: NodeJS.Timeout
  private scanning: Promise<void> | null = null
  private abort?: AbortController
  private started = Date.now()
  progress = ''

  constructor(ctx: EngineCtx) {
    this.ctx = ctx
  }

  private get file() {
    return join(this.ctx.dataDir, 'storage-history.json')
  }

  configure(raw: unknown) {
    this.cfg = cleanStorageSettings(raw)
    if (this.cfg.enabled && !this.timer) this.timer = setInterval(() => void this.maybeScan(), CHECK_MS)
    if (!this.cfg.enabled && this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
      this.abort?.abort()
    }
    if (this.cfg.enabled) setTimeout(() => void this.maybeScan(), FIRST_SCAN_MS)
  }

  async load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const j = JSON.parse(await fsp.readFile(this.file, 'utf8')) as HistoryFile
      if (j?.version === 1 && j.series && typeof j.series === 'object') this.hist = { ...empty(), ...j, alerted: j.alerted ?? {} }
    } catch {
      /* first run or unreadable: start over */
    }
  }

  private async save() {
    const tmp = `${this.file}.${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(this.hist), 'utf8')
    await fsp.rename(tmp, this.file)
  }

  private async maybeScan() {
    if (!this.cfg.enabled) return
    await this.load()
    if (Date.now() - this.started < FIRST_SCAN_MS - 5000) return
    if (Date.now() - this.hist.lastScan < this.cfg.scanHours * 3600_000) return
    await this.scanNow()
  }

  /** Measure everything now (Storage view's "Measure now"); resolves when done. */
  scanNow(): Promise<void> {
    this.scanning ??= this.scan().finally(() => {
      this.scanning = null
      this.progress = ''
      this.ctx.emit('storage', { views: this.views(), scanning: false, progress: '' })
    })
    return this.scanning
  }

  private setProgress(p: string) {
    this.progress = p
    this.ctx.emit('storage', { views: null, scanning: true, progress: p })
  }

  private async scan() {
    await this.load()
    const now = Date.now()
    const seen = new Set<string>()

    if (this.cfg.drives) {
      this.setProgress('Drives')
      let drives: DriveInfo[] = []
      try {
        drives = await this.ctx.shell.call<DriveInfo[]>('drives', {}, 20_000)
      } catch {
        /* helper busy: drives next time */
      }
      for (const d of drives) {
        if (!d.ready || !(d.total > 0) || (d.kind !== 'fixed' && d.kind !== 'network')) continue
        const key = `drive:${d.root.toLowerCase()}`
        seen.add(key)
        const s = this.series(key, { kind: 'drive', path: d.root, label: `${d.label || (d.kind === 'network' ? 'Network drive' : 'Local Disk')} (${d.root.slice(0, 2)})` })
        s.total = d.total
        s.free = d.free
        s.samples.push({ t: now, bytes: d.total - d.free })
      }
    }

    for (const f of this.cfg.folders) {
      this.abort = new AbortController()
      const r = await this.measure(f, this.abort.signal)
      if (!r) continue
      const key = `folder:${f.path.toLowerCase()}`
      seen.add(key)
      const s = this.series(key, { kind: 'folder', path: f.path, label: baseName(f.path), folderId: f.id })
      s.partial = r.partial
      s.folderId = f.id
      s.samples.push({ t: now, bytes: r.total })
      if (f.children)
        for (const [path, bytes] of r.children) {
          const ck = `child:${path.toLowerCase()}`
          seen.add(ck)
          const c = this.series(ck, { kind: 'child', path, label: baseName(path), folderId: f.id })
          c.partial = r.partial
          c.samples.push({ t: now, bytes })
        }
    }

    // forget series nobody measures any more (untracked folders, removed drives) after 30 days
    for (const [k, s] of Object.entries(this.hist.series)) {
      s.samples = compactHistory(s.samples, now)
      const last = s.samples[s.samples.length - 1]
      if (!seen.has(k) && (!last || now - last.t > 30 * DAY)) delete this.hist.series[k]
    }
    this.hist.lastScan = now
    try {
      await this.save()
    } catch (err) {
      console.error('[storage] save', err)
    }
    this.raiseAlerts(now)
  }

  private series(key: string, init: Omit<Series, 'samples'>) {
    const s = (this.hist.series[key] ??= { ...init, samples: [] })
    s.label = init.label
    s.path = init.path
    return s
  }

  /** Total size of a tracked folder and of each immediate subfolder (files directly inside count only in the total). */
  private async measure(f: TrackedFolder, signal: AbortSignal) {
    const root = f.path.replace(/\\+$/, '') + (/^[a-zA-Z]:$/.test(f.path.replace(/\\+$/, '')) ? '\\' : '')
    try {
      const st = await fsp.stat(root)
      if (!st.isDirectory()) return null
    } catch {
      return null
    }
    this.setProgress(baseName(f.path))
    const rootLow = root.toLowerCase().replace(/\\+$/, '') + '\\'
    // lower-case first segment -> the subfolder as listed (keeps its capitalisation) and its bytes
    const kids = new Map<string, { path: string; bytes: number }>()
    let total = 0
    let count = 0
    let partial = false
    const t0 = Date.now()
    const ac = new AbortController()
    const stop = () => ac.abort()
    signal.addEventListener('abort', stop)
    await walk(
      this.ctx,
      root,
      (e: Entry) => {
        if (++count > MAX_ENTRIES || Date.now() - t0 > MAX_WALK_MS) {
          partial = true
          ac.abort()
          return false
        }
        const rel = e.path.slice(rootLow.length)
        const cut = rel.indexOf('\\')
        if (e.dir) {
          if (cut < 0 && f.children && !kids.has(rel.toLowerCase())) kids.set(rel.toLowerCase(), { path: e.path, bytes: 0 })
          return
        }
        total += e.size
        if (cut > 0 && f.children) {
          const first = rel.slice(0, cut)
          const k = kids.get(first.toLowerCase()) ?? { path: root.replace(/\\+$/, '') + '\\' + first, bytes: 0 }
          k.bytes += e.size
          kids.set(first.toLowerCase(), k)
        }
      },
      { signal: ac.signal, concurrency: 4, lane: 'bulk', onError: () => (partial = true) }
    )
    signal.removeEventListener('abort', stop)
    if (signal.aborted) return null
    return { total, children: [...kids.values()].map((k) => [k.path, k.bytes] as const), partial }
  }

  /** Everything the Storage view shows, worst first. */
  views(now = Date.now()): StorageSeriesView[] {
    const out: StorageSeriesView[] = []
    for (const [key, s] of Object.entries(this.hist.series)) {
      const trend = analyse(s.samples, now)
      const last = s.samples[s.samples.length - 1]
      const spark = dailySeries(s.samples.filter((x) => x.t >= now - 60 * DAY)).map((x) => x.bytes)
      out.push({
        key, kind: s.kind, path: s.path, folderId: s.folderId, label: s.label, total: s.total, free: s.free, trend,
        fullIn: s.kind === 'drive' ? daysToFull(s.free ?? 0, trend.rate) : null,
        at: last?.t ?? 0, partial: !!s.partial, spark
      })
    }
    const rank = (v: StorageSeriesView) => (v.trend.unusual ? 3 : v.fullIn !== null && v.fullIn <= FULL_WARN_DAYS ? 2 : 0) + (v.kind === 'child' ? 0 : 0.5)
    return out.sort((a, b) => rank(b) - rank(a) || (b.trend.recent ?? 0) - (a.trend.recent ?? 0))
  }

  /** History of one series, one point per day (for the chart). */
  history(key: string) {
    const s = this.hist.series[key]
    return s ? dailySeries(s.samples) : []
  }

  private raiseAlerts(now: number) {
    const views = this.views(now)
    const byFolder = new Map<string, StorageSeriesView[]>()
    for (const v of views) if (v.folderId) byFolder.set(v.folderId, [...(byFolder.get(v.folderId) ?? []), v])

    const alerts: StorageAlert[] = []
    // one alert per tracked folder: the folder itself, naming its fastest-growing unusual subfolder
    for (const f of this.cfg.folders) {
      const vs = byFolder.get(f.id) ?? []
      const top = vs.find((v) => v.kind === 'folder')
      const kids = vs.filter((v) => v.kind === 'child' && v.trend.unusual).sort((a, b) => (b.trend.recent ?? 0) - (a.trend.recent ?? 0))
      const subject = top?.trend.unusual ? top : kids[0]
      if (!subject) continue
      const level = subject.trend.score ?? 0
      if (!this.shouldAlert(subject.key, level, now, (a, b) => b >= a * 1.5)) continue
      const words = unusualAlert(subject, subject === top ? kids[0] : undefined)
      alerts.push({ key: subject.key, kind: 'unusual', path: subject.path, ...words, users: f.notify, at: now, culprit: subject === top ? kids[0]?.path : subject.path })
    }
    for (const v of views) {
      if (v.kind !== 'drive' || v.fullIn === null || v.fullIn > FULL_WARN_DAYS || (v.trend.days ?? 0) < 3) continue
      // re-alert sooner than daily only when the forecast has at least halved
      if (!this.shouldAlert(v.key, v.fullIn, now, (a, b) => b <= a / 2)) continue
      alerts.push({ key: v.key, kind: 'filling', path: v.path, ...fillingAlert(v), users: [], at: now })
    }

    for (const a of alerts) {
      this.hist.alerted[a.key] = { at: now, level: a.kind === 'unusual' ? (views.find((v) => v.key === a.key)?.trend.score ?? 0) : (views.find((v) => v.key === a.key)?.fullIn ?? 0) }
      this.ctx.emit('storage-alert', a)
      process.parentPort?.postMessage({
        type: 'notify', title: a.title, body: a.body, folder: a.culprit ?? a.path,
        connect: { users: a.users, text: `${a.title}\n${a.body}\n${a.path}`, title: 'Storage alert' }
      })
    }
    if (alerts.length) void this.save().catch(() => {})
  }

  private shouldAlert(key: string, level: number, now: number, worse: (prev: number, cur: number) => boolean) {
    const prev = this.hist.alerted[key]
    if (!prev) return true
    if (now - prev.at >= REALERT_MS * 7) return true
    if (now - prev.at >= REALERT_MS && worse(prev.level, level)) return true
    return false
  }

  status() {
    return { enabled: this.cfg.enabled, lastScan: this.hist.lastScan, scanning: !!this.scanning, progress: this.progress, scanHours: this.cfg.scanHours }
  }
}

function baseName(p: string) {
  const t = p.replace(/\\+$/, '')
  return /^[a-zA-Z]:$/.test(t) ? t + '\\' : t.split('\\').pop() || p
}

export function storageHandlers(ctx: EngineCtx & { storage: StorageIntel }) {
  return {
    'storage.views': async () => {
      await ctx.storage.load()
      return { views: ctx.storage.views(), ...ctx.storage.status() }
    },
    'storage.history': async (key: string) => {
      await ctx.storage.load()
      return ctx.storage.history(String(key))
    },
    'storage.scanNow': () => {
      void ctx.storage.scanNow()
      return true
    }
  }
}
