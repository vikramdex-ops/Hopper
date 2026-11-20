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
import { compileQuery, passesFilters, type CompiledQuery, type LabelName } from '@shared/listing'
import { cleanLabelDefs } from '@shared/labels'

// ---------------------------------------------------------------------------
// Query parsing lives in src/shared/listing.ts (words AND-ed, * ?, ext:pdf, /regex/, and the
// date: / size: / type: filters) so the in-folder filter understands exactly the same language.

export function parseQuery(q: string, caseSensitive = false, weekStart?: number, labels?: readonly LabelName[]): CompiledQuery & IndexMatcher {
  return compileQuery(q, { caseSensitive, weekStart, labels })
}

// ---------------------------------------------------------------------------
// Index: one compact NameIndex per root (see nameindex.ts), kept current by a recursive watcher.

interface RootIndex {
  ix: NameIndex
  watcher?: FSWatcher
  /**
   * The index lives on disk and is not in memory (memory diet: the indexes of a few network
   * drives are hundreds of MB). `ix` is then an empty placeholder; `meta` keeps what status shows,
   * and folders the watcher reports are queued in `dirty` and applied when it is loaded again.
   */
  cold?: boolean
  meta?: { live: number; scannedAt?: number }
  dirty?: Set<string>
  /** more changes than are worth queueing: rebuild in the background on next load */
  overflow?: boolean
  lastUse: number
  waking?: Promise<void>
  /** a rebuild is running: never put to sleep mid-build */
  busy?: boolean
}

