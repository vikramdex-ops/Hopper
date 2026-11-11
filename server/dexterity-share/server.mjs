// Dexterity Share server — (c) Dexterity Design Services Private Limited. Internal software.
// One file, no dependencies (Node 20+). Serves client downloads from the share store that Hopper
// fills over the office network. Listens on 127.0.0.1 only: the tunnel is the only way in.
// It never lists anything; a file is reachable only through its unguessable share id.
import http from 'node:http'
import fs, { promises as fsp } from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { pipeline, Transform } from 'node:stream'
import { fileURLToPath } from 'node:url'

export const ID_RE = /^[a-z2-7]{26}$/
const ROUTE_META = /^\/api\/s\/([a-z2-7]{26})$/
const ROUTE_UNLOCK = /^\/api\/s\/([a-z2-7]{26})\/unlock$/
const ROUTE_FILE = /^\/d\/([a-z2-7]{26})\/(0|[1-9]\d{0,3})$/
const MARKERS = ['manifest.json', 'revoked.json', 'creating.json']
const MAX_FILES = 500
const HOUR = 3_600_000

export const DEFAULTS = {
  port: 47880,
  store: '',
  /** origins of the client page allowed to call the API from a browser */
  allowedOrigins: ['https://vikramdex-ops.github.io'],
  stateDir: '',
  logDir: '',
  /** header that carries the real client address behind the tunnel ('' = use the socket address) */
  clientIpHeader: 'cf-connecting-ip',
  logClientIp: true,
  maxConcurrentDownloads: 24,
  maxDownloadsPerIp: 6,
  apiPerMinutePerIp: 240,
  /** file requests per minute per client: generous, because one link may hold hundreds of files */
  filePerMinutePerIp: 1500,
  unlockFailuresPerIp: 8,
  unlockWindowMinutes: 10,
  unlockFailuresPerShareHour: 40,
  tokenTtlHours: 12,
  /** a download with no progress for this long is dropped (the browser can resume it) */
  idleTimeoutSeconds: 300,
  graceHours: 24,
  cleanupMinutes: 60,
  shutdownGraceSeconds: 10,
  logMaxMB: 10,
  logKeep: 5,
  /**
   * Upload speed limit for all downloads together, in megabits per second (0 = no limit).
   * officeMbps (if set) applies instead during office hours, so client downloads do not slow the office.
   */
  bandwidth: { mbps: 0, officeMbps: 0, officeDays: [1, 2, 3, 4, 5, 6], officeFrom: '09:00', officeTo: '19:00' },
  /**
   * Staff create links from a browser (site/share/create/) with a personal pass Hopper writes into
   * <store>/_staff/. maxGB caps one upload; chunkMB is the size of one upload request (Cloudflare
   * refuses request bodies over 100 MB, so it is never above 90 MB).
   */
  staff: { enabled: true, maxGB: 5, chunkMB: 16, defaultDays: 7, maxUnfinished: 2 },
  /** refuse a new upload when the store's drive would drop below this much free space (GB) */
  minFreeGB: 5,
  /** wrong or switched-off browser passes per client address before it has to wait */
  staffFailuresPerIp: 10,
  staffWindowMinutes: 10,
  /** an upload request that sends nothing for this long is dropped (the page resends the chunk) */
  uploadIdleSeconds: 60,
  /** the longest one upload request may take, start to finish */
  uploadRequestMinutes: 15,
  /** every other request must have sent its whole body within this time */
  bodyTimeoutSeconds: 30
}

export const STAFF_DIR = '_staff'
export const EXPIRY_DAYS = [1, 3, 7, 14, 30, 60, 90]
export const STAFF_EXTENSIONS = ['zip', 'rar', '7z']
const DAY = 86_400_000
const MAX_CHUNK = 90_000_000
const ROUTE_STAFF_CHUNK = /^\/api\/staff\/uploads\/([a-z2-7]{26})\/(0|[1-9]\d{0,6})$/
const ROUTE_STAFF_UPLOAD = /^\/api\/staff\/uploads\/([a-z2-7]{26})$/
const ROUTE_STAFF_FINISH = /^\/api\/staff\/uploads\/([a-z2-7]{26})\/finish$/
const ROUTE_STAFF_LINK = /^\/api\/staff\/links\/([a-z2-7]{26})\/(revoke|renew)$/
const AUTH_RE = /^Bearer ([a-z2-7]{26})\.([A-Za-z0-9_-]{43})$/

/** The same rules as Hopper's safeFileName (src/shared/pubshare.ts): Windows-forbidden characters, control characters, trailing dots/spaces. */
export function safeFileName(name, fallback = 'file') {
  const s = String(name)
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 180)
  return s || fallback
}

/** What the first bytes of a file say it is: 'zip', 'rar', '7z' or null. */
export function archiveKind(head) {
  const b = Buffer.from(head ?? [])
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6) || (b[2] === 7 && b[3] === 8))) return 'zip'
  if (b.length >= 7 && b.subarray(0, 6).equals(Buffer.from('Rar!\x1a\x07', 'latin1')) && (b[6] === 0 || (b[6] === 1 && b[7] === 0))) return 'rar'
  if (b.length >= 6 && b.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z'
  return null
}

/** Staff settings with every number in range. */
export function staffSettings(s, minFreeGB = DEFAULTS.minFreeGB) {
  const d = DEFAULTS.staff
  const v = { ...d, ...(s ?? {}) }
  const gb = Number(v.maxGB)
  const maxGB = Number.isFinite(gb) && gb > 0 && gb <= 1024 ? gb : d.maxGB
  const chunk = Number(v.chunkBytes) || Math.round((Number(v.chunkMB) || d.chunkMB) * 1048576)
  const days = Number(v.defaultDays)
  const free = Number(minFreeGB)
  return {
    enabled: v.enabled !== false,
    maxGB,
    maxBytes: Math.floor(maxGB * 2 ** 30),
    chunkBytes: Math.min(MAX_CHUNK, Math.max(65536, Math.floor(chunk))),
    defaultDays: EXPIRY_DAYS.includes(days) ? days : 7,
    maxUnfinished: Math.max(1, Math.min(20, Math.floor(Number(v.maxUnfinished) || d.maxUnfinished))),
    minFreeBytes: (Number.isFinite(free) && free >= 0 ? free : DEFAULTS.minFreeGB) * 2 ** 30
  }
}

/** The limit in bytes per second that applies at `date` (0 = unlimited). */
export function currentLimit(bw, date = new Date()) {
  if (!bw) return 0
  const total = Math.max(0, Number(bw.mbps) || 0)
  const office = Math.max(0, Number(bw.officeMbps) || 0)
  let mbps = total
  if (office > 0) {
    const mins = (t, d) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? ''))
      return m ? Number(m[1]) * 60 + Number(m[2]) : d
    }
    const now = date.getHours() * 60 + date.getMinutes()
    const days = Array.isArray(bw.officeDays) ? bw.officeDays : [1, 2, 3, 4, 5, 6]
    const from = mins(bw.officeFrom, 540)
    const to = mins(bw.officeTo, 1140)
    if (days.includes(date.getDay()) && now >= from && now < to) mbps = total > 0 ? Math.min(total, office) : office
  }
  return Math.round((mbps * 1_000_000) / 8)
}

/**
 * Paces one download. `share()` returns this stream's bytes-per-second allowance right now
 * (the total limit divided by the number of downloads), or 0 for "no limit".
 */
export class Throttle extends Transform {
  constructor(share, now = () => Date.now()) {
    super({ highWaterMark: 256 * 1024 })
    this.share = share
    this.now = now
    this.nextAt = 0
  }
  _transform(chunk, _enc, cb) {
    let off = 0
    const step = () => {
      if (this.destroyed) return
      if (off >= chunk.length) return cb()
      const rate = this.share()
      if (!(rate > 0)) {
        this.push(off ? chunk.subarray(off) : chunk)
        return cb()
      }
      // slices of about a tenth of a second keep the flow smooth at any limit
      const n = Math.min(chunk.length - off, Math.max(1024, Math.min(65536, Math.ceil(rate / 10))))
      const t = this.now()
      const wait = this.nextAt - t
      if (wait > 4) return void setTimeout(step, Math.min(wait, 1000))
      this.push(chunk.subarray(off, off + n))
      off += n
      this.nextAt = Math.max(t - 250, this.nextAt) + (n / rate) * 1000
      step()
    }
    step()
  }
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit tested)

