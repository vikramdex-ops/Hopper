// Copy / move engine behind the transfer queue.
// - same-volume move = rename (instant), otherwise copy then delete source
// - folders are expanded with the fast lister; empty folders are kept
// - small files copy in parallel (CopyFileW), large files stream in 4 MB chunks so they
//   report progress and can pause/cancel mid-file
// - one conflict prompt with "apply to all"; optional SHA-256 verify; retries on flaky shares
import { createReadStream, promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative } from 'node:path'
import type { ConflictPolicy, TransferSpec } from '@shared/types'
import type { EngineCtx } from './index'
import { Cancelled, type JobCtl } from './jobs'
import { listRaw, walk } from './fsops'
import { exists, freeName, isInside, moveOne, sameVolume, volumeOf, wildcard } from './fsutil'

const CHUNK = 4 * 1024 * 1024
const SMALL = 8 * 1024 * 1024
const RETRYABLE = new Set(['EBUSY', 'ECONNRESET', 'ENETRESET', 'ENETUNREACH', 'EIO', 'EAGAIN', 'UNKNOWN', 'ETIMEDOUT', 'EPIPE'])

interface Item {
  src: string
  dst: string
  size: number
  mtime: number
  dir: boolean
}

async function hashFile(p: string, signal: AbortSignal) {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(p, { highWaterMark: CHUNK, signal })) h.update(chunk as Buffer)
  return h.digest('hex')
}

async function streamCopy(ctl: JobCtl, src: string, dst: string, mtime: number) {
  const tmp = `${dst}.hopper-part`
  const rd = await fsp.open(src, 'r')
  let wr: fsp.FileHandle | undefined
  try {
    wr = await fsp.open(tmp, 'w')
    const buf = Buffer.allocUnsafe(CHUNK)
    let pos = 0
    for (;;) {
      await ctl.checkpoint()
      const { bytesRead } = await rd.read(buf, 0, CHUNK, pos)
      if (!bytesRead) break
      await wr.write(buf, 0, bytesRead, pos)
      pos += bytesRead
      ctl.add(bytesRead)
    }
    await wr.close()
    wr = undefined
    await fsp.utimes(tmp, new Date(), new Date(mtime))
    await fsp.rename(tmp, dst)
  } catch (e) {
    await wr?.close().catch(() => {})
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw e
  } finally {
    await rd.close()
  }
}

async function withRetry<T>(ctl: JobCtl, fn: () => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (e: any) {
      if (e instanceof Cancelled || ctl.cancelled || attempt >= 3 || !RETRYABLE.has(e?.code)) throw e
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
    }
  }
}

/** Expand sources into a flat list of items with destination paths. */
async function plan(ctx: EngineCtx, ctl: JobCtl, spec: TransferSpec) {
  const items: Item[] = []
  const tops: { src: string; dst: string; dir: boolean }[] = []
  const accept = wildcard(spec.filter)
  let bytes = 0
  for (const src of spec.sources) {
    await ctl.checkpoint()
    const st = await fsp.stat(src)
    const dst = join(spec.dest, basename(src))
    if (st.isDirectory() && isInside(spec.dest, src)) throw new Error(`Cannot ${spec.op} "${basename(src)}" into itself`)
    if (src.toLowerCase() === dst.toLowerCase() && spec.op === 'move') continue
    tops.push({ src, dst, dir: st.isDirectory() })
    if (!st.isDirectory()) {
      if (!accept(basename(src))) continue
      items.push({ src, dst, size: st.size, mtime: st.mtimeMs, dir: false })
      bytes += st.size
      continue
    }
    items.push({ src, dst, size: 0, mtime: st.mtimeMs, dir: true })
    await walk(ctx, src, (e) => {
      const rel = relative(src, e.path)
      const target = join(dst, rel)
      if (e.dir) items.push({ src: e.path, dst: target, size: 0, mtime: e.mtime, dir: true })
      else if (accept(e.name)) {
        items.push({ src: e.path, dst: target, size: e.size, mtime: e.mtime, dir: false })
        bytes += e.size
      }
    }, { signal: ctl.signal, onError: (p, m) => ctl.fail(p, m) })
    ctl.setTotal(bytes, items.filter((i) => !i.dir).length)
  }
  ctl.setTotal(bytes, items.filter((i) => !i.dir).length)
  return { items, tops }
}

