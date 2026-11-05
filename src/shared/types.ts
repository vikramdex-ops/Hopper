// Types shared by main, preload, engine, lan and renderer.

/** Windows attribute bits as reported by FindFirstFileEx (subset we use). */
export const ATTR = {
  readonly: 0x1,
  hidden: 0x2,
  system: 0x4,
  directory: 0x10,
  archive: 0x20,
  reparse: 0x400,
  compressed: 0x800,
  offline: 0x1000,
  encrypted: 0x4000,
  recallOnOpen: 0x40000,
  recallOnAccess: 0x400000,
  pinned: 0x80000,
  unpinned: 0x100000
} as const

export interface Entry {
  name: string
  path: string
  dir: boolean
  size: number
  /** ms since epoch */
  mtime: number
  ctime: number
  atime: number
  /** Windows FILE_ATTRIBUTE_* bits (0 where unknown) */
  attrs: number
  /** lower-case extension without the dot, '' for folders */
  ext: string
  /** set for junctions/symlinks when the target is known */
  link?: string
}

export interface ListResult {
  path: string
  entries: Entry[]
  /** entries we could not read (permission etc.) */
  errors: number
  ms: number
}

export interface DriveInfo {
  root: string // 'C:\\'
  label: string
  kind: 'fixed' | 'removable' | 'network' | 'cdrom' | 'ram' | 'unknown'
  total: number
  free: number
  ready: boolean
  /** UNC for mapped network drives */
  remote?: string
}

// ---------------------------------------------------------------------------
// Jobs (transfer queue)

export type JobKind =
  | 'copy'
  | 'move'
  | 'delete'
  | 'zip'
  | 'extract'
  | 'share'
  | 'receive'
  | 'pdf'
  | 'package'
  | 'hash'
  | 'size'

export type JobState = 'queued' | 'running' | 'paused' | 'waiting' | 'done' | 'failed' | 'cancelled'

export type ConflictPolicy = 'ask' | 'overwrite' | 'newer' | 'skip' | 'rename'

export interface TransferSpec {
  op: 'copy' | 'move'
  sources: string[]
  dest: string
  policy: ConflictPolicy
  verify?: boolean
  /** wildcard include filter like "*.pdf;*.dwg" */
  filter?: string
}

export interface JobInfo {
  id: string
  kind: JobKind
  title: string
  state: JobState
  /** bytes */
  done: number
  total: number
  files: number
  filesTotal: number
  current?: string
  /** bytes per second, smoothed */
  rate: number
  startedAt: number
  endedAt?: number
  error?: string
  errors: { path: string; message: string }[]
  /** where the result landed (archive path, destination folder) */
  output?: string
  dest?: string
}

export interface Conflict {
  jobId: string
  conflictId: string
  src: { path: string; size: number; mtime: number }
  dst: { path: string; size: number; mtime: number }
}

export type ConflictAnswer = 'overwrite' | 'skip' | 'rename' | 'newer' | 'cancel'

// ---------------------------------------------------------------------------
// Undo journal

export interface UndoRecord {
  id: string
  at: number
  label: string
  kind: 'copy' | 'move' | 'rename' | 'new' | 'recycle'
  /** pairs of [from, to] (copy: [src, created]) */
  pairs: [string, string][]
  undone?: boolean
}

// ---------------------------------------------------------------------------
// Archives

export interface ArchivePreset {
  id: string
  name: string
  format: 'zip' | '7z' | 'rar'
  /** 0 = store … 9 = ultra */
  level: number
  /** split volume size in MB, 0 = no split */
  volumeMB: number
  password?: boolean
  /** keyboard shortcut label, informative */
  key?: string
}

export interface ArchiveEntry {
  path: string // inside archive, '/' separated
  dir: boolean
  size: number
  packed: number
  mtime: number
  encrypted: boolean
}

export type ExtractMode = 'smart' | 'here' | 'each' | 'to'

// ---------------------------------------------------------------------------
// Search

export interface SearchQuery {
  roots: string[]
  /** name pattern: words (AND), wildcards, or /regex/ */
  name: string
  content?: string
  contentRegex?: boolean
  caseSensitive?: boolean
  minSize?: number
  maxSize?: number
  after?: number
  before?: number
  kinds?: ('file' | 'dir')[]
  limit?: number
}

