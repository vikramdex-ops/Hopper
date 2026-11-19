// Shared status labels and notes (see shared/labels.ts for the format). The store lives in a
// "labels" folder next to office.json, or in Hopper's own data folder when there is no office
// config. Writes are atomic (temp file + rename) and merge on conflict: the file is re-read just
// before and after writing, and every changed item is written again until the newest copy of it
// is on disk (last writer per item wins). Other PCs pick changes up within LABEL_TTL.
import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { folderKey } from '@shared/listing'
import { applyPatch, cleanShard, isLive, mergeShards, movedItems, prune, shardOf, type LabelItem, type LabelShard } from '@shared/labels'
import type { EngineCtx } from './index'

const LABEL_TTL = 10_000
const empty = (): LabelShard => ({ v: 1, items: {} })

export class Labels {
  private shards = new Map<string, { data: LabelShard; readAt: number; mtime: number; size: number }>()
  private chains = new Map<string, Promise<unknown>>()
  private drives: { root: string; remote?: string }[] = []
  private drivesAt = 0

  private ctx: EngineCtx

  constructor(ctx: EngineCtx) {
    this.ctx = ctx
  }

  /** where the shards are kept */
  dir() {
    const p = this.ctx.officePath
    return p ? join(dirname(p), 'labels') : join(this.ctx.dataDir, 'labels')
  }

  private me() {
    const user = (process.env.USERNAME ?? '').toLowerCase()
    return { by: user, byName: this.ctx.settings?.profile?.displayName?.trim() || user }
  }

  /** mapped drives -> UNC, so U:\x and \\server\share\x share their labels */
  async refreshDrives(force = false) {
    if (!force && Date.now() - this.drivesAt < 60_000) return
    this.drivesAt = Date.now()
    try {
      this.drives = await this.ctx.shell.call<{ root: string; remote?: string }[]>('drives', {}, 15_000)
    } catch {
      /* keep the last list */
    }
  }

  key(path: string) {
    return folderKey(path, this.drives)
  }

  /** Shares are labelled for the whole office; a local disk (D:\ on this PC) only for this PC. */
  private file(name: string) {
    const local = name.startsWith('local-') || name === 'other'
    return join(local ? join(this.ctx.dataDir, 'labels') : this.dir(), `${name}.json`)
  }

