// Smart File Notifications: the rules. Instead of "a file changed", Hopper says what it means -
// "the file you just downloaded is identical to one already here", "a 3 GB temporary file has been
// sitting in Temp for a week". Each rule is plain logic over names, sizes, dates and content hashes
// (engine/smartnotify.ts gathers those); nothing is inferred beyond what the file system shows.

export type SmartKind = 'duplicate' | 'large-temp' | 'temp-total' | 'stalled-download' | 'extracted-archive' | 'old-installers' | 'low-space'

export const SMART_KINDS: { id: SmartKind; label: string; help: string }[] = [
  { id: 'duplicate', label: 'Duplicate downloads', help: 'A new file is byte-for-byte identical to one already in the same folder' },
  { id: 'large-temp', label: 'Large temporary files', help: 'A big temporary file (in Temp, or a .tmp/.bak/.dmp) has been left behind' },
  { id: 'temp-total', label: 'Temp folder size', help: 'Your Temp folder as a whole has grown large' },
  { id: 'stalled-download', label: 'Unfinished downloads', help: 'A .crdownload / .part file has not changed for a day' },
  { id: 'extracted-archive', label: 'Already extracted archives', help: 'A zip sits next to the folder it was extracted into' },
  { id: 'old-installers', label: 'Old installers', help: 'Installers in Downloads not touched for 30 days' },
  { id: 'low-space', label: 'Low disk space after a download', help: 'A new file left its drive almost full' }
]

export type SmartActionId = 'recycle' | 'show' | 'open' | 'review' | 'compare'

export interface SmartAction {
  id: SmartActionId
  label: string
  /** paths the action works on (recycle/show/open/review) */
  paths: string[]
}

export interface SmartNotice {
  id: string
  kind: SmartKind
  /** same key = same situation: not repeated within REPEAT_MS */
  key: string
  title: string
  body: string
  /** the folder the notice is about (Windows notification click opens it) */
  folder: string
  /** the file to select there */
  select?: string
  bytes: number
  at: number
  actions: SmartAction[]
}

export interface SmartSettings {
  enabled: boolean
  /** folders checked as files arrive (Downloads is always included unless removed here) */
  folders: string[]
  /** a temporary file at least this big is reported (MB) */
  largeTempMB: number
  /** the Temp folder as a whole at least this big is reported (GB) */
  tempTotalGB: number
  muted: SmartKind[]
}

export const REPEAT_MS = 7 * 86_400_000
export const STALLED_MS = 86_400_000
export const OLD_INSTALLER_MS = 30 * 86_400_000
export const OLD_INSTALLERS_MIN_BYTES = 500 * 1024 ** 2
/** a temp file younger than this may be in use: never reported */
export const TEMP_MIN_AGE_MS = 6 * 3600_000
export const LOW_SPACE_FRACTION = 0.05
export const LOW_SPACE_BYTES = 2 * 1024 ** 3
/** only files at least this big can push a drive into "low space" */
export const LOW_SPACE_TRIGGER_BYTES = 100 * 1024 ** 2

const TEMP_EXT = new Set(['tmp', 'temp', 'bak', 'old', 'dmp', 'mdmp', 'hdmp', 'chk', 'gid', 'etl', 'swp', 'sav', 'bk', 'dwl', 'dwl2', 'sv$', 'ac$'])
const PARTIAL_EXT = new Set(['crdownload', 'part', 'partial', 'download', 'opdownload', '!ut', 'filepart'])
const INSTALLER_EXT = new Set(['exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle'])
const ARCHIVE_EXT = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'tgz'])

