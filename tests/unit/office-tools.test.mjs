// Office tools (PDF toolkit, folder templates, lot packager) against real files in a temp folder.
// The engine sources are TypeScript with bundler-style imports, so a small resolve hook maps
// "@shared/*" and extensionless relative imports to .ts files, and stubs ../archive (7-Zip).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { existsSync, promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ARCHIVE_STUB = 'data:text/javascript,' + encodeURIComponent('export const createArchive = (...a) => globalThis.__createArchive(...a)')

registerHooks({
  resolve(spec, context, next) {
    const parent = context.parentURL ?? ''
    if (spec.startsWith('@shared/')) return next(pathToFileURL(join(ROOT, 'src/shared', spec.slice(8) + '.ts')).href, context)
    if (parent.endsWith('.ts') && /^\.\.?\//.test(spec) && !extname(spec)) {
      if (spec === '../archive') return { url: ARCHIVE_STUB, shortCircuit: true }
      const file = fileURLToPath(new URL(spec + '.ts', parent))
      if (existsSync(file)) return next(pathToFileURL(file).href, context)
    }
    return next(spec, context)
  }
})

const { PDFDocument, StandardFonts } = await import('pdf-lib')
const ExcelJS = (await import('exceljs')).default
const pdf = await import('../../src/engine/office/pdf.ts')
const templates = await import('../../src/engine/office/templates.ts')
const packager = await import('../../src/engine/office/packager.ts')
const { defaultOffice } = await import('../../src/shared/defaults.ts')

let dir
const undo = []
const jobs = new Map()

function fakeCtl() {
  return {
    info: { errors: [], done: 0, files: 0, total: 0, filesTotal: 0 },
    cancelled: false,
    signal: new AbortController().signal,
    async checkpoint() {},
    add(b, f = 0) { this.info.done += b; this.info.files += f },
    setCurrent(p) { this.info.current = p },
    setTotal(b, f) { this.info.total = b; this.info.filesTotal = f },
    fail(path, message) { this.info.errors.push({ path, message }) },
    ask: async () => ({ answer: 'skip', all: true })
  }
}

const office = {
  ...defaultOffice(),
  conventions: [{ id: 'iso', name: 'Iso drawing', pattern: 'ISO-[0-9]{3}_Rev[0-9A-Z]+' }]
}
const ctx = {
  emit() {},
  office,
  settings: null,
  undo: { record: (r) => undo.push(r) },
  jobs: {
    create(kind, title, run, opts) {
      const id = 'j' + (jobs.size + 1)
      const ctl = fakeCtl()
      jobs.set(id, run(ctl).then((out) => { if (out) ctl.info.output = out; return ctl.info }))
      return id
    }
  }
}
const wait = (id) => jobs.get(id)

async function makePdf(path, pages, label) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= pages; i++) doc.addPage([300, 400]).drawText(`${label} page ${i}`, { x: 20, y: 360, size: 14, font })
  doc.setTitle(label)
  doc.setAuthor('test')
  await fsp.writeFile(path, await doc.save())
  return path
}
const pages = async (p) => (await PDFDocument.load(await fsp.readFile(p))).getPageCount()

before(async () => {
  const base = process.env.HOPPER_TEST_TMP ?? tmpdir()
  dir = await fsp.mkdtemp(join(base, 'hopper-office-'))
  await makePdf(join(dir, 'ISO-101_RevA.pdf'), 2, 'A')
  await makePdf(join(dir, 'ISO-102_RevB.pdf'), 3, 'B')
  await makePdf(join(dir, 'notes.pdf'), 1, 'C')
})
after(async () => {
  if (!process.env.HOPPER_KEEP_TEST_OUTPUT) await fsp.rm(dir, { recursive: true, force: true })
})

test('pdf.info', async () => {
  const i = await pdf.info(join(dir, 'ISO-102_RevB.pdf'))
  assert.equal(i.pages, 3)
  assert.equal(i.title, 'B')
  assert.equal(i.author, 'test')
  assert.equal(i.encrypted, false)
  assert.ok(i.bytes > 0)
})

test('pdf merge, never overwriting', async () => {
  const out = join(dir, 'merged.pdf')
  const files = ['ISO-101_RevA.pdf', 'ISO-102_RevB.pdf', 'notes.pdf'].map((f) => join(dir, f))
  const a = await wait(pdf.merge(ctx, files, out))
  assert.equal(a.output, out)
  assert.equal(await pages(out), 6)
  const b = await wait(pdf.merge(ctx, files, out))
  assert.equal(b.output, join(dir, 'merged (2).pdf'))
  assert.deepEqual(undo.at(-1).pairs, [['', b.output]])
})

