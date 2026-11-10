// Office announcements. An announcer (admin, or listed in office.announcers) posts; the post is
//   1. written to <office folder>\announcements.json (atomic, newest first, capped) so PCs that
//      are off see it at their next start, and
//   2. pushed to every online PC over the TLS-PSK channel (role 'small'), retried until each one
//      answers 'ok'.
// Each PC keeps its own read/acknowledged state (HOPPER_DATA\announcements.json). An
// acknowledgement goes back to the author over the LAN and into
// <office folder>\announcement-acks\<user>.json, so the author sees it either way.
import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Announcement, AnnouncementAck, AnnouncementLevel, AnnouncementView, Peer } from '@shared/types'
import type { Discovery } from './discovery'
import { announcementLive, cleanAnnouncement, mergeAnnouncements, sanitizeName } from './protocol'
import { Fatal, sendSmall } from './transfer-client'
import type { LanCtx } from './types'
import { readJson, saver, sleep, writeJsonAtomic } from './util'

const CAP = 200
const SYNC_MS = 60_000
const PUSH_RETRY_MS = [1_000, 3_000, 8_000, 20_000]

interface Seen {
  read?: boolean
  ackedAt?: number
  /** the acknowledgement reached the office folder */
  filed?: boolean
}

interface Local {
  seen: Record<string, Seen>
  /** everything this PC has heard, so it still shows when the office folder is unreachable */
  cache: Announcement[]
}

interface AckFile {
  user: string
  name: string
  acks: Record<string, number>
}

export interface AnnouncementDraft {
  title: string
  body?: string
  level?: AnnouncementLevel
  path?: string
  expires?: number
}

export class Announcements {
  private local: Local = { seen: {}, cache: [] }
  private file: string
  private save
  /** announcement id -> user -> ack, for what this user posted (or all, for announcers) */
  private acks = new Map<string, Map<string, AnnouncementAck>>()
  private timer: NodeJS.Timeout | null = null
  private syncing: Promise<void> | null = null
  private ac = new AbortController()

  constructor(
    private ctx: LanCtx,
    private discovery: Discovery
  ) {
    this.file = join(ctx.dataDir, 'announcements.json')
    this.save = saver(500, () => writeJsonAtomic(this.file, this.local))
  }

  async load() {
    const raw = await readJson<Partial<Local>>(this.file, {})
    const cache = (Array.isArray(raw.cache) ? raw.cache : []).map(cleanAnnouncement).filter((a): a is Announcement => !!a)
    this.local = { seen: raw.seen && typeof raw.seen === 'object' ? raw.seen : {}, cache: mergeAnnouncements([cache], CAP) }
  }

  flush() {
    return this.save.flush()
  }

  /** Read the office folder now and every minute. Works without the LAN (it is only a file). */
  start() {
    if (this.timer) return
    this.ac = new AbortController()
    this.timer = setInterval(() => void this.sync(), SYNC_MS)
    this.timer.unref()
    void this.sync()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.ac.abort()
  }

  canPost() {
    const o = this.ctx.office
    const me = this.ctx.me.user
    return !!me && [...(o?.admins ?? []), ...(o?.announcers ?? [])].some((u) => String(u).toLowerCase() === me)
  }

  list(): AnnouncementView[] {
    const mine = this.canPost()
    return this.local.cache.map((a) => this.view(a, mine))
  }

