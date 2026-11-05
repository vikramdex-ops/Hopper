// Directory listing, metadata and small file operations.
// Listing goes through HopperShell's FindFirstFileEx (attributes + sizes + times in one pass,
// which is several times faster than readdir+stat on SMB shares); Node is the fallback.
import { createReadStream, promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ATTR, type Entry, type ListResult } from '@shared/types'
import type { RawEntry } from '@shared/hshell'
import type { EngineCtx } from './index'
import { exists, extOf, freeName, moveOne } from './fsutil'

const REPARSE_SYMLINK = 0xa000000c
const REPARSE_MOUNT = 0xa0000003

export function toEntry(dir: string, r: RawEntry): Entry {
  const [name, attrs, size, mtime, ctime, atime] = r
  const isDir = (attrs & ATTR.directory) !== 0
  return { name, path: join(dir, name), dir: isDir, size: isDir ? 0 : size, mtime, ctime, atime, attrs, ext: isDir ? '' : extOf(name) }
}

async function listNode(dir: string): Promise<Entry[]> {
  const names = await fsp.readdir(dir)
  const out: Entry[] = new Array(names.length)
  let i = 0
  const worker = async () => {
    while (i < names.length) {
      const k = i++
      const p = join(dir, names[k])
      try {
        const st = await fsp.stat(p)
        const isDir = st.isDirectory()
        out[k] = { name: names[k], path: p, dir: isDir, size: isDir ? 0 : st.size, mtime: st.mtimeMs, ctime: st.birthtimeMs, atime: st.atimeMs, attrs: isDir ? ATTR.directory : 0, ext: isDir ? '' : extOf(names[k]) }
      } catch {
        out[k] = { name: names[k], path: p, dir: false, size: 0, mtime: 0, ctime: 0, atime: 0, attrs: 0, ext: extOf(names[k]) }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(32, names.length) }, worker))
  return out
}

export type Lane = 'ui' | 'bulk' | 'index'

export async function listRaw(ctx: EngineCtx, dir: string, lane: Lane = 'ui'): Promise<Entry[]> {
  const shell = lane === 'index' ? ctx.indexShell : lane === 'bulk' ? ctx.bulkShell : ctx.shell
  try {
    const raw = await shell.call<RawEntry[]>('list', { path: dir }, 120000)
    return raw.map((r) => {
      const e = toEntry(dir, r)
      const tag = r[6] >>> 0
      if ((e.attrs & ATTR.reparse) !== 0 && (tag === REPARSE_SYMLINK || tag === REPARSE_MOUNT)) e.link = '?'
      return e
    })
  } catch (err: any) {
    // Helper unavailable (or an odd path); Node is slower but always works.
    if (/HopperShell/.test(String(err?.message))) return listNode(dir)
    throw normalizeError(err, dir)
  }
}

function normalizeError(err: any, p: string) {
  const m = String(err?.message ?? err)
  if (/access is denied/i.test(m)) return new Error(`Access denied: ${p}`)
  if (/cannot find the path|network path was not found|cannot find the file/i.test(m)) return new Error(`Not found: ${p}`)
  if (/not ready/i.test(m)) return new Error(`Drive not ready: ${p}`)
  return new Error(m)
}

/** Depth-first walk with bounded concurrency. Calls `visit` for every entry below root. */
export async function walk(ctx: EngineCtx, root: string, visit: (e: Entry) => boolean | void, opts: { signal?: AbortSignal; concurrency?: number; onError?: (p: string, m: string) => void; lane?: Lane } = {}) {
  const queue = [root]
  let active = 0
  await new Promise<void>((resolve) => {
    const next = () => {
      if (opts.signal?.aborted) {
        if (active === 0) resolve()
        return
      }
      while (active < (opts.concurrency ?? 8) && queue.length) {
        const dir = queue.pop()!
        active++
        listRaw(ctx, dir, opts.lane ?? 'bulk')
          .then((entries) => {
            for (const e of entries) {
              // false from visit = don't descend
              if (visit(e) !== false && e.dir && !e.link) queue.push(e.path)
            }
          })
          .catch((err) => opts.onError?.(dir, String(err?.message ?? err)))
          .finally(() => {
            active--
            if (!queue.length && active === 0) resolve()
            else next()
          })
      }
    }
    next()
  })
}

function decode(buf: Buffer): { text: string; encoding: string } {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString('utf8'), encoding: 'utf8-bom' }
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf16le' }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const body = buf.subarray(2, buf.length - (buf.length % 2))
    const sw = Buffer.from(body).swap16()
    return { text: sw.toString('utf16le'), encoding: 'utf16be' }
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf)
  // Lots of replacement characters means a legacy code page (most often Windows-1252).
  const bad = (text.match(/�/g) ?? []).length
  if (bad > 2 && bad > text.length / 200) return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'windows-1252' }
  return { text, encoding: 'utf8' }
}

