// Predictive Storage Intelligence: the arithmetic. No AI, no guessing - every number here can be
// re-derived by hand from the size history Hopper records (engine/storage.ts measures, this judges).
//
// Trend     : Theil-Sen slope (median of all pairwise slopes) over the last TREND_DAYS of daily
//             sizes. One huge copy-in or clean-up day moves it far less than a least-squares line.
// Unusual   : the last RECENT_DAYS' growth rate against the folder's own history of daily changes,
//             scored as a robust z (0.6745 * (x - median) / MAD). Unusual = score >= Z_UNUSUAL
//             AND fast in absolute terms (MIN_UNUSUAL_BYTES_DAY and twice the normal rate), so a
//             folder that always grows a little never pages anyone for growing a little more.
// Forecast  : today's size + trend * days. Drives: days until the free space is used up.

export const DAY = 86_400_000
export const TREND_DAYS = 30
export const RECENT_DAYS = 3
export const MIN_TREND_POINTS = 4
export const MIN_BASELINE_DELTAS = 5
export const Z_UNUSUAL = 3.5
/** growth below this per day is never "unusual" (noise floor) */
export const MIN_UNUSUAL_BYTES_DAY = 512 * 1024 ** 2
/** MAD floor so a perfectly steady folder does not score infinity on its first wobble */
export const MAD_FLOOR_BYTES = 64 * 1024 ** 2
/** keep every measurement this long, then one per day */
export const KEEP_RAW_DAYS = 14
export const KEEP_DAYS = 400
/** a folder is not alerted again for this long unless it gets markedly worse */
export const REALERT_MS = DAY
/** drives: warn when the trend fills them within this many days */
export const FULL_WARN_DAYS = 30

export interface StorageSample {
  /** ms since epoch */
  t: number
  bytes: number
}

export interface TrackedFolder {
  id: string
  path: string
  /** office user names to alert besides me (Dexterity Connect); empty = only me */
  notify: string[]
  /** also measure each immediate subfolder, so the alert can name which one is growing */
  children: boolean
}

export interface StorageSettings {
  enabled: boolean
  folders: TrackedFolder[]
  /** measure every N hours (1-48) */
  scanHours: number
  /** forecast fixed and network drives' free space */
  drives: boolean
}

export interface Trend {
  /** bytes per day, Theil-Sen over the last TREND_DAYS (null: not enough history) */
  rate: number | null
  /** bytes per day over the last RECENT_DAYS */
  recent: number | null
  /** median and MAD of daily changes before the recent window */
  baseline: { median: number; mad: number; n: number } | null
  /** robust z of `recent` against `baseline` (null: not enough history) */
  score: number | null
  unusual: boolean
  /** plain-words reason when unusual */
  reason: string
  /** size now and forecast in 30 / 90 days (null without a trend) */
  now: number
  in30: number | null
  in90: number | null
  /** days of history behind these numbers */
  days: number
}

export function median(xs: number[]) {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Median absolute deviation (unscaled). */
export function mad(xs: number[], med = median(xs)) {
  return median(xs.map((x) => Math.abs(x - med)))
}

/** Theil-Sen slope of (x, y) points: the median of pairwise slopes. x in days. */
export function theilSen(points: { x: number; y: number }[]) {
  const slopes: number[] = []
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j].x - points[i].x
      if (dx > 1e-9) slopes.push((points[j].y - points[i].y) / dx)
    }
  return slopes.length ? median(slopes) : NaN
}

/** Local calendar day number of a timestamp (days since epoch in local time). */
export function dayOf(t: number) {
  const d = new Date(t)
  return Math.floor((t - d.getTimezoneOffset() * 60_000) / DAY)
}

/** One sample per local day: the day's last measurement. Sorted by time. */
export function dailySeries(samples: StorageSample[]): StorageSample[] {
  const byDay = new Map<number, StorageSample>()
  for (const s of [...samples].sort((a, b) => a.t - b.t)) byDay.set(dayOf(s.t), s)
  return [...byDay.values()]
}

/** Thin out history: everything from the last KEEP_RAW_DAYS, one per day before that, nothing past KEEP_DAYS. */
export function compactHistory(samples: StorageSample[], now: number): StorageSample[] {
  const raw = samples.filter((s) => s.t >= now - KEEP_RAW_DAYS * DAY && s.t <= now + DAY)
  const old = dailySeries(samples.filter((s) => s.t < now - KEEP_RAW_DAYS * DAY && s.t >= now - KEEP_DAYS * DAY))
  return [...old, ...raw.sort((a, b) => a.t - b.t)]
}

