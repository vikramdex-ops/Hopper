// Sending side of direct transfer: one control connection plus up to 4 data connections that pull
// ranges from a shared queue. Retries with back-off and resumes from the receiver's offsets.
import { createHash, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { connect, type TLSSocket } from 'node:tls'
import type { Peer } from '@shared/types'
import { FrameConn, MAX_STREAMS, PROTOCOL_VERSION, PSK_CIPHERS, pskFor, splitRanges } from './protocol'
import type { FileItem, LanCtx } from './types'
import { CHUNK, hashFile, sleep } from './util'

const CONNECT_MS = 8_000
const FRAME_MS = 90_000 // covers the receiver's 30 s 'wait' pings while a person decides
const DATA_MS = 60_000
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000]

/** The recipient (or their settings) said no; never fall back to the server for this. */
export class Declined extends Error {
  constructor(public reason: string) {
    super(
      reason === 'blocked' ? 'recipient has blocked you' : reason === 'declined' || reason === 'timeout' ? 'recipient declined' : reason === 'no-space' ? 'recipient is out of disk space' : `refused (${reason})`
    )
  }
}

/** Not worth retrying (file changed, verification failed twice, protocol mismatch). */
export class Fatal extends Error {}

export interface DirectJob {
  shareId: string
  items: FileItem[]
  dirs: string[]
  message: string
  /** looked up again before each attempt: the peer may have changed address */
  peer: () => Peer | undefined
  signal: AbortSignal
  onState: (state: 'connecting' | 'sending') => void
  onProgress: (done: number) => void
}

interface Work {
  file: number
  start: number
  end: number
}

