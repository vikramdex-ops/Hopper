// PDF toolkit (pdf-lib): info, merge, split, extract, rotate, reorder.
// Page numbers in this API are 1-based, as the user sees them. One source document is held
// in memory at a time. Outputs never overwrite an existing file (" (2)" is added instead),
// except rotate with out === input, which replaces the input atomically.
import { promises as fsp } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { PDFDocument, degrees } from 'pdf-lib'
import type { EngineCtx } from '../index'
import type { JobCtl } from '../jobs'
import { exists, freeName } from '../fsutil'
import { writeAtomic } from './util'
import type { PdfInfo, RotateDegrees, SplitMode } from './types'

async function load(path: string) {
  const bytes = await fsp.readFile(path)
  try {
    return { doc: await PDFDocument.load(bytes, { updateMetadata: false }), bytes: bytes.length }
  } catch (e: any) {
    if (/encrypted/i.test(String(e?.message))) throw new Error(`${basename(path)} is encrypted; remove the password first`)
    throw new Error(`${basename(path)} could not be read as a PDF: ${e?.message ?? e}`)
  }
}

async function newDoc() {
  const doc = await PDFDocument.create()
  doc.setProducer('Hopper (pdf-lib)')
  return doc
}

const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase()
const stemOf = (p: string) => basename(p, extname(p))
const withPdf = (p: string) => (/\.pdf$/i.test(p) ? p : p + '.pdf')

/** Save to `out`, never overwriting an existing file. Returns the path written. */
async function saveNew(doc: PDFDocument, out: string) {
  const target = await freeName(withPdf(out))
  await writeAtomic(target, await doc.save())
  return target
}

function checkPages(pages: number[], count: number, what = 'page') {
  if (!pages.length) throw new Error(`No ${what}s given`)
  for (const p of pages) {
    if (!Number.isInteger(p) || p < 1 || p > count) throw new Error(`${what} ${p} is outside 1-${count}`)
  }
}

/** "1-3,5,7-" -> [[1,3],[5,5],[7,n]] (1-based, inclusive). Rejects anything outside 1..n. */
export function parseRanges(spec: string, count: number): [number, number][] {
  const out: [number, number][] = []
  for (const raw of spec.split(/[,;\s]+/).filter(Boolean)) {
    let a: number
    let b: number
    if (/^\d+$/.test(raw)) {
      a = b = Number(raw)
    } else {
      const m = /^(\d*)-(\d*)$/.exec(raw)
      if (!m || (m[1] === '' && m[2] === '')) throw new Error(`Bad page range "${raw}"`)
      a = m[1] === '' ? 1 : Number(m[1])
      b = m[2] === '' ? count : Number(m[2])
    }
    if (a < 1 || b > count || a > b) throw new Error(`Page range "${raw}" is outside 1-${count}`)
    out.push([a, b])
  }
  if (!out.length) throw new Error('No page ranges given')
  return out
}

export async function info(path: string): Promise<PdfInfo> {
  const st = await fsp.stat(path)
  const bytes = await fsp.readFile(path)
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
  return {
    path,
    pages: doc.getPageCount(),
    title: doc.getTitle() ?? '',
    author: doc.getAuthor() ?? '',
    producer: doc.getProducer() ?? '',
    created: doc.getCreationDate()?.getTime() ?? null,
    bytes: st.size,
    encrypted: doc.isEncrypted
  }
}

async function totalBytes(paths: string[]) {
  let n = 0
  for (const p of paths) n += (await fsp.stat(p)).size
  return n
}


// ---------------------------------------------------------------------------
// Operations (run inside a job)

export async function mergeOp(ctl: JobCtl, created: string[], paths: string[], out: string) {
  if (paths.length < 2) throw new Error('Choose at least two PDFs to merge')
  ctl.setTotal(await totalBytes(paths), paths.length)
  const doc = await newDoc()
  for (const p of paths) {
    await ctl.checkpoint()
    ctl.setCurrent(p)
    const src = await load(p)
    const pages = await doc.copyPages(src.doc, src.doc.getPageIndices())
    for (const page of pages) doc.addPage(page)
    ctl.add(src.bytes, 1)
  }
  await ctl.checkpoint()
  created.push(await saveNew(doc, out))
}

export async function splitOp(ctl: JobCtl, created: string[], path: string, mode: SplitMode, ranges: string, outDir: string) {
  ctl.setCurrent(path)
  const src = await load(path)
  const n = src.doc.getPageCount()
  const parts: [number, number][] = mode === 'each' ? Array.from({ length: n }, (_, i) => [i + 1, i + 1]) : parseRanges(ranges, n)
  ctl.setTotal(src.bytes, parts.length)
  // A folder we create is recorded alone: undoing it removes the parts inside.
  const madeDir = !(await exists(outDir))
  if (madeDir) {
    await fsp.mkdir(outDir, { recursive: true })
    created.push(outDir)
  }
  const w = String(n).length
  const pad = (k: number) => String(k).padStart(w, '0')
  const stem = stemOf(path)
  for (const [a, b] of parts) {
    await ctl.checkpoint()
    const doc = await newDoc()
    const pages = await doc.copyPages(src.doc, Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i))
    for (const page of pages) doc.addPage(page)
    const name = a === b ? `${stem} p${pad(a)}.pdf` : `${stem} p${pad(a)}-${pad(b)}.pdf`
    const written = await saveNew(doc, join(outDir, name))
    if (!madeDir) created.push(written)
    ctl.add(Math.round(src.bytes / parts.length), 1)
  }
  return outDir
}

