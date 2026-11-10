// Dexterity Share: types and pure helpers shared by the engine, the dialogs and the tests.
// A "public link" is a folder in the office store that the share server (server/dexterity-share)
// reads; Hopper only ever writes files over SMB and never talks to that server to create a link.

/** OfficeConfig.publicShare (shared office.json). */
export interface PublicShareConfig {
  enabled: boolean
  /** store folder as office PCs see it; '' = "<folder of office.json>\PublicShares" */
  store: string
  /** client page, e.g. https://vikramdex-ops.github.io/Hopper/share/ */
  pageUrl: string
  /** default expiry in days (one of EXPIRY_DAYS) */
  defaultDays: number
}

export const EXPIRY_DAYS = [1, 3, 7, 14, 30, 60, 90] as const
export const DEFAULT_EXPIRY_DAYS = 7
export const DEFAULT_PAGE_URL = 'https://vikramdex-ops.github.io/Hopper/share/'
export const MANIFEST_VERSION = 1
/** 128 random bits as 26 lower-case base32 characters: safe in e-mail, on case-blind disks and in URLs. */
export const SHARE_ID_RE = /^[a-z2-7]{26}$/
export const MAX_SHARE_FILES = 500
export const DAY_MS = 86_400_000

export interface ShareFile {
  name: string
  size: number
  /** lower-case hex */
  sha256: string
}

export interface PasswordVerifier {
  kdf: 'scrypt'
  N: number
  r: number
  p: number
  /** base64 */
  salt: string
  /** base64, 32 bytes */
  hash: string
}

/** manifest.json — written last, so a share exists for the server only once it is complete. */
export interface ShareManifest {
  v: number
  id: string
  title: string
  message: string
  /** display name shown to the client */
  sender: string
  createdAt: number
  expiresAt: number
  files: ShareFile[]
  password: PasswordVerifier | null
  /** completed downloads allowed per file; 0 = no limit */
  maxDownloads: number
  /** never sent to clients */
  owner: { user: string; host: string }
}

/** stats.json — written by the share server only. */
export interface ShareStats {
  v: number
  views: number
  started: number
  downloads: number
  bytes: number
  lastViewAt: number
  lastDownloadAt: number
  files: { started: number; completed: number; bytes: number }[]
}

export interface PublicShareSpec {
  paths: string[]
  title: string
  message?: string
  days: number
  password?: string
  /** zip the selection into one file first (always needed for folders) */
  zip?: { presetId?: string; name?: string } | null
  maxDownloads?: number
}

export interface PublicShareCreated {
  jobId: string
  id: string
  url: string
  expiresAt: number
}

export interface PublicLink {
  id: string
  url: string
  title: string
  message: string
  sender: string
  owner: string
  createdAt: number
  expiresAt: number
  expired: boolean
  files: { name: string; size: number }[]
  bytes: number
  hasPassword: boolean
  maxDownloads: number
  stats: ShareStats | null
}

export interface PublicShareStatus {
  enabled: boolean
  store: string
  storeOk: boolean
  storeError?: string
  pageUrl: string
  /** public address the server last reported into the store (heartbeat file) */
  base?: string
  /** ms since epoch of that heartbeat */
  serverSeenAt?: number
  /** /healthz answered through the public address */
  healthy: boolean
  healthError?: string
}

export const isShareId = (s: unknown): s is string => typeof s === 'string' && SHARE_ID_RE.test(s)

export function normalizeDays(days: unknown, fallback: number = DEFAULT_EXPIRY_DAYS): number {
  const ok = (n: number) => (EXPIRY_DAYS as readonly number[]).includes(n)
  const n = Number(days)
  return ok(n) ? n : ok(fallback) ? fallback : DEFAULT_EXPIRY_DAYS
}

