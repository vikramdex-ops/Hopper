// Lot / transmittal packager: validate a lot (plan), then copy it into outDir/name, write the
// transmittal (.xlsx + .pdf) and optionally archive it (run). Revisions are reported exactly as
// parsed by the office rules, or left blank; conventions are checked, never corrected.
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs'
import { once } from 'node:events'
import { basename, join } from 'node:path'
import { DEFAULT_PRESETS } from '@shared/defaults'
import { parseRevision } from '@shared/revisions'
import type { NamingConvention } from '@shared/types'
import type { EngineCtx } from '../index'
import type { JobCtl } from '../jobs'
import { createArchive } from '../archive'
import { freeName } from '../fsutil'
import { checkSegment, officeOf, safeFilePart } from './util'
import type { TransmittalRow } from './transmittal'
import type { ConventionStatus, PackageSpec, PlanFile, PlanReport } from './types'

const CHUNK = 4 * 1024 * 1024

function conventionTest(c: NamingConvention | null, warnings: string[]): ((stem: string) => ConventionStatus) | null {
  if (!c) return null
  let re: RegExp
  try {
    // The whole name must match: a loose partial match would pass names the convention rejects.
    re = new RegExp(`^(?:${c.pattern})$`)
  } catch (e: any) {
    warnings.push(`Naming convention "${c.name}" has an invalid pattern (${e?.message ?? e}); names were not checked`)
    return null
  }
  return (stem) => (re.test(stem) ? 'ok' : 'fail')
}

export async function plan(ctx: EngineCtx, spec: Partial<PackageSpec> & { files: string[] }): Promise<PlanReport> {
  const office = officeOf(ctx)
  const rules = office.revisions
  const warnings: string[] = []
  const blocking: string[] = []
  if (!ctx.office) warnings.push('Office config not loaded; using the default revision rules and templates')

  let conv: NamingConvention | null = null
  if (spec.conventionId) {
    conv = office.conventions.find((c) => c.id === spec.conventionId) ?? null
    if (!conv) warnings.push(`Naming convention "${spec.conventionId}" is not in the office config; names were not checked`)
  }
  const check = conventionTest(conv, warnings)

  const files: PlanFile[] = []
  for (const path of spec.files) {
    const name = basename(path)
    const parsed = parseRevision(name, rules)
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const f: PlanFile = {
      path, name, missing: false, size: 0, mtime: 0,
      base: parsed.base, rev: parsed.rev, ext: parsed.ext,
      convention: check ? check(stem) : 'no convention',
      sameBase: [], nameClash: []
    }
    try {
      const st = await fsp.stat(path)
      if (!st.isFile()) f.problem = 'not a file'
      f.size = st.size
      f.mtime = st.mtimeMs
    } catch (e: any) {
      if (e?.code === 'ENOENT') f.missing = true
      else f.problem = e?.message ?? String(e)
    }
    files.push(f)
  }

  const byBase = new Map<string, PlanFile[]>()
  const byName = new Map<string, PlanFile[]>()
  for (const f of files) {
    const kb = `${f.base.toLowerCase()}\u0000${f.ext}`
    byBase.set(kb, [...(byBase.get(kb) ?? []), f])
    const kn = f.name.toLowerCase()
    byName.set(kn, [...(byName.get(kn) ?? []), f])
  }
  for (const group of byBase.values()) for (const f of group) f.sameBase = group.filter((g) => g !== f).map((g) => g.path)
  for (const group of byName.values()) for (const f of group) f.nameClash = group.filter((g) => g !== f).map((g) => g.path)

  const missing = files.filter((f) => f.missing)
  const problems = files.filter((f) => f.problem)
  const clashes = [...byName.values()].filter((g) => g.length > 1)
  const dupBases = [...byBase.values()].filter((g) => g.length > 1)
  if (!files.length) blocking.push('No files chosen')
  if (missing.length) blocking.push(`${missing.length} file${missing.length === 1 ? ' is' : 's are'} missing`)
  for (const f of problems) blocking.push(`${f.name}: ${f.problem}`)
  for (const g of clashes) blocking.push(`"${g[0].name}" is chosen ${g.length} times from different folders`)
  if (dupBases.length) warnings.push(`${dupBases.length} drawing${dupBases.length === 1 ? ' appears' : 's appear'} more than once (same base name); check which revision belongs in the lot`)

  if (spec.name !== undefined) {
    try {
      checkSegment(spec.name, 'Package name')
    } catch (e: any) {
      blocking.push(e.message)
    }
  }
  if (spec.outDir !== undefined) {
    const st = await fsp.stat(spec.outDir).catch(() => null)
    if (!st?.isDirectory()) blocking.push(`Output folder "${spec.outDir}" does not exist`)
  }

  return {
    files,
    convention: conv ? { id: conv.id, name: conv.name, pattern: conv.pattern } : null,
    blocking,
    warnings,
    totals: {
      files: files.length,
      bytes: files.reduce((n, f) => n + f.size, 0),
      missing: missing.length,
      conventionOk: files.filter((f) => f.convention === 'ok').length,
      conventionFail: files.filter((f) => f.convention === 'fail').length,
      withRev: files.filter((f) => f.rev !== null).length,
      duplicateBases: dupBases.length,
      nameClashes: clashes.length
    }
  }
}