export async function sendDirect(ctx: LanCtx, job: DirectJob): Promise<string> {
  const hashes = new Map<number, string>()
  const verified = new Set<number>()
  const bad = new Map<number, number>()
  const progress = new Map<string, number>()
  let sent = 0
  const setProgress = (key: string, v: number) => {
    sent += v - (progress.get(key) ?? 0)
    progress.set(key, v)
    job.onProgress(sent)
  }

  let attempt = 0
  let bestSent = 0
  for (;;) {
    job.onState('connecting')
    try {
      return await once()
    } catch (e: any) {
      if (job.signal.aborted) throw job.signal.reason ?? new Error('cancelled')
      if (e instanceof Declined || e instanceof Fatal) throw e
      if (sent > bestSent) {
        bestSent = sent
        attempt = 0
      }
      if (attempt >= RETRY_MS.length) throw new Error(`direct transfer failed: ${e?.message ?? e}`)
      ctx.log('share', job.shareId, `attempt failed (${e?.message ?? e}), retrying`)
      await sleep(RETRY_MS[attempt++], job.signal)
    }
  }

  async function once(): Promise<string> {
    const peer = job.peer()
    if (!peer) throw new Error('recipient went offline')
    const ac = new AbortController()
    const conns: FrameConn[] = []
    const stop = () => ac.abort()
    job.signal.addEventListener('abort', stop, { once: true })
    let control: FrameConn | null = null
    let accepted = false
    try {
      control = await open(ctx, peer, ac.signal)
      conns.push(control)
      control.send({ t: 'hello', v: PROTOCOL_VERSION, role: 'control', from: ctx.me.user, fromName: ctx.me.displayName, host: ctx.me.host, version: ctx.version })
      control.send({
        t: 'offer',
        shareId: job.shareId,
        message: job.message,
        files: job.items.map((f) => ({ path: f.rel, size: f.size, mtime: f.mtime })),
        dirs: job.dirs
      })
      let r = await control.readFrame(FRAME_MS)
      while (r?.t === 'wait') r = await control.readFrame(FRAME_MS)
      if (r?.t === 'complete') return String(r.folder ?? '')
      if (r?.t === 'decline') throw r.reason === 'bad-share' || r.reason === 'bad-offer' ? new Fatal(`receiver rejected the offer (${r.reason})`) : new Declined(String(r.reason))
      if (r?.t !== 'accept' || typeof r.token !== 'string') throw new Fatal(`unexpected reply ${r?.t}${r?.message ? `: ${r.message}` : ''}`)
      accepted = true
      const token: string = r.token
      for (const i of Array.isArray(r.verified) ? r.verified : []) markVerified(i)
      job.onState('sending')

      const queue: Work[] = []
      const hashQueue: number[] = []
      const hashQueued = new Set<number>()

      let settle!: { resolve: (folder: string) => void; reject: (e: unknown) => void }
      const outcome = new Promise<string>((resolve, reject) => (settle = { resolve, reject }))
      const fail = (e: unknown) => {
        settle.reject(e)
        ac.abort()
      }

      // control replies: per-file verification and the final 'complete'
      const ctl = control
      void (async () => {
        for (;;) {
          const f = await ctl.readFrame()
          if (f?.t === 'verified') markVerified(f.file)
          else if (f?.t === 'complete') return settle.resolve(String(f.folder ?? ''))
          else if (f?.t === 'bad' && Number.isInteger(f.file) && job.items[f.file]) {
            const n = (bad.get(f.file) ?? 0) + 1
            bad.set(f.file, n)
            if (n >= 2) throw new Fatal(`${job.items[f.file].rel} failed verification twice`)
            ctx.log('share', job.shareId, `${job.items[f.file].rel} failed verification, resending`)
            hashes.delete(f.file)
            for (const [start, end] of splitRanges(job.items[f.file].size)) {
              setProgress(`${f.file}:${start}`, 0)
              queue.push({ file: f.file, start, end })
            }
            queueHash(f.file)
            spawn()
          } else if (f?.t === 'err') throw new Fatal(`receiver error: ${f.code}`)
        }
      })().catch(fail)

      // hashing pass for files whose digest could not be taken while streaming
      let hashing = false
      function queueHash(i: number) {
        if (hashQueued.has(i) || hashes.has(i)) return
        hashQueued.add(i)
        hashQueue.push(i)
        if (!hashing) void runHasher().catch(fail)
      }
      async function runHasher() {
        hashing = true
        try {
          while (hashQueue.length) {
            const i = hashQueue.shift()!
            const sha = await hashFile(job.items[i].abs, ac.signal)
            hashes.set(i, sha)
            ctl.send({ t: 'hash', file: i, sha256: sha })
          }
        } finally {
          hashing = false
        }
      }

      let workers = 0
      function spawn() {
        while (workers < MAX_STREAMS && workers < queue.length) {
          workers++
          void worker()
            .catch(fail)
            .finally(() => workers--)
        }
      }
      async function worker() {
        const conn = await open(ctx, peer!, ac.signal)
        conns.push(conn)
        conn.send({ t: 'hello', v: PROTOCOL_VERSION, role: 'data', shareId: job.shareId, token })
        const ok = await conn.readFrame(DATA_MS)
        if (ok?.t !== 'ok') throw new Error(`data connection refused (${ok?.code ?? ok?.t})`)
        while (queue.length) {
          const w = queue.shift()!
          await sendRange(conn, w)
        }
        conn.close()
      }
      async function sendRange(conn: FrameConn, w: Work) {
        const item = job.items[w.file]
        const key = `${w.file}:${w.start}`
        conn.send({ t: 'put', file: w.file, start: w.start, end: w.end })
        const r = await conn.readFrame(DATA_MS)
        if (r?.t !== 'from' || !(r.offset >= w.start && r.offset <= w.end)) throw new Fatal(`unexpected reply ${r?.t}`)
        let done = r.offset - w.start
        setProgress(key, done)
        const single = w.start === 0 && w.end === item.size
        let hash: Hash | null = single && r.offset === 0 && !hashes.has(w.file) ? createHash('sha256') : null
        await streamRange(conn.sock as TLSSocket, item.abs, r.offset, w.end, ac.signal, (b) => {
          hash?.update(b)
          done += b.length
          setProgress(key, done)
        })
        const ack = await conn.readFrame(DATA_MS)
        if (ack?.t !== 'ack') throw new Error(`no ack for ${item.rel}`)
        if (hash) {
          const sha = hash.digest('hex')
          hash = null
          hashes.set(w.file, sha)
          ctl.send({ t: 'hash', file: w.file, sha256: sha })
        } else if (!hashes.has(w.file)) queueHash(w.file)
      }

      for (let i = 0; i < job.items.length; i++) {
        if (verified.has(i)) continue
        const ranges = splitRanges(job.items[i].size)
        for (const [start, end] of ranges) queue.push({ file: i, start, end })
        if (hashes.has(i)) ctl.send({ t: 'hash', file: i, sha256: hashes.get(i) })
        else if (ranges.length > 1) queueHash(i)
      }

      // when everything was already there, the receiver sends 'complete' right after the accept
      spawn()
      return await outcome
    } catch (e) {
      if (job.signal.aborted && accepted) control?.send({ t: 'cancel' })
      throw e
    } finally {
      job.signal.removeEventListener('abort', stop)
      ac.abort()
      // give a cancel frame a moment to leave before tearing the sockets down
      setTimeout(() => conns.forEach((c) => c.close()), job.signal.aborted ? 300 : 0).unref()
    }
  }

  function markVerified(i: unknown) {
    if (!Number.isInteger(i) || !job.items[i as number]) return
    const n = i as number
    verified.add(n)
    for (const [start, end] of splitRanges(job.items[n].size)) setProgress(`${n}:${start}`, end - start)
  }
}