/** Range header -> null (send everything), {start,end} or 'unsatisfiable'. Single ranges only. */
export function parseRange(header, size) {
  if (typeof header !== 'string' || !header) return null
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)
  if (!m) return null // other units and multi-range requests get the whole file, as RFC 9110 allows
  const [, a, b] = m
  if (a === '' && b === '') return null
  if (size === 0) return 'unsatisfiable'
  if (a === '') {
    const n = Number(b)
    if (n === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(a)
  if (!(start < size)) return 'unsatisfiable'
  if (b === '') return { start, end: size - 1 }
  const end = Number(b)
  if (end < start) return null
  return { start, end: Math.min(end, size - 1) }
}

/** RFC 6266 / RFC 5987: an ASCII fallback plus the exact UTF-8 name. */
export function contentDisposition(name) {
  const clean = String(name).replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '_').slice(0, 255) || 'download'
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%;]/g, '_')
  const star = encodeURIComponent(clean).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`
}

const b64u = (buf) => Buffer.from(buf).toString('base64url')

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
/** 16 random bytes -> 26-character id (the same encoding as Hopper's share ids). */
export function encodeId(bytes) {
  let bits = 0
  let acc = 0
  let out = ''
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits) out += B32[(acc << (5 - bits)) & 31]
  return out
}

function tokenMac(secret, id, exp, bind) {
  return crypto.createHmac('sha256', secret).update(`dxshare-token-v1\n${id}\n${exp}\n${bind}`).digest()
}

/** Unlock token: "<expiry ms, base36>.<mac>", bound to the share and to its current password. */
export function signToken(secret, id, bind, ttlMs, now = Date.now()) {
  const exp = now + ttlMs
  return `${exp.toString(36)}.${b64u(tokenMac(secret, id, exp, bind))}`
}

export function verifyToken(secret, id, bind, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 120) return false
  const m = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token)
  if (!m) return false
  const exp = parseInt(m[1], 36)
  if (!Number.isSafeInteger(exp) || exp <= now) return false
  const want = tokenMac(secret, id, exp, bind)
  const got = Buffer.from(m[2], 'base64url')
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

const scrypt = (pw, salt, len, opts) => new Promise((resolve, reject) => crypto.scrypt(pw, salt, len, opts, (e, k) => (e ? reject(e) : resolve(k))))

/** Same verifier Hopper writes: scrypt, salt and hash in base64. */
export async function hashPassword(password, opts = {}) {
  const N = opts.N ?? 32768
  const r = opts.r ?? 8
  const p = opts.p ?? 1
  const salt = opts.salt ?? crypto.randomBytes(16)
  const hash = await scrypt(String(password).normalize('NFKC'), salt, 32, { N, r, p, maxmem: 256 * N * r })
  return { kdf: 'scrypt', N, r, p, salt: salt.toString('base64'), hash: hash.toString('base64') }
}

export function validVerifier(v) {
  if (!v || typeof v !== 'object' || v.kdf !== 'scrypt') return false
  const pow2 = Number.isInteger(v.N) && v.N >= 1024 && v.N <= 262144 && (v.N & (v.N - 1)) === 0
  return pow2 && Number.isInteger(v.r) && v.r >= 1 && v.r <= 16 && Number.isInteger(v.p) && v.p >= 1 && v.p <= 4 && typeof v.salt === 'string' && v.salt.length >= 16 && v.salt.length <= 128 && typeof v.hash === 'string' && Buffer.from(v.hash, 'base64').length === 32
}

/** Constant-time check of a password against a verifier. */
export async function verifyPassword(password, v) {
  if (typeof password !== 'string' || password.length === 0 || password.length > 256 || !validVerifier(v)) return false
  const want = Buffer.from(v.hash, 'base64')
  const got = await scrypt(password.normalize('NFKC'), Buffer.from(v.salt, 'base64'), 32, { N: v.N, r: v.r, p: v.p, maxmem: 256 * v.N * v.r })
  return crypto.timingSafeEqual(got, want)
}

const str = (v, max) => typeof v === 'string' && v.length <= max
/** Strict manifest check; returns the manifest or null. Nothing in it is ever used to build a path. */
export function validateManifest(m, id) {
  if (!m || typeof m !== 'object' || m.v !== 1 || m.id !== id) return null
  if (!str(m.title, 300) || !str(m.message ?? '', 4000) || !str(m.sender ?? '', 200)) return null
  if (!Number.isSafeInteger(m.createdAt) || !Number.isSafeInteger(m.expiresAt)) return null
  if (!Array.isArray(m.files) || m.files.length < 1 || m.files.length > MAX_FILES) return null
  for (const f of m.files) {
    if (!f || !str(f.name, 255) || !f.name || !Number.isSafeInteger(f.size) || f.size < 0 || !/^[0-9a-f]{64}$/.test(f.sha256 ?? '')) return null
    if (f.mtime != null && !(typeof f.mtime === 'number' && Number.isFinite(f.mtime) && f.mtime >= 0)) return null
  }
  if (m.password != null && !validVerifier(m.password)) return null
  if (m.maxDownloads != null && !(Number.isSafeInteger(m.maxDownloads) && m.maxDownloads >= 0)) return null
  return m
}

/** Is `child` strictly inside `parent`? Both must already be absolute. */
export function inside(child, parent) {
  const rel = path.relative(parent, child)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** A store must be an absolute folder at least one level below a drive or share root. */
export function storeLooksSafe(store) {
  if (!store || !path.isAbsolute(store)) return false
  const root = path.parse(path.resolve(store)).root
  return path.resolve(store).length > root.length
}

export function loadConfig(file, env = process.env) {
  let raw = {}
  if (file && fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  const cfg = { ...DEFAULTS, ...(raw.server ?? raw) }
  if (env.DXSHARE_PORT) cfg.port = Number(env.DXSHARE_PORT)
  if (env.DXSHARE_STORE) cfg.store = env.DXSHARE_STORE
  if (env.DXSHARE_STATE) cfg.stateDir = env.DXSHARE_STATE
  if (env.DXSHARE_LOGS) cfg.logDir = env.DXSHARE_LOGS
  if (env.DXSHARE_ORIGINS) cfg.allowedOrigins = env.DXSHARE_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  const base = file ? path.dirname(path.resolve(file)) : process.cwd()
  cfg.stateDir = path.resolve(base, cfg.stateDir || 'state')
  cfg.logDir = path.resolve(base, cfg.logDir || 'logs')
  cfg.allowedOrigins = (cfg.allowedOrigins ?? []).map((o) => String(o).replace(/\/+$/, '').toLowerCase())
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new Error('config: port must be 1-65535')
  if (!storeLooksSafe(cfg.store)) throw new Error('config: "store" must be an absolute folder path (not a drive root)')
  cfg.store = path.resolve(cfg.store)
  return cfg
}

/** Size-rotated JSON-lines log. Passwords, tokens and query strings never reach it. */
export class Log {
  constructor(dir, name, maxBytes = 10 << 20, keep = 5) {
    this.dir = dir
    this.file = dir ? path.join(dir, `${name}.log`) : ''
    this.name = name
    this.max = maxBytes
    this.keep = keep
    this.size = -1
  }
  write(level, event, data = {}) {
    if (!this.file) return
    const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...data }) + '\n'
    try {
      if (this.size < 0) {
        fs.mkdirSync(this.dir, { recursive: true })
        this.size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0
      }
      if (this.size + line.length > this.max) this.rotate()
      fs.appendFileSync(this.file, line)
      this.size += Buffer.byteLength(line)
    } catch {
      // a full or missing log disk must never take the service down
    }
  }
  rotate() {
    for (let i = this.keep - 1; i >= 1; i--) {
      const from = path.join(this.dir, `${this.name}.${i}.log`)
      if (fs.existsSync(from)) fs.renameSync(from, path.join(this.dir, `${this.name}.${i + 1}.log`))
    }
    fs.renameSync(this.file, path.join(this.dir, `${this.name}.1.log`))
    fs.rmSync(path.join(this.dir, `${this.name}.${this.keep + 1}.log`), { force: true })
    this.size = 0
  }
  info(event, data) {
    this.write('info', event, data)
  }
  warn(event, data) {
    this.write('warn', event, data)
  }
  error(event, data) {
    this.write('error', event, data)
  }
}

/** Fixed-window counters: hit() counts, peek() only looks. */
export class Limiter {
  constructor() {
    this.map = new Map()
  }
  entry(key, windowMs, now) {
    let e = this.map.get(key)
    if (!e || now >= e.reset) {
      e = { n: 0, reset: now + windowMs }
      this.map.set(key, e)
    }
    return e
  }
  peek(key, limit, windowMs, now = Date.now()) {
    const e = this.entry(key, windowMs, now)
    return { ok: e.n < limit, left: Math.max(0, limit - e.n), retryAfter: Math.max(1, Math.ceil((e.reset - now) / 1000)) }
  }
  hit(key, limit, windowMs, now = Date.now()) {
    const e = this.entry(key, windowMs, now)
    e.n++
    return { ok: e.n <= limit, left: Math.max(0, limit - e.n), retryAfter: Math.max(1, Math.ceil((e.reset - now) / 1000)) }
  }
  prune(now = Date.now()) {
    for (const [k, e] of this.map) if (now >= e.reset) this.map.delete(k)
  }
}

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`
  await fsp.writeFile(tmp, text)
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(tmp, file)
      return
    } catch (e) {
      // Windows refuses to replace a file another process has open; that passes in a moment
      if (i >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) {
        await fsp.rm(tmp, { force: true }).catch(() => {})
        throw e
      }
      await new Promise((r) => setTimeout(r, 40 * (i + 1)))
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Server

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000',
  'Cache-Control': 'no-store'
}

