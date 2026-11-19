// File list logic shared by the renderer, the engine and node:test:
//  - group-by buckets (type, date modified, size, name)
//  - search filters in the query language (date:, size:, type:) on top of words, wildcards,
//    ext: and /regex/
//  - the key under which a folder's view is remembered
// Pure (no Node, no DOM, no value imports) so node:test can load it directly. Dates are local time.
import type { ColumnSpec, ViewMode } from './types'

// ---------------------------------------------------------------------------
// Dates

export interface DateMarks {
  now: number
  today: number
  yesterday: number
  tomorrow: number
  week: number
  lastWeek: number
  month: number
  lastMonth: number
  year: number
  lastYear: number
}

/** Start-of-period times around `now` in local time. weekStart: 0 = Sunday, 1 = Monday. */
export function dateMarks(now = Date.now(), weekStart = 1): DateMarks {
  const d = new Date(now)
  const y = d.getFullYear()
  const m = d.getMonth()
  const day = d.getDate()
  const back = (d.getDay() - weekStart + 7) % 7
  // new Date(y, m, day - n) stays on local midnight across daylight-saving changes
  return {
    now,
    today: new Date(y, m, day).getTime(),
    yesterday: new Date(y, m, day - 1).getTime(),
    tomorrow: new Date(y, m, day + 1).getTime(),
    week: new Date(y, m, day - back).getTime(),
    lastWeek: new Date(y, m, day - back - 7).getTime(),
    month: new Date(y, m, 1).getTime(),
    lastMonth: new Date(y, m - 1, 1).getTime(),
    year: new Date(y, 0, 1).getTime(),
    lastYear: new Date(y - 1, 0, 1).getTime()
  }
}

/** First day of the week for the current locale (0 = Sunday), Monday when the runtime cannot say. */
export function localWeekStart(): number {
  try {
    const loc: any = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale)
    const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo
    const first = info?.firstDay
    return typeof first === 'number' ? first % 7 : 1
  } catch {
    return 1
  }
}

// ---------------------------------------------------------------------------
// Group by

export type GroupBy = 'none' | 'type' | 'mtime' | 'size' | 'name'

export const GROUP_BY: { id: GroupBy; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'name', label: 'Name' },
  { id: 'mtime', label: 'Date modified' },
  { id: 'type', label: 'Type' },
  { id: 'size', label: 'Size' }
]

export interface Groupable {
  name: string
  dir: boolean
  ext: string
  size: number
  mtime: number
}

export interface Group<T> {
  key: string
  label: string
  items: T[]
}

export const DATE_GROUPS = ['Today', 'Yesterday', 'Earlier this week', 'Last week', 'Earlier this month', 'Last month', 'Earlier this year', 'A long time ago']
export const SIZE_GROUPS = ['Folders', 'Empty', 'Tiny (under 16 KB)', 'Small (16 KB to 1 MB)', 'Medium (1 to 128 MB)', 'Large (128 MB to 1 GB)', 'Huge (over 1 GB)']
export const NAME_GROUPS = ['A–H', 'I–P', 'Q–Z', '0–9 and other']

const KB = 1024
const MB = KB * 1024
const GB = MB * 1024

/** Index into DATE_GROUPS. A date in the future counts as Today. */
export function dateGroup(mtime: number, m: DateMarks): number {
  if (mtime >= m.today) return 0
  if (mtime >= m.yesterday) return 1
  if (mtime >= m.week) return 2
  if (mtime >= m.lastWeek) return 3
  if (mtime >= m.month) return 4
  if (mtime >= m.lastMonth) return 5
  if (mtime >= m.year) return 6
  return 7
}

/** Index into SIZE_GROUPS. Folders have no size of their own, so they get a group of their own. */
export function sizeGroup(e: { dir: boolean; size: number }): number {
  if (e.dir) return 0
  const s = e.size
  if (s <= 0) return 1
  if (s < 16 * KB) return 2
  if (s < MB) return 3
  if (s < 128 * MB) return 4
  if (s < GB) return 5
  return 6
}

/** Index into NAME_GROUPS by the first character (accents ignored: É sorts with E). */
export function nameGroup(name: string): number {
  const c = name.charAt(0).normalize('NFD').charAt(0).toUpperCase()
  if (c >= 'A' && c <= 'H') return 0
  if (c >= 'I' && c <= 'P') return 1
  if (c >= 'Q' && c <= 'Z') return 2
  return 3
}

