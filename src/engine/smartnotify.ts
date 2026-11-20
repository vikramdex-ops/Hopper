// Smart File Notifications: the gathering side. Watches Downloads (and any folders added in
// Settings) for arriving files and checks each one once it has stopped growing; every two hours it
// also sweeps Temp and those folders for leftovers. The rules and wording are in
// shared/smartnotify.ts. Duplicates are confirmed by SHA-256 of both files, never by name or size alone.
import { createHash } from 'node:crypto'
import { createReadStream, promises as fsp, watch, type FSWatcher } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LOW_SPACE_TRIGGER_BYTES, OLD_INSTALLERS_MIN_BYTES, OLD_INSTALLER_MS, STALLED_MS, TEMP_MIN_AGE_MS, cleanSmartSettings, copyOrigin, duplicateNotice,
  extractedNotice, isArchive, isInstaller, isLowSpace, isPartialDownload, isTempName, largeTempNotice, lowSpaceNotice, oldInstallersNotice,
  shouldNotify, stalledNotice, stemOf, tempTotalNotice, type SmartNotice, type SmartSettings
} from '@shared/smartnotify'
import type { EngineCtx } from './index'

const SETTLE_MS = 4000
const SWEEP_MS = 2 * 3600_000
const FIRST_SWEEP_MS = 5 * 60_000
/** compare contents only up to this size (hashing two 8 GB ISOs is not worth a notification) */
const MAX_HASH_BYTES = 4 * 1024 ** 3
const MAX_CANDIDATES = 25
const TEMP_MAX_ENTRIES = 200_000
const WEEK = 7 * 86_400_000

interface Store {
  sent: Record<string, number>
  recent: SmartNotice[]
}

export class SmartNotify {
  private ctx: EngineCtx
  private cfg: SmartSettings = cleanSmartSettings(undefined)
  private watchers = new Map<string, FSWatcher>()
  private pending = new Map<string, NodeJS.Timeout>()
  private store: Store = { sent: {}, recent: [] }
  private loaded = false
  private sweepTimer?: NodeJS.Timeout
  private firstSweep?: NodeJS.Timeout
  private sweeping = false
  /** paths this Hopper just wrote (a copy you made on purpose is not a "duplicate download") */
  private own = new Map<string, number>()

  constructor(ctx: EngineCtx) {
    this.ctx = ctx
  }

  noteOwn(paths: string[]) {
    const now = Date.now()
    for (const p of paths) this.own.set(p.toLowerCase(), now)
    if (this.own.size > 5000) for (const [k, t] of this.own) if (now - t > 5 * 60_000) this.own.delete(k)
  }

  private isOwn(path: string) {
    const t = this.own.get(path.toLowerCase())
    return t !== undefined && Date.now() - t < 5 * 60_000
  }

  private get file() {
    return join(this.ctx.dataDir, 'smart-notices.json')
  }

  /** Downloads plus the folders named in Settings. */
  folders() {
    const home = process.env.USERPROFILE
    const list = [...(home ? [join(home, 'Downloads')] : []), ...this.cfg.folders]
    const seen = new Set<string>()
    return list.filter((p) => !seen.has(p.toLowerCase()) && !!seen.add(p.toLowerCase()))
  }

  tempDirs() {
    const list = [tmpdir(), process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp') : '']
    const seen = new Set<string>()
    return list.filter((p) => p && !seen.has(p.toLowerCase().replace(/\\+$/, '')) && !!seen.add(p.toLowerCase().replace(/\\+$/, '')))
  }

  configure(raw: unknown) {
    this.cfg = cleanSmartSettings(raw)
    const want = new Set(this.cfg.enabled ? this.folders().map((p) => p.toLowerCase()) : [])
    for (const [k, w] of this.watchers) if (!want.has(k)) { w.close(); this.watchers.delete(k) }
    if (this.cfg.enabled) for (const p of this.folders()) this.watchFolder(p)
    if (this.cfg.enabled && !this.sweepTimer) {
      this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_MS)
      this.firstSweep = setTimeout(() => void this.sweep(), FIRST_SWEEP_MS)
    }
    if (!this.cfg.enabled && this.sweepTimer) {
      clearInterval(this.sweepTimer)
      clearTimeout(this.firstSweep)
      this.sweepTimer = undefined
    }
  }

  private watchFolder(path: string) {
    const k = path.toLowerCase()
    if (this.watchers.has(k)) return
    try {
      const w = watch(path, { persistent: false }, (_ev, name) => {
        if (name) this.arrived(join(path, name.toString()))
      })
      w.on('error', () => {
        w.close()
        this.watchers.delete(k)
      })
      this.watchers.set(k, w)
    } catch {
      /* folder missing or unreadable: tried again at the next configure */
    }
  }

  /** A name changed in a watched folder: check it once it has settled. */
  private arrived(path: string) {
    const k = path.toLowerCase()
    clearTimeout(this.pending.get(k))
    this.pending.set(
      k,
      setTimeout(() => {
        this.pending.delete(k)
        void this.checkArrival(path).catch((err) => console.error('[smart]', err))
      }, SETTLE_MS)
    )
  }

