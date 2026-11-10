// Receiving side of direct transfer: TLS-PSK server, offers, ranged writes into .hopper-part
// files, resume, SHA-256 verification and the final rename into the Inbox.
import { createHash, randomBytes, type Hash } from 'node:crypto'
import { createWriteStream, promises as fsp } from 'node:fs'
import { createServer, type Server, type TLSSocket } from 'node:tls'
import { dirname, join } from 'node:path'
import { finished } from 'node:stream/promises'
import type { InboxItem } from '@shared/types'
import {
  FrameConn,
  MAX_MESSAGE,
  parseKind,
  parseLink,
  PROTOCOL_VERSION,
  PSK_CIPHERS,
  pskFor,
  RawError,
  replyId,
  safeRel,
  sanitizeName,
  splitRanges,
  stamp,
  TRANSFER_PORT,
  TRANSFER_PORT_LAST
} from './protocol'
import type { Admit, LanCtx, OnReceived, OnSmall } from './types'
import { CHUNK, freeName, hashFile, makeFreshDir, readJson, saver, writeJsonAtomic } from './util'

const HELLO_MS = 10_000
const DATA_IDLE_MS = 120_000
const SESSION_IDLE_MS = 30 * 60_000
const PARTIAL_TTL_MS = 24 * 3600_000

interface RecvRange {
  start: number
  end: number
  /** bytes on disk from start */
  done: number
  busy?: { conn: FrameConn; settled: Promise<void> }
}

interface RecvFile {
  rel: string // Windows relative path
  size: number
  mtime: number
  ranges: RecvRange[]
  sha?: string
  /** digest computed while writing, valid only when the single range went 0..size in one run */
  streamSha?: string
  verified: boolean
  verifying: boolean
  failures: number
}

interface RecvSession {
  shareId: string
  from: string
  fromName: string
  message: string
  folder: string
  token: string
  createdAt: number
  files: RecvFile[]
  bytes: number
  replyTo?: string
  control?: FrameConn
  idleTimer?: NodeJS.Timeout
  finished: boolean
}

/** What survives a restart of the receiver (lan-partial.json). */
interface Persisted {
  shareId: string
  from: string
  fromName: string
  message: string
  folder: string
  token: string
  createdAt: number
  files: { rel: string; size: number; mtime: number; done: number[]; verified: boolean; sha?: string }[]
  replyTo?: string
}

export class TransferServer {
  private server: Server | null = null
  private sessions = new Map<string, RecvSession>()
  private completed = new Map<string, { from: string; folder: string; at: number }>()
  private identities = new WeakMap<TLSSocket, string>()
  private persisted: Record<string, Persisted> = {}
  private partialFile: string
  private partialSaver
  port = 0

  constructor(
    private ctx: LanCtx,
    private admit: Admit,
    private onReceived: OnReceived,
    private onSmall: OnSmall
  ) {
    this.partialFile = join(ctx.dataDir, 'lan-partial.json')
    this.partialSaver = saver(2000, () => writeJsonAtomic(this.partialFile, this.persisted))
  }

  async load() {
    this.persisted = await readJson<Record<string, Persisted>>(this.partialFile, {})
    const cutoff = Date.now() - PARTIAL_TTL_MS
    for (const [id, p] of Object.entries(this.persisted)) {
      if (p.createdAt < cutoff) {
        delete this.persisted[id]
        void this.discardFolder(p.folder, p.files.map((f) => f.rel))
      }
    }
    this.partialSaver.schedule()
  }

  get listening() {
    return this.server !== null
  }

