// Folder watch: snapshot diff, burst batching, ignore rules and the notification wording.
// Pure (no Node, no DOM) so the engine, the renderer and node:test share it. The engine takes
// snapshots (name + size + modified time) and feeds the differences in; nothing here touches disk.

export interface WatchedFolder {
  id: string
  path: string
  /** also watch everything below the folder */
  subfolders: boolean
  notify: { added: boolean; changed: boolean; removed: boolean }
  /** no Windows notification, toast or Connect message between from and to (local time, "HH:MM") */
  quiet: { on: boolean; from: string; to: string }
  /** also send a Dexterity Connect message to me (folder name and counts only) */
  connect: boolean
}

export const WATCH_MAX_ENTRIES = 20_000
/** a burst is over when nothing changed for this long */
export const WATCH_SETTLE_MS = 5_000
/** a folder that never stops changing still reports at least this often */
export const WATCH_MAX_HOLD_MS = 5 * 60_000
/** network folders are listed this often (change notifications on SMB shares are unreliable) */
export const WATCH_POLL_NETWORK_MS = 30_000
/** local folders rely on change notifications; this is only a safety net */
export const WATCH_POLL_LOCAL_MS = 5 * 60_000
/** paths Hopper itself wrote count as "you" for this long */
export const OWN_TTL_MS = 2 * 60_000

export function newWatchedFolder(path: string, id = `wf${Date.now().toString(36)}`): WatchedFolder {
  return { id, path, subfolders: true, notify: { added: true, changed: true, removed: false }, quiet: { on: false, from: '19:00', to: '08:00' }, connect: false }
}

/** Fill gaps in a saved entry (older settings, hand edits). Returns null when it has no path. */
export function cleanWatched(raw: unknown): WatchedFolder | null {
  const r = raw as Partial<WatchedFolder> | null
  if (!r || typeof r.path !== 'string' || !r.path.trim()) return null
  const d = newWatchedFolder(r.path, typeof r.id === 'string' && r.id ? r.id : undefined)
  const hhmm = (v: unknown, def: string) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : def)
  return {
    id: d.id,
    path: r.path,
    subfolders: r.subfolders !== false,
    notify: { added: r.notify?.added !== false, changed: r.notify?.changed !== false, removed: r.notify?.removed === true },
    quiet: { on: r.quiet?.on === true, from: hhmm(r.quiet?.from, d.quiet.from), to: hhmm(r.quiet?.to, d.quiet.to) },
    connect: r.connect === true
  }
}

// ---------------------------------------------------------------------------
// engine -> window

export interface FolderWatchStatus {
  id: string
  path: string
  entries: number
  /** the listing stopped at WATCH_MAX_ENTRIES */
  limited: boolean
  /** 'notify' = change notifications plus a check every 5 min; 'poll' = checked every 30 s */
  mode: 'notify' | 'poll'
  error: string
  ready: boolean
}

export interface FolderWatchEvent {
  id: string
  watchId: string
  folder: string
  name: string
  at: number
  title: string
  body: string
  counts: { added: number; changed: number; removed: number }
  /** absolute paths, at most 200 of each */
  added: string[]
  changed: string[]
  removed: string[]
  /** inside the folder's quiet hours: no toast, no Windows notification, no Connect message */
  quiet: boolean
}

// ---------------------------------------------------------------------------
// ignore rules

const IGNORE: RegExp[] = [
  /^~\$/, // Office owner files
  /\.tmp$/i,
  /^\.~lock\./i, // LibreOffice
  /\.dwl2?$/i, // AutoCAD lock files
  /^thumbs\.db$/i,
  /^desktop\.ini$/i,
  // Hopper's own half-written files (copies, zips, saves, renames)
  /\.hopper-(part|save|tmp)$/i,
  /\.hopper-rn\d+$/i,
  /^\.hopper-extract-/i
]

/** Temp and lock files that never count as an arrival or a change. */
export const isIgnoredName = (name: string) => IGNORE.some((re) => re.test(name))

/** True when any part of a relative path ("a\\b\\c.pdf") is ignored (e.g. inside .hopper-extract-…). */
export const isIgnoredPath = (rel: string) => rel.split(/[\\/]/).some((part) => part && isIgnoredName(part))

// ---------------------------------------------------------------------------
// snapshots

export interface SnapItem {
  /** path relative to the watched folder, as written on disk */
  rel: string
  dir: boolean
  size: number
  mtime: number
  /** creation time on this volume; a copy gets a new one even when it keeps the source's modified time */
  ctime?: number
}