  private async checkArrival(path: string) {
    const name = path.split('\\').pop() ?? ''
    if (isPartialDownload(name) || isTempName(name) || name.toLowerCase() === 'desktop.ini' || this.isOwn(path)) return
    let st = await fsp.stat(path).catch(() => null)
    if (!st) return
    if (st.isDirectory()) return this.checkNewFolder(path)
    if (!st.isFile() || st.size === 0) return
    // still being written? wait until two looks agree
    await sleep(1500)
    const again = await fsp.stat(path).catch(() => null)
    if (!again || again.size !== st.size || again.mtimeMs !== st.mtimeMs) return this.arrived(path)
    st = again
    // only files that are new: a rename or an old file touched is not a "download"
    if (Date.now() - st.birthtimeMs > 10 * 60_000 && Date.now() - st.mtimeMs > 10 * 60_000) return

    const dup = await this.findTwin(path, name, st.size)
    if (dup) await this.raise(duplicateNotice(path, dup, st.size))

    if (isArchive(name)) {
      const folder = join(path, '..', stemOf(name))
      const fst = await fsp.stat(folder).catch(() => null)
      if (fst?.isDirectory() && fst.mtimeMs < st.birthtimeMs) await this.raise(extractedNotice(path, folder, st.size))
    }

    if (st.size >= LOW_SPACE_TRIGGER_BYTES) {
      const fs = await fsp.statfs(path).catch(() => null)
      if (fs) {
        const total = fs.blocks * fs.bsize
        const free = fs.bavail * fs.bsize
        if (isLowSpace(free, total)) await this.raise(lowSpaceNotice(path, rootOf(path), free, total))
      }
    }
  }

  /** A folder appeared next to a same-named archive: the archive was just extracted. */
  private async checkNewFolder(folder: string) {
    const parent = join(folder, '..')
    const stem = (folder.split('\\').pop() ?? '').toLowerCase()
    let names: string[] = []
    try {
      names = await fsp.readdir(parent)
    } catch {
      return
    }
    const archive = names.find((n) => isArchive(n) && stemOf(n).toLowerCase() === stem)
    if (!archive) return
    const p = join(parent, archive)
    const st = await fsp.stat(p).catch(() => null)
    if (st?.isFile()) await this.raise(extractedNotice(p, folder, st.size))
  }

  /** Another file in the same folder with identical content (checked by size, then SHA-256). */
  private async findTwin(path: string, name: string, size: number) {
    if (size > MAX_HASH_BYTES) return null
    const parent = join(path, '..')
    let entries: string[] = []
    try {
      entries = await fsp.readdir(parent)
    } catch {
      return null
    }
    const origin = copyOrigin(name)?.toLowerCase()
    // likely twins first: the name this one was copied from, then same extension
    const ext = name.split('.').pop()?.toLowerCase()
    const ordered = entries
      .filter((n) => n.toLowerCase() !== name.toLowerCase())
      .sort((a, b) => score(b) - score(a))
    function score(n: string) {
      const l = n.toLowerCase()
      return (l === origin ? 4 : 0) + (copyOrigin(n)?.toLowerCase() === origin && origin ? 2 : 0) + (l.endsWith('.' + ext) ? 1 : 0)
    }
    let mine: string | null = null
    let tried = 0
    for (const n of ordered) {
      if (tried >= MAX_CANDIDATES) break
      const other = join(parent, n)
      const st = await fsp.stat(other).catch(() => null)
      if (!st?.isFile() || st.size !== size) continue
      tried++
      mine ??= await sha256(path).catch(() => null)
      if (!mine) return null
      if ((await sha256(other).catch(() => '')) === mine) return other
    }
    return null
  }

  /** Temp and the arrival folders: big leftovers, stalled downloads, old installers. */
  async sweep() {
    if (this.sweeping || !this.cfg.enabled) return
    this.sweeping = true
    try {
      const now = Date.now()
      for (const t of this.tempDirs()) await this.sweepTemp(t, now)
      for (const f of this.folders()) await this.sweepFolder(f, now)
    } catch (err) {
      console.error('[smart] sweep', err)
    } finally {
      this.sweeping = false
    }
  }

  private async sweepTemp(dir: string, now: number) {
    const files = await listFiles(dir, 4, TEMP_MAX_ENTRIES)
    let total = 0
    let old = 0
    const big: { path: string; size: number; age: number }[] = []
    for (const f of files) {
      total += f.size
      const age = now - f.mtime
      if (age > WEEK) old += f.size
      if (f.size >= this.cfg.largeTempMB * 1024 ** 2 && age >= TEMP_MIN_AGE_MS) big.push({ path: f.path, size: f.size, age })
    }
    for (const b of big.sort((a, z) => z.size - a.size).slice(0, 3)) await this.raise(largeTempNotice(b.path, b.size, b.age, now))
    if (total >= this.cfg.tempTotalGB * 1024 ** 3) await this.raise(tempTotalNotice(dir, total, files.length, old, now))
  }

