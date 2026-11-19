// "Who has it open" and "Unlock": the LAN messages, their validation, and how the answers from
// every Hopper are put together. See docs/UNLOCK.md.
//   ask  {t:'holders', id, paths}            -> {t:'holders', holders, recent, server}
//   ask  {t:'close', id, holder, file, by}   -> {t:'ok'}  (the holder's PC shows a prompt; its user decides)
//   ask  {t:'notify', id, file, by, reason}  -> {t:'ok'}  (a message only, nothing is closed)
//   ask  {t:'force', id, fileId, path}       -> {t:'forced'} | {t:'err', code}  (server agent, office admins only)
//   small {t:'unlock-status', id, holder, status, message}  (holder's PC -> requester, after the prompt)
// Only paths are sent, never file contents. Pure (no Node, no DOM) so node:test can load it.

export type HolderKind = 'app' | 'explorer' | 'hopper' | 'smb'
export type HolderStatus = 'open' | 'asking' | 'asked' | 'closed' | 'declined' | 'no-answer' | 'released' | 'failed'

export interface Holder {
  /** unique within one lookup */
  id: string
  kind: HolderKind
  /** the file (or folder) that is held, as the reporter sees it */
  path: string
  /** Windows account (the peer's user, or the account the server names) */
  user?: string
  /** display name of the person, when known */
  person?: string
  /** computer, when known */
  pc?: string
  /** id of the Hopper that reported it (asked to close) */
  peer?: string
  app?: string
  pid?: number
  /** process start time (FILETIME ticks, decimal) so a reused process id is never mistaken */
  start?: string
  /** server agent: the SMB open-file id and lock count */
  fileId?: number
  locks?: number
  /** server agent rows the person's own Hopper also reported (force close works on these) */
  fileIds?: number[]
  status: HolderStatus
  message?: string
}

/** One peer's answer to a 'holders' query. */
export interface HoldersReply {
  holders: Holder[]
  /** request paths this person opened through Hopper recently */
  recent: string[]
  /** set by the Hopper running on the file server */
  server?: { agent: true; ok: boolean; error?: string }
}

/** An operation that failed because a file was open, kept so "Wait and retry" can finish it. */
export type UnlockOp =
  | { kind: 'rename'; from: string; to: string }
  /** permanent delete (network places have no Recycle Bin) */
  | { kind: 'delete'; paths: string[] }
  /** to the Recycle Bin: the wait job only waits; Hopper's window recycles when it reports ready */
  | { kind: 'recycle'; paths: string[] }
  /** copy or move of single files that failed, each into its destination folder (overwriting) */
  | { kind: 'transfer'; op: 'copy' | 'move'; items: { src: string; destDir: string }[] }

/** The paths an operation needs free (what "Who has it open" looks at). */
export function opPaths(op: UnlockOp): string[] {
  switch (op.kind) {
    case 'rename': return [op.from]
    case 'delete':
    case 'recycle': return op.paths
    // the source may be held, or the file it would replace
    case 'transfer': return [...new Set(op.items.flatMap((i) => [i.src, `${i.destDir.replace(/\\+$/, '')}\\${i.src.slice(i.src.lastIndexOf('\\') + 1)}`]))].slice(0, MAX_PATHS)
  }
}

export const MAX_PATHS = 50
export const MAX_HOLDERS = 500
export const ID_RE = /^[\w-]{6,64}$/

const ABSOLUTE = /^(\\\\[^\\/:*?"<>|]+\\[^\\/:*?"<>|]+|[a-zA-Z]:\\)/
const KINDS: HolderKind[] = ['app', 'explorer', 'hopper', 'smb']
const STATUSES: HolderStatus[] = ['open', 'asking', 'asked', 'closed', 'declined', 'no-answer', 'released', 'failed']

const plain = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max)