const defaultTypeLabel = (ext: string, dir: boolean) => (dir ? 'File folder' : ext ? `${ext.toUpperCase()} file` : 'File')

/**
 * Split items into groups. Items keep their input order inside each group (so a list sorted
 * folders-first stays folders-first per group); empty groups are left out. Group order:
 * date newest first, size smallest first, name A to Z, type folders first then by label.
 */
export function groupItems<T extends Groupable>(
  items: readonly T[],
  by: GroupBy,
  opts: { now?: number; weekStart?: number; typeLabel?: (ext: string, dir: boolean) => string } = {}
): Group<T>[] {
  if (by === 'none') return [{ key: '', label: '', items: items.slice() }]
  if (by === 'type') {
    const label = opts.typeLabel ?? defaultTypeLabel
    const labels = new Map<string, string>()
    const map = new Map<string, Group<T> & { dir: boolean }>()
    for (const e of items) {
      const lk = (e.dir ? '/' : '.') + e.ext
      let l = labels.get(lk)
      if (l === undefined) labels.set(lk, (l = label(e.ext, e.dir)))
      const key = (e.dir ? 'dir:' : 'type:') + l.toLowerCase()
      let g = map.get(key)
      if (!g) map.set(key, (g = { key, label: l, items: [], dir: e.dir }))
      g.items.push(e)
    }
    return [...map.values()]
      .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.label.localeCompare(b.label)))
      .map(({ key, label, items }) => ({ key, label, items }))
  }
  const names = by === 'mtime' ? DATE_GROUPS : by === 'size' ? SIZE_GROUPS : NAME_GROUPS
  const marks = by === 'mtime' ? dateMarks(opts.now ?? Date.now(), opts.weekStart ?? 1) : null
  const buckets: T[][] = names.map(() => [])
  for (const e of items) {
    const i = by === 'mtime' ? dateGroup(e.mtime, marks!) : by === 'size' ? sizeGroup(e) : nameGroup(e.name)
    buckets[i].push(e)
  }
  const out: Group<T>[] = []
  buckets.forEach((list, i) => {
    if (list.length) out.push({ key: `${by}:${i}`, label: names[i], items: list })
  })
  return out
}

// ---------------------------------------------------------------------------
// Query: words (AND), * ? wildcards, ext:pdf, /regex/, and the filters
//   date: / modified:  today yesterday thisweek lastweek thismonth lastmonth thisyear lastyear
//                      <7d >2w (h d w mo y)  2026-11-01  >2026-11-01  2026-11-01..2026-11-15
//   size:              >10mb <500kb 1mb..5mb empty tiny small medium large huge
//   type: / kind:      folder file pdf drawing document sheet image archive

export interface Range {
  /** inclusive */
  min?: number
  /** inclusive */
  max?: number
}

export interface QueryFilters {
  mtime?: Range
  size?: Range
  /** true: folders only, false: files only */
  dirs?: boolean
  /** lower-case extensions (no dot) a file must have */
  exts?: string[]
  /** the filters contradict each other: nothing can match */
  never?: boolean
}

export const TYPE_EXTS: Record<string, string[]> = {
  pdf: ['pdf'],
  drawing: ['dwg', 'dgn', 'dxf', 'i01'],
  document: ['doc', 'docx', 'odt', 'rtf', 'txt'],
  sheet: ['xls', 'xlsx', 'xlsm', 'csv', 'ods'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'svg', 'heic', 'ico'],
  archive: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'cab', 'iso']
}

const TYPE_ALIAS: Record<string, string> = {
  folder: 'folder', folders: 'folder', dir: 'folder', dirs: 'folder',
  file: 'file', files: 'file',
  pdf: 'pdf', pdfs: 'pdf',
  drawing: 'drawing', drawings: 'drawing', cad: 'drawing',
  document: 'document', documents: 'document', doc: 'document', docs: 'document',
  sheet: 'sheet', sheets: 'sheet', spreadsheet: 'sheet', spreadsheets: 'sheet',
  image: 'image', images: 'image', picture: 'image', pictures: 'image', photo: 'image', photos: 'image',
  archive: 'archive', archives: 'archive'
}

