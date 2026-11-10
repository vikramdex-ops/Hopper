// Offline fallback through the office server: senders drop files into
// <serverInbox>\<user>\<shareId> from <sender>\ with manifest.json written last; each recipient
// scans its own folder at start and every 60 s and moves complete drops into the local Inbox.
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { InboxItem, ShareKind, ShareLink } from '@shared/types'
import { MAX_MESSAGE, parseKind, parseLink, replyId, safeRel, sanitizeName, stamp } from './protocol'
import type { Admit, FileItem, LanCtx, Manifest, OnReceived } from './types'
import { copyWithHash, freeName, makeFreshDir, readJson, sleep, writeJsonAtomic } from './util'

const SCAN_MS = 60_000
const COPY_RETRY_MS = [2_000, 5_000, 10_000]

export interface DropJob {
  shareId: string
  to: string
  items: FileItem[]
  dirs: string[]
  message: string
  kind?: ShareKind
  link?: ShareLink
  replyTo?: string
  signal: AbortSignal
  onProgress: (done: number) => void
}

/** Copy a share into the recipient's server folder. Returns the drop folder. */
export async function dropToServer(ctx: LanCtx, job: DropJob) {
  const root = ctx.office?.serverInbox
  if (!root) throw new Error('no server inbox configured')
  const folder = join(root, sanitizeName(job.to), `${job.shareId} from ${sanitizeName(ctx.me.user)}`)
  await fsp.mkdir(folder, { recursive: true })
  let done = 0
  const files: Manifest['files'] = []
  try {
    for (const item of job.items) {
      const rel = safeRel(item.rel)
      if (!rel) throw new Error(`unsafe name ${item.rel}`)
      const base = done
      let sha = ''
      for (let attempt = 0; ; attempt++) {
        done = base
        try {
          sha = await copyWithHash(item.abs, join(folder, rel), (n) => job.onProgress((done += n)), job.signal)
          break
        } catch (e: any) {
          if (job.signal.aborted || attempt >= COPY_RETRY_MS.length || e.code === 'ENOENT') throw e
          ctx.log('server drop', item.rel, e.code ?? e.message, 'retrying')
          await sleep(COPY_RETRY_MS[attempt], job.signal)
        }
      }
      files.push({ path: item.rel, size: item.size, mtime: item.mtime, sha256: sha })
    }
    for (const d of job.dirs) {
      const rel = safeRel(d)
      if (rel) await fsp.mkdir(join(folder, rel), { recursive: true })
    }
    const manifest: Manifest = {
      v: 1,
      shareId: job.shareId,
      from: ctx.me.user,
      fromName: ctx.me.displayName,
      at: Date.now(),
      message: job.message,
      files,
      dirs: job.dirs,
      ...(job.kind && job.kind !== 'files' ? { kind: job.kind } : {}),
      ...(job.link ? { link: job.link } : {}),
      ...(job.replyTo ? { replyTo: job.replyTo } : {})
    }
    await writeJsonAtomic(join(folder, 'manifest.json'), manifest)
    return folder
  } catch (e) {
    await fsp.rm(folder, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    throw e
  }
}

/** Picks up drops addressed to this user. */
export class ServerPickup {
  private timer: NodeJS.Timeout | null = null
  private scanning = false
  private failures = new Map<string, number>()
  private skipped = new Set<string>()

  constructor(
    private ctx: LanCtx,
    private admit: Admit,
    private onReceived: OnReceived,
    /** true when this share id is already in the local Inbox (server folder could not be removed last time) */
    private already: (shareId: string) => boolean
  ) {}

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.scan(), SCAN_MS)
    this.timer.unref()
    void this.scan()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async scan() {
    const root = this.ctx.office?.serverInbox
    if (this.scanning || !root || !this.ctx.me.user) return
    this.scanning = true
    try {
      const mine = join(root, sanitizeName(this.ctx.me.user))
      let names: string[]
      try {
        names = await fsp.readdir(mine)
      } catch {
        return
      }
      for (const name of names) {
        if (!this.timer) break
        const dir = join(mine, name)
        if ((this.failures.get(dir) ?? 0) >= 3 || this.skipped.has(dir)) continue
        const m = await readJson<Manifest | null>(join(dir, 'manifest.json'), null)
        if (!m || !Array.isArray(m.files)) continue // still being written, or not ours
        if (m.shareId && this.already(String(m.shareId))) {
          await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
          continue
        }
        try {
          await this.pickup(dir, m)
        } catch (e: any) {
          const n = (this.failures.get(dir) ?? 0) + 1
          this.failures.set(dir, n)
          this.ctx.log('server pickup', name, e?.message ?? e, n >= 3 ? '(giving up until restart)' : '')
        }
      }
    } finally {
      this.scanning = false
    }
  }

  private async pickup(dir: string, m: Manifest) {
    const from = String(m.from ?? '').toLowerCase()
    const fromName = String(m.fromName || from)
    const bytes = m.files.reduce((a, f) => a + (Number(f.size) || 0), 0)
    const kind = parseKind(m.kind)
    if (!kind) throw new Error(`unknown kind ${String(m.kind)}`)
    const message = String(m.message ?? '').slice(0, MAX_MESSAGE)
    const verdict = await this.admit({ from, fromName, files: m.files.length, bytes, message, via: 'server', kind })
    if (verdict === 'blocked') {
      this.skipped.add(dir)
      this.ctx.log('server pickup', `left a drop from blocked user ${from} on the server`)
      return
    }
    if (verdict !== true) {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 })
      return
    }
    const at = Number(m.at) || Date.now()
    if (kind !== 'files') {
      // a message, folder link or request: the manifest is the whole share
      const link = kind === 'link' ? parseLink(m.link) : null
      if ((kind === 'link' && !link) || (kind !== 'link' && !message.trim()) || m.files.length) throw new Error('bad manifest')
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch((e) => this.ctx.log('server pickup', 'could not remove', dir, e?.message))
      this.onReceived({
        id: String(m.shareId || dir),
        from,
        fromName,
        at,
        message: message || undefined,
        folder: '',
        files: 0,
        bytes: 0,
        via: 'server',
        kind,
        ...(link ? { link } : {}),
        ...(replyId(m.replyTo) ? { replyTo: replyId(m.replyTo) } : {})
      })
      return
    }
    const local = await makeFreshDir(join(this.ctx.inboxRoot(), `${stamp(new Date(at))} from ${sanitizeName(fromName)}`))
    try {
      for (const f of m.files) {
        const rel = safeRel(f.path)
        if (!rel || !/^[0-9a-f]{64}$/.test(String(f.sha256))) throw new Error(`bad manifest entry ${f.path}`)
        const part = join(local, rel + '.hopper-part')
        const sha = await copyWithHash(join(dir, rel), part, () => {})
        if (sha !== f.sha256) throw new Error(`${f.path} does not match its manifest checksum`)
        const t = new Date(Number(f.mtime) || at)
        await fsp.utimes(part, t, t).catch(() => {})
        await fsp.rename(part, await freeName(join(local, rel)))
      }
      for (const d of Array.isArray(m.dirs) ? m.dirs : []) {
        const rel = safeRel(d)
        if (rel) await fsp.mkdir(join(local, rel), { recursive: true })
      }
    } catch (e) {
      await fsp.rm(local, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
      throw e
    }
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch((e) => this.ctx.log('server pickup', 'could not remove', dir, e?.message))
    const item: InboxItem = {
      id: String(m.shareId || dir),
      from,
      fromName,
      at,
      message: m.message || undefined,
      folder: local,
      files: m.files.length,
      bytes,
      via: 'server',
      kind: 'files',
      ...(replyId(m.replyTo) ? { replyTo: replyId(m.replyTo) } : {})
    }
    this.onReceived(item)

  }
}
