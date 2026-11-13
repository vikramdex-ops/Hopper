// Instant name search (an in-memory index kept current by recursive watchers),
// on-demand content search, and the duplicate finder.
import { createReadStream, promises as fsp, watch, type FSWatcher } from 'node:fs'
import { createHash } from 'node:crypto'
import { deserialize } from 'node:v8'
import { dirname, join } from 'node:path'
import type { Entry, IndexStatus, SearchQuery } from '@shared/types'
import type { EngineCtx } from './index'
import { listRaw, walk } from './fsops'
import { extOf } from './fsutil'
import { NameIndex, type IndexMatcher } from './nameindex'

// ---------------------------------------------------------------------------
// Query parsing: words are AND-ed, * and ? are wildcards, ext:pdf, /regex/

interface Matcher extends IndexMatcher {
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
  // The longest literal that every match must contain lets the index jump straight to hits.
  let anchor = ''
  const words: string[] = []
  let wild = false
  const literal = (t: string) => {
    if (t.length > anchor.length) anchor = t
  }
  for (const raw of q.trim().split(/\s+/).filter(Boolean)) {
    const m = /^ext:(.+)$/i.exec(raw)
    if (m) {
      for (const e of m[1].split(/[,;]/)) exts.add(e.replace(/^\./, '').toLowerCase())
      continue
    }
    const w = raw.toLowerCase()
    if (/[*?]/.test(w)) {
      wild = true
      for (const part of w.split(/[*?]/)) literal(part)
      const r = new RegExp('^' + w.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
      tests.push((n) => r.test(n))
    } else {
      literal(w)
      words.push(w)
      tests.push((n) => n.includes(w))
    }
  }
  if (!anchor && exts.size === 1) anchor = '.' + [...exts][0]
  return {
    anchor: anchor || undefined,
    // extOf() never returns '' for a name with an extension or anything containing a dot
    plain: wild || [...exts].some((e) => !e || e.includes('.')) ? undefined : { words, exts: [...exts] },
    ext: exts.size ? exts : undefined,
    test: (n) => {
      if (exts.size && !exts.has(extOf(n))) return false
      for (const t of tests) if (!t(n)) return false
      return true
    }
  }
}

// ---------------------------------------------------------------------------
// Index: one compact NameIndex per root (see nameindex.ts), kept current by a recursive watcher.

interface RootIndex {
  ix: NameIndex
  watcher?: FSWatcher
}

const norm = (p: string) => (p.endsWith('\\') ? p : p + '\\').toLowerCase()

/** Roots that sit inside another wanted root are covered by it; indexing them again doubles the memory. */
export function nestedRoots(want: string[]) {
  const covered = new Map<string, string>()
  const sorted = [...new Set(want)].sort((a, b) => a.length - b.length)
  const kept: string[] = []
  for (const r of sorted) {
    const outer = kept.find((o) => norm(r).startsWith(norm(o)))
    if (outer) covered.set(r, outer)
    else kept.push(r)
  }
  return { kept, covered }
}

/** Convert an index saved by Hopper 2.6 and earlier (v8-serialised arrays). */
function fromV1(root: string, d: any): NameIndex {
  const ix = new NameIndex(root)
  for (let i = 0; i < d.names.length; i++) ix.add(d.names[i], d.dirs[d.dirOf[i]], !!d.isDir[i], d.size[i], d.mtime[i])
  ix.trim()
  ix.ready = true
  ix.scannedAt = d.scannedAt
  return ix
}

export function searchHandlers(ctx: EngineCtx) {
  const roots = new Map<string, RootIndex>()
  let covered = new Map<string, string>()
  const indexDir = join(ctx.dataDir, 'index')
  let building = false
  const baseFor = (root: string) => join(indexDir, createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16))
  const fileFor = (root: string) => baseFor(root) + '.ix2'