/** key: lower-case relative path (Windows names are case-insensitive) */
export type Snapshot = Map<string, SnapItem>

export function snapshotOf(items: SnapItem[]): Snapshot {
  const m: Snapshot = new Map()
  for (const i of items) if (!isIgnoredPath(i.rel)) m.set(i.rel.toLowerCase(), i)
  return m
}

export interface SnapDiff {
  added: string[]
  changed: string[]
  removed: string[]
}

/**
 * What changed between two listings. With `partial` (either listing stopped at the entry limit)
 * deletions are not reported and additions need a recent creation or modified time.
 * A file changed when its size or modified time differs
 * (a time within 2 s counts as the same: FAT and some NAS shares round to 2 s). Folders are
 * only ever added or removed; their own time changes whenever their contents do.
 */
export function diffSnapshots(prev: Snapshot, next: Snapshot, partial?: { since: number }): SnapDiff {
  const added: string[] = []
  const changed: string[] = []
  const removed: string[] = []
  for (const [k, n] of next) {
    const p = prev.get(k)
    if (!p || p.dir !== n.dir) {
      // A listing cut off at the entry limit holds a different subset each time: an entry missing
      // from the last one is new only if it was created (or written) since that listing.
      if (!partial || Math.max(n.ctime ?? 0, n.mtime) >= partial.since - 2000) added.push(n.rel)
    } else if (!n.dir && (p.size !== n.size || Math.abs(p.mtime - n.mtime) > 2000)) changed.push(n.rel)
  }
  // ...and an entry missing from this one may just be beyond the limit: no deletions then.
  if (partial) return { added, changed, removed }
  for (const [k, p] of prev) {
    const n = next.get(k)
    if (!n || n.dir !== p.dir) removed.push(p.rel)
  }
  return { added, changed, removed }
}

// ---------------------------------------------------------------------------
// paths this Hopper wrote ("you")

/** Paths created, moved or deleted by this Hopper recently. A folder covers everything inside it. */
export class OwnPaths {
  private items = new Map<string, number>()
  private ttl: number
  constructor(ttl = OWN_TTL_MS) {
    this.ttl = ttl
  }

  add(paths: string[], now: number) {
    for (const p of paths) if (p) this.items.set(norm(p), now)
    if (this.items.size > 50_000) this.prune(now)
  }

  has(path: string, now: number) {
    let p = norm(path)
    for (;;) {
      const at = this.items.get(p)
      if (at !== undefined && now - at <= this.ttl) return true
      const cut = p.lastIndexOf('\\')
      if (cut <= 2) return false
      p = p.slice(0, cut)
    }
  }

  prune(now: number) {
    for (const [k, at] of this.items) if (now - at > this.ttl) this.items.delete(k)
  }
}

const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/** Is `child` the folder itself or inside it? (case-insensitive, either slash) */
export function isWithin(child: string, folder: string) {
  const c = norm(child)
  const f = norm(folder)
  return c === f || c.startsWith(f + '\\')
}

// ---------------------------------------------------------------------------
// batching

export type ChangeKind = 'added' | 'changed' | 'removed'

export interface Batch {
  added: string[]
  changed: string[]
  removed: string[]
  firstAt: number
  lastAt: number
}

/**
 * Collects the changes of one watched folder until the burst settles. Later news about the
 * same path replaces earlier news within a batch:
 *   added then changed = added (a file still being copied)
 *   added then removed = nothing (a temp file that came and went)
 *   removed then added = changed (replaced by a new copy)
 */
export class Batcher {
  private state = new Map<string, { kind: ChangeKind; rel: string }>()
  private firstAt = 0
  private lastAt = 0

  get pending() {
    return this.state.size > 0
  }

  get lastChange() {
    return this.lastAt
  }

  add(diff: SnapDiff, now: number) {
    let n = 0
    const put = (rel: string, kind: ChangeKind) => {
      const k = rel.toLowerCase()
      const prev = this.state.get(k)?.kind
      n++
      if (!prev) return void this.state.set(k, { kind, rel })
      if (prev === 'added' && kind === 'changed') return
      if (prev === 'added' && kind === 'removed') return void this.state.delete(k)
      if (prev === 'removed' && kind === 'added') return void this.state.set(k, { kind: 'changed', rel })
      this.state.set(k, { kind, rel })
    }
    for (const r of diff.removed) put(r, 'removed')
    for (const r of diff.added) put(r, 'added')
    for (const r of diff.changed) put(r, 'changed')
    if (!n) return
    if (!this.firstAt) this.firstAt = now
    this.lastAt = now
  }