export function extOf(name: string) {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

export function stemOf(name: string) {
  const lower = name.toLowerCase()
  for (const two of ['.tar.gz', '.tar.bz2', '.tar.xz']) if (lower.endsWith(two)) return name.slice(0, -two.length)
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

/** A temporary or leftover file by its name alone (~$ owner files are tiny and excluded by size). */
export function isTempName(name: string) {
  const e = extOf(name)
  return TEMP_EXT.has(e) || name.startsWith('~') || /^\.~lock\./i.test(name) || /\.tmp\d*$/i.test(name)
}

export function isPartialDownload(name: string) {
  return PARTIAL_EXT.has(extOf(name))
}

export function isInstaller(name: string) {
  return INSTALLER_EXT.has(extOf(name))
}

export function isArchive(name: string) {
  return ARCHIVE_EXT.has(extOf(name)) || /\.tar\.(gz|bz2|xz)$/i.test(name)
}

/**
 * The name a re-download or copy was derived from: "Report (1).pdf", "Report - Copy.pdf",
 * "Report - Copy (2).pdf", "Copy of Report.pdf" -> "Report.pdf". Null when the name is not a copy.
 */
export function copyOrigin(name: string): string | null {
  const ext = extOf(name)
  const dot = ext ? '.' + name.slice(name.length - ext.length) : ''
  const stem = ext ? name.slice(0, -(ext.length + 1)) : name
  let m = /^(.*?)\s*\(\d{1,3}\)$/.exec(stem)
  if (m && m[1]) return m[1].replace(/\s*-\s*Copy$/i, '') + dot
  m = /^(.*?)\s*-\s*Copy$/i.exec(stem)
  if (m && m[1]) return m[1] + dot
  m = /^Copy of (.+)$/i.exec(stem)
  if (m) return m[1] + dot
  return null
}

export function fmtSize(n: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = Math.max(0, n)
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 ? v : v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

export function fmtAge(ms: number) {
  const h = ms / 3600_000
  if (h < 1) return 'less than an hour'
  if (h < 48) return `${Math.round(h)} hours`
  return `${Math.round(h / 24)} days`
}

const base = (p: string) => p.replace(/\\+$/, '').split('\\').pop() || p
const dir = (p: string) => {
  const t = p.replace(/\\+$/, '')
  const i = t.lastIndexOf('\\')
  return i <= 2 ? t.slice(0, i + 1) : t.slice(0, i)
}

let seq = 0
const nid = (at: number) => `sn${at.toString(36)}${(seq++).toString(36)}`

export function duplicateNotice(file: string, twin: string, bytes: number, at = Date.now()): SmartNotice {
  const reDownload = copyOrigin(base(file))?.toLowerCase() === base(twin).toLowerCase()
  return {
    id: nid(at), kind: 'duplicate', key: `duplicate:${file.toLowerCase()}`, at, bytes, folder: dir(file), select: file,
    title: reDownload ? `You already have ${base(twin)}` : `${base(file)} is a duplicate`,
    body: `${base(file)} is identical to ${base(twin)} in ${base(dir(file)) || dir(file)} (same ${fmtSize(bytes)}, same content). Removing the new copy frees ${fmtSize(bytes)}.`,
    actions: [
      { id: 'recycle', label: 'Recycle new copy', paths: [file] },
      { id: 'show', label: 'Show both', paths: [file, twin] }
    ]
  }
}

export function largeTempNotice(file: string, bytes: number, ageMs: number, at = Date.now()): SmartNotice {
  return {
    id: nid(at), kind: 'large-temp', key: `large-temp:${file.toLowerCase()}`, at, bytes, folder: dir(file), select: file,
    title: `A ${fmtSize(bytes)} temporary file is taking up space`,
    body: `${base(file)} in ${dir(file)} has not changed for ${fmtAge(ageMs)}. Temporary files like this are usually safe to recycle once the program that made it is closed.`,
    actions: [
      { id: 'recycle', label: 'Recycle it', paths: [file] },
      { id: 'show', label: 'Show', paths: [file] }
    ]
  }
}

export function tempTotalNotice(tempDir: string, bytes: number, count: number, oldBytes: number, at = Date.now()): SmartNotice {
  return {
    id: nid(at), kind: 'temp-total', key: `temp-total:${tempDir.toLowerCase()}:${Math.floor(bytes / 1024 ** 3)}`, at, bytes, folder: tempDir,
    title: `Your Temp folder holds ${fmtSize(bytes)}`,
    body: `${count.toLocaleString('en-GB')} files in ${tempDir}; ${fmtSize(oldBytes)} of it untouched for over a week. Review lists the old files biggest first.`,
    actions: [
      { id: 'review', label: 'Review', paths: [tempDir] },
      { id: 'open', label: 'Open Temp', paths: [tempDir] }
    ]
  }
}

export function stalledNotice(file: string, bytes: number, ageMs: number, at = Date.now()): SmartNotice {
  return {
    id: nid(at), kind: 'stalled-download', key: `stalled:${file.toLowerCase()}`, at, bytes, folder: dir(file), select: file,
    title: `An unfinished download has stopped`,
    body: `${base(file)} (${fmtSize(bytes)}) has not grown for ${fmtAge(ageMs)}. If the download failed, the partial file can go.`,
    actions: [
      { id: 'recycle', label: 'Recycle partial file', paths: [file] },
      { id: 'show', label: 'Show', paths: [file] }
    ]
  }
}

export function extractedNotice(archive: string, folder: string, bytes: number, at = Date.now()): SmartNotice {
  return {
    id: nid(at), kind: 'extracted-archive', key: `extracted:${archive.toLowerCase()}`, at, bytes, folder: dir(archive), select: archive,
    title: `${base(archive)} is already extracted`,
    body: `Its contents are in the folder ${base(folder)} next to it. Recycling the archive frees ${fmtSize(bytes)}.`,
    actions: [
      { id: 'recycle', label: 'Recycle archive', paths: [archive] },
      { id: 'show', label: 'Show both', paths: [archive, folder] }
    ]
  }
}

export function oldInstallersNotice(folder: string, files: { path: string; bytes: number }[], at = Date.now()): SmartNotice {
  const bytes = files.reduce((s, f) => s + f.bytes, 0)
  return {
    id: nid(at), kind: 'old-installers', key: `old-installers:${folder.toLowerCase()}:${Math.floor(bytes / 1024 ** 3)}`, at, bytes, folder,
    title: `${files.length} old installer${files.length === 1 ? '' : 's'} in ${base(folder)}: ${fmtSize(bytes)}`,
    body: `Setup files not touched for 30 days or more. Once a program is installed its setup file is rarely needed again.`,
    actions: [
      { id: 'review', label: 'Review', paths: files.map((f) => f.path) },
      { id: 'open', label: 'Open folder', paths: [folder] }
    ]
  }
}

export function lowSpaceNotice(file: string, root: string, free: number, total: number, at = Date.now()): SmartNotice {
  return {
    id: nid(at), kind: 'low-space', key: `low-space:${root.toLowerCase()}`, at, bytes: free, folder: dir(file), select: file,
    title: `${root.slice(0, 2)} is almost full after this download`,
    body: `${fmtSize(free)} left of ${fmtSize(total)} (${Math.round((free / total) * 100)}% free) once ${base(file)} arrived.`,
    actions: [{ id: 'show', label: 'Show file', paths: [file] }]
  }
}

export function isLowSpace(free: number, total: number) {
  return total > 0 && (free / total < LOW_SPACE_FRACTION || free < LOW_SPACE_BYTES)
}

/** Not muted and not already said about this situation within REPEAT_MS. */
export function shouldNotify(n: Pick<SmartNotice, 'key' | 'kind'>, sent: Record<string, number>, muted: SmartKind[], now = Date.now()) {
  if (muted.includes(n.kind)) return false
  const prev = sent[n.key]
  return typeof prev !== 'number' || now - prev >= REPEAT_MS
}

export function cleanSmartSettings(raw: unknown): SmartSettings {
  const r = (raw ?? {}) as Partial<SmartSettings>
  const num = (v: unknown, d: number, lo: number, hi: number) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d)
  const kinds = new Set(SMART_KINDS.map((k) => k.id))
  return {
    enabled: r.enabled !== false,
    folders: (Array.isArray(r.folders) ? r.folders : []).filter((p): p is string => typeof p === 'string' && /^([a-zA-Z]:\\|\\\\)/.test(p)).slice(0, 20),
    largeTempMB: num(r.largeTempMB, 500, 10, 100_000),
    tempTotalGB: num(r.tempTotalGB, 5, 1, 1000),
    muted: (Array.isArray(r.muted) ? r.muted : []).filter((k): k is SmartKind => kinds.has(k as SmartKind))
  }
}
