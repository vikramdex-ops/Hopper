// Archives through the bundled 7-Zip (multithreaded) and WinRAR's Rar.exe for .rar creation.
// Everything runs as a child process with progress parsed from -bsp1, so the UI never waits.
import { spawn } from 'node:child_process'
import { existsSync, promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, extname, join } from 'node:path'
import type { ArchiveEntry, ArchivePreset, Entry, ExtractMode } from '@shared/types'
import type { EngineCtx } from './index'
import type { JobCtl } from './jobs'
import { walk } from './fsops'
import { exists, freeName, removeTree } from './fsutil'
import { DEFAULT_PRESETS } from '@shared/defaults'

export const ARCHIVE_EXTS = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'txz', 'zst', 'iso', 'cab', 'wim', 'arj', 'lzh', 'z', 'jar', 'apk', 'msi'])

const RAR_PATHS = ['C:\\Program Files\\WinRAR\\Rar.exe', 'C:\\Program Files (x86)\\WinRAR\\Rar.exe']
export const rarExe = () => RAR_PATHS.find((p) => existsSync(p))

class PasswordNeeded extends Error {
  code = 'PASSWORD'
  constructor() {
    super('This archive is password protected')
  }
}

/** Run a tool, call onPercent for every progress update, collect stderr. */
function run(exe: string, args: string[], opts: { cwd?: string; signal?: AbortSignal; onPercent?: (p: number) => void; onLine?: (l: string) => void } = {}) {
  return new Promise<{ code: number; out: string; err: string }>((resolve, reject) => {
    const child = spawn(exe, args, { cwd: opts.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let lastPct = -1
    const onAbort = () => child.kill()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      // 7-Zip progress lines are rewritten with backspaces; just look for the last "NN%".
      const m = d.match(/(\d{1,3})%/g)
      if (m && opts.onPercent) {
        const pct = Number(m[m.length - 1].slice(0, -1))
        if (pct !== lastPct) opts.onPercent((lastPct = pct))
      }
      if (opts.onLine) for (const l of d.split(/\r?\n/)) if (l.trim()) opts.onLine(l)
      if (out.length < 4 * 1024 * 1024) out += d
    })
    child.stderr.on('data', (d: string) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ code: code ?? -1, out, err })
    })
  })
}