  private async sweepFolder(dir: string, now: number) {
    const files = await listFiles(dir, 1, 50_000)
    const installers: { path: string; bytes: number }[] = []
    for (const f of files) {
      const age = now - f.mtime
      if (isPartialDownload(f.name) && age >= STALLED_MS && f.size >= 1024 ** 2) await this.raise(stalledNotice(f.path, f.size, age, now))
      else if (isTempName(f.name) && f.size >= this.cfg.largeTempMB * 1024 ** 2 && age >= TEMP_MIN_AGE_MS) await this.raise(largeTempNotice(f.path, f.size, age, now))
      else if (isInstaller(f.name) && age >= OLD_INSTALLER_MS) installers.push({ path: f.path, bytes: f.size })
    }
    if (installers.reduce((s, f) => s + f.bytes, 0) >= OLD_INSTALLERS_MIN_BYTES) await this.raise(oldInstallersNotice(dir, installers.sort((a, b) => b.bytes - a.bytes), now))
  }

  private async load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const j = JSON.parse(await fsp.readFile(this.file, 'utf8'))
      if (j && typeof j.sent === 'object' && Array.isArray(j.recent)) this.store = j
    } catch {
      /* first run */
    }
  }

  private async save() {
    const now = Date.now()
    for (const [k, t] of Object.entries(this.store.sent)) if (now - t > 60 * 86_400_000) delete this.store.sent[k]
    const tmp = `${this.file}.${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(this.store), 'utf8')
    await fsp.rename(tmp, this.file)
  }

  private async raise(n: SmartNotice) {
    await this.load()
    if (!shouldNotify(n, this.store.sent, this.cfg.muted, n.at)) return
    this.store.sent[n.key] = n.at
    this.store.recent = [n, ...this.store.recent.filter((x) => x.key !== n.key)].slice(0, 100)
    await this.save().catch(() => {})
    this.ctx.emit('smart-notice', n)
    process.parentPort?.postMessage({ type: 'notify', title: n.title, body: n.body, folder: n.folder, select: n.select ?? '' })
  }

  async list() {
    await this.load()
    return this.store.recent
  }

  async dismiss(id: string) {
    await this.load()
    this.store.recent = this.store.recent.filter((n) => n.id !== id)
    await this.save().catch(() => {})
    return true
  }

  /** Files a "Review" action lists: old Temp files (biggest first), or the given files as they are now. */
  async review(paths: string[]) {
    const now = Date.now()
    const out: { path: string; name: string; size: number; mtime: number }[] = []
    if (paths.length === 1 && this.tempDirs().some((t) => t.toLowerCase() === paths[0].toLowerCase())) {
      for (const f of await listFiles(paths[0], 4, TEMP_MAX_ENTRIES)) if (now - f.mtime >= TEMP_MIN_AGE_MS) out.push({ path: f.path, name: f.name, size: f.size, mtime: f.mtime })
    } else {
      for (const p of paths.slice(0, 500)) {
        const st = await fsp.stat(p).catch(() => null)
        if (st?.isFile()) out.push({ path: p, name: p.split('\\').pop() ?? p, size: st.size, mtime: st.mtimeMs })
      }
    }
    return out.sort((a, b) => b.size - a.size).slice(0, 2000)
  }

  /** Re-check a duplicate right before recycling: both still there and still identical. */
  async stillIdentical(a: string, b: string) {
    const [sa, sb] = await Promise.all([fsp.stat(a).catch(() => null), fsp.stat(b).catch(() => null)])
    if (!sa?.isFile() || !sb?.isFile() || sa.size !== sb.size) return false
    return (await sha256(a)) === (await sha256(b))
  }
}

async function listFiles(root: string, depth: number, max: number) {
  const out: { path: string; name: string; size: number; mtime: number }[] = []
  const queue: [string, number][] = [[root, 0]]
  while (queue.length && out.length < max) {
    const [dir, d] = queue.pop()!
    let ents: import('node:fs').Dirent[] = []
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (d + 1 < depth) queue.push([p, d + 1])
      } else if (e.isFile()) {
        const st = await fsp.stat(p).catch(() => null)
        if (st) out.push({ path: p, name: e.name, size: st.size, mtime: st.mtimeMs })
        if (out.length >= max) break
      }
    }
  }
  return out
}

function sha256(path: string) {
  return new Promise<string>((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}

function rootOf(p: string) {
  if (p.startsWith('\\\\')) return '\\\\' + p.slice(2).split('\\').slice(0, 2).join('\\') + '\\'
  return p.slice(0, 3)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function smartHandlers(ctx: EngineCtx & { smart: SmartNotify }) {
  return {
    'smart.list': () => ctx.smart.list(),
    'smart.dismiss': (id: string) => ctx.smart.dismiss(String(id)),
    'smart.review': (paths: string[]) => ctx.smart.review(Array.isArray(paths) ? paths.map(String) : []),
    'smart.sweep': () => {
      void ctx.smart.sweep()
      return true
    },
    'smart.stillIdentical': (a: string, b: string) => ctx.smart.stillIdentical(String(a), String(b))
  }
}
