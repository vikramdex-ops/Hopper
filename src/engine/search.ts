// Instant name search (an in-memory index kept current by recursive watchers),
// on-demand content search, and the duplicate finder.
import { createReadStream, promises as fsp, watch, type FSWatcher } from 'node:fs'
import { createHash } from 'node:crypto'
import { deserialize, serialize } from 'node:v8'
import { basename, dirname, join } from 'node:path'
import type { Entry, IndexStatus, SearchQuery } from '@shared/types'
import type { EngineCtx } from './index'
import { listRaw, walk } from './fsops'
import { extOf } from './fsutil'

// ---------------------------------------------------------------------------
// Query parsing: words are AND-ed, * and ? are wildcards, ext:pdf, /regex/

interface Matcher {
  test(nameLower: string): boolean
  ext?: Set<string>
}

export function parseQuery(q: string, caseSensitive = false): Matcher {
  const exts = new Set<string>()
  const tests: ((n: string) => boolean)[] = []
  const re = /^\/(.+)\/([a-z]*)$/.exec(q.trim())
  if (re) {
    const r = new RegExp(re[1], re[2].includes('i') || !caseSensitive ? 'i' : '')
    return { test: (n) => r.test(n) }
  }
  for (const raw of q.trim().split(/\s+/).filter(Boolean)) {
    const m = /^ext:(.+)$/i.exec(raw)
    if (m) {
      for (const e of m[1].split(/[,;]/)) exts.add(e.replace(/^\./, '').toLowerCase())
      continue
    }
    const w = raw.toLowerCase()
    if (/[*?]/.test(w)) {
      const r = new RegExp('^' + w.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
      tests.push((n) => r.test(n))
    } else tests.push((n) => n.includes(w))
  }
  return {
    ext: exts.size ? exts : undefined,
    test: (n) => {
      if (exts.size && !exts.has(extOf(n))) return false
      for (const t of tests) if (!t(n)) return false
      return true
    }
  }
}

// ---------------------------------------------------------------------------
// Index: per root, folders are stored once; files reference their folder by number.

interface RootIndex {
  root: string
  dirs: string[]
  dirIds: Map<string, number>
  names: string[] // lower-case; '' = deleted
  display: string[]
  dirOf: number[]
  size: number[]
  mtime: number[]
  isDir: boolean[]
  byDir: Map<number, number[]>
  ready: boolean
  scannedAt?: number
  dead: number
  watcher?: FSWatcher
}

function emptyIndex(root: string): RootIndex {
  return { root, dirs: [], dirIds: new Map(), names: [], display: [], dirOf: [], size: [], mtime: [], isDir: [], byDir: new Map(), ready: false, dead: 0 }
}

function dirId(ix: RootIndex, dir: string) {
  const k = dir.toLowerCase()
  let id = ix.dirIds.get(k)
  if (id === undefined) {
    id = ix.dirs.length
    ix.dirs.push(dir)
    ix.dirIds.set(k, id)
  }
  return id
}

function addEntry(ix: RootIndex, e: Entry) {
  const d = dirId(ix, dirname(e.path))
  const i = ix.names.length
  ix.names.push(e.name.toLowerCase())
  ix.display.push(e.name)
  ix.dirOf.push(d)
  ix.size.push(e.size)
  ix.mtime.push(e.mtime)
  ix.isDir.push(e.dir)
  let list = ix.byDir.get(d)
  if (!list) ix.byDir.set(d, (list = []))
  list.push(i)
}

function compact(ix: RootIndex): RootIndex {
  const next = emptyIndex(ix.root)
  next.ready = ix.ready
  next.scannedAt = ix.scannedAt
  next.watcher = ix.watcher
  for (let i = 0; i < ix.names.length; i++) {
    if (!ix.names[i]) continue
    const dir = ix.dirs[ix.dirOf[i]]
    addEntry(next, { name: ix.display[i], path: join(dir, ix.display[i]), dir: ix.isDir[i], size: ix.size[i], mtime: ix.mtime[i], ctime: 0, atime: 0, attrs: 0, ext: '' })
  }
  return next
}

export function searchHandlers(ctx: EngineCtx) {
  const roots = new Map<string, RootIndex>()
  const indexDir = join(ctx.dataDir, 'index')
  let building = false
  const fileFor = (root: string) => join(indexDir, createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16) + '.bin')

  const status = (): IndexStatus => ({
    roots: [...roots.values()].map((r) => ({ path: r.root, files: r.names.length - r.dead, ready: r.ready, scannedAt: r.scannedAt })),
    total: [...roots.values()].reduce((a, r) => a + r.names.length - r.dead, 0),
    building
  })

  const save = async (ix: RootIndex) => {
    const c = ix.dead > ix.names.length * 0.2 ? compact(ix) : ix
    if (c !== ix) roots.set(ix.root.toLowerCase(), c)
    await fsp.mkdir(indexDir, { recursive: true })
    const data = serialize({ v: 1, root: c.root, dirs: c.dirs, names: c.display, dirOf: c.dirOf, size: c.size, mtime: c.mtime, isDir: c.isDir, scannedAt: c.scannedAt })
    await fsp.writeFile(fileFor(c.root) + '.tmp', data)
    await fsp.rename(fileFor(c.root) + '.tmp', fileFor(c.root))
  }

  const load = async (root: string): Promise<RootIndex | null> => {
    try {
      const d = deserialize(await fsp.readFile(fileFor(root)))
      const ix = emptyIndex(root)
      ix.dirs = d.dirs
      d.dirs.forEach((p: string, i: number) => ix.dirIds.set(p.toLowerCase(), i))
      ix.display = d.names
      ix.names = d.names.map((n: string) => n.toLowerCase())
      ix.dirOf = d.dirOf
      ix.size = d.size
      ix.mtime = d.mtime
      ix.isDir = d.isDir
      ix.dirOf.forEach((dd, i) => {
        let l = ix.byDir.get(dd)
        if (!l) ix.byDir.set(dd, (l = []))
        l.push(i)
      })
      ix.ready = true
      ix.scannedAt = d.scannedAt
      return ix
    } catch {
      return null
    }
  }

  /** Re-list one folder and patch the index (called from the recursive watcher). */
  const rescanDir = async (ix: RootIndex, dir: string) => {
    const id = ix.dirIds.get(dir.toLowerCase())
    if (id !== undefined) {
      for (const i of ix.byDir.get(id) ?? []) {
        if (ix.names[i]) {
          ix.names[i] = ''
          ix.dead++
        }
      }
      ix.byDir.set(id, [])
    }
    try {
      for (const e of await listRaw(ctx, dir, 'index')) addEntry(ix, e)
    } catch {
      /* folder removed */
    }
  }

  const startWatcher = (ix: RootIndex) => {
    if (ix.watcher) return
    const pending = new Set<string>()
    let timer: NodeJS.Timeout | undefined
    try {
      ix.watcher = watch(ix.root, { recursive: true, persistent: false }, (_ev, rel) => {
        if (!rel) return
        pending.add(dirname(join(ix.root, rel.toString())))
        clearTimeout(timer)
        timer = setTimeout(async () => {
          const dirs = [...pending]
          pending.clear()
          for (const d of dirs) await rescanDir(ix, d)
          dirtySave(ix)
        }, 1500)
      })
      ix.watcher.on('error', () => {
        ix.watcher?.close()
        ix.watcher = undefined
      })
    } catch {
      /* not watchable */
    }
  }

  const saveTimers = new Map<string, NodeJS.Timeout>()
  const dirtySave = (ix: RootIndex) => {
    clearTimeout(saveTimers.get(ix.root))
    saveTimers.set(ix.root, setTimeout(() => void save(ix).catch(() => {}), 60000))
  }

  const build = async (root: string) => {
    const ix = emptyIndex(root)
    const prev = roots.get(root.toLowerCase())
    // keep serving the old index while the new one builds
    if (!prev) roots.set(root.toLowerCase(), ix)
    await walk(ctx, root, (e) => {
      // skip noise that nobody searches for
      if (e.dir && /^(\$recycle\.bin|system volume information|node_modules|\.git)$/i.test(e.name)) return false
      addEntry(ix, e)
    }, { concurrency: 3, lane: 'index' })
    ix.ready = true
    ix.scannedAt = Date.now()
    ix.watcher = prev?.watcher
    roots.set(root.toLowerCase(), ix)
    startWatcher(ix)
    await save(ix).catch(() => {})
    ctx.emit('index', status())
  }

  const configure = async (want: string[]) => {
    const wanted = new Set(want.map((w) => w.toLowerCase()))
    for (const [k, ix] of roots) {
      if (!wanted.has(k)) {
        ix.watcher?.close()
        roots.delete(k)
      }
    }
    building = true
    ctx.emit('index', status())
    for (const root of want) {
      if (roots.get(root.toLowerCase())?.ready) continue
      const loaded = await load(root)
      if (loaded) {
        roots.set(root.toLowerCase(), loaded)
        startWatcher(loaded)
        ctx.emit('index', status())
        // refresh stale indexes in the background (older than a day)
        if (!loaded.scannedAt || Date.now() - loaded.scannedAt > 86400000) void build(root).catch(() => {})
      } else {
        await build(root).catch(() => {})
      }
    }
    building = false
    ctx.emit('index', status())
  }

  const query = (q: string, opts: { limit?: number; dirsOnly?: boolean; under?: string } = {}) => {
    const t = Date.now()
    const m = parseQuery(q)
    const limit = opts.limit ?? 500
    const out: Entry[] = []
    const under = opts.under?.toLowerCase()
    let total = 0
    for (const ix of roots.values()) {
      for (let i = 0; i < ix.names.length; i++) {
        const n = ix.names[i]
        if (!n || !m.test(n)) continue
        if (opts.dirsOnly && !ix.isDir[i]) continue
        const dir = ix.dirs[ix.dirOf[i]]
        if (under && !dir.toLowerCase().startsWith(under)) continue
        total++
        if (out.length < limit) {
          const name = ix.display[i]
          out.push({ name, path: join(dir, name), dir: ix.isDir[i], size: ix.size[i], mtime: ix.mtime[i], ctime: 0, atime: 0, attrs: ix.isDir[i] ? 0x10 : 0, ext: ix.isDir[i] ? '' : extOf(name) })
        }
      }
    }
    return { entries: out, total, ms: Date.now() - t }
  }

  // ---------------------------------------------------------------------------
  // Content / filtered search, streaming hits

  const searches = new Map<string, AbortController>()

  const contentMatch = async (p: string, needle: string | RegExp, signal: AbortSignal) => {
    // Stream with a small overlap so matches across chunk borders are found.
    let tail = ''
    const isRe = needle instanceof RegExp
    const lower = !isRe ? (needle as string).toLowerCase() : ''
    for await (const chunk of createReadStream(p, { highWaterMark: 256 * 1024, signal })) {
      const buf = chunk as Buffer
      if (buf.subarray(0, 4096).includes(0)) return false // binary
      const text = tail + buf.toString('utf8')
      if (isRe ? (needle as RegExp).test(text) : text.toLowerCase().includes(lower)) return true
      tail = text.slice(-512)
    }
    return false
  }

  return {
    'index.configure': (rootsWanted: string[]) => {
      void configure(rootsWanted)
      return true
    },
    'index.status': () => status(),
    'index.rebuild': async (root?: string) => {
      for (const r of root ? [root] : [...roots.values()].map((x) => x.root)) await build(r)
      return status()
    },
    'index.query': (q: string, opts?: { limit?: number; dirsOnly?: boolean; under?: string }) => query(q, opts),

    'search.run': (token: string, q: SearchQuery) => {
      const ac = new AbortController()
      searches.set(token, ac)
      const m = parseQuery(q.name || '')
      const needle = q.content ? (q.contentRegex ? new RegExp(q.content, q.caseSensitive ? '' : 'i') : q.content) : null
      const limit = q.limit ?? 5000
      let hits = 0
      let scanned = 0
      let batch: Entry[] = []
      let lastFlush = Date.now()
      const flush = (done = false) => {
        if (batch.length || done) ctx.emit('search-hit', { token, entries: batch, scanned, hits, done })
        batch = []
        lastFlush = Date.now()
      }
      const checks: Promise<void>[] = []
      let active = 0
      const run = async () => {
        for (const root of q.roots) {
          await walk(ctx, root, (e) => {
            scanned++
            if (ac.signal.aborted || hits >= limit) return false
            if (!m.test(e.name.toLowerCase())) return
            if (q.kinds && !q.kinds.includes(e.dir ? 'dir' : 'file')) return
            if (!e.dir) {
              if (q.minSize !== undefined && e.size < q.minSize) return
              if (q.maxSize !== undefined && e.size > q.maxSize) return
            }
            if (q.after && e.mtime < q.after) return
            if (q.before && e.mtime > q.before) return
            if (needle) {
              if (e.dir || e.size > 64 * 1024 * 1024) return
              const job = (async () => {
                while (active >= 4) await new Promise((r) => setTimeout(r, 5))
                active++
                try {
                  if (await contentMatch(e.path, needle, ac.signal)) {
                    hits++
                    batch.push(e)
                  }
                } catch {
                  /* unreadable */
                } finally {
                  active--
                }
              })()
              checks.push(job)
              return
            }
            hits++
            batch.push(e)
            if (Date.now() - lastFlush > 150) flush()
          }, { signal: ac.signal, concurrency: 6 })
        }
        await Promise.all(checks)
        flush(true)
        searches.delete(token)
      }
      void run()
      return token
    },
    'search.cancel': (token: string) => searches.get(token)?.abort(),

    /** Duplicate finder job: size -> head/tail hash -> full hash. */
    'dupes.run': (roots: string[], opts: { by: 'content' | 'name' | 'nameSize'; minSize?: number }) =>
      ctx.jobs.create('hash', 'Finding duplicates', async (ctl) => {
        const files: Entry[] = []
        for (const r of roots) await walk(ctx, r, (e) => { if (!e.dir && e.size >= (opts.minSize ?? 1)) files.push(e) }, { signal: ctl.signal })
        const groups: Entry[][] = []
        const by = (key: (e: Entry) => string, list: Entry[]) => {
          const m = new Map<string, Entry[]>()
          for (const e of list) {
            const k = key(e)
            const g = m.get(k)
            g ? g.push(e) : m.set(k, [e])
          }
          return [...m.values()].filter((g) => g.length > 1)
        }
        if (opts.by === 'name') groups.push(...by((e) => e.name.toLowerCase(), files))
        else if (opts.by === 'nameSize') groups.push(...by((e) => `${e.name.toLowerCase()}|${e.size}`, files))
        else {
          const sameSize = by((e) => String(e.size), files)
          const candidates = sameSize.flat()
          ctl.setTotal(candidates.reduce((a, e) => a + Math.min(e.size, 131072), 0), candidates.length)
          const quick = async (e: Entry) => {
            const fh = await fsp.open(e.path, 'r')
            try {
              const n = Math.min(65536, e.size)
              const a = Buffer.alloc(n)
              await fh.read(a, 0, n, 0)
              const b = Buffer.alloc(n)
              await fh.read(b, 0, n, Math.max(0, e.size - n))
              return createHash('sha1').update(a).update(b).digest('hex')
            } finally {
              await fh.close()
            }
          }
          for (const g of sameSize) {
            await ctl.checkpoint()
            const keyed = new Map<string, Entry[]>()
            for (const e of g) {
              try {
                const k = await quick(e)
                ctl.add(Math.min(e.size, 131072), 1)
                keyed.get(k)?.push(e) ?? keyed.set(k, [e])
              } catch (err: any) {
                ctl.fail(e.path, String(err?.message ?? err))
              }
            }
            for (const sub of keyed.values()) {
              if (sub.length < 2) continue
              if (sub[0].size <= 131072) {
                groups.push(sub)
                continue
              }
              // full hash only for files that still look identical
              const full = new Map<string, Entry[]>()
              for (const e of sub) {
                await ctl.checkpoint()
                ctl.setCurrent(e.path)
                const h = createHash('sha256')
                for await (const c of createReadStream(e.path, { highWaterMark: 1 << 20, signal: ctl.signal })) h.update(c as Buffer)
                const k = h.digest('hex')
                full.get(k)?.push(e) ?? full.set(k, [e])
              }
              for (const f of full.values()) if (f.length > 1) groups.push(f)
            }
          }
        }
        groups.sort((a, b) => b[0].size * b.length - a[0].size * a.length)
        ctx.emit('dupes', { jobId: ctl.info.id, groups: groups.slice(0, 5000) })
        return `${groups.length} groups`
      }, { immediate: true }),

  }
}
