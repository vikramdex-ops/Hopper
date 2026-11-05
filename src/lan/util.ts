// File-system and timing helpers for the lan process. All copies stream; nothing buffers a file.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs'
import { basename, dirname, join, parse } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FileItem } from './types'

export const CHUNK = 1024 * 1024

export async function exists(p: string) {
  try {
    await fsp.lstat(p)
    return true
  } catch {
    return false
  }
}

/** "name.ext" -> "name (2).ext" (or "folder (2)"), the first free one. */
export async function freeName(p: string, isDir = false) {
  if (!(await exists(p))) return p
  const { dir, name, ext } = isDir ? { dir: dirname(p), name: basename(p), ext: '' } : parse(p)
  for (let i = 2; i < 10000; i++) {
    const c = join(dir, `${name} (${i})${ext}`)
    if (!(await exists(c))) return c
  }
  throw new Error('no free name')
}

/** Create a new, never-existing folder (adds " (2)" etc.). */
export async function makeFreshDir(p: string) {
  await fsp.mkdir(dirname(p), { recursive: true })
  for (let i = 0; i < 20; i++) {
    const c = await freeName(p, true)
    try {
      await fsp.mkdir(c)
      return c
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e
    }
  }
  throw new Error('could not create folder')
}

export async function readJson<T>(p: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8')) as T
  } catch {
    return fallback
  }
}

export async function writeJsonAtomic(p: string, data: unknown) {
  await fsp.mkdir(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(data, null, 1), 'utf8')
  await fsp.rename(tmp, p)
}

/** Coalesces saves: at most one write per `ms`, always writing the latest state. */
export function saver(ms: number, write: () => Promise<void>) {
  let timer: NodeJS.Timeout | null = null
  let running: Promise<void> | null = null
  const run = async () => {
    timer = null
    running = write().catch((e) => console.error('[lan] save failed', e?.message ?? e))
    await running
    running = null
  }
  return {
    schedule() {
      if (!timer) timer = setTimeout(run, ms)
    },
    async flush() {
      if (timer) {
        clearTimeout(timer)
        await run()
      } else if (running) await running
    }
  }
}

export async function hashFile(p: string, signal?: AbortSignal) {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(p, { highWaterMark: CHUNK, signal })) h.update(chunk as Buffer)
  return h.digest('hex')
}

/** Stream src to dst, returning the SHA-256 of what was read. */
export async function copyWithHash(src: string, dst: string, onBytes: (n: number) => void, signal?: AbortSignal) {
  const h = createHash('sha256')
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      h.update(chunk)
      onBytes(chunk.length)
      cb(null, chunk)
    }
  })
  await fsp.mkdir(dirname(dst), { recursive: true })
  await pipeline(createReadStream(src, { highWaterMark: CHUNK }), tap, createWriteStream(dst), { signal })
  return h.digest('hex')
}

/**
 * Expand the share's paths into files plus empty folders. Each top-level path keeps its own name
 * as the root of its relative paths. Symlinks and junctions are skipped (no loops, no surprises).
 */
export async function walk(paths: string[]) {
  const files: FileItem[] = []
  const dirs: string[] = []
  const errors: string[] = []
  const visit = async (abs: string, rel: string) => {
    let st
    try {
      st = await fsp.lstat(abs)
    } catch (e: any) {
      errors.push(`${abs}: ${e.code ?? e.message}`)
      return
    }
    if (st.isSymbolicLink()) {
      errors.push(`${abs}: link skipped`)
      return
    }
    if (st.isFile()) {
      files.push({ rel, abs, size: st.size, mtime: st.mtimeMs })
      return
    }
    if (!st.isDirectory()) return
    let names: string[]
    try {
      names = await fsp.readdir(abs)
    } catch (e: any) {
      errors.push(`${abs}: ${e.code ?? e.message}`)
      return
    }
    if (!names.length) dirs.push(rel)
    for (const n of names) await visit(join(abs, n), `${rel}/${n}`)
  }
  const seen = new Set<string>()
  for (const p of paths) {
    let name = basename(p.replace(/[\\/]+$/, '')) || p.replace(/[:\\/]/g, '')
    // two roots with the same name (C:\a\x and D:\b\x) must not collide on the receiver
    for (let i = 2; seen.has(name.toLowerCase()); i++) name = `${basename(p)} (${i})`
    seen.add(name.toLowerCase())
    await visit(p, name)
  }
  return { files, dirs, errors }
}

/** Abortable sleep; timers are unref'd so they never hold the process open. */
export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
    const t = setTimeout(done, ms)
    t.unref()
    function done() {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    function onAbort() {
      clearTimeout(t)
      reject(signal!.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Run fn over items with at most n in flight. */
export async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let i = 0
  const worker = async () => {
    while (i < items.length) await fn(items[i++])
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
}

/** Exponential moving average of bytes/second, sampled at most every 500 ms. */
export function rateMeter() {
  let lastT = Date.now()
  let lastDone = 0
  let rate = 0
  return (done: number) => {
    const now = Date.now()
    const dt = now - lastT
    if (dt >= 500) {
      const inst = ((done - lastDone) * 1000) / dt
      rate = rate ? rate * 0.6 + inst * 0.4 : inst
      lastT = now
      lastDone = done
    }
    return Math.max(0, Math.round(rate))
  }
}