/** "<page>#<id>": the id sits in the fragment, so it never reaches the page host's logs. */
export function shareUrl(pageUrl: string | undefined, id: string) {
  let base = (pageUrl || DEFAULT_PAGE_URL).trim().replace(/[#?].*$/, '')
  if (!/\/$/.test(base) && !/\.html?$/i.test(base)) base += '/'
  return `${base}#${id}`
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
/** 16 random bytes -> 26-character share id. */
export function encodeShareId(bytes: Uint8Array) {
  if (bytes.length !== 16) throw new Error('share id needs 16 bytes')
  let bits = 0
  let acc = 0
  let out = ''
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
    acc &= (1 << bits) - 1
  }
  if (bits) out += B32[(acc << (5 - bits)) & 31]
  return out
}

// No look-alikes (0/O, 1/l/I), so a password read out over the phone survives.
const PW_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
/** Password in groups of four, e.g. "k7Hd-Qm3x-9TpW" (about 70 bits). */
export function generatePassword(random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  const out: string[] = []
  while (out.length < 12) {
    for (const b of random(32)) {
      // rejection sampling keeps every character equally likely (224 = 4 x 56)
      if (b < 224 && out.length < 12) out.push(PW_CHARS[b % 56])
    }
  }
  return `${out.slice(0, 4).join('')}-${out.slice(4, 8).join('')}-${out.slice(8).join('')}`
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

const longDate = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
/** "Tuesday 17 November 2026" — month spelled out, because clients read numeric dates in different orders. */
export const fmtExpiryDate = (ms: number) => longDate.format(new Date(ms)).replace(',', '')

/** Whole days left, rounded up; 0 once expired. */
export const daysLeft = (expiresAt: number, now = Date.now()) => Math.max(0, Math.ceil((expiresAt - now) / DAY_MS))

/** Characters Windows forbids in names, control characters and trailing dots/spaces removed. */
export function safeFileName(name: string, fallback = 'file') {
  const s = name
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 180)
  return s || fallback
}

export interface EmailInput {
  url: string
  title: string
  message?: string
  sender: string
  company?: string
  files: { name: string; size: number }[]
  expiresAt: number
  now?: number
  hasPassword: boolean
}

/** Subject and plain-text body for the e-mail to the client. Never contains the password. */
export function buildEmail(e: EmailInput) {
  const company = e.company || 'Dexterity Design Services Private Limited'
  const total = e.files.reduce((a, f) => a + f.size, 0)
  const n = daysLeft(e.expiresAt, e.now)
  const what = e.files.length === 1 ? `${e.files[0].name} (${fmtBytes(total)})` : `${e.files.length} files (${fmtBytes(total)} in total)`
  const lines = [
    'Hello,',
    '',
    ...(e.message?.trim() ? [e.message.trim(), ''] : []),
    `Please download ${e.files.length === 1 ? 'the file' : 'the files'} we have prepared for you from this link:`,
    '',
    e.url,
    '',
    `Contents: ${what}`,
    ...(e.files.length > 1 && e.files.length <= 12 ? e.files.map((f) => `  - ${f.name} (${fmtBytes(f.size)})`) : []),
    '',
    `This link expires on ${fmtExpiryDate(e.expiresAt)} (${n} ${n === 1 ? 'day' : 'days'} from today). Please download before then.`,
    ...(e.hasPassword ? ['The link is password protected. We will send you the password separately.'] : []),
    '',
    'If the link does not open or the download fails, please reply to this e-mail and we will help.',
    '',
    'Regards,',
    e.sender,
    company
  ]
  return { subject: `${e.title} - files from ${company}`, body: lines.join('\r\n') }
}

/** mailto: with subject and body. Mail apps cap URL length, so a very long body loses its per-file list. */
export function mailtoUrl(subject: string, body: string) {
  const enc = (s: string) => encodeURIComponent(s)
  let b = body
  if (enc(b).length > 1800) b = b.split('\r\n').filter((l) => !l.startsWith('  - ')).join('\r\n')
  return `mailto:?subject=${enc(subject)}&body=${enc(b)}`
}