export async function runTransfer(ctx: EngineCtx, ctl: JobCtl, spec: TransferSpec) {
  await fsp.mkdir(spec.dest, { recursive: true })
  const undoPairs: [string, string][] = []
  let policy: ConflictPolicy = spec.policy

  // Fast path: a move inside one volume is a rename of each top-level item.
  if (spec.op === 'move' && !spec.filter && spec.sources.every((s) => sameVolume(s, spec.dest))) {
    ctl.setTotal(0, spec.sources.length)
    for (const src of spec.sources) {
      await ctl.checkpoint()
      let dst = join(spec.dest, basename(src))
      if (src.toLowerCase() === dst.toLowerCase()) continue
      ctl.setCurrent(src)
      try {
        const st = await fsp.stat(src)
        if (st.isDirectory() && isInside(spec.dest, src)) throw new Error('cannot move a folder into itself')
        if (await exists(dst)) {
          const decision = await decide(ctl, src, dst, policy)
          if (decision.all) policy = decision.policy
          if (decision.action === 'skip') { ctl.add(0, 1); continue }
          if (decision.action === 'rename') dst = await freeName(dst)
          if (decision.action === 'overwrite') {
            const dstSt = await fsp.stat(dst)
            // Merging folders needs the per-file path below; replacing a file is fine.
            if (st.isDirectory() || dstSt.isDirectory()) return await copyPath(ctx, ctl, { ...spec, sources: spec.sources.slice(spec.sources.indexOf(src)) }, policy, undoPairs)
            await fsp.rm(dst, { force: true })
          }
        }
        await withRetry(ctl, () => fsp.rename(src, dst))
        undoPairs.push([src, dst])
        ctl.add(0, 1)
      } catch (e: any) {
        if (e instanceof Cancelled) throw e
        ctl.fail(src, String(e?.message ?? e))
      }
    }
    if (undoPairs.length) ctx.undo.record({ kind: 'move', label: `Move ${undoPairs.length} item${undoPairs.length > 1 ? 's' : ''}`, pairs: undoPairs })
    return spec.dest
  }
  return copyPath(ctx, ctl, spec, policy, undoPairs)
}

type Decision = { action: 'overwrite' | 'skip' | 'rename'; policy: ConflictPolicy; all: boolean }

async function decide(ctl: JobCtl, src: string, dst: string, policy: ConflictPolicy): Promise<Decision> {
  const resolveFixed = async (p: ConflictPolicy): Promise<Decision['action']> => {
    if (p === 'overwrite' || p === 'skip' || p === 'rename') return p
    // 'newer': overwrite only when the source is newer
    const [a, b] = await Promise.all([fsp.stat(src), fsp.stat(dst)])
    return a.mtimeMs > b.mtimeMs + 2000 ? 'overwrite' : 'skip'
  }
  if (policy !== 'ask') return { action: await resolveFixed(policy), policy, all: false }
  const [a, b] = await Promise.all([fsp.stat(src), fsp.stat(dst)])
  const { answer, all } = await ctl.ask({
    src: { path: src, size: a.size, mtime: a.mtimeMs },
    dst: { path: dst, size: b.size, mtime: b.mtimeMs }
  })
  if (answer === 'cancel') throw new Cancelled()
  const p = answer as ConflictPolicy
  return { action: await resolveFixed(p), policy: all ? p : 'ask', all }
}