/** Judge one folder's (or drive's used space's) history. */
export function analyse(samples: StorageSample[], now = Date.now()): Trend {
  const daily = dailySeries(samples.filter((s) => s.t <= now + DAY))
  const last = daily[daily.length - 1]
  const out: Trend = { rate: null, recent: null, baseline: null, score: null, unusual: false, reason: '', now: last?.bytes ?? 0, in30: null, in90: null, days: 0 }
  if (!last) return out
  out.days = Math.round((last.t - daily[0].t) / DAY)

  const window = daily.filter((s) => s.t >= last.t - TREND_DAYS * DAY)
  if (window.length >= MIN_TREND_POINTS) {
    const r = theilSen(window.map((s) => ({ x: s.t / DAY, y: s.bytes })))
    if (Number.isFinite(r)) {
      out.rate = r
      out.in30 = Math.max(0, last.bytes + r * 30)
      out.in90 = Math.max(0, last.bytes + r * 90)
    }
  }

  // recent rate: change over the last RECENT_DAYS (from the newest sample at or before that point)
  const cut = last.t - RECENT_DAYS * DAY
  const before = [...daily].reverse().find((s) => s.t <= cut + DAY / 4 && s !== last)
  if (before) out.recent = (last.bytes - before.bytes) / Math.max(0.5, (last.t - before.t) / DAY)

  // baseline: per-day changes strictly before the recent window
  const deltas: number[] = []
  const older = daily.filter((s) => s.t <= (before?.t ?? cut))
  for (let i = 1; i < older.length; i++) {
    const days = (older[i].t - older[i - 1].t) / DAY
    if (days > 0.25) deltas.push((older[i].bytes - older[i - 1].bytes) / days)
  }
  if (deltas.length >= MIN_BASELINE_DELTAS) {
    const m = median(deltas)
    const d = mad(deltas, m)
    out.baseline = { median: m, mad: d, n: deltas.length }
    if (out.recent !== null) {
      out.score = (0.6745 * (out.recent - m)) / Math.max(d, MAD_FLOOR_BYTES)
      const normal = Math.max(m, 0)
      if (out.score >= Z_UNUSUAL && out.recent >= MIN_UNUSUAL_BYTES_DAY && out.recent >= 2 * normal) {
        out.unusual = true
        out.reason = normal > 0
          ? `growing ${fmtBytes(out.recent)}/day over the last ${RECENT_DAYS} days, ${Math.round(out.recent / normal)}x its usual ${fmtBytes(normal)}/day`
          : `growing ${fmtBytes(out.recent)}/day over the last ${RECENT_DAYS} days; it normally does not grow`
      }
    }
  }
  return out
}

/** Days until a drive is full at the trend rate (null: not filling / no trend). */
export function daysToFull(free: number, rate: number | null) {
  if (rate === null || !(rate > 0) || !(free >= 0)) return null
  return free / rate
}

export function fmtBytes(n: number) {
  const neg = n < 0
  let v = Math.abs(n)
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${neg ? '-' : ''}${i === 0 ? v : v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

export function cleanTracked(raw: unknown): TrackedFolder | null {
  const r = raw as Partial<TrackedFolder> | null
  if (!r || typeof r.path !== 'string' || !/^([a-zA-Z]:\\|\\\\[^\\]+\\[^\\]+)/.test(r.path)) return null
  return {
    id: typeof r.id === 'string' && r.id ? r.id.slice(0, 40) : `st${Math.abs(hash(r.path.toLowerCase())).toString(36)}`,
    path: r.path,
    notify: Array.isArray(r.notify) ? r.notify.filter((u): u is string => typeof u === 'string' && u.length > 0 && u.length < 120).slice(0, 30) : [],
    children: r.children !== false
  }
}

export function cleanStorageSettings(raw: unknown): StorageSettings {
  const r = (raw ?? {}) as Partial<StorageSettings>
  const hours = Number(r.scanHours)
  const folders = (Array.isArray(r.folders) ? r.folders : []).map(cleanTracked).filter((f): f is TrackedFolder => !!f)
  const seen = new Set<string>()
  return {
    enabled: r.enabled !== false,
    folders: folders.filter((f) => !seen.has(f.path.toLowerCase()) && !!seen.add(f.path.toLowerCase())).slice(0, 50),
    scanHours: Number.isFinite(hours) ? Math.min(48, Math.max(1, Math.round(hours))) : 6,
    drives: r.drives !== false
  }
}

function hash(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

/** What the Storage view and alerts show for one series. */
export interface StorageSeriesView {
  key: string
  kind: 'drive' | 'folder' | 'child'
  path: string
  /** tracked folder id this belongs to (folders and their children) */
  folderId?: string
  label: string
  /** drives: total and free bytes at the last measurement */
  total?: number
  free?: number
  trend: Trend
  /** drives: days until full at the trend rate */
  fullIn: number | null
  /** last measurement time, and whether it was cut short (entry cap / unreadable parts) */
  at: number
  partial: boolean
  /** daily sizes for the sparkline (last 60 days) */
  spark: number[]
}

export interface StorageAlert {
  key: string
  kind: 'unusual' | 'filling'
  path: string
  title: string
  body: string
  /** users to notify on Dexterity Connect besides me */
  users: string[]
  at: number
  /** the growing subfolder, when known */
  culprit?: string
}

/** Alert wording for a folder (or subfolder) that is growing unusually fast. */
export function unusualAlert(v: StorageSeriesView, culprit?: StorageSeriesView): Pick<StorageAlert, 'title' | 'body'> {
  const name = v.label
  const t = v.trend
  const where = culprit && culprit.path !== v.path ? `Most of it is in ${culprit.label} (${culprit.trend.reason}). ` : ''
  const fc = t.in30 !== null ? `At this rate it reaches ${fmtBytes(t.now + (t.recent ?? 0) * 30)} in 30 days (now ${fmtBytes(t.now)}).` : `Now ${fmtBytes(t.now)}.`
  return { title: `${name} is growing unusually fast`, body: `${capital(t.reason)}. ${where}${fc}` }
}

/** Alert wording for a drive whose free space runs out within FULL_WARN_DAYS at the trend rate. */
export function fillingAlert(v: StorageSeriesView): Pick<StorageAlert, 'title' | 'body'> {
  const days = Math.max(0, Math.floor(v.fullIn ?? 0))
  return {
    title: `${v.label} will be full in about ${days === 0 ? 'a day' : days === 1 ? '1 day' : `${days} days`}`,
    body: `${fmtBytes(v.free ?? 0)} free; it has been filling at ${fmtBytes(v.trend.rate ?? 0)}/day over the last ${Math.min(v.trend.days, TREND_DAYS)} days.`
  }
}

function capital(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}