test('pdf split each and ranges', async () => {
  const src = join(dir, 'merged.pdf')
  const each = await wait(pdf.split(ctx, src, 'each', '', join(dir, 'each')))
  assert.equal(each.output, join(dir, 'each'))
  assert.equal((await fsp.readdir(join(dir, 'each'))).length, 6)
  assert.deepEqual(undo.at(-1).pairs, [['', join(dir, 'each')]]) // the created folder, not each part
  await wait(pdf.split(ctx, src, 'ranges', '1-2,4,5-', join(dir, 'ranges')))
  const names = (await fsp.readdir(join(dir, 'ranges'))).sort()
  assert.deepEqual(names, ['merged p1-2.pdf', 'merged p4.pdf', 'merged p5-6.pdf'])
  assert.equal(await pages(join(dir, 'ranges', 'merged p5-6.pdf')), 2)
  assert.throws(() => pdf.parseRanges('1-9', 6), /outside/)
  assert.throws(() => pdf.parseRanges('a', 6), /Bad page range/)
  assert.deepEqual(pdf.parseRanges('-2, 6', 6), [[1, 2], [6, 6]])
})

test('pdf extract and reorder', async () => {
  const src = join(dir, 'merged.pdf')
  const ex = await wait(pdf.extract(ctx, src, [6, 1], join(dir, 'extract.pdf')))
  assert.equal(await pages(ex.output), 2)
  const re = await wait(pdf.reorder(ctx, join(dir, 'ISO-102_RevB.pdf'), [3, 1, 2], join(dir, 'reordered.pdf')))
  assert.equal(await pages(re.output), 3)
  await assert.rejects(wait(pdf.reorder(ctx, src, [1, 2], join(dir, 'bad.pdf'))), /exactly once/)
  await assert.rejects(wait(pdf.extract(ctx, src, [7], join(dir, 'bad.pdf'))), /outside/)
})

test('pdf rotate in place records no undo; to another file it does', async () => {
  const src = join(dir, 'extract.pdf')
  const n = undo.length
  const r = await wait(pdf.rotate(ctx, src, 'all', 90, src))
  assert.equal(r.output, src)
  assert.equal(undo.length, n)
  const d = await PDFDocument.load(await fsp.readFile(src))
  assert.deepEqual(d.getPages().map((p) => p.getRotation().angle), [90, 90])
  const r2 = await wait(pdf.rotate(ctx, src, [2], 270, join(dir, 'merged.pdf')))
  assert.equal(r2.output, join(dir, 'merged (3).pdf'))
  const d2 = await PDFDocument.load(await fsp.readFile(r2.output))
  assert.deepEqual(d2.getPages().map((p) => p.getRotation().angle), [90, 0])
  assert.equal(undo.length, n + 1)
  assert.equal((await fsp.readdir(dir)).filter((f) => f.endsWith('.hopper-tmp')).length, 0)
})

test('templates create with substitution and refuse traversal', async () => {
  const dest = join(dir, 'tpl')
  await fsp.mkdir(dest)
  const r = await templates.create(ctx, 'lot', dest, { name: 'Lot 07' })
  assert.equal(r.created.length, 5)
  assert.ok(existsSync(join(dest, 'Lot 07', '04_Issued')))
  assert.deepEqual(undo.at(-1).pairs, [['', join(dest, 'Lot 07')]])
  const again = await templates.create(ctx, 'lot', dest, { name: 'Lot 07' })
  assert.equal(again.created.length, 0)
  await assert.rejects(templates.create(ctx, 'lot', dest, {}), /needs a value for \{name\}/)
  await assert.rejects(templates.create(ctx, 'lot', dest, { name: '../x' }), /not allow/)
  await assert.rejects(templates.create(ctx, { id: 't', name: 't', folders: ['a/../../b'] }, dest), /leaves/)
  await assert.rejects(templates.create(ctx, { id: 't', name: 't', folders: ['C:/x'] }, dest), /absolute/)
  await assert.rejects(templates.create(ctx, { id: 't', name: 't', folders: ['{date}_{project}'] }, dest, { date: '05/11/2026', project: 'P' }), /YYYY-MM-DD/)
  const d = await templates.create(ctx, { id: 't', name: 't', folders: ['{date}_{project}'] }, dest, { date: '2026-11-05', project: 'P1' })
  assert.deepEqual(d.created, [join(dest, '2026-11-05_P1')])
})

test('package.plan reports conventions, revisions, clashes and missing files', async () => {
  await fsp.mkdir(join(dir, 'other'), { recursive: true })
  await makePdf(join(dir, 'other', 'notes.pdf'), 1, 'D')
  const r = await packager.plan(ctx, {
    files: [join(dir, 'ISO-101_RevA.pdf'), join(dir, 'ISO-102_RevB.pdf'), join(dir, 'notes.pdf'), join(dir, 'other', 'notes.pdf'), join(dir, 'gone.pdf')],
    conventionId: 'iso'
  })
  assert.deepEqual(r.files.map((f) => f.convention), ['ok', 'ok', 'fail', 'fail', 'fail'])
  assert.deepEqual(r.files.map((f) => f.rev), ['A', 'B', null, null, null])
  assert.equal(r.totals.missing, 1)
  assert.equal(r.totals.nameClashes, 1)
  assert.equal(r.blocking.length, 2)
  const none = await packager.plan(ctx, { files: [join(dir, 'notes.pdf')], conventionId: 'nope' })
  assert.equal(none.files[0].convention, 'no convention')
  assert.equal(none.warnings.length, 1)
})