/** For the help popover in the search box. */
export const FILTER_HELP: { filter: string; example: string; meaning: string }[] = [
  { filter: 'words', example: 'iso 07', meaning: 'Names containing every word' },
  { filter: '* ?', example: 'ISO-10??_*.pdf', meaning: 'Wildcards' },
  { filter: 'ext:', example: 'ext:pdf,dwg', meaning: 'Extension' },
  { filter: 'type:', example: 'type:drawing', meaning: 'folder, file, pdf, drawing, document, sheet, image, archive' },
  { filter: 'date:', example: 'date:thisweek', meaning: 'today, yesterday, thisweek, lastweek, thismonth, thisyear' },
  { filter: 'date:', example: 'date:<7d  date:>2w', meaning: 'Newer than 7 days, older than 2 weeks (h, d, w, mo, y)' },
  { filter: 'date:', example: 'date:2026-11-01..2026-11-15', meaning: 'A day, a range, or >date / <date' },
  { filter: 'size:', example: 'size:>10mb  size:1mb..5mb', meaning: 'Bigger, smaller, between (kb, mb, gb)' },
  { filter: 'size:', example: 'size:empty', meaning: 'Also tiny, small, medium, large, huge' },
  { filter: '/regex/', example: '/^ISO-\\d+_Rev[A-C]/', meaning: 'Regular expression (the whole query)' }
]

const isDay = /^(\d{4})-(\d{1,2})-(\d{1,2})$/

/** Local midnight of a yyyy-mm-dd date, or null when the date does not exist (2026-02-30). */
function dayStart(s: string, plusDays = 0): number | null {
  const m = isDay.exec(s)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2]) - 1
  const d = Number(m[3])
  const t = new Date(y, mo, d)
  if (t.getFullYear() !== y || t.getMonth() !== mo || t.getDate() !== d) return null
  return plusDays ? new Date(y, mo, d + plusDays).getTime() : t.getTime()
}

function ago(n: number, unit: string, now: number): number | null {
  const d = new Date(now)
  switch (unit) {
    case 'h': return now - n * 3600000
    case 'd': return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n, d.getHours(), d.getMinutes(), d.getSeconds()).getTime()
    case 'w': return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7 * n, d.getHours(), d.getMinutes(), d.getSeconds()).getTime()
    case 'mo': return new Date(d.getFullYear(), d.getMonth() - n, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()).getTime()
    case 'y': return new Date(d.getFullYear() - n, d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()).getTime()
  }
  return null
}

/** A date: value as a time range, or null when it is not understood. */
export function parseDateFilter(v: string, m: DateMarks): Range | null {
  // named periods may be written this-week or this_week; dates keep their dashes
  const s = /\d/.test(v) ? v.toLowerCase() : v.toLowerCase().replace(/[-_]/g, '')
  switch (s) {
    case 'today': return { min: m.today }
    case 'yesterday': return { min: m.yesterday, max: m.today - 1 }
    case 'thisweek': return { min: m.week }
    case 'lastweek': return { min: m.lastWeek, max: m.week - 1 }
    case 'thismonth': return { min: m.month }
    case 'lastmonth': return { min: m.lastMonth, max: m.month - 1 }
    case 'thisyear': return { min: m.year }
    case 'lastyear': return { min: m.lastYear, max: m.year - 1 }
  }
  // age: <7d = newer than 7 days, >7d = older than 7 days; a bare 7d means within 7 days
  const rel = /^(<=|>=|<|>)?(\d+)(h|d|w|mo|y)$/.exec(s)
  if (rel) {
    const t = ago(Number(rel[2]), rel[3], m.now)
    if (t === null) return null
    return rel[1]?.startsWith('>') ? { max: t } : { min: t }
  }
  const range = /^(\d{4}-\d{1,2}-\d{1,2})\.\.(\d{4}-\d{1,2}-\d{1,2})$/.exec(s)
  if (range) {
    let a = range[1]
    let b = range[2]
    if (dayStart(a) === null || dayStart(b) === null) return null
    if (dayStart(a)! > dayStart(b)!) [a, b] = [b, a]
    return { min: dayStart(a)!, max: dayStart(b, 1)! - 1 }
  }
  const one = /^(<=|>=|<|>)?(\d{4}-\d{1,2}-\d{1,2})$/.exec(s)
  if (one) {
    const start = dayStart(one[2])
    if (start === null) return null
    const next = dayStart(one[2], 1)!
    switch (one[1]) {
      case '>': return { min: next }
      case '>=': return { min: start }
      case '<': return { max: start - 1 }
      case '<=': return { max: next - 1 }
      default: return { min: start, max: next - 1 }
    }
  }
  return null
}