  /** Listen on the first free port in 47821..47830; resolves the port or null if all are in use. */
  async listen(): Promise<number | null> {
    if (this.server) return this.port
    for (let port = TRANSFER_PORT; port <= TRANSFER_PORT_LAST; port++) {
      const srv = createServer(
        {
          ciphers: PSK_CIPHERS,
          minVersion: 'TLSv1.2',
          maxVersion: 'TLSv1.2',
          pskIdentityHint: 'hopper',
          pskCallback: (socket, identity) => {
            if (!this.ctx.key || !/^[a-z0-9._$ -]{1,64}$/i.test(identity)) return null
            this.identities.set(socket, identity.toLowerCase())
            return pskFor(this.ctx.key, identity)
          }
        },
        (sock) => void this.onConnection(sock)
      )
      srv.on('tlsClientError', () => {}) // wrong key / port scanners: nothing to do
      const ok = await new Promise<boolean>((resolve) => {
        srv.once('error', (e: any) => {
          if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') this.ctx.log('tcp listen', e.message)
          resolve(false)
        })
        srv.listen(port, '0.0.0.0', () => resolve(true))
      })
      if (ok) {
        srv.on('error', (e) => this.ctx.log('tcp error', e.message))
        this.server = srv
        this.port = port
        return port
      }
      srv.close()
    }
    return null
  }

  async close() {
    const srv = this.server
    this.server = null
    for (const s of this.sessions.values()) {
      s.control?.close()
      if (s.idleTimer) clearTimeout(s.idleTimer)
    }
    await this.partialSaver.flush()
    if (srv) await new Promise<void>((r) => srv.close(() => r()))
  }

  // -------------------------------------------------------------------------

  private async onConnection(sock: TLSSocket) {
    const identity = this.identities.get(sock)
    const conn = new FrameConn(sock)
    sock.setKeepAlive(true, 15_000)
    sock.setNoDelay(true)
    sock.on('error', () => {})
    if (!identity) return sock.destroy()
    try {
      const hello = await conn.readFrame(HELLO_MS)
      if (hello?.t !== 'hello' || hello.v !== PROTOCOL_VERSION) {
        conn.send({ t: 'err', code: 'version', message: `protocol ${PROTOCOL_VERSION} required` })
        return sock.end()
      }
      if (hello.role === 'control') await this.control(conn, identity, hello)
      else if (hello.role === 'data') await this.data(conn, identity, hello)
      else if (hello.role === 'small') await this.small(conn, identity, hello)
      else sock.destroy()
    } catch (e: any) {
      if (!/closed|ended|ECONNRESET/.test(String(e?.message))) this.ctx.log('recv', e?.message ?? e)
      sock.destroy()
    }
  }

  /** An announcement or acknowledgement: one frame in, 'ok' or 'err' out. */
  private async small(conn: FrameConn, identity: string, hello: any) {
    const frame = await conn.readFrame(HELLO_MS)
    let verdict: true | string
    try {
      verdict = this.onSmall(identity, frame, String(hello.fromName || identity).slice(0, 80))
    } catch (e: any) {
      verdict = String(e?.message ?? e)
    }
    conn.send(verdict === true ? { t: 'ok' } : { t: 'err', code: verdict })
    conn.sock.end()
  }

  /** A share with no bytes (message, folder link, request): admit, put it in the Inbox, done. */
  private async note(conn: FrameConn, identity: string, hello: any, offer: any, kind: 'message' | 'link' | 'request') {
    const shareId: string = offer.shareId
    const message = String(offer.message ?? '').slice(0, MAX_MESSAGE)
    const link = kind === 'link' ? parseLink(offer.link) : null
    if ((kind === 'link' && !link) || (kind !== 'link' && !message.trim()) || (Array.isArray(offer.files) && offer.files.length)) {
      conn.send({ t: 'decline', reason: 'bad-offer' })
      return conn.sock.end()
    }
    const fromName = String(hello.fromName || identity).slice(0, 80)
    const verdict = await this.admit({ from: identity, fromName, files: 0, bytes: 0, message, via: 'direct', kind })
    if (verdict !== true) {
      conn.send({ t: 'decline', reason: verdict })
      return conn.sock.end()
    }
    this.completed.set(shareId, { from: identity, folder: '', at: Date.now() })
    const item: InboxItem = {
      id: shareId,
      from: identity,
      fromName,
      at: Date.now(),
      message: message || undefined,
      folder: '',
      files: 0,
      bytes: 0,
      via: 'direct',
      kind,
      ...(link ? { link } : {}),
      ...(replyId(offer.replyTo) ? { replyTo: replyId(offer.replyTo) } : {})
    }
    this.onReceived(item)
    conn.send({ t: 'complete', folder: '' })
    conn.sock.end()
  }