  const status = (): IndexStatus => ({
    roots: [
      ...[...roots.values()].map((r) => ({ path: r.ix.root, files: r.ix.live, ready: r.ix.ready, scannedAt: r.ix.scannedAt })),
      ...[...covered].map(([path, outer]) => {
        const o = roots.get(outer.toLowerCase())?.ix
        return { path, files: 0, ready: !!o?.ready, scannedAt: o?.scannedAt, coveredBy: outer }
      })
    ],
    total: [...roots.values()].reduce((a, r) => a + r.ix.live, 0),
    building
  })

  const save = async (r: RootIndex) => {
    if (r.ix.dead > r.ix.n * 0.2) r.ix = r.ix.compact()
    await fsp.mkdir(indexDir, { recursive: true })
    const f = fileFor(r.ix.root)
    await r.ix.save(f + '.tmp')
    await fsp.rename(f + '.tmp', f)
  }

  const load = async (root: string): Promise<NameIndex | null> => {
    try {
      const ix = await NameIndex.load(fileFor(root))
      if (ix) return ix
    } catch {
      /* missing or unreadable: fall through */
    }
    // Older format: convert once, then drop the old file.
    const old = baseFor(root) + '.bin'
    try {
      const ix = fromV1(root, deserialize(await fsp.readFile(old)))
      // the old file goes only once the new one is safely written
      if (await save({ ix }).then(() => true, () => false)) await fsp.rm(old, { force: true }).catch(() => {})
      return ix
    } catch {
      return null
    }
  }

  /** Re-list changed folders and patch the index (called from the recursive watcher). */
  const rescanDirs = async (r: RootIndex, dirs: string[]) => {
    const fresh = await Promise.all(dirs.map((d) => listRaw(ctx, d, 'index').catch(() => [] as Entry[])))
    const ix = r.ix
    const ids = new Set<number>()
    for (const d of dirs) {
      const id = ix.lookupDir(d)
      if (id >= 0) ids.add(id)
    }
    ix.removeIn(ids)
    for (let k = 0; k < dirs.length; k++) for (const e of fresh[k]) ix.add(e.name, dirs[k], e.dir, e.size, e.mtime)
  }

  const saveTimers = new Map<string, NodeJS.Timeout>()
  const dirtySave = (r: RootIndex) => {
    clearTimeout(saveTimers.get(r.ix.root))
    saveTimers.set(r.ix.root, setTimeout(() => void save(r).catch(() => {}), 60000))
  }

  const startWatcher = (r: RootIndex) => {
    if (r.watcher) return
    const pending = new Set<string>()
    let timer: NodeJS.Timeout | undefined
    try {
      r.watcher = watch(r.ix.root, { recursive: true, persistent: false }, (_ev, rel) => {
        if (!rel) return
        pending.add(dirname(join(r.ix.root, rel.toString())))
        clearTimeout(timer)
        timer = setTimeout(async () => {
          const dirs = [...pending]
          pending.clear()
          await rescanDirs(r, dirs)
          dirtySave(r)
        }, 1500)
      })
      r.watcher.on('error', () => {
        r.watcher?.close()
        r.watcher = undefined
      })
    } catch {
      /* not watchable */
    }
  }

  const build = async (root: string) => {
    const ix = new NameIndex(root)
    const key = root.toLowerCase()
    let r = roots.get(key)
    // keep serving the old index while the new one builds
    if (!r) roots.set(key, (r = { ix }))
    await walk(ctx, root, (e) => {
      // skip noise that nobody searches for
      if (e.dir && /^(\$recycle\.bin|system volume information|node_modules|\.git)$/i.test(e.name)) return false
      ix.add(e.name, dirname(e.path), e.dir, e.size, e.mtime)
    }, { concurrency: 3, lane: 'index' })
    ix.trim()
    ix.ready = true
    ix.scannedAt = Date.now()
    if (roots.get(key) !== r) return // the root was removed while building
    r.ix = ix
    startWatcher(r)
    await save(r).catch(() => {})
    ctx.emit('index', status())
  }