const ERROR_TEXT = {
  not_found: ['This link is not available', 'It may have expired or been withdrawn by the sender.'],
  expired: ['This link has expired', 'Please ask the sender for a new link.'],
  locked: ['This download needs its password', 'Open the link you were sent again and enter the password.'],
  limit: ['This file has reached its download limit', 'Please ask the sender for a new link.'],
  busy: ['The server is busy right now', 'Please go back and try again in a minute.'],
  unavailable: ['This file is temporarily unavailable', 'Please try again in a few minutes or contact the sender.'],
  changed: ['This file was changed after it was shared', 'Please ask the sender for a new link.'],
  rate_limited: ['Too many requests', 'Please wait a minute and try again.']
}

function errorPage(code) {
  const [h, p] = ERROR_TEXT[code] ?? ['Something went wrong', 'Please open the link you were sent again.']
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Dexterity Share</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.6 'Segoe UI',system-ui,-apple-system,sans-serif;background:#f7f8fa;color:#14171c}main{max-width:440px;margin:24px;padding:32px;border-radius:16px;background:#fff;border:1px solid rgba(15,23,42,.09)}h1{font-size:22px;margin:0 0 8px}p{margin:0;color:#4a5361}small{display:block;margin-top:20px;color:#7c8595}@media(prefers-color-scheme:dark){body{background:#0e1014;color:#f1f3f6}main{background:#161a20;border-color:rgba(255,255,255,.09)}p{color:#b3bbc7}}</style><main><h1>${h}</h1><p>${p}</p><small>Dexterity Share &middot; Dexterity Design Services Private Limited</small></main></html>`
}