const UNIT: Record<string, number> = { '': 1, b: 1, k: KB, kb: KB, m: MB, mb: MB, g: GB, gb: GB, t: GB * 1024, tb: GB * 1024 }

function bytes(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?|\.\d+)(b|k|kb|m|mb|g|gb|t|tb)?$/.exec(s)
  if (!m) return null
  return Math.round(Number(m[1]) * UNIT[m[2] ?? ''])
}

/** A size: value as a byte range, or null when it is not understood. */
export function parseSizeFilter(v: string): Range | null {
  const s = v.toLowerCase()
  switch (s) {
    case 'empty': return { min: 0, max: 0 }
    case 'tiny': return { min: 1, max: 16 * KB - 1 }
    case 'small': return { min: 16 * KB, max: MB - 1 }
    case 'medium': return { min: MB, max: 128 * MB - 1 }
    case 'large': return { min: 128 * MB, max: GB - 1 }
    case 'huge': return { min: GB }
  }
  const range = /^([^.].*?)\.\.(.+)$/.exec(s)
  if (range) {
    const a = bytes(range[1])
    const b = bytes(range[2])
    if (a === null || b === null) return null
    return { min: Math.min(a, b), max: Math.max(a, b) }
  }
  const one = /^(<=|>=|<|>|=)?(.+)$/.exec(s)!
  const n = bytes(one[2])
  if (n === null) return null
  switch (one[1]) {
    case '>': return { min: n + 1 }
    case '>=': return { min: n }
    case '<': return { max: n - 1 }
    case '<=': return { max: n }
    default: return { min: n, max: n }
  }
}

/** A type: value, or null when it is not understood. */
export function parseTypeFilter(v: string): { dirs?: boolean; exts?: string[] } | null {
  const parts = v.toLowerCase().split(/[,;]/).filter(Boolean)
  if (!parts.length) return null
  let folder = false
  let file = false
  const exts = new Set<string>()
  for (const p of parts) {
    const k = TYPE_ALIAS[p]
    if (!k) return null
    if (k === 'folder') folder = true
    else if (k === 'file') file = true
    else for (const e of TYPE_EXTS[k]) exts.add(e)
  }
  // a comma list means "any of"; folders or certain files cannot be told apart by one filter
  if (exts.size) return folder ? null : { dirs: false, exts: [...exts] }
  if (folder && file) return {}
  return { dirs: folder }
}

const intersect = (a: Range | undefined, b: Range): Range => {
  const min = a?.min === undefined ? b.min : b.min === undefined ? a.min : Math.max(a.min, b.min)
  const max = a?.max === undefined ? b.max : b.max === undefined ? a.max : Math.min(a.max, b.max)
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) }
}
const empty = (r?: Range) => !!r && r.min !== undefined && r.max !== undefined && r.min > r.max

export interface ParsedFilters {
  /** the query without its filter tokens */
  text: string
  filters: QueryFilters
  /** filters that were understood, as typed */
  used: string[]
  /** one line per value that was not understood (the token is ignored) */
  hints: string[]
}

const FILTER_KEY = /^(date|modified|size|type|kind):(.*)$/i

