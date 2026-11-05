// LAN wire protocol: signed discovery beacons, PSK derivation, and length-prefixed JSON frames
// that can be interleaved with raw byte runs on the same socket.
// Kept free of TS-only syntax (enums, parameter properties) so tests can load it with Node's
// type stripping.
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'
import type { Duplex, Writable } from 'node:stream'

export const DISCOVERY_PORT = 47820
export const TRANSFER_PORT = 47821
/** If 47821 is taken (a second Windows session on the same PC) try up to this one; the beacon carries the real port. */
export const TRANSFER_PORT_LAST = 47830
export const PROTOCOL_VERSION = 1
/** OpenSSL (plain Node) offers PSK-AES256-GCM-SHA384; Electron's BoringSSL has the ECDHE-PSK ones. Unknown names are skipped. */
export const PSK_CIPHERS = 'PSK-AES256-GCM-SHA384:ECDHE-PSK-CHACHA20-POLY1305:ECDHE-PSK-AES256-CBC-SHA:PSK-AES256-CBC-SHA'
export const MAX_FRAME = 16 * 1024 * 1024
export const MAX_BEACON = 2048
export const MAX_STREAMS = 4
/** Files at least this big are split into MAX_STREAMS ranges. */
export const SPLIT_MIN = 64 * 1024 * 1024
const RANGE_ALIGN = 1024 * 1024

export interface Beacon {
  v: 1
  id: string
  user: string
  displayName: string
  host: string
  email: string
  port: number
  version: string
  status: 'online' | 'busy' | 'away' | 'offline'
  /** sender clock, ms */
  t: number
  bye?: boolean
}

// ---------------------------------------------------------------------------
// Keys

/** The office key is hex; anything shorter than 16 bytes or not hex is rejected. */
export function officeKeyBytes(officeKey: string | undefined | null): Buffer | null {
  const hex = (officeKey ?? '').trim()
  if (hex.length < 32 || hex.length % 2 || !/^[0-9a-fA-F]+$/.test(hex)) return null
  return Buffer.from(hex, 'hex')
}

function hkdf(key: Buffer, info: string) {
  return Buffer.from(hkdfSync('sha256', key, 'hopper-lan', info, 32))
}

export const beaconKey = (key: Buffer) => hkdf(key, 'beacon-mac v1')
/** Per-identity PSK, so a session key is bound to the claimed sender name. */
export const pskFor = (key: Buffer, identity: string) => hkdf(key, `psk v1|${identity.toLowerCase()}`)

// ---------------------------------------------------------------------------
// Beacons: datagram = JSON {d: "<beacon json>", m: "<hex hmac-sha256 of d>"}

export function sealBeacon(b: Beacon, macKey: Buffer): Buffer {
  const d = JSON.stringify(b)
  const m = createHmac('sha256', macKey).update(d).digest('hex')
  return Buffer.from(JSON.stringify({ d, m }))
}