  /** Ready to report: quiet for `settle` ms, or held for `maxHold` ms while still changing. */
  due(now: number, settle = WATCH_SETTLE_MS, maxHold = WATCH_MAX_HOLD_MS) {
    if (!this.firstAt) return false
    return now - this.lastAt >= settle || now - this.firstAt >= maxHold
  }

  take(): Batch {
    const b: Batch = { added: [], changed: [], removed: [], firstAt: this.firstAt, lastAt: this.lastAt }
    for (const { kind, rel } of this.state.values()) b[kind].push(rel)
    for (const k of ['added', 'changed', 'removed'] as const) b[k].sort((x, y) => x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }))
    this.state.clear()
    this.firstAt = 0
    this.lastAt = 0
    return b
  }
}

/** Keep what the folder's settings ask to be told about, minus paths this Hopper wrote. */
export function filterBatch(b: Batch, w: Pick<WatchedFolder, 'notify' | 'path'>, own: (abs: string) => boolean): Batch {
  const abs = (rel: string) => `${w.path.replace(/[\\/]+$/, '')}\\${rel}`
  const keep = (list: string[], on: boolean) => (on ? list.filter((r) => !own(abs(r))) : [])
  return { ...b, added: keep(b.added, w.notify.added), changed: keep(b.changed, w.notify.changed), removed: keep(b.removed, w.notify.removed) }
}

export const batchSize = (b: Pick<Batch, 'added' | 'changed' | 'removed'>) => b.added.length + b.changed.length + b.removed.length

// ---------------------------------------------------------------------------
// quiet hours and wording

const minutes = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm)
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1
}

/** Inside quiet hours at local time `d`? A range like 19:00–08:00 runs over midnight. */
export function inQuietHours(q: WatchedFolder['quiet'], d: Date) {
  if (!q.on) return false
  const from = minutes(q.from)
  const to = minutes(q.to)
  if (from < 0 || to < 0 || from === to) return false
  const now = d.getHours() * 60 + d.getMinutes()
  return from < to ? now >= from && now < to : now >= from || now < to
}

const count = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`

/** Last part of a folder path ("\\\\server\\share" stays whole). */
export function folderName(path: string) {
  const p = path.replace(/[\\/]+$/, '')
  const i = p.lastIndexOf('\\')
  const name = i >= 0 ? p.slice(i + 1) : p
  return /^[a-z]:$/i.test(name) ? `${name}\\` : name || p
}

/** "300 new files in Drop" / "1 changed file in Drop" / "8 changes in Drop". */
export function batchTitle(b: Pick<Batch, 'added' | 'changed' | 'removed'>, folder: string) {
  const parts = ([['added', 'new'], ['changed', 'changed'], ['removed', 'deleted']] as const).filter(([k]) => b[k].length)
  if (parts.length === 1) {
    const [k, word] = parts[0]
    const files = b[k].length
    return `${files.toLocaleString('en-US')} ${word} ${files === 1 ? 'file' : 'files'} in ${folder}`
  }
  return `${count(batchSize(b), 'change')} in ${folder}`
}

/** Counts plus a few names: "5 new, 2 changed · a.pdf, b.pdf and 5 more". Names stay on this PC. */
export function batchBody(b: Pick<Batch, 'added' | 'changed' | 'removed'>, names = 3) {
  const counts = ([['added', 'new'], ['changed', 'changed'], ['removed', 'deleted']] as const).filter(([k]) => b[k].length).map(([k, w]) => `${b[k].length.toLocaleString('en-US')} ${w}`)
  const all = [...b.added, ...b.changed, ...b.removed].map((r) => r.split(/[\\/]/).pop() ?? r)
  const shown = all.slice(0, names).join(', ')
  const more = all.length > names ? ` and ${(all.length - names).toLocaleString('en-US')} more` : ''
  return counts.length > 1 ? `${counts.join(', ')} · ${shown}${more}` : `${shown}${more}`
}

/** The Dexterity Connect text: the folder's name and counts, never file names or contents. */
export function connectText(b: Pick<Batch, 'added' | 'changed' | 'removed'>, folder: string) {
  const counts = ([['added', 'new'], ['changed', 'changed'], ['removed', 'deleted']] as const).filter(([k]) => b[k].length).map(([k, w]) => `${b[k].length.toLocaleString('en-US')} ${w}`)
  return `Hopper: ${batchTitle(b, folder)} (${counts.join(', ')})`
}