/** Take date:, size: and type: tokens out of a query. Anything not understood is ignored and named in `hints`. */
export function parseFilters(q: string, opts: { now?: number; weekStart?: number } = {}): ParsedFilters {
  const marks = dateMarks(opts.now ?? Date.now(), opts.weekStart ?? 1)
  const filters: QueryFilters = {}
  const used: string[] = []
  const hints: string[] = []
  const rest: string[] = []
  let exts: Set<string> | undefined
  for (const tok of q.trim().split(/\s+/).filter(Boolean)) {
    const m = FILTER_KEY.exec(tok)
    if (!m) {
      rest.push(tok)
      continue
    }
    const key = m[1].toLowerCase()
    const val = m[2]
    if (!val) {
      hints.push(`${tok} needs a value`)
      continue
    }
    if (key === 'date' || key === 'modified') {
      const r = parseDateFilter(val, marks)
      if (!r) hints.push(`${tok} not understood (try today, thisweek, <7d or 2026-11-01)`)
      else {
        filters.mtime = intersect(filters.mtime, r)
        used.push(tok)
      }
    } else if (key === 'size') {
      const r = parseSizeFilter(val)
      if (!r) hints.push(`${tok} not understood (try >10mb, <500kb, 1mb..5mb or empty)`)
      else {
        filters.size = intersect(filters.size, r)
        used.push(tok)
      }
    } else {
      const t = parseTypeFilter(val)
      if (!t) hints.push(`${tok} not understood (try folder, file, pdf, drawing, document, sheet, image or archive)`)
      else {
        used.push(tok)
        if (t.dirs !== undefined) {
          if (filters.dirs !== undefined && filters.dirs !== t.dirs) filters.never = true
          filters.dirs = t.dirs
        }
        if (t.exts) {
          exts = exts ? new Set([...exts].filter((e) => t.exts!.includes(e))) : new Set(t.exts)
          if (!exts.size) filters.never = true
        }
      }
    }
  }
  if (exts) filters.exts = [...exts]
  if (empty(filters.mtime) || empty(filters.size)) filters.never = true
  return { text: rest.join(' '), filters, used, hints }
}

export const hasFilters = (f: QueryFilters) => !!(f.mtime || f.size || f.dirs !== undefined || f.exts || f.never)

/**
 * Whether an entry passes the folder/size/date filters (not the extension: that is a name check).
 * Folders have no size of their own, so a size filter shows files only.
 */
export function passesFilters(e: { dir: boolean; size: number; mtime: number }, f: QueryFilters): boolean {
  if (f.never) return false
  if (f.dirs !== undefined && e.dir !== f.dirs) return false
  if (f.size) {
    if (e.dir) return false
    if (f.size.min !== undefined && e.size < f.size.min) return false
    if (f.size.max !== undefined && e.size > f.size.max) return false
  }
  if (f.mtime) {
    if (f.mtime.min !== undefined && e.mtime < f.mtime.min) return false
    if (f.mtime.max !== undefined && e.mtime > f.mtime.max) return false
  }
  return true
}

/** extname() semantics, lower case, no dot: 'a.PDF' -> 'pdf', '.bashrc' -> '', 'a.' -> ''. */
export function extOfName(name: string) {
  const i = name.lastIndexOf('.')
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : ''
}

export interface CompiledQuery {
  /** name test on the lower-case name (words, wildcards, ext:, type: extensions, regex) */
  test(nameLower: string): boolean
  /** a lower-case literal every matching name contains (lets the name index jump to hits) */
  anchor?: string
  /** "every word is in the name and the extension is one of exts": the index matches raw bytes */
  plain?: { words: string[]; exts: string[] }
  ext?: Set<string>
  filters: QueryFilters
  /** folder / size / date filters present: call passesFilters as well */
  filtered: boolean
  used: string[]
  hints: string[]
}

