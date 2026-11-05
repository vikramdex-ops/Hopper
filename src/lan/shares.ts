// Outgoing shares: expand recipients, optionally zip first, then per recipient try the direct
// transfer and fall back to the server inbox; notify each recipient through the Cliq bot.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import type { ShareSpec } from '@shared/types'
import { postCliq, shareText } from './cliq'
import type { Discovery } from './discovery'
import { sanitizeName, stamp } from './protocol'
import { dropToServer } from './server-inbox'
import { Declined, Fatal, sendDirect } from './transfer-client'
import type { FileItem, LanCtx, OutgoingShare, RecipientState, ShareEvent, ShareState } from './types'
import { pool, rateMeter, walk } from './util'

const RECIPIENTS_AT_ONCE = 3
const EMIT_MS = 250
const KEEP_SHARES = 50

interface Live extends OutgoingShare {
  ac: AbortController
  spec: ShareSpec
  last: Map<string, number>
}

const FINAL: ShareState[] = ['done', 'failed', 'cancelled']

export class Shares {
  private shares = new Map<string, Live>()

  constructor(
    private ctx: LanCtx,
    private discovery: Discovery
  ) {}

  send(spec: ShareSpec): string {
    if (!this.ctx.key) throw new Error('LAN sharing needs the office key (Settings > Office)')
    if (!spec || !Array.isArray(spec.paths) || !spec.paths.length) throw new Error('nothing to share')
    const to = this.expand(Array.isArray(spec.to) ? spec.to : [])
    if (!to.length) throw new Error('no recipients')
    const shareId = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
    const share: Live = {
      shareId,
      to,
      paths: [...spec.paths],
      message: spec.message,
      zipFirst: !!spec.zipFirst,
      createdAt: Date.now(),
      files: 0,
      bytes: 0,
      recipients: to.map((user) => ({ user, state: spec.zipFirst ? 'zipping' : 'connecting', done: 0, total: 0, rate: 0, via: null })),
      ac: new AbortController(),
      spec,
      last: new Map()
    }
    this.shares.set(shareId, share)
    this.prune()
    for (const r of share.recipients) this.emit(share, r, true)
    void this.run(share)
    return shareId
  }

  cancel(shareId: string) {
    const s = this.shares.get(shareId)
    if (!s || s.recipients.every((r) => FINAL.includes(r.state))) return false
    s.ac.abort(new Error('cancelled'))
    for (const r of s.recipients) if (!FINAL.includes(r.state)) this.set(s, r, 'cancelled')
    return true
  }

  cancelAll() {
    for (const id of this.shares.keys()) this.cancel(id)
  }