/** An index nobody searched for this long leaves memory (it is on disk already). */
const IDLE_COLD_MS = 3 * 60_000
const DIRTY_MAX = 20_000

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
      ...[...roots.values()].map((r) => (r.cold ? { path: r.ix.root, files: r.meta?.live ?? 0, ready: true, scannedAt: r.meta?.scannedAt } : { path: r.ix.root, files: r.ix.live, ready: r.ix.ready, scannedAt: r.ix.scannedAt })),
      ...[...covered].map(([path, outer]) => {
        const o = roots.get(outer.toLowerCase())?.ix
        return { path, files: 0, ready: !!o?.ready, scannedAt: o?.scannedAt, coveredBy: outer }
      })
    ],
    total: [...roots.values()].reduce((a, r) => a + (r.cold ? r.meta?.live ?? 0 : r.ix.live), 0),
    building
  })

  const metaFor = (root: string) => baseFor(root) + '.meta.json'
  const save = async (r: Pick<RootIndex, 'ix'>) => {
    if (r.ix.dead > r.ix.n * 0.2) r.ix = r.ix.compact()
    await fsp.mkdir(indexDir, { recursive: true })
    const f = fileFor(r.ix.root)
    await r.ix.save(f + '.tmp')
    await fsp.rename(f + '.tmp', f)
    // a few bytes beside it, so a cold index's size and age are known without loading it
    await fsp.writeFile(metaFor(r.ix.root), JSON.stringify({ live: r.ix.live, scannedAt: r.ix.scannedAt }), 'utf8').catch(() => {})
  }

  const readMeta = async (root: string): Promise<{ live: number; scannedAt?: number } | null> => {
    try {
      await fsp.access(fileFor(root))
      const j = JSON.parse(await fsp.readFile(metaFor(root), 'utf8'))
      return typeof j?.live === 'number' ? { live: j.live, scannedAt: typeof j.scannedAt === 'number' ? j.scannedAt : undefined } : null
    } catch {
      return null
    }
  }

  /** Load a cold index back into memory and apply what changed while it slept. */
  const wake = (r: RootIndex): Promise<void> => {
    r.lastUse = Date.now()
    if (!r.cold) return Promise.resolve()
    r.waking ??= (async () => {
      const ix = await load(r.ix.root)
      if (!ix) {
        r.cold = false
        r.busy = true
        await build(r.ix.root).catch(() => {})
        r.busy = false
        return
      }
      r.ix = ix
      r.cold = false
      const dirty = [...(r.dirty ?? [])]
      const overflow = r.overflow
      r.dirty = undefined
      r.overflow = false
      if (overflow || !ix.scannedAt || Date.now() - ix.scannedAt > 7 * 86400000) refresh(ix.root)
      else if (dirty.length) {
        await rescanDirs(r, dirty)
        dirtySave(r)
      }
    })().finally(() => {
      r.waking = undefined
      r.lastUse = Date.now()
    })
    return r.waking
  }

  /** Put idle indexes to sleep: saved first if changed, then dropped from memory. */
  const sleep = async (r: RootIndex) => {
    if (r.cold || r.busy || r.waking || !r.ix.ready) return
    if (saveTimers.has(r.ix.root)) {
      clearTimeout(saveTimers.get(r.ix.root))
      saveTimers.delete(r.ix.root)
      try {
        await save(r)
      } catch {
        return // could not be saved: keep it in memory rather than lose changes
      }
    }
    if (r.cold || r.busy || r.waking || Date.now() - r.lastUse < IDLE_COLD_MS) return
    r.meta = { live: r.ix.live, scannedAt: r.ix.scannedAt }
    const root = r.ix.root
    r.ix = new NameIndex(root)
    r.cold = true
    r.dirty = new Set()
    // the index's Buffers are freed only when V8 collects; do it now rather than "eventually"
    setTimeout(() => (globalThis as { gc?: () => void }).gc?.(), 100)
  }
  setInterval(() => {
    for (const r of roots.values()) if (!r.cold && Date.now() - r.lastUse >= IDLE_COLD_MS) void sleep(r)
  }, 30_000).unref?.()

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
    saveTimers.set(
      r.ix.root,
      setTimeout(() => {
        saveTimers.delete(r.ix.root)
        void save(r).catch(() => {})
      }, 60000)
    )
  }

  const startWatcher = (r: RootIndex) => {
    if (r.watcher) return
    const pending = new Set<string>()
    let timer: NodeJS.Timeout | undefined
    try {
      r.watcher = watch(r.ix.root, { recursive: true, persistent: false }, (_ev, rel) => {
        if (!rel) return
        if (r.cold) {
          // asleep: remember the folder, re-list it on wake
          if (r.dirty && r.dirty.size < DIRTY_MAX) r.dirty.add(dirname(join(r.ix.root, rel.toString())))
          else r.overflow = true
          return
        }
        pending.add(dirname(join(r.ix.root, rel.toString())))
        clearTimeout(timer)
        timer = setTimeout(async () => {
          const dirs = [...pending]
          pending.clear()
          if (r.cold) {
            for (const d of dirs) r.dirty?.add(d)
            return
          }
          await rescanDirs(r, dirs)
          dirtySave(r)
          // live views of saved searches (smart folders) refresh when their folders change
          ctx.emit('index-changed', { dirs })
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
    if (!r) roots.set(key, (r = { ix, lastUse: Date.now() }))
    r.busy = true
    try {
      await walk(ctx, root, (e) => {
        // skip noise that nobody searches for
        if (e.dir && /^(\$recycle\.bin|system volume information|node_modules|\.git)$/i.test(e.name)) return false
        ix.add(e.name, dirname(e.path), e.dir, e.size, e.mtime)
      }, { concurrency: 3, lane: 'index' })
    } finally {
      r.busy = false
    }
    ix.trim()
    ix.ready = true
    ix.scannedAt = Date.now()
    if (roots.get(key) !== r) return // the root was removed while building
    // the fresh build replaces whatever was there (also a sleeping index and its queued changes)
    r.ix = ix
    r.cold = false
    r.dirty = undefined
    r.overflow = false
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
      const base = join(indexDir, f.replace(/\.(bin|ix2|meta\.json)(\.tmp)?$/, ''))
      // a kept root's .bin was converted (and removed) on load; any other is stale
      if ((f.endsWith('.bin') || f.endsWith('.ix2') || f.endsWith('.meta.json')) && !keep.has(base)) await fsp.rm(join(indexDir, f), { force: true }).catch(() => {})
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
      const have = roots.get(root.toLowerCase())
      if (have && (have.cold || have.ix.ready)) continue
      // memory diet: an index already on disk starts asleep; the first search loads it
      const meta = await readMeta(root)
      if (meta) {
        const r: RootIndex = { ix: new NameIndex(root), cold: true, meta, dirty: new Set(), lastUse: 0 }
        roots.set(root.toLowerCase(), r)
        startWatcher(r)
        ctx.emit('index', status())
        // no daily rebuild at startup: the watcher keeps it current, and a stale one is refreshed
        // when it is next woken (a rebuild holds a second full index in memory while it runs)
        continue
      }
      const loaded = await load(root)
      if (loaded) {
        const r: RootIndex = { ix: loaded, lastUse: Date.now() }
        roots.set(root.toLowerCase(), r)
        startWatcher(r)
        // writes the .meta.json for next time
        void save(r).catch(() => {})
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

  const query = (q: string, opts: { limit?: number; dirsOnly?: boolean; under?: string; weekStart?: number } = {}) => {
    const t = Date.now()
    const m = parseQuery(q, false, opts.weekStart, cleanLabelDefs(ctx.office?.labels))
    const limit = opts.limit ?? 500
    const out: Entry[] = []
    const under = opts.under ? norm(opts.under) : undefined
    // folder, size and date filters read the index's own columns: no file is touched
    const f = m.filters
    const pre = (ix: NameIndex) =>
      opts.dirsOnly || m.filtered
        ? (i: number) => (!opts.dirsOnly || ix.isDirEntry(i)) && (!m.filtered || passesFilters({ dir: ix.isDirEntry(i), size: ix.sizeOf(i), mtime: ix.mtimeOf(i), label: f.labels ? labelAt(ix, i) : undefined }, f))
        : undefined
    if (f.never) return { entries: out, total: 0, ms: 0 }
    // label: filters read the labels already loaded (search.run loads them first)
    const labelAt = (ix: NameIndex, i: number) => {
      const h = ix.hit(i)
      return ctx.labels.labelOf(join(h.dir, h.name))
    }
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
      }, pre(ix))
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
    /** memory diagnostics: which indexes are in memory, and the process's own counters */
    'index.memory': () => ({
      roots: [...roots.values()].map((r) => ({ root: r.ix.root, cold: !!r.cold, busy: !!r.busy, idleS: Math.round((Date.now() - r.lastUse) / 1000), saving: saveTimers.has(r.ix.root) })),
      mem: process.memoryUsage()
    }),
    'index.rebuild': async (root?: string) => {
      for (const r of root ? [root] : [...roots.values()].map((x) => x.ix.root)) await build(r)
      return status()
    },
    'index.query': async (q: string, opts?: { limit?: number; dirsOnly?: boolean; under?: string; weekStart?: number }) => {
      // wake only the indexes this query can use
      const under = opts?.under ? norm(opts.under) : undefined
      const need = [...roots.values()].filter((r) => !under || norm(r.ix.root).startsWith(under) || under.startsWith(norm(r.ix.root)))
      await Promise.all(need.map((r) => wake(r).catch(() => {})))
      return query(q, opts)
    },

    'search.run': (token: string, q: SearchQuery) => {
      const ac = new AbortController()
      searches.set(token, ac)
      const m = parseQuery(q.name || '', false, q.weekStart, cleanLabelDefs(ctx.office?.labels))
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
        if (m.filters.labels) await ctx.labels.preload(q.roots).catch(() => {})
        for (const root of q.roots) {
          await walk(ctx, root, (e) => {
            scanned++
            if (ac.signal.aborted || hits >= limit) return false
            if (!m.test(e.name.toLowerCase())) return
            if (m.filtered && !passesFilters(m.filters.labels ? { ...e, label: ctx.labels.labelOf(e.path) } : e, m.filters)) return
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