/** An absolute drive or UNC path with no control characters, wildcards or '..' part; else null. */
export function cleanPath(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const p = v.trim()
  if (!p || p.length > 1024 || /[\u0000-\u001f<>"|?*]/.test(p) || !ABSOLUTE.test(p)) return null
  if (p.split('\\').some((s) => s === '..' || s === '.')) return null
  return p
}

/** A list of 1..MAX_PATHS valid paths, or null when any one is not valid. */
export function cleanPaths(v: unknown, max = MAX_PATHS): string[] | null {
  if (!Array.isArray(v) || !v.length || v.length > max) return null
  const out: string[] = []
  for (const x of v) {
    const p = cleanPath(x)
    if (!p) return null
    out.push(p)
  }
  return out
}

export function cleanHolder(h: any): Holder | null {
  if (!h || typeof h !== 'object' || !KINDS.includes(h.kind)) return null
  const path = cleanPath(h.path)
  if (!path) return null
  const out: Holder = { id: plain(h.id, 80) || 'h', kind: h.kind, path, status: STATUSES.includes(h.status) ? h.status : 'open' }
  for (const k of ['user', 'person', 'pc', 'peer', 'app', 'message'] as const) {
    const s = plain(h[k], k === 'message' ? 300 : 120)
    if (s) out[k] = s
  }
  if (Number.isInteger(h.pid) && h.pid > 0 && h.pid < 2 ** 32) out.pid = h.pid
  if (typeof h.start === 'string' && /^\d{1,20}$/.test(h.start)) out.start = h.start
  if (Number.isInteger(h.fileId) && h.fileId >= 0 && h.fileId < 2 ** 32) out.fileId = h.fileId
  if (Number.isInteger(h.locks) && h.locks >= 0) out.locks = h.locks
  return out
}

export function cleanQuery(f: any): { id: string; paths: string[] } | null {
  if (f?.t !== 'holders' || typeof f.id !== 'string' || !ID_RE.test(f.id)) return null
  const paths = cleanPaths(f.paths)
  return paths ? { id: f.id, paths } : null
}

export function cleanReply(f: any): HoldersReply | null {
  if (f?.t !== 'holders' || !Array.isArray(f.holders) || f.holders.length > MAX_HOLDERS) return null
  const holders = f.holders.map(cleanHolder).filter((h: Holder | null): h is Holder => !!h)
  const recent = Array.isArray(f.recent) ? f.recent.slice(0, MAX_PATHS).map(cleanPath).filter((p: string | null): p is string => !!p) : []
  const out: HoldersReply = { holders, recent }
  if (f.server && typeof f.server === 'object') out.server = { agent: true, ok: f.server.ok === true, ...(f.server.error ? { error: plain(f.server.error, 200) } : {}) }
  return out
}

/** A close request: which process, for which file, asked by whom. */
export function cleanClose(f: any): { id: string; path: string; pid: number; start: string; app: string; kind: 'app' | 'explorer'; byName: string } | null {
  if (f?.t !== 'close' || typeof f.id !== 'string' || !ID_RE.test(f.id)) return null
  const path = cleanPath(f.path)
  const kind = f.kind === 'explorer' ? 'explorer' : f.kind === 'app' ? 'app' : null
  if (!path || !kind) return null
  if (kind === 'app' && (!Number.isInteger(f.pid) || f.pid <= 0 || typeof f.start !== 'string' || !/^\d{1,20}$/.test(f.start))) return null
  return { id: f.id, path, pid: kind === 'app' ? f.pid : 0, start: kind === 'app' ? f.start : '', app: plain(f.app, 120), kind, byName: plain(f.byName, 80) }
}

export function cleanNotify(f: any): { id: string; path: string; byName: string; reason: 'recent' | 'server' | 'forced' } | null {
  if (f?.t !== 'notify' || typeof f.id !== 'string' || !ID_RE.test(f.id)) return null
  const path = cleanPath(f.path)
  const reason = f.reason === 'server' || f.reason === 'forced' ? f.reason : f.reason === 'recent' ? 'recent' : null
  return path && reason ? { id: f.id, path, byName: plain(f.byName, 80), reason } : null
}

export function cleanForce(f: any): { id: string; fileId: number; path: string } | null {
  if (f?.t !== 'force' || typeof f.id !== 'string' || !ID_RE.test(f.id)) return null
  const path = cleanPath(f.path)
  if (!path || !Number.isInteger(f.fileId) || f.fileId < 0 || f.fileId >= 2 ** 32) return null
  return { id: f.id, fileId: f.fileId, path }
}

export function cleanStatus(f: any): { id: string; holder: string; status: HolderStatus; message?: string } | null {
  if (f?.t !== 'unlock-status' || typeof f.id !== 'string' || !ID_RE.test(f.id)) return null
  const holder = plain(f.holder, 80)
  if (!holder || !STATUSES.includes(f.status)) return null
  const message = plain(f.message, 300)
  return { id: f.id, holder, status: f.status, ...(message ? { message } : {}) }
}

// ---------------------------------------------------------------------------

/** Windows account without the domain, lower case. */
export const bareUser = (u: unknown) => String(u ?? '').replace(/^.*\\/, '').trim().toLowerCase()

/**
 * The local path behind \\host\share\rest when this PC is `host` and shares `share`; else null.
 * hostNames: this PC's names and addresses, any case.
 */
export function serverLocalPath(unc: string, hostNames: readonly string[], shares: readonly { name: string; path: string }[]): string | null {
  const m = /^\\\\([^\\]+)\\([^\\]+)(\\.*)?$/.exec(unc)
  if (!m) return null
  const host = m[1].toLowerCase()
  if (!hostNames.some((h) => h && h.toLowerCase() === host)) return null
  const share = shares.find((s) => s.name.toLowerCase() === m[2].toLowerCase())
  if (!share || !/^[a-zA-Z]:\\/.test(share.path)) return null
  const rest = (m[3] ?? '').replace(/\\+$/, '')
  return share.path.replace(/\\+$/, '') + rest || share.path
}

/** The share-relative UNC path for a local path the server reported (inverse of serverLocalPath). */
export function serverUncPath(local: string, host: string, shares: readonly { name: string; path: string }[]): string | null {
  const l = local.toLowerCase()
  let best: { name: string; path: string } | null = null
  for (const s of shares) {
    const root = s.path.replace(/\\+$/, '').toLowerCase()
    if ((l === root || l.startsWith(root + '\\')) && (!best || s.path.length > best.path.length)) best = s
  }
  if (!best) return null
  return `\\\\${host}\\${best.name}${local.slice(best.path.replace(/\\+$/, '').length)}`
}

/** The host of a UNC path, lower case ('' for anything else). */
export const uncHost = (p: string) => /^\\\\([^\\]+)\\/.exec(p)?.[1].toLowerCase() ?? ''

/** "::ffff:192.168.1.5" -> "192.168.1.5"; "[fe80::1]" -> "fe80::1". */
export const normIp = (a: unknown) => String(a ?? '').trim().replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '').toLowerCase()

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0)$/i