  list(): OutgoingShare[] {
    return [...this.shares.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ ac, spec, last, ...pub }) => ({ ...pub, recipients: pub.recipients.map((r) => ({ ...r })) }))
  }

  /** "group:<id>" -> members; lower-case, de-duplicated; a group never includes the sender. */
  private expand(to: string[]) {
    const out = new Set<string>()
    const me = this.ctx.me.user
    for (const t of to) {
      if (typeof t !== 'string') continue
      if (t.startsWith('group:')) {
        const g = this.ctx.office?.groups?.find((x) => x.id === t.slice(6))
        if (!g) throw new Error(`unknown group ${t.slice(6)}`)
        for (const m of g.members) if (m.toLowerCase() !== me) out.add(m.toLowerCase())
      } else if (t.trim()) out.add(t.trim().toLowerCase())
    }
    return [...out]
  }

  private async run(s: Live) {
    const signal = s.ac.signal
    let zipDir = ''
    try {
      const walked = await walk(s.paths)
      for (const e of walked.errors) this.ctx.log('share', s.shareId, e)
      if (!walked.files.length && !walked.dirs.length) throw new Error('nothing readable to send')
      s.files = walked.files.length
      s.bytes = walked.files.reduce((a, f) => a + f.size, 0)
      let items = walked.files
      let dirs = walked.dirs
      if (s.zipFirst) {
        zipDir = join(this.ctx.dataDir, 'outbox', s.shareId)
        const zip = await this.zip(s, zipDir, signal)
        items = [zip]
        dirs = []
      }
      const total = items.reduce((a, f) => a + f.size, 0)
      for (const r of s.recipients) r.total = total
      await pool(s.recipients, RECIPIENTS_AT_ONCE, (r) => this.deliver(s, r, items, dirs))
    } catch (e: any) {
      for (const r of s.recipients) {
        if (!FINAL.includes(r.state)) this.set(s, r, signal.aborted ? 'cancelled' : 'failed', { error: e?.message ?? String(e) })
      }
    } finally {
      if (zipDir) await fsp.rm(zipDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    }
  }

  private async deliver(s: Live, r: RecipientState, items: FileItem[], dirs: string[]) {
    const signal = s.ac.signal
    if (signal.aborted || FINAL.includes(r.state)) return
    const meter = rateMeter()
    const progress = (done: number) => {
      r.done = Math.min(done, r.total)
      r.rate = meter(r.done)
      this.emit(s, r)
    }
    let via: 'direct' | 'server' | null = null
    let folderNote = ''
    const peer = this.discovery.find(r.user)
    if (peer) {
      try {
        await sendDirect(this.ctx, {
          shareId: s.shareId,
          items,
          dirs,
          message: s.message ?? '',
          peer: () => this.discovery.find(r.user),
          signal,
          onState: (st) => this.set(s, r, st, { via: 'direct' }),
          onProgress: progress
        })
        via = 'direct'
      } catch (e: any) {
        if (signal.aborted) return this.set(s, r, 'cancelled')
        if (e instanceof Declined || e instanceof Fatal) return this.set(s, r, 'failed', { error: e.message, via: 'direct' })
        folderNote = e?.message ?? String(e)
        this.ctx.log('share', s.shareId, `direct to ${r.user} failed (${folderNote}); using the server inbox`)
      }
    } else if (r.user === this.ctx.me.user) {
      return this.set(s, r, 'failed', { error: 'you cannot share with yourself on this PC' })
    }
    if (!via) {
      if (!this.ctx.office?.serverInbox) {
        return this.set(s, r, 'failed', { error: folderNote || 'recipient is offline and no server inbox is configured' })
      }
      r.done = 0
      this.set(s, r, 'server', { via: 'server' })
      try {
        await dropToServer(this.ctx, { shareId: s.shareId, to: r.user, items, dirs, message: s.message ?? '', signal, onProgress: progress })
        via = 'server'
      } catch (e: any) {
        if (signal.aborted) return this.set(s, r, 'cancelled')
        return this.set(s, r, 'failed', { error: `server inbox: ${e?.message ?? e}`, via: 'server' })
      }
    }
    r.done = r.total
    this.set(s, r, 'done', { via })
    if (s.spec.notifyCliq !== false) void this.notify(s, r.user, via)
  }

  private async notify(s: Live, user: string, via: 'direct' | 'server') {
    const cliq = this.ctx.office?.cliq
    if (!cliq?.enabled) return
    const email = this.discovery.emailFor(user)
    if (!email) return this.ctx.log('cliq', `no Zoho email known for ${user}; notice skipped`)
    const text = shareText({ fromName: this.ctx.me.displayName, files: s.files, bytes: s.bytes, message: s.message ?? '', zipped: s.zipFirst, via })
    const res = await postCliq(cliq, [email], text)
    this.ctx.log('cliq', res.ok ? `notified ${user} (HTTP ${res.status})` : `notice to ${user} failed: ${res.status ? `HTTP ${res.status} ` : ''}${res.error ?? ''}`)
  }

  /** 7-Zip into HOPPER_DATA\outbox\<shareId>\<name>.zip, reporting -bsp1 percentages. */
  private async zip(s: Live, dir: string, signal: AbortSignal): Promise<FileItem> {
    await fsp.mkdir(dir, { recursive: true })
    const name =
      s.paths.length === 1 ? sanitizeName(basename(s.paths[0]).replace(/\.[^.\\/]+$/, '') || 'share', 'share') : `Hopper share ${stamp()}`
    const out = join(dir, `${name}.zip`)
    await fsp.rm(out, { force: true })
    const total = s.bytes
    for (const r of s.recipients) r.total = total
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.ctx.sevenZip, ['a', '-tzip', '-mx=1', '-mmt=on', '-bsp1', '-y', out, '--', ...s.paths], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let errTail = ''
      const onAbort = () => child.kill()
      signal.addEventListener('abort', onAbort, { once: true })
      child.stdout.setEncoding('utf8').on('data', (t: string) => {
        const all = [...t.matchAll(/(\d{1,3})%/g)]
        if (!all.length) return
        const pct = Math.min(100, Number(all[all.length - 1][1]))
        for (const r of s.recipients) {
          r.done = Math.round((total * pct) / 100)
          this.emit(s, r)
        }
      })
      child.stderr.setEncoding('utf8').on('data', (t: string) => (errTail = (errTail + t).slice(-400)))
      child.on('error', (e) => reject(new Error(`7-Zip could not start: ${e.message}`)))
      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) reject(new Error('cancelled'))
        // 1 = warnings (e.g. a locked file was skipped): an incomplete zip is a failure, not a success
        else if (code === 0) resolve()
        else reject(new Error(`7-Zip exited with ${code}${errTail.trim() ? `: ${errTail.trim()}` : ''}`))
      })
    })
    const st = await fsp.stat(out)
    for (const r of s.recipients) {
      r.done = 0
      r.total = st.size
    }
    return { rel: basename(out), abs: out, size: st.size, mtime: st.mtimeMs }
  }

  private set(s: Live, r: RecipientState, state: ShareState, extra: Partial<RecipientState> = {}) {
    if (FINAL.includes(r.state) && r.state !== state) return
    r.state = state
    Object.assign(r, extra)
    if (FINAL.includes(state)) {
      r.endedAt = Date.now()
      r.rate = 0
    }
    this.emit(s, r, true)
  }

  private emit(s: Live, r: RecipientState, force = false) {
    const now = Date.now()
    if (!force && now - (s.last.get(r.user) ?? 0) < EMIT_MS) return
    s.last.set(r.user, now)
    const ev: ShareEvent = { shareId: s.shareId, to: r.user, state: r.state, done: r.done, total: r.total, rate: r.rate, via: r.via, ...(r.error ? { error: r.error } : {}) }
    this.ctx.emit('share', ev)
  }

  private prune() {
    const done = [...this.shares.values()]
      .filter((s) => s.recipients.every((r) => FINAL.includes(r.state)))
      .sort((a, b) => a.createdAt - b.createdAt)
    while (this.shares.size > KEEP_SHARES && done.length) this.shares.delete(done.shift()!.shareId)
  }
}