  private async control(conn: FrameConn, identity: string, hello: any) {
    const offer = await conn.readFrame(HELLO_MS)
    if (offer?.t !== 'offer' || typeof offer.shareId !== 'string' || !/^[\w-]{6,64}$/.test(offer.shareId)) {
      conn.send({ t: 'err', code: 'bad-offer' })
      return conn.sock.end()
    }
    const shareId: string = offer.shareId
    const done = this.completed.get(shareId)
    if (done && done.from === identity) {
      conn.send({ t: 'complete', folder: done.folder })
      return conn.sock.end()
    }
    const kind = parseKind(offer.kind)
    if (!kind) {
      conn.send({ t: 'decline', reason: 'bad-offer' })
      return conn.sock.end()
    }
    if (kind !== 'files') return this.note(conn, identity, hello, offer, kind)
    let s = this.sessions.get(shareId) ?? this.restore(shareId)
    if (s && s.from !== identity) {
      conn.send({ t: 'decline', reason: 'bad-share' })
      return conn.sock.end()
    }
    if (!s) {
      const files = parseFiles(offer.files)
      const dirs = Array.isArray(offer.dirs) ? offer.dirs.map(safeRel) : []
      if (!files || dirs.includes(null)) {
        conn.send({ t: 'decline', reason: 'bad-offer' })
        return conn.sock.end()
      }
      const bytes = files.reduce((a, f) => a + f.size, 0)
      const fromName = String(hello.fromName || identity).slice(0, 80)
      const message = String(offer.message ?? '').slice(0, 2000)
      // the ask can take minutes; keep the sender informed so its read does not time out
      const ping = setInterval(() => conn.send({ t: 'wait' }), 30_000)
      let verdict: true | string
      try {
        verdict = await this.admit({ from: identity, fromName, files: files.length, bytes, message, via: 'direct' })
      } finally {
        clearInterval(ping)
      }
      if (verdict === true) verdict = await this.spaceCheck(bytes)
      if (verdict !== true) {
        conn.send({ t: 'decline', reason: verdict })
        return conn.sock.end()
      }
      const folder = await makeFreshDir(join(this.ctx.inboxRoot(), `${stamp()} from ${sanitizeName(fromName)}`))
      for (const d of dirs as string[]) await fsp.mkdir(join(folder, d), { recursive: true })
      s = {
        shareId,
        from: identity,
        fromName,
        message,
        folder,
        token: randomBytes(16).toString('hex'),
        createdAt: Date.now(),
        files: files.map((f) => ({
          ...f,
          ranges: splitRanges(f.size).map(([start, end]) => ({ start, end, done: 0 })),
          verified: false,
          verifying: false,
          failures: 0
        })),
        bytes,
        replyTo: replyId(offer.replyTo),
        finished: false
      }
      this.sessions.set(shareId, s)
      this.persist(s)
    }
    const session = s
    session.control?.close()
    session.control = conn
    if (session.idleTimer) clearTimeout(session.idleTimer)
    conn.send({
      t: 'accept',
      token: session.token,
      verified: session.files.flatMap((f, i) => (f.verified ? [i] : []))
    })
    if (session.files.every((f) => f.verified)) return this.finish(session)

    for (;;) {
      let f: any
      try {
        f = await conn.readFrame()
      } catch {
        break
      }
      if (f?.t === 'hash' && Number.isInteger(f.file) && session.files[f.file] && /^[0-9a-f]{64}$/.test(f.sha256)) {
        session.files[f.file].sha = f.sha256
        this.persist(session)
        void this.maybeVerify(session, f.file)
      } else if (f?.t === 'cancel') {
        await this.cancel(session)
        return conn.sock.end()
      }
    }
    if (session.control === conn) {
      session.control = undefined
      if (!session.finished) {
        session.idleTimer = setTimeout(() => this.sessions.delete(session.shareId), SESSION_IDLE_MS)
        session.idleTimer.unref()
      }
    }
  }

