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
  bandwidth: { mbps: 0, officeMbps: 0, officeDays: [1, 2, 3, 4, 5, 6], officeFrom: '09:00', officeTo: '19:00' }
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
      return { uptimeSec: Math.round((Date.now() - startedAt) / 1000), activeDownloads: active.size, bytesToday: today.bytes, downloadsToday: today.downloads, freeBytes: free?.free ?? null, totalBytes: free?.total ?? null, limitMbps: Math.round((currentLimit(bandwidth) * 8) / 10000) / 100 }
    },
    setBandwidth(b) {
      bandwidth = b
    },
    get activeDownloads() {
      return active.size
    },
    async listen() {
      await fsp.mkdir(cfg.stateDir, { recursive: true }).catch(() => {})
      secret = hooks.secret ?? loadSecret()
      const st = await fsp.stat(store).catch(() => null)
      if (!st?.isDirectory()) throw new Error(`store folder not found: ${store}`)
      // Loopback only, always: nothing on the LAN or the internet can connect to this port directly.
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(cfg.port, '127.0.0.1', resolve)
      })
      timers.push(setInterval(() => void flushStats(), cfg.statsFlushMs ?? 5000))
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