test('package.run copies, writes the transmittal and archives', async () => {
  const out = join(dir, 'issue')
  await fsp.mkdir(out)
  let archived
  globalThis.__createArchive = async (c, ctl, sources, file, preset) => {
    archived = { sources, file, preset: preset.id }
    await fsp.writeFile(file, 'zip')
    return file
  }
  const files = [join(dir, 'ISO-101_RevA.pdf'), join(dir, 'ISO-102_RevB.pdf'), join(dir, 'notes.pdf')]
  // a set mtime must survive the copy
  const when = new Date('2026-10-01T09:30:00')
  await fsp.utimes(files[0], when, when)
  const spec = {
    files, outDir: out, name: 'LOT-07', conventionId: 'iso', copy: true, zip: true,
    transmittal: { number: 'DDS/TR/0042', project: 'P12513', client: 'FST', to: 'Client QA', from: 'Dexterity', purpose: 'For approval', date: '05-Nov-2026', notes: 'Second lot.\nBack-checked.' }
  }
  const info = await wait(packager.run(ctx, spec))
  const lot = join(out, 'LOT-07')
  assert.equal(info.output, join(out, 'LOT-07.zip'))
  assert.deepEqual(archived, { sources: [lot], file: join(out, 'LOT-07.zip'), preset: 'balanced' })
  const names = (await fsp.readdir(lot)).sort()
  assert.deepEqual(names, ['ISO-101_RevA.pdf', 'ISO-102_RevB.pdf', 'Transmittal DDS-TR-0042.pdf', 'Transmittal DDS-TR-0042.xlsx', 'notes.pdf'])
  assert.equal((await fsp.stat(join(lot, 'ISO-101_RevA.pdf'))).mtimeMs, when.getTime())
  assert.deepEqual(undo.at(-1).pairs, [['', lot], ['', join(out, 'LOT-07.zip')]])

  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(join(lot, 'Transmittal DDS-TR-0042.xlsx'))
  const ws = wb.getWorksheet('Transmittal')
  const cells = []
  const rowNo = []
  ws.eachRow((row, n) => {
    rowNo.push(n)
    cells.push(row.values.slice(1).map((v) => (v?.richText ? v.richText.map((t) => t.text).join('') : v)))
  })
  const head = cells.findIndex((r) => r[0] === 'S.No')
  assert.ok(head > 0)
  assert.deepEqual(cells.slice(head + 1).map((r) => [r[0], r[1], r[2]]), [[1, 'ISO-101_RevA.pdf', 'A'], [2, 'ISO-102_RevB.pdf', 'B'], [3, 'notes.pdf', '']])
  assert.equal(ws.getCell(`B${rowNo[head] + 1}`).font.name, 'Arial')
  assert.equal(ws.views[0].state, 'frozen')

  const tp = await PDFDocument.load(await fsp.readFile(join(lot, 'Transmittal DDS-TR-0042.pdf')))
  assert.equal(tp.getPageCount(), 1)
  assert.equal(tp.getTitle(), 'Transmittal DDS/TR/0042')

  // a second run never overwrites: folder and archive get " (2)"
  const again = await wait(packager.run(ctx, spec))
  assert.equal(again.output, join(out, 'LOT-07 (2).zip'))
})

test('package.run paginates a long transmittal and refuses a blocked lot', async () => {
  const out = join(dir, 'long')
  await fsp.mkdir(out)
  const files = []
  for (let i = 0; i < 70; i++) {
    const p = join(out, `ISO-${String(i).padStart(3, '0')}_Rev0.pdf`)
    await fsp.writeFile(p, 'x'.repeat(100))
    files.push(p)
  }
  const spec = { files, outDir: out, name: 'BIG', copy: false, zip: false, transmittal: { number: '7', project: 'P', to: 'T', from: 'F', purpose: 'Info', date: 'today', notes: 'Ünïcode ✓ check' } }
  const info = await wait(packager.run(ctx, spec))
  assert.equal(info.output, join(out, 'BIG'))
  assert.deepEqual((await fsp.readdir(join(out, 'BIG'))).sort(), ['Transmittal 7.pdf', 'Transmittal 7.xlsx'])
  const tp = await PDFDocument.load(await fsp.readFile(join(out, 'BIG', 'Transmittal 7.pdf')))
  assert.ok(tp.getPageCount() >= 2)
  await assert.rejects(wait(packager.run(ctx, { ...spec, files: [join(out, 'missing.pdf')] })), /missing/)
  await assert.rejects(wait(packager.run(ctx, { ...spec, transmittal: { ...spec.transmittal, number: ' ' } })), /number is required/)
})