export function createShareServer(config, hooks = {}) {
  const cfg = { ...DEFAULTS, ...config }
  if (!storeLooksSafe(cfg.store)) throw new Error('store must be an absolute folder path (not a drive root)')
  const store = path.resolve(cfg.store)
  const log = hooks.log ?? new Log(cfg.logDir, 'share', cfg.logMaxMB << 20, cfg.logKeep)
  const now = hooks.now ?? (() => Date.now())
  const origins = new Set((cfg.allowedOrigins ?? []).map((o) => String(o).replace(/\/+$/, '').toLowerCase()))
  const instance = crypto.randomBytes(8).toString('hex')
  const limiter = new Limiter()
  const manifests = new Map() // id -> { at, share }
  const stats = new Map() // id -> { dir, data, dirty }
  const active = new Set() // downloads in flight
  const perIp = new Map()
  const sockets = new Set()
  let secret = null
  let storeOk = true
  let closing = false
  let inflight = 0
  const startedAt = Date.now()
  let bandwidth = cfg.bandwidth
  let staff = staffSettings(cfg.staff, cfg.minFreeGB)
  let today = { day: new Date().toDateString(), bytes: 0, downloads: 0 }
  let free = null
  const countToday = (bytes, done) => {
    const d = new Date().toDateString()
    if (d !== today.day) today = { day: d, bytes: 0, downloads: 0 }
    today.bytes += bytes
    if (done) today.downloads++
  }
  const refreshFree = () => fsp.statfs(store).then((v) => (free = { free: v.bavail * v.bsize, total: v.blocks * v.bsize }), () => (free = null))
  const timers = []

  function loadSecret() {
    // The token key survives restarts, so a client who unlocked a link can still resume afterwards.
    const file = path.join(cfg.stateDir, 'secret.key')
    try {
      const s = fs.readFileSync(file)
      if (s.length === 32) return s
    } catch {}
    const s = crypto.randomBytes(32)
    try {
      fs.mkdirSync(cfg.stateDir, { recursive: true })
      fs.writeFileSync(file, s, { mode: 0o600 })
    } catch (e) {
      log.warn('secret-not-saved', { code: e.code })
    }
    return s
  }

  function clientIp(req) {
    const h = cfg.clientIpHeader && req.headers[cfg.clientIpHeader]
    const v = typeof h === 'string' ? h.split(',')[0].trim() : ''
    if (v && v.length <= 45 && /^[0-9a-fA-F:.]+$/.test(v)) return v.toLowerCase()
    return req.socket.remoteAddress ?? 'unknown'
  }

  /** Never throws. state: ok | expired | missing */
  async function loadShare(id, fresh = false) {
    const t = now()
    const hit = manifests.get(id)
    if (!fresh && hit && t - hit.at < (cfg.manifestCacheMs ?? 2000)) return hit.share
    const dir = path.join(store, id)
    let share = { state: 'missing' }
    try {
      if (!ID_RE.test(id) || !inside(dir, store)) throw new Error('bad id')
      const file = path.join(dir, 'manifest.json')
      const st = await fsp.stat(file)
      if (!st.isFile() || st.size > 1 << 20) throw new Error('bad manifest')
      const m = validateManifest(JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '')), id)
      if (!m) throw new Error('invalid manifest')
      share = { state: m.expiresAt <= t ? 'expired' : 'ok', manifest: m, dir }
    } catch (e) {
      if (e.code && e.code !== 'ENOENT' && e.code !== 'ENOTDIR') log.warn('manifest-unreadable', { id: id.slice(0, 6), code: e.code })
    }
    if (manifests.size > 2000) manifests.clear()
    manifests.set(id, { at: t, share })
    return share
  }

  const bindOf = (m) => (m.password ? m.password.hash : '')

  async function statsFor(id, dir, nFiles) {
    let s = stats.get(id)
    if (!s) {
      let data = null
      try {
        data = JSON.parse(await fsp.readFile(path.join(dir, 'stats.json'), 'utf8'))
      } catch {}
      if (!data || data.v !== 1 || !Array.isArray(data.files)) data = { v: 1, views: 0, started: 0, downloads: 0, bytes: 0, lastViewAt: 0, lastDownloadAt: 0, files: [] }
      s = stats.get(id) ?? { dir, data, dirty: false }
      stats.set(id, s)
    }
    while (s.data.files.length < nFiles) s.data.files.push({ started: 0, completed: 0, bytes: 0 })
    return s
  }

  async function flushOnce() {
    for (const [id, s] of stats) {
      if (!s.dirty) {
        if (stats.size > 500) stats.delete(id)
        continue
      }
      // Only into a share that still exists: a revoked share must not be recreated by a late write.
      const alive = await fsp.access(path.join(s.dir, 'manifest.json')).then(() => true, (e) => e.code !== 'ENOENT')
      if (!alive) {
        stats.delete(id)
        continue
      }
      s.dirty = false
      try {
        await writeAtomic(path.join(s.dir, 'stats.json'), JSON.stringify(s.data))
      } catch (e) {
        s.dirty = true // keep the numbers; the next flush tries again
        log.warn('stats-write-failed', { id: id.slice(0, 6), code: e.code })
      }
    }
  }
  // One flush at a time: two writers racing on the same file could let an older snapshot win.
  let flushing = Promise.resolve()
  function flushStats() {
    flushing = flushing.then(flushOnce, flushOnce)
    return flushing
  }

  /** Delete expired shares after the grace period, and nothing that is not unmistakably a share. */
  async function cleanup() {
    const removed = []
    let entries
    try {
      entries = await fsp.readdir(store, { withFileTypes: true })
      storeOk = true
    } catch (e) {
      storeOk = false
      log.error('store-unreadable', { code: e.code })
      return removed
    }
    const t = now()
    const grace = cfg.graceHours * HOUR
    for (const ent of entries) {
      if (!ID_RE.test(ent.name) || !ent.isDirectory() || ent.isSymbolicLink()) continue
      const dir = path.join(store, ent.name)
      try {
        if (!inside(dir, store) || (await fsp.lstat(dir)).isSymbolicLink()) continue
        const real = await fsp.realpath(dir)
        if (path.basename(real) !== ent.name) continue
        const have = []
        for (const mk of MARKERS) {
          const st = await fsp.lstat(path.join(dir, mk)).catch(() => null)
          if (st?.isFile()) have.push([mk, st])
        }
        if (!have.length) continue // not a share we know: never touch it
        let reason = ''
        const man = have.find(([n]) => n === 'manifest.json')
        if (man) {
          let m = null
          try {
            m = validateManifest(JSON.parse((await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8')).replace(/^\uFEFF/, '')), ent.name)
          } catch {}
          if (m) {
            if (m.expiresAt + grace <= t) reason = 'expired'
          } else if (man[1].mtimeMs + 7 * 24 * HOUR <= t) reason = 'invalid-manifest'
        } else if (have.some(([n]) => n === 'revoked.json')) reason = 'revoked'
        else if (have[0][1].mtimeMs + 24 * HOUR <= t) reason = 'abandoned'
        if (!reason) continue
        // The manifest goes first, so a half-finished delete can never be served.
        await fsp.rm(path.join(dir, 'manifest.json'), { force: true })
        await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
        manifests.delete(ent.name)
        stats.delete(ent.name)
        uploadsMem.delete(ent.name)
        removed.push(ent.name)
        log.info('share-removed', { id: ent.name.slice(0, 6), reason })
      } catch (e) {
        log.warn('cleanup-failed', { id: ent.name.slice(0, 6), code: e.code })
      }
    }
    limiter.prune(t)
    return removed
  }

  function corsHeaders(req) {
    const origin = String(req.headers.origin ?? '').toLowerCase()
    if (!origin || !origins.has(origin)) return null
    return { 'Access-Control-Allow-Origin': req.headers.origin, Vary: 'Origin', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag, Content-Disposition, Retry-After' }
  }

  function send(req, res, status, body, extra = {}) {
    const html = body && body.error && req.url.startsWith('/d/') && /text\/html/.test(req.headers.accept ?? '')
    const text = html ? errorPage(body.error) : body == null ? '' : JSON.stringify(body)
    const headers = { ...BASE_HEADERS, ...(corsHeaders(req) ?? {}), ...extra }
    if (text) {
      headers['Content-Type'] = html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'
      if (html) headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"
    }
    headers['Content-Length'] = Buffer.byteLength(text)
    res.writeHead(status, headers)
    res.end(req.method === 'HEAD' ? undefined : text)
    res.locals = { ...(res.locals ?? {}), error: body?.error }
  }

  const notFound = (req, res) => send(req, res, 404, { error: 'not_found' })
  const tooMany = (req, res, retryAfter, error = 'rate_limited') => send(req, res, 429, { error }, { 'Retry-After': String(retryAfter) })

  function readBody(req, max) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let n = 0
      req.on('data', (c) => {
        n += c.length
        if (n > max) {
          reject(Object.assign(new Error('too large'), { status: 413 }))
          req.destroy()
        } else chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  const publicFiles = (m) => m.files.map((f, n) => ({ n, name: f.name, size: f.size, sha256: f.sha256 }))

  async function handleMeta(req, res, id, query) {
    const share = await loadShare(id)
    if (share.state === 'missing') return notFound(req, res)
    if (share.state === 'expired') return send(req, res, 410, { error: 'expired' })
    const m = share.manifest
    const unlocked = !m.password || verifyToken(secret, id, bindOf(m), query.get('t'), now())
    const body = {
      v: 1,
      title: m.title,
      message: m.message ?? '',
      sender: m.sender ?? '',
      createdAt: m.createdAt,
      expiresAt: m.expiresAt,
      now: now(),
      needsPassword: !!m.password,
      unlocked,
      fileCount: m.files.length,
      totalSize: m.files.reduce((a, f) => a + f.size, 0),
      // a protected share shows its file names only after the password
      files: unlocked ? publicFiles(m) : null
    }
    if (req.method === 'GET' && !query.has('quiet')) {
      const s = await statsFor(id, share.dir, m.files.length)
      s.data.views++
      s.data.lastViewAt = now()
      s.dirty = true
    }
    send(req, res, 200, body)
  }

  async function handleUnlock(req, res, id, ip) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(req, res, 415, { error: 'bad_request' })
    const share = await loadShare(id)
    if (share.state === 'missing') return notFound(req, res)
    if (share.state === 'expired') return send(req, res, 410, { error: 'expired' })
    const m = share.manifest
    if (!m.password) return send(req, res, 400, { error: 'bad_request' })
    const winIp = cfg.unlockWindowMinutes * 60_000
    const a = limiter.peek(`u:${ip}:${id}`, cfg.unlockFailuresPerIp, winIp, now())
    const b = limiter.peek(`us:${id}`, cfg.unlockFailuresPerShareHour, HOUR, now())
    if (!a.ok || !b.ok) return tooMany(req, res, !a.ok ? a.retryAfter : b.retryAfter)
    let password
    try {
      password = JSON.parse((await readBody(req, 4096)).toString('utf8')).password
    } catch (e) {
      return send(req, res, e.status ?? 400, { error: 'bad_request' })
    }
    // Count the attempt before the slow hash, so parallel guesses cannot outrun the limit.
    const ha = limiter.hit(`u:${ip}:${id}`, cfg.unlockFailuresPerIp, winIp, now())
    limiter.hit(`us:${id}`, cfg.unlockFailuresPerShareHour, HOUR, now())
    const ok = await verifyPassword(password, m.password).catch(() => false)
    if (!ok) {
      log.info('unlock-failed', { id: id.slice(0, 6), ip: cfg.logClientIp ? ip : undefined })
      return send(req, res, 403, { error: 'wrong_password', attemptsLeft: ha.left })
    }
    // a correct password gives the attempt back
    const e1 = limiter.map.get(`u:${ip}:${id}`)
    if (e1) e1.n = Math.max(0, e1.n - 1)
    const e2 = limiter.map.get(`us:${id}`)
    if (e2) e2.n = Math.max(0, e2.n - 1)
    const ttl = cfg.tokenTtlHours * HOUR
    send(req, res, 200, { token: signToken(secret, id, bindOf(m), ttl, now()), expiresIn: Math.floor(ttl / 1000), files: publicFiles(m) })
  }

  async function handleFile(req, res, id, n, query, ip) {
    const share = await loadShare(id)
    if (share.state === 'missing') return notFound(req, res)
    if (share.state === 'expired') return send(req, res, 410, { error: 'expired' })
    const m = share.manifest
    const file = m.files[n]
    if (!file) return notFound(req, res)
    if (m.password && !verifyToken(secret, id, bindOf(m), query.get('t'), now())) return send(req, res, 401, { error: 'locked' })
    const s = await statsFor(id, share.dir, m.files.length)
    if (m.maxDownloads > 0 && s.data.files[n].completed >= m.maxDownloads) return send(req, res, 410, { error: 'limit' })

    // Payloads are stored as data/<number>: no client- or manifest-supplied text ever reaches a path.
    const full = path.join(share.dir, 'data', String(n))
    if (!inside(full, share.dir)) return notFound(req, res)
    let fh
    try {
      fh = await fsp.open(full, 'r')
      const st = await fh.stat()
      if (!st.isFile() || st.size !== file.size || (file.mtime != null && Math.abs(st.mtimeMs - file.mtime) > 2500)) {
        // A file linked (not copied) into the store shares its bytes with the original: if someone
        // edited the original in place, what we hold is no longer what was checksummed. Never serve it.
        if (st.isFile() && file.mtime != null) {
          await fh.close().catch(() => {})
          log.warn('payload-changed', { id: id.slice(0, 6), n })
          return send(req, res, 409, { error: 'changed' })
        }
        throw Object.assign(new Error('size mismatch'), { code: 'ESIZE' })
      }
    } catch (e) {
      await fh?.close().catch(() => {})
      log.error('payload-unavailable', { id: id.slice(0, 6), n, code: e.code })
      return send(req, res, 503, { error: 'unavailable' }, { 'Retry-After': '120' })
    }

    const size = file.size
    const etag = `"${file.sha256.slice(0, 32)}"`
    const lastMod = new Date(Math.floor(m.createdAt / 1000) * 1000).toUTCString()
    const common = {
      ...BASE_HEADERS,
      ...(corsHeaders(req) ?? {}),
      'Cache-Control': 'private, no-transform, max-age=0',
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition(file.name),
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Last-Modified': lastMod
    }
    const inm = req.headers['if-none-match']
    if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
      await fh.close()
      res.writeHead(304, common)
      return res.end()
    }
    let range = parseRange(req.headers.range, size)
    const ifRange = req.headers['if-range']
    if (range && ifRange && ifRange !== etag && ifRange !== lastMod) range = null
    if (range === 'unsatisfiable') {
      await fh.close()
      const { 'Content-Type': _t, 'Content-Disposition': _d, ...bare } = common
      res.writeHead(416, { ...bare, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 })
      return res.end()
    }
    const start = range ? range.start : 0
    const end = range ? range.end : size - 1
    const length = size === 0 ? 0 : end - start + 1
    const headers = { ...common, 'Content-Length': length }
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    if (req.method === 'HEAD') {
      await fh.close()
      res.writeHead(range ? 206 : 200, headers)
      return res.end()
    }

    const mine = perIp.get(ip) ?? 0
    if (active.size >= cfg.maxConcurrentDownloads || mine >= cfg.maxDownloadsPerIp) {
      await fh.close()
      return tooMany(req, res, 30, 'busy')
    }

    const dl = { id, res }
    active.add(dl)
    perIp.set(ip, mine + 1)
    s.data.started++
    s.data.files[n].started++
    s.dirty = true
    let sent = 0
    const idleMs = cfg.idleTimeoutSeconds * 1000
    const onIdle = () => req.socket.destroy()
    req.socket.setTimeout(idleMs, onIdle)
    // A revoked share stops being served within seconds, even to a download already running.
    const watch = setInterval(() => {
      fsp.access(path.join(share.dir, 'manifest.json')).catch((e) => {
        if (e.code === 'ENOENT') {
          log.info('download-aborted-revoked', { id: id.slice(0, 6), n })
          res.destroy()
        }
      })
    }, cfg.revokeCheckMs ?? 5000)
    res.locals = { ...(res.locals ?? {}), range: range ? `${start}-${end}` : undefined }
    res.writeHead(range ? 206 : 200, headers)
    const done = (err) => {
      clearInterval(watch)
      req.socket.setTimeout(0)
      req.socket.removeListener('timeout', onIdle)
      active.delete(dl)
      const left = (perIp.get(ip) ?? 1) - 1
      if (left > 0) perIp.set(ip, left)
      else perIp.delete(ip)
      countToday(sent, !err && sent === length && end === size - 1)
      s.data.bytes += sent
      s.data.files[n].bytes += sent
      if (!err && sent === length && end === size - 1) {
        // the request that delivers the last byte counts as one finished download
        s.data.downloads++
        s.data.files[n].completed++
        s.data.lastDownloadAt = now()
      }
      s.dirty = true
      res.locals.sent = sent
      res.locals.aborted = !!err
    }
    if (length === 0) {
      await fh.close()
      res.end()
      return done(null)
    }
    const limited = currentLimit(bandwidth) > 0
    const rs = fh.createReadStream({ start, end, highWaterMark: limited ? 256 * 1024 : 1 << 20 })
    // every download gets an equal part of the limit; with no limit the throttle passes data straight through
    const pace = new Throttle(() => {
      const total = currentLimit(bandwidth)
      return total > 0 ? Math.max(8192, total / Math.max(1, active.size)) : 0
    })
    pace.on('data', (c) => (sent += c.length))
    pipeline(rs, pace, res, done) // pipeline applies backpressure and closes the file on every outcome
  }

  // ---- staff: links made from a browser -------------------------------------------------------
  // A person signs in with a pass Hopper wrote into <store>/_staff/<id>.json (only a SHA-256 of the
  // secret is in it). An upload is an ordinary share folder with creating.json until it is finished;
  // then manifest.json is written last in exactly Hopper's format, so everything else is unchanged.
  const passes = new Map() // pass id -> { at, pass }
  const used = new Map() // pass id -> last use (ms)
  let usedDirty = false
  const uploadsMem = new Map() // upload id -> { busy:Set<n>, reqs:Set<req>, finishing, result }
  const usedFile = () => path.join(cfg.stateDir, 'staff-used.json')

  function loadUsed() {
    try {
      const j = JSON.parse(fs.readFileSync(usedFile(), 'utf8'))
      for (const [k, v] of Object.entries(j)) if (ID_RE.test(k) && Number.isSafeInteger(v)) used.set(k, v)
    } catch {}
  }
  async function flushUsed() {
    if (!usedDirty) return
    usedDirty = false
    try {
      await fsp.mkdir(cfg.stateDir, { recursive: true })
      await writeAtomic(usedFile(), JSON.stringify(Object.fromEntries(used)))
    } catch (e) {
      usedDirty = true
      log.warn('staff-used-write-failed', { code: e.code })
    }
  }

  const sendStaff = (req, res, status, body, extra) => send(req, res, status, body, extra)
  const strOk = (v, max) => v == null || (typeof v === 'string' && v.length <= max)

  /** The pass file, or null (missing, malformed or switched off). Cached for a few seconds. */
  async function loadPass(id) {
    const t = now()
    const hit = passes.get(id)
    if (hit && t - hit.at < (cfg.passCacheMs ?? 3000)) return hit.pass
    let pass = null
    try {
      const dir = path.join(store, STAFF_DIR)
      const file = path.join(dir, `${id}.json`)
      if (!ID_RE.test(id) || !inside(file, store) || !inside(file, dir)) throw new Error('bad id')
      const st = await fsp.lstat(file)
      if (!st.isFile() || st.size > 8192) throw new Error('bad pass')
      const p = JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^﻿/, ''))
      const ok = p && p.v === 1 && p.id === id && typeof p.user === 'string' && p.user.length > 0 && p.user.length <= 120 && strOk(p.name, 200) && strOk(p.host, 120) && typeof p.verifier === 'string' && /^[0-9a-f]{64}$/.test(p.verifier) && !p.revokedAt
      if (ok) pass = { id, user: p.user.toLowerCase(), host: String(p.host ?? ''), name: String(p.name || p.user).slice(0, 120), verifier: p.verifier }
    } catch {}
    if (passes.size > 1000) passes.clear()
    passes.set(id, { at: t, pass })
    return pass
  }

  /** Checks "Authorization: Bearer <pass id>.<secret>". Answers 401/429 itself and returns null when it fails. */
  async function staffAuth(req, res, ip) {
    const win = cfg.staffWindowMinutes * 60_000
    const m = AUTH_RE.exec(String(req.headers.authorization ?? ''))
    let pass = null
    if (m) {
      const p = await loadPass(m[1])
      const got = crypto.createHash('sha256').update(Buffer.from(m[2], 'base64url')).digest()
      const want = Buffer.from(p ? p.verifier : '0'.repeat(64), 'hex')
      if (p && crypto.timingSafeEqual(got, want)) pass = p
    }
    if (!pass) {
      // A whole office shares one public address, so failures never lock out a valid pass: only
      // further wrong attempts from that address are refused.
      const lim = limiter.peek(`sf:${ip}`, cfg.staffFailuresPerIp, win, now())
      if (!lim.ok) {
        tooMany(req, res, lim.retryAfter)
        return null
      }
      limiter.hit(`sf:${ip}`, cfg.staffFailuresPerIp, win, now())
      log.info('staff-signed-out', { ip: cfg.logClientIp ? ip : undefined, pass: m ? m[1].slice(0, 6) : undefined })
      sendStaff(req, res, 401, { error: 'signed_out' }, req.method === 'PUT' ? { Connection: 'close' } : {})
      return null
    }
    used.set(pass.id, now())
    usedDirty = true
    return pass
  }

  async function readJsonBody(req, max = 16384) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw Object.assign(new Error('type'), { status: 415 })
    try {
      const j = JSON.parse((await readBody(req, max)).toString('utf8') || '{}')
      if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('shape')
      return j
    } catch (e) {
      throw Object.assign(new Error('bad'), { status: e.status ?? 400 })
    }
  }

  const memOf = (id) => {
    let m = uploadsMem.get(id)
    if (!m) uploadsMem.set(id, (m = { busy: new Set(), reqs: new Set(), finishing: null, result: null }))
    return m
  }

  /** creating.json of a browser upload, or null. */
  async function loadUpload(id) {
    if (!ID_RE.test(id)) return null
    const dir = path.join(store, id)
    if (!inside(dir, store)) return null
    try {
      const c = JSON.parse(await fsp.readFile(path.join(dir, 'creating.json'), 'utf8'))
      const s = c?.staff
      if (!c || c.v !== 1 || c.id !== id || typeof c.owner?.user !== 'string' || !s || typeof s.pass !== 'string') return null
      if (!Number.isSafeInteger(s.size) || s.size < 1 || !Number.isSafeInteger(s.chunkBytes) || s.chunkBytes < 1 || typeof s.name !== 'string') return null
      return { ...c, dir, chunks: Math.ceil(s.size / s.chunkBytes) }
    } catch {
      return null
    }
  }

  async function partsOf(up) {
    const names = await fsp.readdir(path.join(up.dir, 'parts')).catch(() => [])
    return names.filter((n) => /^(0|[1-9]\d{0,6})$/.test(n)).map(Number).filter((n) => n < up.chunks).sort((a, b) => a - b)
  }

  /** Unfinished browser uploads in the store, optionally only one person's. */
  async function unfinished(user) {
    const out = []
    let entries = []
    try {
      entries = await fsp.readdir(store, { withFileTypes: true })
    } catch {
      return out
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || !ID_RE.test(ent.name)) continue
      const up = await loadUpload(ent.name)
      if (up && (!user || up.owner.user === user)) out.push(up)
    }
    return out
  }

  async function uploadInfo(up) {
    const have = await partsOf(up)
    const s = up.staff
    const mem = uploadsMem.get(up.id)
    return { id: up.id, name: s.name, size: s.size, chunkBytes: s.chunkBytes, chunks: up.chunks, have, received: have.reduce((a, n) => a + (n === up.chunks - 1 ? s.size - n * s.chunkBytes : s.chunkBytes), 0), createdAt: up.createdAt, state: mem?.finishing ? 'finishing' : 'uploading' }
  }

  const gbText = (n) => `${(n / 2 ** 30).toFixed(n < 10 * 2 ** 30 ? 1 : 0)} GB`

  function staffMe(req, res, pass) {
    sendStaff(req, res, 200, {
      v: 1,
      name: pass.name,
      user: pass.user,
      now: now(),
      limits: { maxBytes: staff.maxBytes, chunkBytes: staff.chunkBytes, extensions: STAFF_EXTENSIONS, days: EXPIRY_DAYS, defaultDays: staff.defaultDays, maxUnfinished: staff.maxUnfinished }
    })
  }

  async function staffCreate(req, res, pass) {
    let b
    try {
      b = await readJsonBody(req)
    } catch (e) {
      return sendStaff(req, res, e.status, { error: 'bad_request' })
    }
    const name = typeof b.name === 'string' ? b.name : ''
    const ext = /\.([A-Za-z0-9]{1,4})$/.exec(name)?.[1]?.toLowerCase() ?? ''
    if (!name || name.length > 180 || safeFileName(name) !== name.normalize('NFC') || name.startsWith('.')) return sendStaff(req, res, 400, { error: 'bad_name' })
    if (!STAFF_EXTENSIONS.includes(ext)) return sendStaff(req, res, 400, { error: 'bad_type', extensions: STAFF_EXTENSIONS })
    if (!Number.isSafeInteger(b.size) || b.size < 1) return sendStaff(req, res, 400, { error: 'bad_request', field: 'size' })
    if (b.size > staff.maxBytes) return sendStaff(req, res, 413, { error: 'too_big', maxBytes: staff.maxBytes })
    if (!strOk(b.title, 300) || !strOk(b.message, 4000)) return sendStaff(req, res, 400, { error: 'bad_request', field: 'text' })
    const password = b.password == null || b.password === '' ? '' : b.password
    if (password && (typeof password !== 'string' || password.length < 6 || password.length > 256)) return sendStaff(req, res, 400, { error: 'bad_password' })
    const days = EXPIRY_DAYS.includes(Number(b.days)) ? Number(b.days) : staff.defaultDays
    const mine = (await unfinished(pass.user)).filter((u) => u.staff.pass === pass.id)
    if (mine.length >= staff.maxUnfinished) return sendStaff(req, res, 409, { error: 'too_many_uploads', max: staff.maxUnfinished })
    try {
      const v = await fsp.statfs(store)
      const freeNow = v.bavail * v.bsize
      if (freeNow - b.size < staff.minFreeBytes) {
        log.warn('staff-disk-full', { free: freeNow, need: b.size })
        return sendStaff(req, res, 507, { error: 'disk_full', message: `The office server is nearly full: ${gbText(freeNow)} free, and client links must leave ${gbText(staff.minFreeBytes)}.` })
      }
    } catch {}
    const id = encodeId(crypto.randomBytes(16))
    const dir = path.join(store, id)
    if (!inside(dir, store)) return sendStaff(req, res, 500, { error: 'server' })
    const createdAt = now()
    const creating = {
      v: 1,
      id,
      owner: { user: pass.user, host: pass.host },
      createdAt,
      staff: {
        pass: pass.id,
        name: name.normalize('NFC'),
        size: b.size,
        chunkBytes: staff.chunkBytes,
        days,
        title: String(b.title ?? '').trim().slice(0, 200),
        message: String(b.message ?? '').trim().slice(0, 4000),
        sender: pass.name,
        password: password ? await hashPassword(password) : null
      }
    }
    try {
      await fsp.mkdir(path.join(dir, 'data'), { recursive: true })
      await fsp.mkdir(path.join(dir, 'parts'), { recursive: true })
      // creating.json first: it tells the clean-up this folder is a share if the upload is abandoned
      await fsp.writeFile(path.join(dir, 'creating.json'), JSON.stringify(creating))
      await fsp.writeFile(path.join(dir, 'data', '0'), '')
    } catch (e) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
      log.error('staff-create-failed', { code: e.code })
      return sendStaff(req, res, 503, { error: 'unavailable' })
    }
    log.info('staff-upload-started', { id: id.slice(0, 6), pass: pass.id.slice(0, 6), size: b.size })
    sendStaff(req, res, 201, { id, chunkBytes: staff.chunkBytes, chunks: Math.ceil(b.size / staff.chunkBytes), days })
  }

  async function staffChunk(req, res, pass, id, index) {
    const close = { Connection: 'close' } // the body is not read: do not keep the connection for it
    const up = await loadUpload(id)
    if (!up || up.owner.user !== pass.user) return sendStaff(req, res, 404, { error: 'not_found' }, close)
    if (index >= up.chunks) return sendStaff(req, res, 400, { error: 'bad_chunk' }, close)
    const s = up.staff
    const want = index === up.chunks - 1 ? s.size - index * s.chunkBytes : s.chunkBytes
    const declared = req.headers['content-length']
    if (declared === undefined || !/^\d{1,12}$/.test(declared) || Number(declared) !== want) return sendStaff(req, res, 400, { error: 'wrong_size', expected: want }, close)
    const mem = memOf(id)
    if (mem.finishing || mem.result) return sendStaff(req, res, 409, { error: 'finishing' }, close)
    if (mem.busy.has(index)) return sendStaff(req, res, 409, { error: 'busy' }, close)
    mem.busy.add(index)
    mem.reqs.add(req)
    const marker = path.join(up.dir, 'parts', String(index))
    const data = path.join(up.dir, 'data', '0')
    const idle = () => req.socket.destroy()
    req.socket.setTimeout(cfg.uploadIdleSeconds * 1000, idle)
    let got = 0
    let fh = null
    let failed = null
    try {
      await fsp.rm(marker, { force: true })
      fh = await fsp.open(data, 'r+')
      const start = index * s.chunkBytes
      // piece by piece, straight to its place in the file: never the whole chunk in memory
      for await (const c of req) {
        if (got + c.length > want) throw Object.assign(new Error('overlong'), { code: 'EOVER' })
        await fh.write(c, 0, c.length, start + got)
        got += c.length
      }
    } catch (e) {
      failed = e
    } finally {
      await fh?.close().catch(() => {})
      req.socket.setTimeout(0)
      req.socket.removeListener('timeout', idle)
      mem.busy.delete(index)
      mem.reqs.delete(req)
    }
    if (failed || got !== want || !req.complete) {
      if (failed?.code === 'ENOSPC') return sendStaff(req, res, 507, { error: 'disk_full' }, close)
      if (failed && !['EOVER', 'ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(failed.code) && failed.message !== 'aborted') log.warn('staff-chunk-failed', { id: id.slice(0, 6), n: index, code: failed.code })
      if (!res.headersSent && !res.destroyed) sendStaff(req, res, 400, { error: 'short_body' }, close)
      return
    }
    try {
      // the upload may have been cancelled meanwhile: never recreate its folder
      if (!(await loadUpload(id))) return sendStaff(req, res, 404, { error: 'not_found' })
      await fsp.writeFile(marker, '')
      const t = new Date(now())
      await fsp.utimes(path.join(up.dir, 'creating.json'), t, t).catch(() => {}) // still in use: not abandoned
    } catch (e) {
      log.warn('staff-chunk-mark-failed', { id: id.slice(0, 6), code: e.code })
      return sendStaff(req, res, 503, { error: 'unavailable' })
    }
    sendStaff(req, res, 200, { ok: true, index })
  }

  async function staffStatus(req, res, pass, id) {
    const up = await loadUpload(id)
    if (up && up.owner.user === pass.user) return sendStaff(req, res, 200, await uploadInfo(up))
    // finished: the link itself
    const share = await loadShare(id, true)
    if (share.manifest && String(share.manifest.owner?.user ?? '').toLowerCase() === pass.user) return sendStaff(req, res, 200, { id, state: 'done', expiresAt: share.manifest.expiresAt, createdAt: share.manifest.createdAt })
    sendStaff(req, res, 404, { error: 'not_found' })
  }

  async function staffCancel(req, res, pass, id) {
    const up = await loadUpload(id)
    if (!up || up.owner.user !== pass.user) return sendStaff(req, res, 404, { error: 'not_found' })
    const mem = uploadsMem.get(id)
    if (mem?.finishing) return sendStaff(req, res, 409, { error: 'finishing' })
    for (const r of mem?.reqs ?? []) r.destroy()
    for (let i = 0; mem?.busy.size && i < 50; i++) await new Promise((r) => setTimeout(r, 40))
    await fsp.rm(path.join(up.dir, 'creating.json'), { force: true }).catch(() => {})
    await fsp.rm(up.dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
    uploadsMem.delete(id)
    log.info('staff-upload-cancelled', { id: id.slice(0, 6) })
    sendStaff(req, res, 200, { ok: true })
  }

  async function finishJob(up) {
    const s = up.staff
    const have = await partsOf(up)
    if (have.length !== up.chunks) throw Object.assign(new Error('incomplete'), { status: 409, error: 'incomplete', missing: up.chunks - have.length })
    const data = path.join(up.dir, 'data', '0')
    const st = await fsp.stat(data)
    if (st.size !== s.size) throw Object.assign(new Error('size'), { status: 409, error: 'incomplete' })
    const ext = /\.([A-Za-z0-9]{1,4})$/.exec(s.name)[1].toLowerCase()
    const head = Buffer.alloc(16)
    const fh = await fsp.open(data, 'r')
    try {
      await fh.read(head, 0, 16, 0)
    } finally {
      await fh.close()
    }
    if (archiveKind(head) !== ext) {
      // not what its name says: nothing a client should be sent, so it goes now
      await fsp.rm(path.join(up.dir, 'creating.json'), { force: true }).catch(() => {})
      await fsp.rm(up.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {})
      log.warn('staff-upload-wrong-content', { id: up.id.slice(0, 6), ext })
      throw Object.assign(new Error('content'), { status: 422, error: 'wrong_content', extension: ext })
    }
    const hash = crypto.createHash('sha256')
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(data, { highWaterMark: 1 << 20 })
      rs.on('data', (c) => hash.update(c))
      rs.on('end', resolve)
      rs.on('error', reject)
    })
    const createdAt = now()
    const manifest = {
      v: 1,
      id: up.id,
      title: s.title || s.name,
      message: s.message ?? '',
      sender: s.sender || up.owner.user,
      createdAt,
      expiresAt: createdAt + s.days * DAY,
      files: [{ name: s.name, size: s.size, sha256: hash.digest('hex') }],
      password: s.password ?? null,
      maxDownloads: 0,
      owner: up.owner
    }
    if (!validateManifest(manifest, up.id)) throw Object.assign(new Error('manifest'), { status: 500, error: 'server' })
    await fsp.rm(path.join(up.dir, 'parts'), { recursive: true, force: true })
    await writeAtomic(path.join(up.dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    await fsp.rm(path.join(up.dir, 'creating.json'), { force: true })
    manifests.delete(up.id)
    log.info('staff-link-created', { id: up.id.slice(0, 6), pass: s.pass.slice(0, 6), size: s.size })
    return { id: up.id, createdAt, expiresAt: manifest.expiresAt }
  }

  async function staffFinish(req, res, pass, id) {
    await readBody(req, 1024).catch(() => null)
    const mem = uploadsMem.get(id)
    if (!mem?.finishing && !mem?.result) {
      const up = await loadUpload(id)
      if (!up || up.owner.user !== pass.user) {
        // asked again after it finished (e.g. the answer was lost on the way): report the link
        const share = await loadShare(id, true)
        if (share.manifest && String(share.manifest.owner?.user ?? '').toLowerCase() === pass.user) return sendStaff(req, res, 200, { id, createdAt: share.manifest.createdAt, expiresAt: share.manifest.expiresAt })
        return sendStaff(req, res, 404, { error: 'not_found' })
      }
      if (mem?.busy.size) return sendStaff(req, res, 409, { error: 'busy' })
      const m = memOf(id)
      m.finishing = finishJob(up).then(
        (r) => {
          m.result = r
          m.finishing = null
          setTimeout(() => uploadsMem.get(id) === m && uploadsMem.delete(id), 10 * 60_000).unref?.()
          return r
        },
        (e) => {
          m.finishing = null
          if (e.status === 422) uploadsMem.delete(id)
          throw e
        }
      )
      m.finishing.catch(() => {})
    } else {
      const up = (await loadUpload(id)) ?? (await loadShare(id, true)).manifest
      if (!up || String(up.owner?.user ?? '').toLowerCase() !== pass.user) return sendStaff(req, res, 404, { error: 'not_found' })
    }
    const m = uploadsMem.get(id)
    if (m?.result) return sendStaff(req, res, 200, m.result)
    // a big file takes a while to check; Cloudflare gives up after 100 s, so answer "still working" well before
    const wait = new Promise((r) => setTimeout(() => r('wait'), cfg.finishWaitMs ?? 20000))
    try {
      const r = await Promise.race([m.finishing, wait])
      if (r === 'wait') return sendStaff(req, res, 202, { state: 'finishing' })
      sendStaff(req, res, 200, r)
    } catch (e) {
      if (!e.status) log.error('staff-finish-failed', { id: id.slice(0, 6), code: e.code, message: String(e.message).slice(0, 120) })
      sendStaff(req, res, e.status ?? 500, { error: e.error ?? 'server', ...(e.missing ? { missing: e.missing } : {}), ...(e.extension ? { extension: e.extension } : {}) })
    }
  }

  async function readStats(id, dir) {
    const live = stats.get(id)
    if (live) return live.data
    try {
      const d = JSON.parse(await fsp.readFile(path.join(dir, 'stats.json'), 'utf8'))
      return d?.v === 1 ? d : null
    } catch {
      return null
    }
  }

  async function staffLinks(req, res, pass) {
    let entries = []
    try {
      entries = await fsp.readdir(store, { withFileTypes: true })
    } catch {
      return sendStaff(req, res, 503, { error: 'unavailable' })
    }
    const out = []
    const t = now()
    const ids = entries.filter((e) => e.isDirectory() && ID_RE.test(e.name)).map((e) => e.name)
    for (let i = 0; i < ids.length; i += 16) {
      const part = await Promise.all(
        ids.slice(i, i + 16).map(async (id) => {
          const share = await loadShare(id)
          const m = share.manifest
          if (!m || String(m.owner?.user ?? '').toLowerCase() !== pass.user) return null
          const st = await readStats(id, share.dir)
          return {
            id,
            title: m.title,
            files: m.files.map((f) => ({ name: f.name, size: f.size })),
            bytes: m.files.reduce((a, f) => a + f.size, 0),
            createdAt: m.createdAt,
            expiresAt: m.expiresAt,
            expired: m.expiresAt <= t,
            hasPassword: !!m.password,
            message: m.message ?? '',
            sender: m.sender ?? '',
            downloads: st?.downloads ?? 0,
            views: st?.views ?? 0,
            lastDownloadAt: st?.lastDownloadAt ?? 0
          }
        })
      )
      for (const l of part) if (l) out.push(l)
    }
    out.sort((a, b) => b.createdAt - a.createdAt)
    const uploads = await Promise.all((await unfinished(pass.user)).map(uploadInfo))
    sendStaff(req, res, 200, { now: t, links: out, uploads })
  }

  async function staffLinkAction(req, res, pass, id, action) {
    let body = {}
    try {
      body = await readJsonBody(req, 1024)
    } catch (e) {
      if (action === 'renew') return sendStaff(req, res, e.status, { error: 'bad_request' })
    }
    const dir = path.join(store, id)
    const file = path.join(dir, 'manifest.json')
    if (!inside(dir, store)) return sendStaff(req, res, 404, { error: 'not_found' })
    let m = null
    try {
      m = validateManifest(JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^﻿/, '')), id)
    } catch {}
    // someone else's link answers exactly like a missing one
    if (!m || String(m.owner?.user ?? '').toLowerCase() !== pass.user) return sendStaff(req, res, 404, { error: 'not_found' })
    if (action === 'revoke') {
      // the same steps as Hopper's revoke: the manifest goes first, then the folder
      try {
        await fsp.rename(file, path.join(dir, 'revoked.json'))
      } catch (e) {
        if (e.code !== 'ENOENT') await fsp.rm(file, { force: true })
      }
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {})
      manifests.delete(id)
      stats.delete(id)
      log.info('staff-link-revoked', { id: id.slice(0, 6), pass: pass.id.slice(0, 6) })
      return sendStaff(req, res, 200, { ok: true })
    }
    // renew: the same arithmetic as Hopper's extend
    const t = now()
    const add = Math.max(1, Math.min(90, Math.floor(Number(body.days) || 0)))
    m.expiresAt = Math.min(Math.max(m.expiresAt, t) + add * DAY, t + 365 * DAY)
    await writeAtomic(file, JSON.stringify(m, null, 2))
    manifests.delete(id)
    log.info('staff-link-renewed', { id: id.slice(0, 6), pass: pass.id.slice(0, 6), days: add })
    sendStaff(req, res, 200, { ok: true, expiresAt: m.expiresAt })
  }

  async function routeStaff(req, res, pathname, method, ip) {
    const origin = req.headers.origin
    const isPut = method === 'PUT'
    if (origin && !corsHeaders(req)) return send(req, res, 403, { error: 'origin' }, isPut ? { Connection: 'close' } : {})
    if (method === 'OPTIONS') return preflight(req, res, 'GET, POST, PUT, DELETE, OPTIONS', 'Authorization, Content-Type')
    if (!staff.enabled) return send(req, res, 403, { error: 'disabled' }, isPut ? { Connection: 'close' } : {})
    const lim = limiter.hit(`st:${ip}`, cfg.apiPerMinutePerIp, 60_000, now())
    if (!lim.ok) return tooMany(req, res, lim.retryAfter)
    const pass = await staffAuth(req, res, ip)
    if (!pass) return
    const allow = (list) => send(req, res, 405, { error: 'method' }, { Allow: list, ...(isPut ? { Connection: 'close' } : {}) })
    let m
    if (pathname === '/api/staff/me') return method === 'GET' ? staffMe(req, res, pass) : allow('GET, OPTIONS')
    if (pathname === '/api/staff/links') return method === 'GET' ? staffLinks(req, res, pass) : allow('GET, OPTIONS')
    if (pathname === '/api/staff/uploads') {
      if (method === 'POST') return staffCreate(req, res, pass)
      if (method === 'GET') return sendStaff(req, res, 200, { uploads: await Promise.all((await unfinished(pass.user)).map(uploadInfo)) })
      return allow('GET, POST, OPTIONS')
    }
    if ((m = ROUTE_STAFF_CHUNK.exec(pathname))) return isPut ? staffChunk(req, res, pass, m[1], Number(m[2])) : allow('PUT, OPTIONS')
    if ((m = ROUTE_STAFF_FINISH.exec(pathname))) return method === 'POST' ? staffFinish(req, res, pass, m[1]) : allow('POST, OPTIONS')
    if ((m = ROUTE_STAFF_UPLOAD.exec(pathname))) {
      if (method === 'GET') return staffStatus(req, res, pass, m[1])
      if (method === 'DELETE') return staffCancel(req, res, pass, m[1])
      return allow('GET, DELETE, OPTIONS')
    }
    if ((m = ROUTE_STAFF_LINK.exec(pathname))) return method === 'POST' ? staffLinkAction(req, res, pass, m[1], m[2]) : allow('POST, OPTIONS')
    send(req, res, 404, { error: 'not_found' }, isPut ? { Connection: 'close' } : {})
  }

  function preflight(req, res, methods, headers) {
    const cors = corsHeaders(req)
    if (!cors) return send(req, res, 403, { error: 'origin' })
    res.writeHead(204, { ...BASE_HEADERS, ...cors, 'Access-Control-Allow-Methods': methods, 'Access-Control-Allow-Headers': headers, 'Access-Control-Max-Age': '600', 'Content-Length': 0 })
    res.end()
  }

  async function route(req, res, ip) {
    const raw = req.url ?? ''
    if (raw.length > 512) return send(req, res, 414, { error: 'not_found' })
    const q = raw.indexOf('?')
    const pathname = q < 0 ? raw : raw.slice(0, q)
    const query = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1))
    const method = req.method

    if (pathname === '/healthz') {
      if (method !== 'GET' && method !== 'HEAD') return send(req, res, 405, { error: 'method' }, { Allow: 'GET, HEAD' })
      return send(req, res, storeOk ? 200 : 503, { ok: storeOk, i: instance })
    }
    if (pathname === '/robots.txt' && (method === 'GET' || method === 'HEAD')) {
      const text = 'User-agent: *\nDisallow: /\n'
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': text.length })
      return res.end(method === 'HEAD' ? undefined : text)
    }

    // Routes match the raw path against a strict pattern: anything encoded, dotted or longer is "not found".
    let m
    if ((m = ROUTE_FILE.exec(pathname))) {
      if (method === 'OPTIONS') return preflight(req, res, 'GET, HEAD, OPTIONS', 'Range, If-Range')
      if (method !== 'GET' && method !== 'HEAD') return send(req, res, 405, { error: 'method' }, { Allow: 'GET, HEAD, OPTIONS' })
      const lim = limiter.hit(`f:${ip}`, cfg.filePerMinutePerIp, 60_000, now())
      if (!lim.ok) return tooMany(req, res, lim.retryAfter)
      return handleFile(req, res, m[1], Number(m[2]), query, ip)
    }
    if (pathname.startsWith('/api/staff/')) return routeStaff(req, res, pathname, method, ip)
    const meta = ROUTE_META.exec(pathname)
    const unlock = meta ? null : ROUTE_UNLOCK.exec(pathname)
    if (!meta && !unlock) return notFound(req, res)

    // Browser calls must come from the client page; tools that send no Origin are not browsers.
    const origin = req.headers.origin
    if (origin && !corsHeaders(req)) return send(req, res, 403, { error: 'origin' })
    if (method === 'OPTIONS') return preflight(req, res, 'GET, HEAD, POST, OPTIONS', 'Content-Type')
    const lim = limiter.hit(`a:${ip}`, cfg.apiPerMinutePerIp, 60_000, now())
    if (!lim.ok) return tooMany(req, res, lim.retryAfter)
    if (meta) {
      if (method !== 'GET' && method !== 'HEAD') return send(req, res, 405, { error: 'method' }, { Allow: 'GET, HEAD, OPTIONS' })
      return handleMeta(req, res, meta[1], query)
    }
    if (method !== 'POST') return send(req, res, 405, { error: 'method' }, { Allow: 'POST, OPTIONS' })
    return handleUnlock(req, res, unlock[1], ip)
  }

  const server = http.createServer({ keepAliveTimeout: 60_000, headersTimeout: 15_000, requestTimeout: 30_000 }, (req, res) => {
    const t0 = now()
    const ip = clientIp(req)
    inflight++
    // Upload chunks may take minutes; every other request must have sent its body within bodyTimeoutSeconds.
    if (!(req.method === 'PUT' && ROUTE_STAFF_CHUNK.test((req.url ?? '').split('?')[0])) && cfg.bodyTimeoutSeconds > 0) {
      const bt = setTimeout(() => !req.complete && req.socket.destroy(), cfg.bodyTimeoutSeconds * 1000)
      res.on('close', () => clearTimeout(bt))
    }
    res.on('close', () => {
      inflight--
      const p = (req.url ?? '').split('?')[0].replace(/[a-z2-7]{26}/, (id) => id.slice(0, 6) + '~')
      if (p === '/healthz') return
      log.info('req', { ip: cfg.logClientIp ? ip : undefined, m: req.method, p: p.slice(0, 80), s: res.statusCode, ms: now() - t0, ...(res.locals ?? {}), ua: String(req.headers['user-agent'] ?? '').slice(0, 120) })
    })
    if (closing) res.setHeader('Connection', 'close')
    route(req, res, ip).catch((e) => {
      log.error('handler', { message: String(e?.message ?? e), stack: String(e?.stack ?? '').split('\n').slice(0, 4).join(' | ') })
      if (res.headersSent) res.destroy()
      else send(req, res, 500, { error: 'server' })
    })
  })
  server.timeout = 0 // downloads may run for hours; stalled ones are caught by the idle timer
  // the whole-request limit has to allow one upload chunk on a slow line; other requests keep their own (above)
  server.requestTimeout = Math.max(30_000, cfg.uploadRequestMinutes * 60_000)
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  server.on('clientError', (_e, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    else socket.destroy()
  })

  return {
    server,
    instance,
    config: cfg,
    cleanup,
    flushStats,
    /** Live numbers for the heartbeat file (never sent to clients). */
    health() {
      countToday(0, false)
      // staffUsed: when each browser pass was last used (pass ids are not secrets), so Hopper can show it
      const staffUsed = Object.fromEntries([...used].sort((a, b) => b[1] - a[1]).slice(0, 300))
      return { uptimeSec: Math.round((Date.now() - startedAt) / 1000), activeDownloads: active.size, bytesToday: today.bytes, downloadsToday: today.downloads, freeBytes: free?.free ?? null, totalBytes: free?.total ?? null, limitMbps: Math.round((currentLimit(bandwidth) * 8) / 10000) / 100, staffUsed }
    },
    setBandwidth(b) {
      bandwidth = b
    },
    /** Browser link settings (office.json publicShare.web) without a restart. */
    setStaff(s, minFreeGB = cfg.minFreeGB) {
      staff = staffSettings(s, minFreeGB)
    },
    get staff() {
      return staff
    },
    get activeDownloads() {
      return active.size
    },
    async listen() {
      await fsp.mkdir(cfg.stateDir, { recursive: true }).catch(() => {})
      secret = hooks.secret ?? loadSecret()
      loadUsed()
      const st = await fsp.stat(store).catch(() => null)
      if (!st?.isDirectory()) throw new Error(`store folder not found: ${store}`)
      // Loopback only, always: nothing on the LAN or the internet can connect to this port directly.
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(cfg.port, '127.0.0.1', resolve)
      })
      timers.push(setInterval(() => void flushStats(), cfg.statsFlushMs ?? 5000))
      timers.push(setInterval(() => void flushUsed(), cfg.statsFlushMs ?? 5000))
      timers.push(setInterval(() => void cleanup(), cfg.cleanupMinutes * 60_000))
      timers.push(setInterval(() => fsp.access(store).then(() => (storeOk = true), () => (storeOk = false)), 30_000))
      timers.push(setInterval(() => void refreshFree(), 60_000))
      void refreshFree()
      for (const t of timers) t.unref()
      void cleanup()
      log.info('listening', { port: server.address().port, store: path.basename(store) })
      return server.address().port
    },
    async close(graceMs = cfg.shutdownGraceSeconds * 1000) {
      closing = true
      for (const t of timers) clearInterval(t)
      const closed = new Promise((r) => server.close(r))
      server.closeIdleConnections?.()
      const deadline = Date.now() + graceMs
      // requests already accepted (including downloads in flight) get the grace period to finish
      while ((active.size || inflight) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
      for (const s of sockets) s.destroy()
      await closed
      await flushStats()
      await flushUsed()
      log.info('stopped', {})
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Entry point

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const file = process.env.DXSHARE_CONFIG || path.join(here, 'config.json')
  let cfg
  try {
    cfg = loadConfig(file)
  } catch (e) {
    console.error(`Dexterity Share: ${e.message} (${file})`)
    process.exit(2)
  }
  const app = createShareServer(cfg)
  let stopping = false
  const stop = async (why) => {
    if (stopping) return
    stopping = true
    console.log(`Dexterity Share: stopping (${why})`)
    await app.close().catch(() => {})
    process.exit(0)
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => void stop(sig))
  process.on('message', (m) => m === 'shutdown' && void stop('supervisor'))
  process.on('uncaughtException', (e) => console.error('Dexterity Share: uncaught', e))
  process.on('unhandledRejection', (e) => console.error('Dexterity Share: unhandled', e))
  // If the supervisor dies without a word, do not linger holding the port.
  const parent = Number(process.env.DXSHARE_PARENT_PID)
  if (parent) {
    setInterval(() => {
      try {
        process.kill(parent, 0)
      } catch {
        void stop('supervisor gone')
      }
    }, 5000).unref()
  }
  try {
    const port = await app.listen()
    console.log(`Dexterity Share: listening on http://127.0.0.1:${port}`)
    if (process.send) setInterval(() => process.connected && process.send({ type: 'health', health: app.health() }), 20_000).unref()
  } catch (e) {
    console.error(`Dexterity Share: cannot start: ${e.message}`)
    process.exit(e.code === 'EADDRINUSE' ? 3 : 2)
  }
}

// Compared through realpath: on a mapped network drive Node reports the module under its UNC name.
function isMain() {
  try {
    if (path.basename(process.argv[1] ?? '') !== 'server.mjs') return false // bundled into Hopper: never self-start
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}
if (isMain()) void main()