  private async data(conn: FrameConn, identity: string, hello: any) {
    const s = this.sessions.get(hello.shareId)
    if (!s || s.from !== identity || s.token !== hello.token || s.finished) {
      conn.send({ t: 'err', code: 'unknown-share' })
      return conn.sock.end()
    }
    conn.send({ t: 'ok' })
    ;(conn.sock as TLSSocket).setTimeout(DATA_IDLE_MS, () => conn.close())
    for (;;) {
      const put = await conn.readFrame()
      if (put?.t !== 'put') throw new Error('expected put')
      const file = s.files[put.file]
      const range = file?.ranges.find((r) => r.start === put.start && r.end === put.end)
      if (!file || !range || file.verified) {
        conn.send({ t: 'err', code: 'bad-range' })
        return conn.sock.end()
      }
      await this.receiveRange(s, put.file, file, range, conn)
      void this.maybeVerify(s, put.file)
    }
  }

  private async receiveRange(s: RecvSession, index: number, file: RecvFile, range: RecvRange, conn: FrameConn) {
    // a stale connection may still own this range after the sender reconnected
    if (range.busy) {
      range.busy.conn.close()
      await range.busy.settled
    }
    let release!: () => void
    range.busy = { conn, settled: new Promise<void>((r) => (release = r)) }
    try {
      const part = join(s.folder, file.rel + '.hopper-part')
      await fsp.mkdir(dirname(part), { recursive: true })
      const fh = await fsp.open(part, 'a') // create if missing, never truncate
      const onDisk = (await fh.stat()).size
      await fh.close()
      // single-range files resume from the part length even if our bookkeeping was lost
      if (file.ranges.length === 1 && range.done === 0) range.done = Math.min(onDisk, range.end)
      const offset = range.start + range.done
      conn.send({ t: 'from', offset })
      const n = range.end - offset
      let hash: Hash | null = file.ranges.length === 1 && offset === 0 ? createHash('sha256') : null
      if (n === 0) {
        if (hash) file.streamSha = hash.digest('hex')
      } else {
        const ws = createWriteStream(part, { flags: 'r+', start: offset, highWaterMark: CHUNK })
        let received = 0
        let err: unknown = null
        try {
          received = await conn.readRaw(n, ws, hash ? (b) => hash!.update(b) : undefined)
        } catch (e) {
          err = e
          received = e instanceof RawError ? e.received : 0
          hash = null
        }
        ws.end()
        await finished(ws).catch(() => {})
        range.done += received
        this.persist(s)
        if (err) throw err
        if (hash) file.streamSha = hash.digest('hex')
      }
      conn.send({ t: 'ack', file: index, start: range.start, end: range.end })
    } finally {
      range.busy = undefined
      release()
    }
  }

  private async maybeVerify(s: RecvSession, index: number) {
    const f = s.files[index]
    if (f.verified || f.verifying || !f.sha || s.finished) return
    if (!f.ranges.every((r) => r.done === r.end - r.start && !r.busy)) return
    f.verifying = true
    const part = join(s.folder, f.rel + '.hopper-part')
    try {
      const got = f.streamSha ?? (await hashFile(part))
      if (got !== f.sha) {
        f.failures++
        f.streamSha = undefined
        for (const r of f.ranges) r.done = 0
        await fsp.rm(part, { force: true })
        this.persist(s)
        s.control?.send({ t: 'bad', file: index })
        return
      }
      const t = new Date(f.mtime)
      await fsp.utimes(part, t, t).catch(() => {})
      await fsp.rename(part, await freeName(join(s.folder, f.rel)))
      f.verified = true
      this.persist(s)
      s.control?.send({ t: 'verified', file: index })
      if (s.files.every((x) => x.verified)) await this.finish(s)
    } catch (e: any) {
      this.ctx.log('verify', f.rel, e?.message ?? e)
      s.control?.send({ t: 'bad', file: index })
    } finally {
      f.verifying = false
    }
  }

  private async finish(s: RecvSession) {
    if (s.finished) return
    s.finished = true
    if (s.idleTimer) clearTimeout(s.idleTimer)
    this.sessions.delete(s.shareId)
    delete this.persisted[s.shareId]
    this.partialSaver.schedule()
    this.completed.set(s.shareId, { from: s.from, folder: s.folder, at: Date.now() })
    for (const [id, c] of this.completed) if (Date.now() - c.at > 3600_000) this.completed.delete(id)
    s.control?.send({ t: 'complete', folder: s.folder })
    const item: InboxItem = {
      id: s.shareId,
      from: s.from,
      fromName: s.fromName,
      at: Date.now(),
      message: s.message || undefined,
      folder: s.folder,
      files: s.files.length,
      bytes: s.bytes,
      via: 'direct',
      kind: 'files',
      ...(s.replyTo ? { replyTo: s.replyTo } : {})
    }
    this.onReceived(item)
  }