export interface IndexStatus {
  roots: { path: string; files: number; ready: boolean; scannedAt?: number }[]
  total: number
  building: boolean
}

// ---------------------------------------------------------------------------
// LAN

export interface Peer {
  id: string
  user: string // Windows account name
  displayName: string
  host: string
  email?: string
  address: string
  port: number
  version: string
  status: 'online' | 'busy' | 'away' | 'offline'
  lastSeen: number
  /** this machine */
  self?: boolean
}

export interface PeerGroup {
  id: string
  name: string
  members: string[] // user names
}

export interface ShareSpec {
  /** user names (stable across PCs) */
  to: string[]
  paths: string[]
  message?: string
  zipFirst?: boolean
  notifyCliq?: boolean
}

export interface InboxItem {
  id: string
  from: string
  fromName: string
  at: number
  message?: string
  folder: string
  files: number
  bytes: number
  via: 'direct' | 'server'
  seen?: boolean
}

export interface Profile {
  user: string
  displayName: string
  email: string
  host: string
  status: Peer['status']
}

// ---------------------------------------------------------------------------
// Office config (shared JSON on the server; never committed)

export interface RevisionRules {
  /** regexes with a named group "rev" and optional "base"; tried in order */
  patterns: string[]
  /** ordered revision tokens, earliest first. Tokens not in the list are "order unknown". */
  order: string[]
}

export interface FolderTemplate {
  id: string
  name: string
  /** relative folder paths, '/' separated; {name} {date} {project} tokens allowed */
  folders: string[]
}

export interface NamingConvention {
  id: string
  name: string
  /** regex the file name (without extension) must match */
  pattern: string
  example?: string
}

export interface OfficeConfig {
  officeName: string
  /** hex PSK shared by every Hopper in the office */
  officeKey: string
  serverInbox: string
  cliq: {
    enabled: boolean
    /** e.g. https://cliq.zoho.in/api/v2/bots/hopper/message */
    endpoint: string
    zapikey: string
  }
  groups: PeerGroup[]
  templates: FolderTemplate[]
  revisions: RevisionRules
  conventions: NamingConvention[]
}

// ---------------------------------------------------------------------------
// Settings (per user, local)

export type ViewMode = 'details' | 'list' | 'grid'

export interface ColumnSpec {
  id: 'name' | 'size' | 'type' | 'mtime' | 'ctime' | 'attrs' | 'rev'
  width: number
  visible: boolean
}

export interface TabState {
  id: string
  path: string
  history: string[]
  index: number
  locked?: boolean
  title?: string
}

export interface PaneState {
  tabs: TabState[]
  active: number
  view: ViewMode
  sort: { key: ColumnSpec['id']; dir: 1 | -1 }
}

export interface Workspace {
  id: string
  name: string
  panes: [PaneState, PaneState]
  dual: boolean
}

export interface QuickDest {
  path: string
  label?: string
  pinned: boolean
  usedAt: number
}

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  accent: 'system' | string
  dual: boolean
  showHidden: boolean
  showSystem: boolean
  showExtensions: boolean
  confirmDelete: boolean
  keepInTray: boolean
  confirmPermanentDelete: boolean
  inspector: boolean
  sidebarWidth: number
  inspectorWidth: number
  groupRevisions: boolean
  thumbSize: number
  columns: ColumnSpec[]
  panes: [PaneState, PaneState]
  activePane: 0 | 1
  workspaces: Workspace[]
  pinned: string[]
  quickDests: QuickDest[]
  archivePresets: ArchivePreset[]
  defaultPreset: string
  verifyCopies: boolean
  parallelSmallFiles: number
  inboxDir: string
  officeConfigPath: string
  indexRoots: string[]
  indexEnabled: boolean
  autoUpdate: boolean
  profile: { displayName: string; email: string; status: Peer['status'] }
  lan: { enabled: boolean; acceptFrom: 'all' | 'ask'; blocked: string[]; askFor: string[] }
  windowBounds?: { x: number; y: number; width: number; height: number; maximized: boolean }
  recentShares: string[]
  tagColors: Record<string, string>
}
