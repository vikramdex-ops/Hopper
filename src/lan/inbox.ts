// Inbox history (HOPPER_DATA\inbox.json, newest first, capped) and the accept/decline gate for
// incoming shares, direct or from the server.
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { InboxItem } from '@shared/types'
import type { IncomingRequest, LanCtx } from './types'
import { readJson, saver, writeJsonAtomic } from './util'

const CAP = 500
const ASK_MS = 5 * 60_000

export class Inbox {
  private items: InboxItem[] = []
  private file: string
  private save
  private pending = new Map<string, { req: IncomingRequest; resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>()

  constructor(private ctx: LanCtx) {
    this.file = join(ctx.dataDir, 'inbox.json')
    this.save = saver(1000, () => writeJsonAtomic(this.file, this.items))
  }

  async load() {
    const raw = await readJson<InboxItem[]>(this.file, [])
    this.items = Array.isArray(raw) ? raw.slice(0, CAP) : []
  }

  flush() {
    return this.save.flush()
  }

  /** settings.inboxDir, else Downloads\Hopper Inbox. */
  root() {
    return this.ctx.settings?.inboxDir?.trim() || join(homedir(), 'Downloads', 'Hopper Inbox')
  }

  list() {
    return this.items
  }

  has(id: string) {
    return this.items.some((i) => i.id === id)
  }

  add(item: InboxItem) {
    this.items = [item, ...this.items.filter((i) => i.id !== item.id)].slice(0, CAP)
    this.save.schedule()
    this.ctx.emit('received', item)
    this.ctx.attention()
  }

  markSeen(id: string) {
    const it = this.items.find((i) => i.id === id)
    if (!it || it.seen) return false
    it.seen = true
    this.save.schedule()
    return true
  }

  /** Decide on an incoming share: true, or the decline reason. */
  async admit(r: Omit<IncomingRequest, 'requestId'>): Promise<true | string> {
    const lan = this.ctx.settings?.lan
    const from = r.from.toLowerCase()
    const has = (list?: string[]) => (list ?? []).some((u) => u.toLowerCase() === from)
    if (has(lan?.blocked)) return 'blocked'
    // a note carries no bytes: nothing to accept, it just shows up in the Inbox
    if (r.kind && r.kind !== 'files') return true
    if (lan?.acceptFrom
 === 'ask' || has(lan?.askFor)) return (await this.ask(r)) ? true : 'declined'
    return true
  }

  answer(requestId: string, accept: boolean) {
    const p = this.pending.get(requestId)
    if (!p) return false
    clearTimeout(p.timer)
    this.pending.delete(requestId)
    p.resolve(!!accept)
    return true
  }

  pendingList() {
    return [...this.pending.values()].map((p) => p.req)
  }

  /** Decline everything still waiting (shutdown). */
  declineAll() {
    for (const id of [...this.pending.keys()]) this.answer(id, false)
  }

  private ask(r: Omit<IncomingRequest, 'requestId'>) {
    const req: IncomingRequest = { ...r, requestId: randomBytes(8).toString('hex') }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.answer(req.requestId, false), ASK_MS)
      timer.unref()
      this.pending.set(req.requestId, { req, resolve, timer })
      this.ctx.emit('incoming', req)
      this.ctx.attention()
    })
  }
}
