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
  /** coveredBy: the root is inside another indexed root and is searched through that one */
  roots: { path: string; files: number; ready: boolean; scannedAt?: number; coveredBy?: string }[]
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

/** What a share carries: files, a text note, a pointer to a folder on a shared drive, or a request for files. */
export type ShareKind = 'files' | 'message' | 'link' | 'request'

export interface ShareLink {
  /** UNC or drive path as the receiver should open it */
  path: string
  /** false when the link points at a file (the receiver's Hopper reveals it in its folder) */
  dir: boolean
}

export interface ShareSpec {
  /** user names (stable across PCs) */
  to: string[]
  paths: string[]
  message?: string
  zipFirst?: boolean
  notifyCliq?: boolean
  /** default 'files'; the other kinds carry no bytes (paths is empty) */
  kind?: ShareKind
  link?: ShareLink
  /** id of the request this share answers */
  replyTo?: string
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
  /** absent on items from before 2.1: files */
  kind?: ShareKind
  link?: ShareLink
  replyTo?: string
}

/** One line of the conversation with a person: something received from or sent to them. */
export interface HistoryItem {
  id: string
  dir: 'in' | 'out'
  user: string
  at: number
  kind: ShareKind
  message?: string
  link?: ShareLink
  folder?: string
  /** top-level names that were sent (outgoing only) */
  names?: string[]
  files: number
  bytes: number
  via: 'direct' | 'server'
  replyTo?: string
}

export type AnnouncementLevel = 'info' | 'important' | 'urgent'

export interface Announcement {
  id: string
  title: string
  body: string
  level: AnnouncementLevel
  /** optional folder the announcement is about (UNC where possible) */
  path?: string
  /** ms; absent = never expires */
  expires?: number
  at: number
  /** Windows account name of the author, lower-case */
  by: string
  byName: string
  host?: string
  withdrawn?: boolean
}

export interface AnnouncementAck {
  user: string
  name: string
  at: number
}

/** An announcement plus this PC's read/acknowledged state (and, for announcers, who acknowledged). */
export interface AnnouncementView extends Announcement {
  read: boolean
  acked: boolean
  ackedAt?: number
  acks?: AnnouncementAck[]
  /** set on the reply to a post when the office folder could not be written */
  notStored?: boolean
}

/** A join invite heard on the LAN. The key itself stays in the LAN process until Join is clicked. */
export interface OfficeInvite {
  id: string
  officeName: string
  adminUser: string
  adminName: string
  host: string
  address: string
  configPath: string
  /** first 8 hex of SHA-256 of the key */
  fingerprint: string
  at: number
  /** this PC already has a (different) office key: show as a notice only */
  haveKey: boolean
}

/** How this PC got its office key, when it was not read from the shared config. */
export interface OfficeJoined {
  officeName: string
  by: string
  at: number
  fingerprint: string
  via: 'paste' | 'invite'
}

/** What office:get adds for the Office page. */
export interface OfficeSetup {
  /** Windows account that set the office up, lower-case */
  user: string
  /** computer name of the PC that set it up */
  pc: string
  /** epoch ms */
  at: number
}

export interface OfficeMeta {
  /** Windows account of this user, lower-case */
  user: string
  /** this PC's computer name */
  pc: string
  /** may configure the office (see shared/office-access.ts) */
  admin: boolean
  /** the office has been set up by some PC (null: open to everyone) */
  setup: OfficeSetup | null
  /** this is the PC that set the office up */
  setupPc: boolean
  /** this user is a standing admin (configures whether set up or not) */
  standing: boolean
  keySource: 'config' | 'override' | 'none'
  fingerprint: string
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
  // Structured templates (see template-model.ts) set `tree`; simple ones leave all of these out.
  description?: string
  inputs?: import('./template-model').TemplateInput[]
  /** name pattern of the folder the template creates, e.g. '{job}-{name}' */
  root?: string
  tree?: import('./template-model').TemplateNode[]
  blocks?: Record<string, import('./template-model').TemplateNode[]>
  numbering?: import('./template-model').NumberingOptions
  /** folder name of a sub-project, default '{label}< ({unit})>' */
  subLabel?: string
  /** shipped with Hopper (not stored in the office config) */
  builtin?: boolean
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
  /** Dexterity Share: client download links served from the office server */
  publicShare?: import('./pubshare').PublicShareConfig
  cliq: {
    enabled: boolean
    /** e.g. https://cliq.zoho.in/api/v2/bots/hopper/message */
    endpoint: string
    zapikey: string
    /** tell senders when a client first downloads a link and before it closes (sent by the share PC); default on */
    linkNotices?: boolean
  }
  groups: PeerGroup[]
  templates: FolderTemplate[]
  revisions: RevisionRules
  conventions: NamingConvention[]
  /** Legacy (before 2.5): who could edit this config. Access now follows office-access.ts. */
  admins: string[]
  /** Legacy (before 2.5): who could post announcements. Everyone can post now. */
  announcers: string[]
  /** Which PC set the office up. While it is missing, everyone may configure the office. */
  setup?: OfficeSetup
  /** Runtime only, never saved: this PC could not read office.json (see office-access.ts). */
  unreadable?: boolean
  /** set in the old file when an admin moved the config: other PCs follow it */
  movedTo?: string
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
  sidebarCollapsed: boolean
  /** show Hopper's progress window for copy, move, delete, zip and extract (the Transfers panel stays closed) */
  progressPopup: boolean
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
  /** most recently visited folders, newest first */
  recentFolders: string[]
  pathCopy: { quote: 'never' | 'spaces' | 'always'; defaultMode: string }
  tagColors: Record<string, string>
  /** this PC hosts the Dexterity Share server (set by the setup wizard; secrets are stored elsewhere) */
  shareServer?: import('./pubshare').ShareServerSettings
  /** office key pasted or accepted from an invite; used when the shared config has none or is unreachable */
  officeKeyOverride?: string
  officeJoined?: OfficeJoined
  /** Network node: saved network places (this PC only) and view options */
  network?: import('./network').NetworkSettings
}