export async function extractOp(ctl: JobCtl, created: string[], path: string, pages: number[], out: string) {
  ctl.setCurrent(path)
  const src = await load(path)
  ctl.setTotal(src.bytes, 1)
  checkPages(pages, src.doc.getPageCount())
  const doc = await newDoc()
  for (const page of await doc.copyPages(src.doc, pages.map((p) => p - 1))) doc.addPage(page)
  await ctl.checkpoint()
  created.push(await saveNew(doc, out))
  ctl.add(src.bytes, 1)
}

/** In place (out === path) nothing is added to `created`: undo must not delete the input. */
export async function rotateOp(ctl: JobCtl, created: string[], path: string, pages: number[] | 'all', deg: RotateDegrees, out: string) {
  if (![90, 180, 270].includes(deg)) throw new Error(`Rotation must be 90, 180 or 270 degrees, not ${deg}`)
  ctl.setCurrent(path)
  const src = await load(path)
  ctl.setTotal(src.bytes, 1)
  const n = src.doc.getPageCount()
  const list = pages === 'all' ? Array.from({ length: n }, (_, i) => i + 1) : pages
  checkPages(list, n)
  for (const p of new Set(list)) {
    const page = src.doc.getPage(p - 1)
    page.setRotation(degrees((((page.getRotation().angle + deg) % 360) + 360) % 360))
  }
  await ctl.checkpoint()
  if (samePath(path, out)) {
    await writeAtomic(path, await src.doc.save())
    ctl.add(src.bytes, 1)
    return path
  }
  created.push(await saveNew(src.doc, out))
  ctl.add(src.bytes, 1)
}

export async function reorderOp(ctl: JobCtl, created: string[], path: string, order: number[], out: string) {
  ctl.setCurrent(path)
  const src = await load(path)
  ctl.setTotal(src.bytes, 1)
  const n = src.doc.getPageCount()
  checkPages(order, n)
  if (order.length !== n || new Set(order).size !== n) throw new Error(`The new order must list each of the ${n} pages exactly once`)
  const doc = await newDoc()
  for (const page of await doc.copyPages(src.doc, order.map((p) => p - 1))) doc.addPage(page)
  await ctl.checkpoint()
  created.push(await saveNew(doc, out))
  ctl.add(src.bytes, 1)
}

// ---------------------------------------------------------------------------
// Job wrappers (return the job id)

type Op = (ctl: JobCtl, created: string[]) => Promise<string | void>

function job(ctx: EngineCtx, title: string, dest: string, label: string, op: Op) {
  return ctx.jobs.create(
    'pdf',
    title,
    async (ctl) => {
      const created: string[] = []
      try {
        return (await op(ctl, created)) || created[0]
      } finally {
        // recorded even after a failure or cancel, so partial output can be undone
        if (created.length) ctx.undo.record({ kind: 'new', label, pairs: created.map((p) => ['', p] as [string, string]) })
      }
    },
    { dest }
  )
}

export const merge = (ctx: EngineCtx, paths: string[], out: string) =>
  job(ctx, `Merge ${paths.length} PDFs`, out, `Merge into ${basename(out)}`, (ctl, created) => mergeOp(ctl, created, paths, out))

export const split = (ctx: EngineCtx, path: string, mode: SplitMode, ranges: string, outDir: string) =>
  job(ctx, `Split ${basename(path)}`, outDir, `Split ${basename(path)}`, (ctl, created) => splitOp(ctl, created, path, mode, ranges, outDir))

export const extract = (ctx: EngineCtx, path: string, pages: number[], out: string) =>
  job(ctx, `Extract pages from ${basename(path)}`, out, `Extract from ${basename(path)}`, (ctl, created) => extractOp(ctl, created, path, pages, out))

export const rotate = (ctx: EngineCtx, path: string, pages: number[] | 'all', deg: RotateDegrees, out: string) =>
  job(ctx, `Rotate ${basename(path)}`, out, `Rotate ${basename(path)}`, (ctl, created) => rotateOp(ctl, created, path, pages, deg, out))

export const reorder = (ctx: EngineCtx, path: string, order: number[], out: string) =>
  job(ctx, `Reorder ${basename(path)}`, out, `Reorder ${basename(path)}`, (ctl, created) => reorderOp(ctl, created, path, order, out))