  private async read(name: string, fresh = false): Promise<LabelShard> {
    const c = this.shards.get(name)
    if (c && !fresh && Date.now() - c.readAt < LABEL_TTL) return c.data
    const file = this.file(name)
    try {
      const st = await fsp.stat(file)
      if (c && c.mtime === st.mtimeMs && c.size === st.size) {
        c.readAt = Date.now()
        return c.data
      }
      const data = cleanShard(JSON.parse(await fsp.readFile(file, 'utf8')))
      this.shards.set(name, { data, readAt: Date.now(), mtime: st.mtimeMs, size: st.size })
      return data
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        const data = empty()
        this.shards.set(name, { data, readAt: Date.now(), mtime: 0, size: 0 })
        return data
      }
      // unreadable for now (share busy, half-written by an old version): keep what we had
      return c?.data ?? empty()
    }
  }

  /** Live items for these paths, keyed by the lower-case path as given. */
  async get(paths: string[]): Promise<Record<string, LabelItem>> {
    await this.refreshDrives()
    const out: Record<string, LabelItem> = {}
    const byShard = new Map<string, [string, string][]>()
    for (const p of paths) {
      const k = this.key(p)
      if (!k) continue
      const s = shardOf(k)
      byShard.set(s, [...(byShard.get(s) ?? []), [p, k]])
    }
    for (const [name, list] of byShard) {
      const s = await this.read(name)
      for (const [p, k] of list) if (isLive(s.items[k])) out[p.toLowerCase()] = s.items[k]
    }
    return out
  }

  /** Load the shards for these roots (search uses labelOf, which must not wait). */
  async preload(paths: string[]) {
    await this.refreshDrives()
    for (const name of new Set(paths.map((p) => this.key(p)).filter((k): k is string => !!k).map(shardOf))) await this.read(name)
  }

  /** The label id of a path from what is already loaded ('' = none). */
  labelOf(path: string): string {
    const k = this.key(path)
    if (!k) return ''
    const i = this.shards.get(shardOf(k))?.data.items[k]
    return i && isLive(i) ? i.label ?? '' : ''
  }

  /** Set (or clear, with null) the label and/or the note of these paths. */
  async set(paths: string[], patch: { label?: string | null; note?: string | null }) {
    await this.refreshDrives()
    const { by, byName } = this.me()
    const at = Date.now()
    const changes = new Map<string, Record<string, LabelItem>>()
    for (const p of paths) {
      const k = this.key(p)
      if (!k) continue
      const name = shardOf(k)
      const prev = (await this.read(name)).items[k]
      const c = changes.get(name) ?? {}
      c[k] = applyPatch(prev, patch, by, byName, at)
      changes.set(name, c)
    }
    for (const [name, items] of changes) await this.write(name, items)
    this.ctx.emit('labels-changed', { paths })
    return true
  }

  /** Labels follow renames and moves made by Hopper ([from, to] pairs, files or folders). */
  async moved(pairs: [string, string][]) {
    if (!pairs.length) return
    await this.refreshDrives()
    const { by, byName } = this.me()
    const at = Date.now()
    const changes = new Map<string, Record<string, LabelItem>>()
    const add = (k: string, i: LabelItem) => {
      const name = shardOf(k)
      const c = changes.get(name) ?? {}
      c[k] = i
      changes.set(name, c)
    }
    for (const [from, to] of pairs) {
      const fk = this.key(from)
      const tk = this.key(to)
      if (!fk || !tk || !from || !to || fk === tk) continue
      const { put, clear } = movedItems((await this.read(shardOf(fk))).items, fk, tk, at)
      for (const k of clear) add(k, applyPatch(undefined, { label: null, note: null }, by, byName, at))
      for (const [k, i] of Object.entries(put)) add(k, i)
    }
    for (const [name, items] of changes) await this.write(name, items).catch((e) => console.error('[labels] move', e?.message ?? e))
    if (changes.size) this.ctx.emit('labels-changed', { paths: pairs.flat() })
  }

  /** Write items into a shard, merging with whatever another PC wrote meanwhile. One write per shard at a time. */
  private write(name: string, items: Record<string, LabelItem>) {
    const run = async () => {
      const file = this.file(name)
      await fsp.mkdir(dirname(file), { recursive: true })
      for (let attempt = 0; attempt < 4; attempt++) {
        const disk = await this.read(name, true)
        const next = mergeShards(prune(disk, Date.now()), { v: 1, items })
        const tmp = `${file}.${process.pid}-${Date.now().toString(36)}.tmp`
        await fsp.writeFile(tmp, JSON.stringify(next), 'utf8')
        try {
          await renameRetry(tmp, file)
        } catch (e) {
          await fsp.rm(tmp, { force: true }).catch(() => {})
          throw e
        }
        this.shards.delete(name)
        const back = await this.read(name, true)
        // someone else's rename may have landed after ours without our items: merge again
        if (Object.entries(items).every(([k, i]) => (back.items[k]?.at ?? 0) >= i.at)) return
      }
      throw new Error('the labels file keeps changing; try again')
    }
    const p = (this.chains.get(name) ?? Promise.resolve()).then(run, run)
    this.chains.set(name, p.catch(() => {}))
    return p
  }
}

async function renameRetry(from: string, to: string) {
  for (let i = 0; ; i++) {
    try {
      return await fsp.rename(from, to)
    } catch (e: any) {
      // another PC reading the file at this very moment
      if (i >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(e?.code)) throw e
      await new Promise((r) => setTimeout(r, 100 + i * 150))
    }
  }
}

export function labelHandlers(ctx: EngineCtx & { labels: Labels }) {
  return {
    'labels.get': (paths: string[]) => ctx.labels.get(Array.isArray(paths) ? paths.slice(0, 200_000) : []),
    'labels.set': (paths: string[], patch: { label?: string | null; note?: string | null }) => ctx.labels.set(paths, patch),
    'labels.where': () => ctx.labels.dir()
  }
}