  // Background refreshes run one at a time: each holds a second index while the old one is
  // served, and several drives walked at once multiplied that.
  let refreshes = Promise.resolve()
  const refresh = (root: string) => {
    refreshes = refreshes.then(() => (roots.has(root.toLowerCase()) ? build(root) : undefined)).catch(() => {})
  }

  /** Delete index files of folders that are no longer indexed (they are hundreds of MB each). */
  const dropUnused = async (want: string[]) => {
    if (!want.length) return // indexing switched off: keep the files for when it comes back
    const keep = new Set(want.map((r) => baseFor(r)))
    const names = await fsp.readdir(indexDir).catch(() => [] as string[])
    for (const f of names) {
      const base = join(indexDir, f.replace(/\.(bin|ix2)(\.tmp)?$/, ''))
      // a kept root's .bin was converted (and removed) on load; any other is stale
      if ((f.endsWith('.bin') || f.endsWith('.ix2')) && !keep.has(base)) await fsp.rm(join(indexDir, f), { force: true }).catch(() => {})
    }
  }

  let generation = 0
  const configure = async (wantAll: string[]) => {
    const gen = ++generation
    const nest = nestedRoots(wantAll)
    covered = nest.covered
    const want = nest.kept
    const wanted = new Set(want.map((w) => w.toLowerCase()))
    for (const [k, r] of roots) {
      if (!wanted.has(k)) {
        r.watcher?.close()
        clearTimeout(saveTimers.get(r.ix.root))
        roots.delete(k)
      }
    }
    building = true
    ctx.emit('index', status())
    for (const root of want) {
      if (roots.get(root.toLowerCase())?.ix.ready) continue
      const loaded = await load(root)
      if (loaded) {
        const r: RootIndex = { ix: loaded }
        roots.set(root.toLowerCase(), r)
        startWatcher(r)
        ctx.emit('index', status())
        // refresh stale indexes in the background (older than a day)
        if (!loaded.scannedAt || Date.now() - loaded.scannedAt > 86400000) refresh(root)
      } else {
        await build(root).catch(() => {})
      }
    }
    building = false
    ctx.emit('index', status())
    if (gen === generation) await dropUnused(want) // a newer configure decides instead
  }

  const query = (q: string, opts: { limit?: number; dirsOnly?: boolean; under?: string } = {}) => {
    const t = Date.now()
    const m = parseQuery(q)
    const limit = opts.limit ?? 500
    const out: Entry[] = []
    const under = opts.under ? norm(opts.under) : undefined
    for (const { ix } of roots.values()) {
      if (out.length >= limit) break
      // a search inside one folder never needs the other drives' indexes
      if (under && !norm(ix.root).startsWith(under) && !under.startsWith(norm(ix.root))) continue
      // whether a folder lies under `under`, worked out once per folder
      const inside = new Map<number, boolean>()
      ix.scan(m, (i) => {
        if (under) {
          const d = ix.dirIdOf(i)
          let ok = inside.get(d)
          if (ok === undefined) inside.set(d, (ok = norm(ix.dirPath(d)).startsWith(under)))
          if (!ok) return
        }
        const h = ix.hit(i)
        out.push({ name: h.name, path: join(h.dir, h.name), dir: h.isDir, size: h.size, mtime: h.mtime, ctime: 0, atime: 0, attrs: h.isDir ? 0x10 : 0, ext: h.isDir ? '' : extOf(h.name) })
        // stop at the limit: callers only show the entries, and counting every hit of a
        // one-letter query over millions of names costs seconds
        return out.length < limit
      }, opts.dirsOnly ? (i) => ix.isDirEntry(i) : undefined)
    }
    // total is a lower bound once the limit is reached
    const total = out.length
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
      for (const r of root ? [root] : [...roots.values()].map((x) => x.ix.root)) await build(r)
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