/**
 * A path another PC may ask this one about: a UNC path on a known host (this PC's own names, the
 * servers behind its mapped drives, the office's servers), never a drive letter, localhost or an
 * admin share (C$, ADMIN$, IPC$). Anything else is never looked at, so a crafted question cannot
 * make this PC connect to a stranger's host.
 */
export function acceptRemotePath(p: unknown, allowedHosts: readonly string[]): string | null {
  const path = cleanPath(p)
  if (!path) return null
  const m = /^\\\\([^\\]+)\\([^\\]+)/.exec(path)
  if (!m) return null
  const host = m[1].toLowerCase()
  if (LOOPBACK.test(host) || m[2].endsWith('$')) return null
  return allowedHosts.some((h) => h && !LOOPBACK.test(h) && h.toLowerCase() === host) ? path : null
}

/**
 * Who asks, as the file server sees it: the SMB session(s) from the asking PC's address. Only an
 * account the server itself authenticated counts, never the name a Hopper claims.
 */
export function sessionAdmin(sessions: readonly { client: string; user: string }[], ip: string, isAdmin: (user: string) => boolean): { user: string } | { error: 'no-session' | 'not-admin' } {
  const want = normIp(ip)
  if (!want || LOOPBACK.test(want)) return { error: 'no-session' }
  const mine = sessions.filter((s) => normIp(String(s.client ?? '').replace(/^\\+/, '')) === want && bareUser(s.user))
  if (!mine.length) return { error: 'no-session' }
  const admin = mine.find((s) => isAdmin(bareUser(s.user)))
  return admin ? { user: bareUser(admin.user) } : { error: 'not-admin' }
}

/** At most `cap` open prompts per asking person, and at most `perMinute` new ones a minute. */
export function promptAllowed(openFromThem: number, recentTimes: readonly number[], now: number, cap = 3, perMinute = 6) {
  return openFromThem < cap && recentTimes.filter((t) => now - t < 60_000).length < perMinute
}

/** Is `p` the same as `root` or inside it (case-insensitive)? */
export function within(p: string, root: string) {
  const a = p.toLowerCase().replace(/\\+$/, '')
  const b = root.toLowerCase().replace(/\\+$/, '')
  return a === b || a.startsWith(b + '\\')
}

/**
 * All answers as one list: duplicates dropped; a server-agent row whose user's own Hopper also
 * reported that file is folded into that row (its ids kept for an admin's force close), so a person
 * is listed once. Order: apps and windows first, then server rows, Hopper's own last.
 */
export function aggregateHolders(list: readonly Holder[]): Holder[] {
  const seen = new Set<string>()
  const out: Holder[] = []
  for (const h of list) {
    const k = [h.kind, h.peer ?? '', h.pid ?? '', h.start ?? '', h.fileId ?? '', h.path.toLowerCase()].join('|')
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ ...h })
  }
  const claimed = out.filter((h) => h.kind === 'app' || h.kind === 'explorer')
  const keep: Holder[] = []
  for (const h of out) {
    if (h.kind === 'smb' && h.user) {
      const owner = claimed.find((c) => c.kind === 'app' && bareUser(c.user) === bareUser(h.user) && c.path.toLowerCase() === h.path.toLowerCase())
      if (owner) {
        owner.fileIds = [...(owner.fileIds ?? []), ...(h.fileId !== undefined ? [h.fileId] : [])]
        continue
      }
    }
    keep.push(h)
  }
  const rank = (h: Holder) => (h.kind === 'app' ? 0 : h.kind === 'explorer' ? 1 : h.kind === 'smb' ? 2 : 3)
  return keep.sort((a, b) => rank(a) - rank(b))
}

/** Plain words for one holder row: never a guess for a holder the server cannot name. */
export function holderWho(h: Holder): string {
  if (h.kind === 'smb' && !h.user) return 'Unknown — the server still has it open'
  const who = h.person || h.user || 'Unknown'
  return h.pc ? `${who} on ${h.pc}` : h.kind === 'smb' ? `${who} (computer not known)` : who
}

/** Does an error from a move, rename, delete or copy mean another program has the file open? */
export function isBusyError(message: string): boolean {
  return /\bEBUSY\b|\bEPERM\b|being used by another process|used by another process|sharing violation|resource busy|locked/i.test(message)
}