/** The whole query language compiled once: the name part for the index, the rest as filters. */
export function compileQuery(q: string, opts: { caseSensitive?: boolean; now?: number; weekStart?: number } = {}): CompiledQuery {
  const whole = /^\/(.+)\/([a-z]*)$/.exec(q.trim())
  const p: ParsedFilters = whole ? { text: q.trim(), filters: {}, used: [], hints: [] } : parseFilters(q, opts)
  const { filters, used, hints } = p
  const filtered = !!(filters.mtime || filters.size || filters.dirs !== undefined || filters.never)
  const re = /^\/(.+)\/([a-z]*)$/.exec(p.text.trim())
  if (re) {
    try {
      const r = new RegExp(re[1], re[2].includes('i') || !opts.caseSensitive ? 'i' : '')
      const typeExts = filters.exts ? new Set(filters.exts) : undefined
      return { test: (n) => (!typeExts || typeExts.has(extOfName(n))) && r.test(n), ext: typeExts, filters, filtered: filtered || !!typeExts, used, hints }
    } catch {
      hints.push('Not a valid regular expression: searching for the text instead')
      p.text = re[1]
    }
  }
  let exts: Set<string> | undefined
  const tests: ((n: string) => boolean)[] = []
  // The longest literal that every match must contain lets the index jump straight to hits.
  let anchor = ''
  const words: string[] = []
  let wild = false
  const literal = (t: string) => {
    if (t.length > anchor.length) anchor = t
  }
  for (const raw of p.text.trim().split(/\s+/).filter(Boolean)) {
    const m = /^ext:(.*)$/i.exec(raw)
    if (m) {
      const list = m[1].split(/[,;]/).map((e) => e.replace(/^\./, '').toLowerCase())
      if (!m[1]) {
        hints.push(`${raw} needs a value`)
        continue
      }
      exts = exts ? new Set(list.filter((e) => exts!.has(e))) : new Set(list)
      continue
    }
    const w = raw.toLowerCase()
    if (/[*?]/.test(w)) {
      wild = true
      for (const part of w.split(/[*?]/)) literal(part)
      const r = new RegExp('^' + w.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
      tests.push((n) => r.test(n))
    } else {
      literal(w)
      words.push(w)
      tests.push((n) => n.includes(w))
    }
  }
  if (filters.exts) exts = exts ? new Set([...exts].filter((e) => filters.exts!.includes(e))) : new Set(filters.exts)
  if (exts && !exts.size) filters.never = true
  if (!anchor && exts?.size === 1) anchor = '.' + [...exts][0]
  return {
    anchor: anchor || undefined,
    // extOfName() never returns '' for a name with an extension or anything containing a dot
    plain: wild || filters.never || (exts && [...exts].some((e) => !e || e.includes('.'))) ? undefined : { words, exts: exts ? [...exts] : [] },
    ext: exts,
    filters,
    // type: with extensions means files: a folder called "x.pdf" is not a PDF
    filtered: filtered || !!filters.exts,
    used,
    hints,
    test: (n) => {
      if (filters.never) return false
      if (exts && !exts.has(extOfName(n))) return false
      for (const t of tests) if (!t(n)) return false
      return true
    }
  }
}

// ---------------------------------------------------------------------------
// Per-folder view memory

export interface FolderView {
  view: ViewMode
  sort: { key: ColumnSpec['id']; dir: 1 | -1 }
  groupBy: GroupBy
  /** group drawing revisions; absent = follow the global setting */
  revisions?: boolean
}

export interface RememberedView extends FolderView {
  /** last used (ms), for least-recently-used eviction */
  at: number
}

export const VIEW_MEMORY_MAX = 2000

/**
 * The key a folder's view is remembered under: case-insensitive, no trailing backslash, and a
 * mapped drive spelled as its UNC path so U:\x and \\server\share\x are the same folder.
 * Null for places that are not folders (Home, search results, inside archives).
 */
export function folderKey(path: string, drives: readonly { root: string; remote?: string }[] = []): string | null {
  if (!path || path.startsWith('hopper:') || path.includes('::')) return null
  let p = path.trim().replace(/\//g, '\\').replace(/\\+$/, '')
  const m = /^([a-zA-Z]):(.*)$/.exec(p)
  if (m) {
    const d = drives.find((x) => x.remote && x.root.charAt(0).toLowerCase() === m[1].toLowerCase())
    if (d) p = d.remote!.replace(/[\\/]+$/, '') + m[2]
  }
  return p ? p.toLowerCase() : null
}

/** Remember a folder's view, evicting the least recently used folders beyond `max`. Returns a new object. */
export function rememberView(mem: Readonly<Record<string, RememberedView>>, key: string, v: FolderView, at: number, max = VIEW_MEMORY_MAX): Record<string, RememberedView> {
  const next: Record<string, RememberedView> = { ...mem, [key]: { view: v.view, sort: { key: v.sort.key, dir: v.sort.dir }, groupBy: v.groupBy, ...(v.revisions !== undefined ? { revisions: v.revisions } : {}), at } }
  const keys = Object.keys(next)
  if (keys.length > max) {
    keys.sort((a, b) => next[a].at - next[b].at)
    for (const k of keys.slice(0, keys.length - max)) delete next[k]
  }
  return next
}

// ---------------------------------------------------------------------------
// Smart folders (saved searches)

export interface SmartFolder {
  id: string
  name: string
  /** the query, filters included */
  q: string
  /** folder searched; '' = everywhere */
  root: string
  /** text inside files, when the search had one */
  content?: string
}

export const SMART_SUGGESTIONS: { name: string; q: string }[] = [
  { name: 'PDFs changed this week', q: 'ext:pdf date:thisweek' },
  { name: 'Large files', q: 'size:>100mb' }
]
