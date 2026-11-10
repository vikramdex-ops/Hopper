// What this PC sent (HOPPER_DATA\lan-sent.json, newest first, capped). Together with the Inbox it
// gives the conversation shown in the Person panel.
import { join } from 'node:path'
import type { HistoryItem, InboxItem } from '@shared/types'
import type { LanCtx } from './types'
import { readJson, saver, writeJsonAtomic } from './util'

const CAP = 500

export class Sent {
  private items: HistoryItem[] = []
  private file: string
  private save

  constructor(private ctx: LanCtx) {
    this.file = join(ctx.dataDir, 'lan-sent.json')
    this.save = saver(1000, () => writeJsonAtomic(this.file, this.items))
  }

  async load() {
    const raw = await readJson<HistoryItem[]>(this.file, [])
    this.items = Array.isArray(raw) ? raw.filter((i) => i && typeof i.id === 'string' && typeof i.user === 'string').slice(0, CAP) : []
  }

  flush() {
    return this.save.flush()
  }

  add(item: HistoryItem) {
    this.items = [item, ...this.items.filter((i) => i.id !== item.id)].slice(0, CAP)
    this.save.schedule()
    this.ctx.emit('sent', item)
  }

  /** Everything exchanged with one person, oldest first. */
  with(user: string, inbox: InboxItem[]): HistoryItem[] {
    const u = String(user ?? '').toLowerCase()
    const received: HistoryItem[] = inbox
      .filter((i) => i.from.toLowerCase() === u)
      .map((i) => ({
        id: i.id,
        dir: 'in',
        user: u,
        at: i.at,
        kind: i.kind ?? 'files',
        message: i.message,
        link: i.link,
        folder: i.folder || undefined,
        files: i.files,
        bytes: i.bytes,
        via: i.via,
        replyTo: i.replyTo
      }))
    return [...received, ...this.items.filter((i) => i.user === u)].sort((a, b) => a.at - b.at)
  }
}