  private async cancel(s: RecvSession) {
    s.finished = true
    this.sessions.delete(s.shareId)
    delete this.persisted[s.shareId]
    this.partialSaver.schedule()
    for (const f of s.files) for (const r of f.ranges) r.busy?.conn.close()
    // the folder was created for this share alone; a half share with no Inbox entry only confuses
    await Promise.all(s.files.flatMap((f) => f.ranges.map((r) => r.busy?.settled)))
    await fsp.rm(s.folder, { recursive: true, force: true, maxRetries: 3 }).catch((e) => this.ctx.log('cancel cleanup', e?.message))
    this.ctx.log('share', s.shareId, 'cancelled by sender')
  }

  /** Remove part files; drop the folder only if nothing else is left in it. */
  private async discardFolder(folder: string, rels: string[]) {
    for (const rel of rels) await fsp.rm(join(folder, rel + '.hopper-part'), { force: true }).catch(() => {})
    await removeEmptyTree(folder).catch(() => {})
  }

  private async spaceCheck(bytes: number): Promise<true | string> {
    try {
      const root = this.ctx.inboxRoot()
      await fsp.mkdir(root, { recursive: true })
      const st = await fsp.statfs(root)
      return st.bavail * st.bsize > bytes + 64 * 1024 * 1024 ? true : 'no-space'
    } catch {
      return true
    }
  }

  private persist(s: RecvSession) {
    if (s.finished) return
    this.persisted[s.shareId] = {
      shareId: s.shareId,
      from: s.from,
      fromName: s.fromName,
      message: s.message,
      folder: s.folder,
      token: s.token,
      createdAt: s.createdAt,
      files: s.files.map((f) => ({ rel: f.rel, size: f.size, mtime: f.mtime, done: f.ranges.map((r) => r.done), verified: f.verified, sha: f.sha })),
      ...(s.replyTo ? { replyTo: s.replyTo } : {})
    }
    this.partialSaver.schedule()
  }

  private restore(shareId: string): RecvSession | undefined {
    const p = this.persisted[shareId]
    if (!p) return undefined
    const s: RecvSession = {
      shareId,
      from: p.from,
      fromName: p.fromName,
      message: p.message,
      folder: p.folder,
      token: p.token,
      createdAt: p.createdAt,
      bytes: p.files.reduce((a, f) => a + f.size, 0),
      replyTo: p.replyTo,
      finished: false,
      files: p.files.map((f) => ({
        rel: f.rel,
        size: f.size,
        mtime: f.mtime,
        sha: f.sha,
        verified: f.verified,
        verifying: false,
        failures: 0,
        ranges: splitRanges(f.size).map(([start, end], i) => ({ start, end, done: Math.min(f.done[i] ?? 0, end - start) }))
      }))
    }
    this.sessions.set(shareId, s)
    return s
  }
}

function parseFiles(raw: unknown) {

  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200_000) return null
  const out: { rel: string; size: number; mtime: number }[] = []
  const seen = new Set<string>()
  for (const f of raw) {
    const rel = safeRel(f?.path)
    if (!rel || !Number.isSafeInteger(f.size) || f.size < 0 || seen.has(rel.toLowerCase())) return null
    seen.add(rel.toLowerCase())
    out.push({ rel, size: f.size, mtime: Number(f.mtime) || Date.now() })
  }
  return out
}

async function removeEmptyTree(dir: string): Promise<boolean> {
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch {
    return true
  }
  let empty = true
  for (const n of names) {
    const p = join(dir, n)
    const st = await fsp.lstat(p).catch(() => null)
    if (st?.isDirectory() && !st.isSymbolicLink()) {
      if (!(await removeEmptyTree(p))) empty = false
    } else empty = false
  }
  if (empty) await fsp.rmdir(dir).catch(() => {})
  return empty
}