function open(ctx: LanCtx, peer: Peer, signal: AbortSignal) {
  const key = ctx.key
  if (!key) return Promise.reject(new Fatal('no office key'))
  const user = ctx.me.user
  return new Promise<FrameConn>((resolve, reject) => {
    const sock = connect({
      host: peer.address,
      port: peer.port,
      ciphers: PSK_CIPHERS,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
      pskCallback: () => ({ psk: pskFor(key, user), identity: user }),
      checkServerIdentity: () => undefined
    })
    const timer = setTimeout(() => fail(new Error('connect timed out')), CONNECT_MS)
    const onAbort = () => fail(new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    function fail(e: Error) {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      sock.destroy()
      reject(e)
    }
    sock.once('error', fail)
    sock.once('secureConnect', () => {
      clearTimeout(timer)
      sock.removeListener('error', fail)
      sock.on('error', () => {})
      sock.setNoDelay(true)
      sock.setKeepAlive(true, 15_000)
      const conn = new FrameConn(sock)
      signal.addEventListener('abort', () => conn.close(), { once: true })
      resolve(conn)
    })
  })
}

async function streamRange(sock: TLSSocket, path: string, from: number, end: number, signal: AbortSignal, onChunk: (b: Buffer) => void) {
  if (from >= end) return
  let n = 0
  for await (const chunk of createReadStream(path, { start: from, end: end - 1, highWaterMark: CHUNK, signal })) {
    const b = chunk as Buffer
    n += b.length
    onChunk(b)
    if (!sock.write(b)) await drained(sock)
  }
  if (n !== end - from) throw new Fatal(`${path} changed while it was being sent`)
}

function drained(sock: TLSSocket) {
  return new Promise<void>((resolve, reject) => {
    const ok = () => (cleanup(), resolve())
    const bad = () => (cleanup(), reject(new Error('connection closed')))
    const cleanup = () => {
      sock.off('drain', ok)
      sock.off('close', bad)
      sock.off('error', bad)
    }
    if (sock.destroyed) return reject(new Error('connection closed'))
    sock.on('drain', ok)
    sock.on('close', bad)
    sock.on('error', bad)
  })
}