function failure(r: { code: number; out: string; err: string }, what: string) {
  const text = (r.err || r.out).trim()
  if (/wrong password|can not open encrypted|enter password|encrypted/i.test(text)) return new PasswordNeeded()
  const line = text.split(/\r?\n/).filter((l) => /error|cannot|can't|not/i.test(l)).slice(-2).join(' ')
  return new Error(`${what} failed (${r.code})${line ? `: ${line}` : ''}`)
}

async function totalSize(ctx: EngineCtx, sources: string[], signal: AbortSignal) {
  let bytes = 0
  let files = 0
  for (const s of sources) {
    const st = await fsp.stat(s)
    if (!st.isDirectory()) {
      bytes += st.size
      files++
      continue
    }
    await walk(ctx, s, (e) => {
      if (!e.dir) {
        bytes += e.size
        files++
      }
    }, { signal })
  }
  return { bytes, files }
}

/** Smart default name: one item -> its name; many -> the parent folder name + date. */
export async function smartArchiveName(sources: string[], ext: string) {
  if (sources.length === 1) {
    const name = basename(sources[0])
    const isDir = (await fsp.stat(sources[0]).catch(() => null))?.isDirectory()
    const stem = isDir || !extname(name) ? name : name.slice(0, -extname(name).length)
    return `${stem}.${ext}`
  }
  const parent = basename(dirname(sources[0])) || 'Archive'
  const d = new Date()
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${parent} ${stamp}.${ext}`
}

export async function createArchive(ctx: EngineCtx, ctl: JobCtl, sources: string[], outFile: string, preset: ArchivePreset, password?: string) {
  const { bytes, files } = await totalSize(ctx, sources, ctl.signal)
  ctl.setTotal(bytes, files)
  let reported = 0
  const onPercent = (pct: number) => {
    const target = Math.round((bytes * pct) / 100)
    if (target > reported) {
      ctl.add(target - reported)
      reported = target
    }
  }
  // Store names relative to the common parent so the archive has no absolute paths.
  const cwd = dirname(sources[0])
  const sameParent = sources.every((s) => dirname(s).toLowerCase() === cwd.toLowerCase())
  const names = sameParent ? sources.map((s) => basename(s)) : sources
  await fsp.mkdir(dirname(outFile), { recursive: true })
  const tmp = outFile + '.hopper-part'
  let r
  if (preset.format === 'rar') {
    const rar = rarExe()
    if (!rar) throw new Error('WinRAR is not installed on this PC; choose a zip or 7z preset')
    const args = ['a', `-m${Math.min(5, Math.max(0, Math.round(preset.level / 2)))}`, '-r', '-ep1', '-y', '-idc', `-mt${Math.max(1, Math.min(32, (await import('node:os')).cpus().length))}`]
    if (preset.volumeMB) args.push(`-v${preset.volumeMB}m`)
    if (password) args.push(`-hp${password}`)
    args.push(outFile, ...names)
    r = await run(rar, args, { cwd, signal: ctl.signal, onPercent })
    if (r.code !== 0) throw failure(r, 'RAR')
  } else {
    const args = ['a', `-t${preset.format}`, `-mx=${preset.level}`, '-mmt=on', '-bsp1', '-bso0', '-bse1', '-sccUTF-8', '-y', '-ssw']
    if (preset.volumeMB) args.push(`-v${preset.volumeMB}m`)
    if (password) args.push(`-p${password}`, preset.format === 'zip' ? '-mem=AES256' : '-mhe=on')
    // Split volumes need the real name; single archives go to a temp name and rename at the end.
    const target = preset.volumeMB ? outFile : tmp
    args.push(target, '--', ...names)
    r = await run(ctx.sevenZip, args, { cwd, signal: ctl.signal, onPercent })
    if (ctl.cancelled) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      throw new Error('cancelled')
    }
    if (r.code > 1) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      throw failure(r, '7-Zip')
    }
    if (r.code === 1) ctl.fail(outFile, 'Some files were in use and could not be added')
    if (!preset.volumeMB) await fsp.rename(tmp, outFile)
  }
  ctl.add(Math.max(0, bytes - reported), files)
  ctx.undo.record({ kind: 'new', label: `Create ${basename(outFile)}`, pairs: [['', outFile]] })
  return preset.volumeMB ? `${outFile}.001` : outFile
}

// ---------------------------------------------------------------------------
// Listing (cached per archive + mtime), used for previews and "archive as folder"

const listCache = new Map<string, { key: string; entries: ArchiveEntry[] }>()

export async function listArchive(ctx: EngineCtx, file: string, password?: string): Promise<ArchiveEntry[]> {
  const st = await fsp.stat(file)
  const key = `${st.size}|${st.mtimeMs}`
  const hit = listCache.get(file.toLowerCase())
  if (hit && hit.key === key) return hit.entries
  const args = ['l', '-slt', '-ba', '-sccUTF-8', `-p${password ?? ''}`, file]
  const r = await run(ctx.sevenZip, args)
  if (r.code !== 0) throw failure(r, 'Reading archive')
  const entries: ArchiveEntry[] = []
  let cur: Record<string, string> = {}
  const flush = () => {
    if (cur['Path']) {
      const attrs = cur['Attributes'] ?? ''
      entries.push({
        path: cur['Path'].replace(/\\/g, '/'),
        dir: cur['Folder'] === '+' || attrs.startsWith('D'),
        size: Number(cur['Size'] || 0),
        packed: Number(cur['Packed Size'] || 0),
        mtime: cur['Modified'] ? Date.parse(cur['Modified'].replace(' ', 'T')) || 0 : 0,
        encrypted: cur['Encrypted'] === '+'
      })
    }
    cur = {}
  }
  for (const line of r.out.split(/\r?\n/)) {
    if (!line.trim()) {
      flush()
      continue
    }
    const i = line.indexOf(' = ')
    if (i > 0) cur[line.slice(0, i)] = line.slice(i + 3)
  }
  flush()
  if (listCache.size > 20) listCache.delete(listCache.keys().next().value!)
  listCache.set(file.toLowerCase(), { key, entries })
  return entries
}

/** Entries directly inside `inner` ('' = root), as file-list Entries with virtual paths. */
export async function listArchiveDir(ctx: EngineCtx, file: string, inner: string, password?: string): Promise<Entry[]> {
  const all = await listArchive(ctx, file, password)
  const prefix = inner ? inner.replace(/\\/g, '/').replace(/\/?$/, '/') : ''
  const out = new Map<string, Entry>()
  for (const e of all) {
    if (!e.path.toLowerCase().startsWith(prefix.toLowerCase()) || e.path.length === prefix.length) continue
    const rest = e.path.slice(prefix.length)
    const slash = rest.indexOf('/')
    const name = slash < 0 ? rest : rest.slice(0, slash)
    const isDir = slash >= 0 || e.dir
    const key = name.toLowerCase()
    const prev = out.get(key)
    const vpath = `${file}::${prefix}${name}`
    if (!prev) {
      out.set(key, {
        name, path: vpath, dir: isDir, size: isDir ? 0 : e.size, mtime: e.mtime, ctime: e.mtime, atime: e.mtime,
        attrs: e.encrypted ? 0x4000 : 0, ext: isDir ? '' : extname(name).slice(1).toLowerCase()
      })
    } else if (isDir) {
      prev.dir = true
    }
  }
  return [...out.values()]
}

async function extract(ctx: EngineCtx, ctl: JobCtl | null, file: string, dest: string, entries: string[] = [], password?: string, overwrite: 'rename' | 'overwrite' | 'skip' = 'rename') {
  const ao = overwrite === 'overwrite' ? '-aoa' : overwrite === 'skip' ? '-aos' : '-aou'
  const args = ['x', file, `-o${dest}`, '-y', ao, '-bsp1', '-bso0', '-bse1', '-sccUTF-8', `-p${password ?? ''}`]
  if (entries.length) args.push('--', ...entries.map((e) => e.replace(/\//g, '\\')))
  let reported = 0
  const total = ctl?.info.total ?? 0
  const r = await run(ctx.sevenZip, args, {
    signal: ctl?.signal,
    onPercent: (pct) => {
      if (!ctl) return
      const target = Math.round((total * pct) / 100)
      if (target > reported) {
        ctl.add(target - reported)
        reported = target
      }
    }
  })
  if (r.code > 1) throw failure(r, 'Extracting')
  if (ctl) ctl.add(Math.max(0, total - reported))
}

export async function extractSmart(ctx: EngineCtx, ctl: JobCtl, file: string, destDir: string, mode: ExtractMode, password?: string, deleteAfter = false) {
  const list = await listArchive(ctx, file, password)
  const bytes = list.reduce((a, e) => a + (e.dir ? 0 : e.size), 0)
  ctl.setTotal(bytes, list.filter((e) => !e.dir).length)
  const stem = basename(file).replace(/(\.tar)?\.[^.]+$/i, '').replace(/\.part0*1$/i, '')
  let target = destDir
  if (mode === 'smart') {
    const tops = new Set(list.map((e) => e.path.split('/')[0].toLowerCase()))
    // One top-level item: extract straight here (no "folder inside a folder").
    if (tops.size !== 1) target = await freeName(join(destDir, stem))
  } else if (mode === 'each') {
    target = await freeName(join(destDir, stem))
  }
  await fsp.mkdir(target, { recursive: true })
  await extract(ctx, ctl, file, target, [], password)
  ctl.add(0, list.filter((e) => !e.dir).length)
  if (deleteAfter && !ctl.info.errors.length) await fsp.rm(file, { force: true })
  ctx.undo.record({ kind: 'new', label: `Extract ${basename(file)}`, pairs: target === destDir ? list.filter((e) => !e.path.includes('/')).map((e) => ['', join(destDir, e.path)] as [string, string]) : [['', target]] })
  return target
}

/** Extract a single entry to a private cache folder (for open / Quick Look / drag-out). */
export async function extractToCache(ctx: EngineCtx, file: string, inner: string, password?: string) {
  const st = await fsp.stat(file)
  const h = createHash('sha1').update(`${file}|${st.mtimeMs}|${st.size}`).digest('hex').slice(0, 16)
  const dir = join(ctx.dataDir, 'archive-cache', h)
  const out = join(dir, ...inner.split('/'))
  if (await exists(out)) return out
  await fsp.mkdir(dir, { recursive: true })
  await extract(ctx, null, file, dir, [inner], password, 'overwrite')
  return out
}

function presetById(ctx: EngineCtx, id?: string) {
  const list = ctx.settings?.archivePresets?.length ? ctx.settings.archivePresets : DEFAULT_PRESETS
  return list.find((p) => p.id === (id ?? ctx.settings?.defaultPreset)) ?? list[0]
}

export function archiveHandlers(ctx: EngineCtx) {
  return {
    'archive.hasRar': () => !!rarExe(),
    /** Create with a preset. dest folder defaults to the sources' folder; name is smart. */
    'archive.create': async (sources: string[], opts: { presetId?: string; dest?: string; name?: string; password?: string } = {}) => {
      const preset = presetById(ctx, opts.presetId)
      const ext = preset.format
      const dest = opts.dest ?? dirname(sources[0])
      const name = opts.name ? (opts.name.toLowerCase().endsWith(`.${ext}`) ? opts.name : `${opts.name}.${ext}`) : await smartArchiveName(sources, ext)
      const out = await freeName(join(dest, name))
      return ctx.jobs.create('zip', `Zipping ${basename(out)}`, (ctl) => createArchive(ctx, ctl, sources, out, preset, opts.password), { immediate: true, dest })
    },
    'archive.list': (file: string, password?: string) => listArchive(ctx, file, password),
    'archive.listDir': (file: string, inner: string, password?: string) => listArchiveDir(ctx, file, inner, password),
    'archive.extract': (files: string[], opts: { mode: ExtractMode; dest?: string; password?: string; deleteAfter?: boolean }) => {
      const ids: string[] = []
      for (const file of files) {
        const dest = opts.dest ?? dirname(file)
        ids.push(ctx.jobs.create('extract', `Extracting ${basename(file)}`, (ctl) => extractSmart(ctx, ctl, file, dest, files.length > 1 && opts.mode === 'smart' ? 'each' : opts.mode, opts.password, opts.deleteAfter), { immediate: true, dest }))
      }
      return ids
    },
    /** Copy entries out of an archive to a real folder (drag from an archive pane). */
    'archive.extractEntries': (file: string, entries: string[], dest: string, password?: string) =>
      ctx.jobs.create('extract', `Extracting from ${basename(file)}`, async (ctl) => {
        // 7-Zip keeps the inner folder structure; extract to a staging folder and move the items up.
        const all = await listArchive(ctx, file, password)
        const wanted = all.filter((e) => entries.some((x) => e.path === x || e.path.startsWith(x + '/')))
        ctl.setTotal(wanted.reduce((a, e) => a + e.size, 0), wanted.filter((e) => !e.dir).length)
        const stage = join(dest, `.hopper-extract-${Date.now().toString(36)}`)
        await fsp.mkdir(stage, { recursive: true })
        try {
          await extract(ctx, ctl, file, stage, entries, password, 'overwrite')
          const created: [string, string][] = []
          for (const e of entries) {
            const from = join(stage, ...e.split('/'))
            const to = await freeName(join(dest, e.split('/').pop()!))
            await fsp.rename(from, to)
            created.push(['', to])
          }
          ctx.undo.record({ kind: 'new', label: `Extract from ${basename(file)}`, pairs: created })
        } finally {
          await removeTree(stage)
        }
        return dest
      }, { immediate: true, dest }),
    'archive.openEntry': (file: string, inner: string, password?: string) => extractToCache(ctx, file, inner, password),
    /** Add files into an existing archive (drop onto an archive pane). */
    'archive.add': (file: string, sources: string[]) =>
      ctx.jobs.create('zip', `Adding to ${basename(file)}`, async (ctl) => {
        const { bytes, files } = await totalSize(ctx, sources, ctl.signal)
        ctl.setTotal(bytes, files)
        const cwd = dirname(sources[0])
        const args = ['a', file, '-mmt=on', '-bsp1', '-bso0', '-sccUTF-8', '-y', '-ssw', '--', ...sources.map((s) => basename(s))]
        const r = await run(ctx.sevenZip, args, { cwd, signal: ctl.signal, onPercent: (p) => ctl.add(Math.max(0, Math.round((bytes * p) / 100) - ctl.info.done)) })
        if (r.code > 1) throw failure(r, 'Updating archive')
        listCache.delete(file.toLowerCase())
        return file
      }, { immediate: true }),
    'archive.delete': async (file: string, entries: string[]) => {
      const r = await run(ctx.sevenZip, ['d', file, '-y', '-sccUTF-8', '--', ...entries.map((e) => e.replace(/\//g, '\\'))])
      if (r.code > 1) throw failure(r, 'Deleting from archive')
      listCache.delete(file.toLowerCase())
      return true
    },
    'archive.clearCache': () => removeTree(join(ctx.dataDir, 'archive-cache'))
  }
}