/** Stream copy with byte progress and pause/cancel between chunks; keeps the source mtime. */
async function copyFile(ctl: JobCtl, src: string, dst: string) {
  const st = await fsp.stat(src)
  const ws = createWriteStream(dst, { flags: 'wx' })
  try {
    for await (const chunk of createReadStream(src, { highWaterMark: CHUNK })) {
      await ctl.checkpoint()
      if (!ws.write(chunk)) await once(ws, 'drain')
      ctl.add((chunk as Buffer).length)
    }
    ws.end()
    await once(ws, 'close')
    await fsp.utimes(dst, st.atime, st.mtime)
  } catch (e) {
    ws.destroy()
    await once(ws, 'close').catch(() => {})
    await fsp.rm(dst, { force: true }).catch(() => {})
    throw e
  }
}

function presetFor(ctx: EngineCtx, id?: string) {
  const presets = ctx.settings?.archivePresets?.length ? ctx.settings.archivePresets : DEFAULT_PRESETS
  const want = id ?? 'balanced'
  const p = presets.find((x) => x.id === want) ?? DEFAULT_PRESETS.find((x) => x.id === want)
  if (!p) throw new Error(`No archive preset "${want}"`)
  return p
}

export async function runOp(ctx: EngineCtx, ctl: JobCtl, spec: PackageSpec, created: string[]) {
  const t = spec.transmittal
  if (!t?.number?.trim()) throw new Error('Transmittal number is required')
  const report = await plan(ctx, spec)
  if (report.blocking.length) throw new Error(report.blocking.join('; '))
  const preset = spec.zip ? presetFor(ctx, spec.presetId) : null
  if (preset?.password && !spec.password) throw new Error(`Preset "${preset.name}" needs a password`)

  const dir = await freeName(join(spec.outDir, spec.name))
  await fsp.mkdir(dir)
  created.push(dir)

  if (spec.copy) {
    ctl.setTotal(report.totals.bytes, report.files.length)
    for (const f of report.files) {
      await ctl.checkpoint()
      ctl.setCurrent(f.path)
      await copyFile(ctl, f.path, join(dir, f.name))
      ctl.add(0, 1)
    }
  }

  await ctl.checkpoint()
  const rows: TransmittalRow[] = report.files.map((f) => ({ name: f.name, rev: f.rev, size: f.size, mtime: f.mtime }))
  const doc = { office: officeOf(ctx).officeName, info: t, rows }
  const stem = `Transmittal ${safeFilePart(t.number) || 'untitled'}`
  const xlsx = join(dir, `${stem}.xlsx`)
  const pdf = join(dir, `${stem}.pdf`)
  ctl.setCurrent(xlsx)
  // exceljs and pdf-lib load only when a package is actually written, so checking a lot stays fast.
  const { writePdf, writeXlsx } = await import('./transmittal')
  await writeXlsx(doc, xlsx)
  ctl.setCurrent(pdf)
  await writePdf(doc, pdf)

  if (!preset) return dir
  await ctl.checkpoint()
  const ext = preset.format === '7z' ? '7z' : preset.format === 'rar' ? 'rar' : 'zip'
  const archive = await freeName(join(spec.outDir, `${basename(dir)}.${ext}`))
  // copied lots are archived as their folder; otherwise the originals plus the transmittal
  const sources = spec.copy ? [dir] : [...report.files.map((f) => f.path), xlsx, pdf]
  try {
    const result = await createArchive(ctx, ctl, sources, archive, preset, spec.password)
    created.push(result)
    return result
  } catch (e) {
    created.push(archive) // a partial archive is ours to remove on undo
    throw e
  }
}

export function run(ctx: EngineCtx, spec: PackageSpec) {
  return ctx.jobs.create(
    'package',
    `Package ${spec.name}`,
    async (ctl) => {
      const created: string[] = []
      try {
        return await runOp(ctx, ctl, spec, created)
      } finally {
        if (created.length) ctx.undo.record({ kind: 'new', label: `Package ${spec.name}`, pairs: created.map((p) => ['', p] as [string, string]) })
      }
    },
    { dest: spec.outDir }
  )
}