/** Returns the beacon, or null when it is malformed or the MAC does not match. */
export function openBeacon(buf: Buffer, macKey: Buffer): Beacon | null {
  if (buf.length > MAX_BEACON) return null
  let outer: any
  try {
    outer = JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
  if (!outer || typeof outer.d !== 'string' || typeof outer.m !== 'string' || !/^[0-9a-f]{64}$/.test(outer.m)) return null
  const want = createHmac('sha256', macKey).update(outer.d).digest()
  if (!timingSafeEqual(want, Buffer.from(outer.m, 'hex'))) return null
  let b: any
  try {
    b = JSON.parse(outer.d)
  } catch {
    return null
  }
  if (!b || b.v !== 1 || typeof b.id !== 'string' || typeof b.user !== 'string' || !b.user) return null
  if (!Number.isInteger(b.port) || b.port < 1 || b.port > 65535) return null
  return {
    v: 1,
    id: b.id.slice(0, 64),
    user: b.user.toLowerCase().slice(0, 64),
    displayName: String(b.displayName ?? b.user).slice(0, 80),
    host: String(b.host ?? '').slice(0, 64),
    email: String(b.email ?? '').slice(0, 120),
    port: b.port,
    version: String(b.version ?? '').slice(0, 32),
    status: ['online', 'busy', 'away', 'offline'].includes(b.status) ? b.status : 'online',
    t: Number(b.t) || 0,
    bye: b.bye === true
  }
}

// ---------------------------------------------------------------------------
// Ranges and names

/** Deterministic split shared by sender and receiver: [start, end) pairs. */
export function splitRanges(size: number): [number, number][] {
  if (size < SPLIT_MIN) return [[0, size]]
  const piece = Math.ceil(size / MAX_STREAMS / RANGE_ALIGN) * RANGE_ALIGN
  const out: [number, number][] = []
  for (let s = 0; s < size; s += piece) out.push([s, Math.min(size, s + piece)])
  return out
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i
const BAD_CHARS = /[<>:"|?*\u0000-\u001f]/

/** Validates a '/'-separated relative path from the wire; returns a Windows relative path or null. */
export function safeRel(rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel || rel.length > 1024) return null
  const parts = rel.split(/[\\/]/)
  for (const p of parts) {
    if (!p || p === '.' || p === '..' || BAD_CHARS.test(p) || RESERVED.test(p) || /[ .]$/.test(p)) return null
  }
  return parts.join('\\')
}

/** Make a display name safe for a folder name. */
export function sanitizeName(s: string, fallback = 'unknown') {
  const t = s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[ .]+$/, '').trim().slice(0, 60)
  return t || fallback
}

/** "YYYY-MM-DD HHmm" in local time. */
export function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`
}

export function formatBytes(n: number) {
  const u = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return i === 0 ? `${n} ${n === 1 ? 'byte' : 'bytes'}` : `${n >= 100 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, '')} ${u[i]}`
}

// ---------------------------------------------------------------------------
// Frames: 4-byte big-endian length + UTF-8 JSON.

export function encodeFrame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  if (body.length > MAX_FRAME) throw new Error('frame too large')
  const head = Buffer.allocUnsafe(4)
  head.writeUInt32BE(body.length, 0)
  return Buffer.concat([head, body])
}

export class ProtocolError extends Error {}

/** Error from readRaw carrying how many bytes made it into the sink. */
export class RawError extends Error {
  received: number
  constructor(message: string, received: number) {
    super(message)
    this.received = received
  }
}

const HIGH_WATER = 4 * 1024 * 1024

/**
 * Pull-based reader over a socket. Frames are parsed only when readFrame() is called, so a raw
 * byte run that follows a frame is never mistaken for one. readRaw() hands the next n bytes to a
 * Writable with backpressure (the socket is paused while the sink is full).
 */
export class FrameConn {
  sock: Duplex
  private chunks: Buffer[] = []
  private len = 0
  private waiter: { resolve: (v: any) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> } | null = null
  private raw: {
    remaining: number
    received: number
    sink: Writable
    onChunk?: (b: Buffer) => void
    resolve: (n: number) => void
    reject: (e: Error) => void
  } | null = null
  private sinkFull = false
  private closed: Error | null = null

  constructor(sock: Duplex) {
    this.sock = sock
    sock.on('data', (d: Buffer) => this.onData(d))
    sock.on('error', (e) => this.fail(e))
    sock.on('close', () => this.fail(new Error('connection closed')))
    sock.on('end', () => this.fail(new Error('connection ended')))
  }

  send(obj: unknown) {
    if (this.closed) return false
    return this.sock.write(encodeFrame(obj))
  }

  /** Next frame; rejects on close, on timeout (ms, 0 = none) or on a malformed frame. */
  readFrame<T = any>(timeoutMs = 0): Promise<T> {
    if (this.waiter || this.raw) return Promise.reject(new Error('read already pending'))
    const ready = this.tryFrame()
    if (ready !== undefined) return ready instanceof Error ? Promise.reject(ready) : Promise.resolve(ready)
    if (this.closed) return Promise.reject(this.closed)
    return new Promise<T>((resolve, reject) => {
      this.waiter = { resolve, reject }
      if (timeoutMs > 0) {
        this.waiter.timer = setTimeout(() => {
          this.waiter = null
          reject(new Error('timed out waiting for peer'))
        }, timeoutMs)
      }
      this.flow()
    })
  }

  /** Copy exactly n bytes into sink (not ended here). Resolves with n; rejects with RawError. */
  readRaw(n: number, sink: Writable, onChunk?: (b: Buffer) => void): Promise<number> {
    if (this.waiter || this.raw) return Promise.reject(new Error('read already pending'))
    if (n === 0) return Promise.resolve(0)
    if (this.closed) return Promise.reject(new RawError(this.closed.message, 0))
    return new Promise<number>((resolve, reject) => {
      this.raw = { remaining: n, received: 0, sink, onChunk, resolve, reject }
      sink.on('error', (e) => this.fail(e))
      if (this.len) {
        const buffered = Buffer.concat(this.chunks, this.len)
        this.chunks = []
        this.len = 0
        this.onData(buffered)
      }
      this.flow()
    })
  }

  close() {
    this.sock.destroy()
  }

  private onData(d: Buffer) {
    if (this.raw) {
      const r = this.raw
      const take = Math.min(r.remaining, d.length)
      const piece = take === d.length ? d : d.subarray(0, take)
      r.remaining -= take
      r.received += take
      r.onChunk?.(piece)
      if (!r.sink.write(piece) && !this.sinkFull) {
        this.sinkFull = true
        r.sink.once('drain', this.onDrain)
      }
      if (r.remaining === 0) {
        // the caller ends this sink next, and an ending Writable never emits 'drain'
        this.releaseSink(r.sink)
        this.raw = null
        r.resolve(r.received)
      }
      if (take === d.length) {
        this.flow()
        return
      }
      d = d.subarray(take)
    }
    this.chunks.push(d)
    this.len += d.length
    if (this.waiter) {
      const f = this.tryFrame()
      if (f !== undefined) {
        const w = this.waiter
        this.waiter = null
        if (w.timer) clearTimeout(w.timer)
        f instanceof Error ? w.reject(f) : w.resolve(f)
      }
    }
    this.flow()
  }

  /** Parse one frame from the buffer: value, Error for a bad frame, or undefined if incomplete. */
  private tryFrame(): any {
    if (this.len < 4) return undefined
    const head = this.chunks[0].length >= 4 ? this.chunks[0] : Buffer.concat(this.chunks, this.len)
    const n = head.readUInt32BE(0)
    if (n > MAX_FRAME) return new ProtocolError('frame too large')
    if (this.len < 4 + n) return undefined
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.len)
    const body = all.subarray(4, 4 + n)
    const rest = all.subarray(4 + n)
    this.chunks = rest.length ? [rest] : []
    this.len = rest.length
    try {
      return JSON.parse(body.toString('utf8'))
    } catch {
      return new ProtocolError('malformed frame')
    }
  }

  private onDrain = () => {
    this.sinkFull = false
    this.flow()
  }

  private releaseSink(sink: Writable) {
    sink.off('drain', this.onDrain)
    this.sinkFull = false
  }

  /** Pause the socket while nobody is reading or the sink is full. */
  private flow() {
    const want = !this.sinkFull && (this.raw !== null || this.waiter !== null || this.len < HIGH_WATER)
    if (want) this.sock.resume()
    else this.sock.pause()
  }

  private fail(e: Error) {
    if (this.closed) return
    this.closed = e
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      if (w.timer) clearTimeout(w.timer)
      w.reject(e)
    }
    if (this.raw) {
      const r = this.raw
      this.raw = null
      this.releaseSink(r.sink)
      r.reject(new RawError(e.message, r.received))
    }
  }
}