async function copyPath(ctx: EngineCtx, ctl: JobCtl, spec: TransferSpec, startPolicy: ConflictPolicy, undoPairs: [string, string][]) {
  let policy = startPolicy
  const { items, tops } = await plan(ctx, ctl, spec)
  const existedBefore = new Map<string, boolean>()
  for (const t of tops) existedBefore.set(t.dst.toLowerCase(), await exists(t.dst))
  const created: [string, string][] = []
  const movedFiles: string[] = []
  const renamedDirs = new Map<string, string>() // when a top-level folder is renamed on conflict

  const mapDst = (p: string) => {
    for (const [from, to] of renamedDirs) if (p.toLowerCase().startsWith(from.toLowerCase() + '\\')) return to + p.slice(from.length)
    return p
  }

  // Top-level conflicts for folders: merge (overwrite), skip whole folder, or rename.
  const skippedDirs: string[] = []
  for (const t of tops) {
    if (!t.dir || !existedBefore.get(t.dst.toLowerCase())) continue
    if (t.src.toLowerCase() === t.dst.toLowerCase()) {
      // copy into its own parent: always "rename" (like Explorer's "- Copy")
      renamedDirs.set(t.dst, await freeName(t.dst))
      continue
    }
    const d = await decide(ctl, t.src, t.dst, policy === 'newer' ? 'overwrite' : policy)
    if (d.all) policy = d.policy
    if (d.action === 'skip') skippedDirs.push(t.src.toLowerCase())
    else if (d.action === 'rename') renamedDirs.set(t.dst, await freeName(t.dst))
  }
  const skipped = (src: string) => skippedDirs.some((s) => src.toLowerCase() === s || src.toLowerCase().startsWith(s + '\\'))

  // Folders first, in order, so files always have a parent.
  for (const it of items) {
    if (!it.dir || skipped(it.src)) continue
    const dst = mapDst(it.dst)
    it.dst = dst
    await fsp.mkdir(dst, { recursive: true }).catch((e) => ctl.fail(dst, String(e.message)))
  }

  const files = items.filter((i) => !i.dir && !skipped(i.src))
  let next = 0
  const parallel = Math.max(1, Math.min(8, ctx.settings?.parallelSmallFiles ?? 4))

  const one = async (it: Item) => {
    await ctl.checkpoint()
    let dst = mapDst(it.dst)
    if (it.src.toLowerCase() === dst.toLowerCase()) dst = await freeName(dst) // copy onto itself = duplicate
    ctl.setCurrent(it.src)
    try {
      if (await exists(dst)) {
        const d = await decide(ctl, it.src, dst, policy)
        if (d.all) policy = d.policy
        if (d.action === 'skip') {
          ctl.add(it.size, 1)
          return
        }
        if (d.action === 'rename') dst = await freeName(dst)
      }
      await withRetry(ctl, async () => {
        if (it.size < SMALL) {
          await fsp.copyFile(it.src, dst)
          ctl.add(it.size)
        } else {
          await streamCopy(ctl, it.src, dst, it.mtime)
        }
      })
      if (spec.verify) {
        const [a, b] = await Promise.all([hashFile(it.src, ctl.signal), hashFile(dst, ctl.signal)])
        if (a !== b) throw new Error('verification failed: checksums differ')
      }
      ctl.add(0, 1)
      created.push([it.src, dst])
      if (spec.op === 'move') movedFiles.push(it.src)
    } catch (e: any) {
      if (e instanceof Cancelled) throw e
      ctl.fail(it.src, String(e?.message ?? e))
    }
  }

  const small = files.filter((f) => f.size < SMALL)
  const large = files.filter((f) => f.size >= SMALL)
  // Small files in parallel (latency bound), large files one by one (bandwidth bound).
  await Promise.all(
    Array.from({ length: Math.min(parallel, small.length) }, async () => {
      while (next < small.length) await one(small[next++])
    })
  )
  for (const it of large) await one(it)

  if (spec.op === 'move') {
    for (const f of movedFiles) await fsp.rm(f, { force: true }).catch((e) => ctl.fail(f, String(e.message)))
    // Remove now-empty source folders, deepest first.
    const dirs = items.filter((i) => i.dir && !skipped(i.src)).map((i) => i.src).sort((a, b) => b.length - a.length)
    for (const d of dirs) {
      const left = await listRaw(ctx, d).catch(() => [{}])
      if (!left.length) await fsp.rmdir(d).catch(() => {})
    }
  }

  // Undo: remove what was created (top-level when it did not exist before, else the files).
  for (const t of tops) {
    const dst = renamedDirs.get(t.dst) ?? t.dst
    if (!existedBefore.get(t.dst.toLowerCase()) || renamedDirs.has(t.dst)) {
      if (created.some(([, d]) => d.toLowerCase() === dst.toLowerCase() || d.toLowerCase().startsWith(dst.toLowerCase() + '\\')) || t.dir)
        undoPairs.push([t.src, dst])
    } else {
      for (const c of created) if (c[1].toLowerCase().startsWith(dst.toLowerCase())) undoPairs.push(c)
    }
  }
  const label = `${spec.op === 'move' ? 'Move' : 'Copy'} ${spec.sources.length} item${spec.sources.length > 1 ? 's' : ''} to ${basename(spec.dest) || spec.dest}`
  if (undoPairs.length && undoPairs.length < 20000) ctx.undo.record({ kind: spec.op === 'move' ? 'move' : 'copy', label, pairs: undoPairs })
  return spec.dest
}

export function transferHandlers(ctx: EngineCtx) {
  return {
    'transfer.start': (spec: TransferSpec) => {
      const n = spec.sources.length
      const title = `${spec.op === 'move' ? 'Moving' : 'Copying'} ${n === 1 ? basename(spec.sources[0]) : `${n} items`} to ${basename(spec.dest) || spec.dest}`
      return ctx.jobs.create(spec.op, title, (ctl) => runTransfer(ctx, ctl, spec), {
        lane: `vol:${volumeOf(spec.dest)}`,
        dest: spec.dest
      })
    },
    /** Same-folder duplicate ("Copy" + paste into the same folder). */
    'transfer.duplicate': (paths: string[]) => {
      const dest = dirname(paths[0])
      return ctx.jobs.create('copy', `Duplicating ${paths.length} item${paths.length > 1 ? 's' : ''}`, (ctl) => runTransfer(ctx, ctl, { op: 'copy', sources: paths, dest, policy: 'rename' }), { lane: `vol:${volumeOf(dest)}`, dest })
    }
  }
}