export function fsHandlers(ctx: EngineCtx) {
  return {
    'fs.list': async (dir: string): Promise<ListResult> => {
      const t = Date.now()
      const entries = await listRaw(ctx, dir)
      return { path: dir, entries, errors: 0, ms: Date.now() - t }
    },
    'fs.stat': async (p: string) => {
      try {
        const st = await fsp.stat(p)
        return { exists: true, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, ctime: st.birthtimeMs, atime: st.atimeMs }
      } catch {
        return { exists: false }
      }
    },
    'fs.exists': (p: string) => exists(p),
    'fs.mkdir': async (dir: string, name: string) => {
      const p = await freeName(join(dir, name))
      await fsp.mkdir(p)
      ctx.undo.record({ kind: 'new', label: `New folder ${name}`, pairs: [['', p]] })
      return p
    },
    'fs.newFile': async (dir: string, name: string, content = '') => {
      const p = await freeName(join(dir, name))
      await fsp.writeFile(p, content, { flag: 'wx' })
      ctx.undo.record({ kind: 'new', label: `New file ${name}`, pairs: [['', p]] })
      return p
    },
    'fs.rename': async (from: string, to: string) => {
      if (from === to) return to
      // Allow case-only renames on Windows (same file, different case).
      if (from.toLowerCase() !== to.toLowerCase() && (await exists(to))) throw new Error(`"${to}" already exists`)
      await moveOne(from, to)
      ctx.undo.record({ kind: 'rename', label: `Rename ${from.split('\\').pop()}`, pairs: [[from, to]] })
      return to
    },
    'fs.renameMany': async (pairs: [string, string][]) => {
      const lower = new Set<string>()
      for (const [, to] of pairs) {
        const k = to.toLowerCase()
        if (lower.has(k)) throw new Error(`Two files would be named "${to.split('\\').pop()}"`)
        lower.add(k)
      }
      // Two phases through temp names so A->B, B->A swaps work.
      const temp: [string, string, string][] = pairs.filter(([a, b]) => a !== b).map(([a, b], i) => [a, `${a}.hopper-rn${i}`, b])
      const done: [string, string][] = []
      const failed: { path: string; message: string }[] = []
      const moved: [string, string][] = []
      try {
        for (const [a, t] of temp) {
          await fsp.rename(a, t)
          moved.push([a, t])
        }
      } catch (e) {
        // Put back anything already moved to a temp name, then report.
        for (const [a, t] of moved.reverse()) await fsp.rename(t, a).catch(() => {})
        throw e
      }
      for (const [a, t, b] of temp) {
        try {
          if (a.toLowerCase() !== b.toLowerCase() && (await exists(b))) throw new Error('target exists')
          await fsp.rename(t, b)
          done.push([a, b])
        } catch (e: any) {
          await fsp.rename(t, a).catch(() => {})
          failed.push({ path: a, message: String(e?.message ?? e) })
        }
      }
      if (done.length) ctx.undo.record({ kind: 'rename', label: `Rename ${done.length} items`, pairs: done })
      return { done: done.length, failed }
    },
    'fs.readText': async (p: string, maxBytes = 1024 * 1024) => {
      const fh = await fsp.open(p, 'r')
      try {
        const st = await fh.stat()
        const n = Math.min(st.size, maxBytes)
        const buf = Buffer.alloc(n)
        await fh.read(buf, 0, n, 0)
        const binary = buf.subarray(0, Math.min(n, 8000)).includes(0) && !(buf[0] === 0xff && buf[1] === 0xfe) && !(buf[0] === 0xfe && buf[1] === 0xff)
        const { text, encoding } = decode(buf)
        return { text: binary ? '' : text, encoding, size: st.size, truncated: st.size > n, binary }
      } finally {
        await fh.close()
      }
    },
    'fs.writeText': async (p: string, text: string, encoding = 'utf8') => {
      let data: Buffer
      if (encoding === 'utf16le') data = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
      else if (encoding === 'utf8-bom') data = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
      else if (encoding === 'windows-1252') data = Buffer.from(text, 'latin1')
      else data = Buffer.from(text, 'utf8')
      const tmp = `${p}.hopper-save`
      await fsp.writeFile(tmp, data)
      await fsp.rename(tmp, p)
      return true
    },
    'fs.readBytes': async (p: string, offset = 0, length = 4096) => {
      const fh = await fsp.open(p, 'r')
      try {
        const buf = Buffer.alloc(length)
        const { bytesRead } = await fh.read(buf, 0, length, offset)
        return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead)
      } finally {
        await fh.close()
      }
    },
    'fs.hash': (p: string, algo = 'sha256') =>
      new Promise<string>((resolve, reject) => {
        const h = createHash(algo)
        createReadStream(p, { highWaterMark: 1024 * 1024 })
          .on('data', (c) => h.update(c))
          .on('end', () => resolve(h.digest('hex')))
          .on('error', reject)
      }),
    /** Recursive size; emits 'size' {path, bytes, files, dirs, done} as it goes. */
    'fs.size': async (paths: string[], token: string) => {
      const ac = new AbortController()
      sizeJobs.set(token, ac)
      try {
        await Promise.all(
          paths.map(async (root) => {
            let bytes = 0
            let files = 0
            let dirs = 0
            let last = 0
            await walk(ctx, root, (e) => {
              if (e.dir) dirs++
              else {
                files++
                bytes += e.size
              }
              const now = Date.now()
              if (now - last > 250) {
                last = now
                ctx.emit('size', { token, path: root, bytes, files, dirs, done: false })
              }
            }, { signal: ac.signal })
            ctx.emit('size', { token, path: root, bytes, files, dirs, done: !ac.signal.aborted })
          })
        )
      } finally {
        sizeJobs.delete(token)
      }
    },
    'fs.sizeCancel': (token: string) => sizeJobs.get(token)?.abort(),
    'fs.recordRecycle': (paths: string[]) => ctx.undo.record({ kind: 'recycle', label: `Delete ${paths.length} item${paths.length > 1 ? 's' : ''}`, pairs: paths.map((p) => [p, '']) }),
    'fs.deletePermanent': async (paths: string[]) => {
      const failed: { path: string; message: string }[] = []
      for (const p of paths) {
        try {
          await fsp.rm(p, { recursive: true, force: false, maxRetries: 2 })
        } catch (e: any) {
          failed.push({ path: p, message: String(e?.message ?? e) })
        }
      }
      return { failed }
    }
  }
}

const sizeJobs = new Map<string, AbortController>()