  /** Post a new announcement. Resolves once it is stored; delivery to online PCs continues behind. */
  async post(draft: AnnouncementDraft): Promise<AnnouncementView> {
    if (!this.canPost()) throw new Error('Only office admins and announcers can post announcements')
    const a = cleanAnnouncement({
      id: `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
      title: draft?.title,
      body: draft?.body,
      level: draft?.level,
      path: draft?.path,
      expires: draft?.expires,
      at: Date.now(),
      by: this.ctx.me.user,
      byName: this.ctx.me.displayName || this.ctx.me.user,
      host: this.ctx.me.host
    })
    if (!a) throw new Error('An announcement needs a title')
    if (draft?.path && !a.path) throw new Error('The folder must be a full path (\\\\server\\share\\folder or X:\\folder)')
    if (a.expires && a.expires <= Date.now()) throw new Error('The expiry is in the past')
    return this.publish(a)
  }

  /** Take an announcement back: it stays in the history, marked withdrawn, and leaves every banner. */
  async withdraw(id: string) {
    const a = this.local.cache.find((x) => x.id === id)
    if (!a) throw new Error('unknown announcement')
    if (!this.canPost()) throw new Error('Only office admins and announcers can withdraw announcements')
    if (a.withdrawn) return this.view(a, true)
    return this.publish({ ...a, withdrawn: true })
  }

  markRead(id: string) {
    const s = (this.local.seen[id] ??= {})
    if (s.read) return false
    s.read = true
    this.save.schedule()
    this.emitList()
    return true
  }

  /** "Got it": recorded here, filed in the office folder and sent to the author. */
  async ack(id: string) {
    const a = this.local.cache.find((x) => x.id === id)
    if (!a) return false
    const s = (this.local.seen[id] ??= {})
    s.read = true
    if (!s.ackedAt) {
      s.ackedAt = Date.now()
      s.filed = false
    }
    this.save.schedule()
    const mine: AnnouncementAck = { user: this.ctx.me.user, name: this.ctx.me.displayName || this.ctx.me.user, at: s.ackedAt }
    this.noteAck(id, mine)
    this.emitList()
    void this.fileAcks()
    if (a.by !== this.ctx.me.user) void this.push(a.by, { t: 'ack', id, at: mine.at })
    return true
  }

  /** A frame from another PC (transfer server, role 'small'). Returns true or the refusal code. */
  onFrame(identity: string, frame: any, fromName: string): true | string {
    if (frame?.t === 'announce') {
      const a = cleanAnnouncement(frame.a)
      if (!a) return 'bad-announcement'
      // the TLS identity must be the author, and the author must be allowed to announce here
      if (a.by !== identity || !this.allowed(identity)) return 'not-an-announcer'
      this.take([a], true)
      return true
    }
    if (frame?.t === 'ack' && typeof frame.id === 'string') {
      if (!this.local.cache.some((x) => x.id === frame.id)) return 'unknown-announcement'
      this.noteAck(frame.id, { user: identity, name: fromName, at: Number(frame.at) || Date.now() })
      this.emitList()
      return true
    }
    return 'bad-frame'
  }

  /** Pull the shared file (and, for announcers, everyone's acknowledgements); retry filing our own. */
  sync(): Promise<void> {
    this.syncing ??= this.doSync()
      .catch((e) => this.ctx.log('announcements', e?.message ?? e))
      .finally(() => (this.syncing = null))
    return this.syncing
  }

  // -------------------------------------------------------------------------

  private dir() {
    return this.ctx.officePath ? dirname(this.ctx.officePath) : ''
  }

  private allowed(user: string) {
    const o = this.ctx.office
    return [...(o?.admins ?? []), ...(o?.announcers ?? [])].some((u) => String(u).toLowerCase() === user)
  }

  private view(a: Announcement, withAcks: boolean): AnnouncementView {
    const s = this.local.seen[a.id]
    const own = a.by === this.ctx.me.user
    return {
      ...a,
      read: own || !!s?.read,
      acked: own || !!s?.ackedAt,
      ackedAt: s?.ackedAt,
      ...(withAcks || own ? { acks: [...(this.acks.get(a.id)?.values() ?? [])].sort((x, y) => x.at - y.at) } : {})
    }
  }

  private emitList() {
    this.ctx.emit('announcements', this.list())
  }

  private noteAck(id: string, ack: AnnouncementAck) {
    let m = this.acks.get(id)
    if (!m) this.acks.set(id, (m = new Map()))
    const prev = m.get(ack.user)
    if (!prev || ack.at < prev.at) m.set(ack.user, ack)
  }

  /** Merge announcements into the cache; announce the ones that are new to this PC. */
  private take(list: Announcement[], live: boolean) {
    const known = new Map(this.local.cache.map((a) => [a.id, a]))
    const fresh: Announcement[] = []
    let changed = false
    for (const a of list) {
      const prev = known.get(a.id)
      if (!prev) fresh.push(a)
      if (!prev || (a.withdrawn && !prev.withdrawn)) changed = true
    }
    if (!changed) return
    this.local.cache = mergeAnnouncements([list, this.local.cache], CAP)
    const ids = new Set(this.local.cache.map((a) => a.id))
    for (const id of Object.keys(this.local.seen)) if (!ids.has(id)) delete this.local.seen[id]
    this.save.schedule()
    this.emitList()
    for (const a of fresh) {
      if (a.by === this.ctx.me.user || !announcementLive(a) || this.local.seen[a.id]?.ackedAt) continue
      this.ctx.emit('announcement', { ...this.view(a, false), live })
      if (a.level !== 'info') this.ctx.attention()
    }
  }

  private async publish(a: Announcement): Promise<AnnouncementView> {
    this.take([a], true)
    let stored = true
    try {
      await this.writeShared(a)
    } catch (e: any) {
      stored = false
      this.ctx.log('announcements', `could not write the office folder (${e?.code ?? e?.message ?? e}); online PCs still get it`)
    }
    const peers = this.discovery.online()
    for (const p of peers) void this.push(p.user, { t: 'announce', a }, p)
    this.ctx.log('announcements', `${a.withdrawn ? 'withdrew' : 'posted'} "${a.title}" to ${peers.length} online PC(s)${stored ? '' : ' (not stored on the server)'}`)
    return { ...this.view(a, true), ...(stored ? {} : { notStored: true }) }
  }

  /** Read-merge-write of the shared file; the temp name is per PC so two announcers never share one. */
  private async writeShared(a: Announcement) {
    const dir = this.dir()
    if (!dir) throw new Error('no office folder')
    const file = join(dir, 'announcements.json')
    const current = await this.readShared()
    const next = mergeAnnouncements([[a], current ?? []], CAP)
    await fsp.mkdir(dir, { recursive: true })
    const tmp = `${file}.${sanitizeName(this.ctx.me.host || 'pc')}-${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(next, null, 1), 'utf8')
    await fsp.rename(tmp, file)
  }

  /** null when the file cannot be read (missing folder, server down). */
  private async readShared(): Promise<Announcement[] | null> {
    const dir = this.dir()
    if (!dir) return null
    let text: string
    try {
      text = await fsp.readFile(join(dir, 'announcements.json'), 'utf8')
    } catch (e: any) {
      return e?.code === 'ENOENT' ? [] : null
    }
    try {
      const raw = JSON.parse(text)
      return (Array.isArray(raw) ? raw : []).map(cleanAnnouncement).filter((x): x is Announcement => !!x)
    } catch {
      return null // half-written by a non-atomic copy: try again next minute
    }
  }

  private async doSync() {
    const shared = await this.readShared()
    if (shared) this.take(shared, false)
    await this.fileAcks()
    if (this.canPost() || this.local.cache.some((a) => a.by === this.ctx.me.user)) await this.readAcks()
  }

  /** Write <office folder>\announcement-acks\<me>.json when something in it is not filed yet. */
  private async fileAcks() {
    const dir = this.dir()
    const pending = Object.entries(this.local.seen).filter(([, s]) => s.ackedAt && !s.filed)
    if (!dir || !pending.length || !this.ctx.me.user) return
    const data: AckFile = { user: this.ctx.me.user, name: this.ctx.me.displayName || this.ctx.me.user, acks: {} }
    for (const [id, s] of Object.entries(this.local.seen)) if (s.ackedAt) data.acks[id] = s.ackedAt
    try {
      await writeJsonAtomic(join(dir, 'announcement-acks', `${sanitizeName(this.ctx.me.user)}.json`), data)
      for (const [, s] of pending) s.filed = true
      this.save.schedule()
    } catch (e: any) {
      this.ctx.log('announcements', `acknowledgement not filed yet (${e?.code ?? e?.message ?? e})`)
    }
  }

  private async readAcks() {
    const dir = this.dir()
    if (!dir) return
    let names: string[]
    try {
      names = await fsp.readdir(join(dir, 'announcement-acks'))
    } catch {
      return
    }
    let changed = false
    for (const n of names.filter((x) => x.toLowerCase().endsWith('.json')).slice(0, 500)) {
      const f = await readJson<AckFile | null>(join(dir, 'announcement-acks', n), null)
      const user = String(f?.user ?? '').toLowerCase()
      if (!f || !user || !f.acks || typeof f.acks !== 'object') continue
      for (const [id, at] of Object.entries(f.acks)) {
        if (!Number.isFinite(at) || this.acks.get(id)?.has(user)) continue
        this.noteAck(id, { user, name: String(f.name || user).slice(0, 80), at: Number(at) })
        changed = true
      }
    }
    if (changed) this.emitList()
  }

  /** Deliver one frame to a user's PC, retrying until it says ok, it goes offline, or we give up. */
  private async push(user: string, frame: unknown, first?: Peer) {
    const signal = this.ac.signal
    for (let attempt = 0; ; attempt++) {
      const peer = attempt === 0 && first ? first : this.discovery.find(user)
      if (!peer) return false
      try {
        await sendSmall(this.ctx, peer, frame, signal)
        return true
      } catch (e: any) {
        if (signal.aborted || e instanceof Fatal || attempt >= PUSH_RETRY_MS.length) {
          if (!signal.aborted) this.ctx.log('announcements', `not delivered to ${user}: ${e?.message ?? e} (they get it from the office folder)`)
          return false
        }
        await sleep(PUSH_RETRY_MS[attempt], signal).catch(() => {})
        if (signal.aborted) return false
      }
    }
  }
}
