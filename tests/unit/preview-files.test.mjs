// Preview readers other than DGN: OLE compound files and their stored previews, DWG saved
// previews, spreadsheets (SheetJS) and Word (mammoth). Fixtures are built in code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { load } from './preview-hooks.mjs'

const XLSX = await import('xlsx')
const { Cfb, bufferSource } = await load('engine/preview/cfb.ts')
const { readOlePreview, readSummary, sniffImage } = await load('engine/preview/olepreview.ts')
const { readDwgThumbnail, dibToBmp, dwgVersion } = await load('engine/preview/dwg.ts')
const { sheetBook, sheetGrid, MAX_ROWS, MAX_COLS } = await load('engine/preview/sheet.ts')
const { docxToHtml } = await load('engine/preview/word.ts')
const { sniff } = await load('engine/preview/worker.ts')

const le32 = (v) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(v >>> 0)
  return b
}
const le16 = (v) => {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(v)
  return b
}

/** 1x1 PNG, built with zlib so the test needs no binary fixture. */
function png() {
  const crcT = new Uint32Array(256).map((_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type), data])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))), chunk('IEND', Buffer.alloc(0))])
}

/** 2x2 8-bit device-independent bitmap (header + 256-colour table + pixels). */
function dib() {
  const h = Buffer.alloc(40)
  h.writeUInt32LE(40, 0)
  h.writeInt32LE(2, 4)
  h.writeInt32LE(2, 8)
  h.writeUInt16LE(1, 12)
  h.writeUInt16LE(8, 14)
  return Buffer.concat([h, Buffer.alloc(1024, 0x7f), Buffer.from([0, 1, 0, 0, 1, 0, 0, 0])])
}

/** \005SummaryInformation stream with a title, an author and (optionally) a thumbnail. */
function summary(thumb, tag = 0xffffffff, fmt = 8) {
  const str = (s) => {
    const b = Buffer.from(s + '\0', 'latin1')
    const pad = Buffer.alloc((4 - (b.length % 4)) % 4)
    return Buffer.concat([le32(30), le32(b.length), b, pad])
  }
  const props = [[1, Buffer.concat([le32(2), le32(1252)])], [2, str('P&ID 1601')], [4, str('Kävi Müller')]]
  if (thumb) props.push([17, Buffer.concat([le32(71), le32(thumb.length + 8), le32(tag), le32(fmt), thumb, Buffer.alloc((4 - (thumb.length % 4)) % 4)])])
  let off = 8 + props.length * 8
  const table = []
  for (const [id, data] of props) {
    table.push(le32(id), le32(off))
    off += data.length
  }
  const set = Buffer.concat([le32(off), le32(props.length), ...table, ...props.map((p) => p[1])])
  const head = Buffer.alloc(48)
  head.writeUInt16LE(0xfffe, 0)
  head.writeUInt32LE(1, 24)
  head.writeUInt32LE(48, 44)
  return Buffer.concat([head, set])
}

function compound(streams) {
  const cfb = XLSX.CFB.utils.cfb_new()
  for (const [name, data] of streams) XLSX.CFB.utils.cfb_add(cfb, name, data)
  return Buffer.from(XLSX.CFB.write(cfb, { type: 'buffer' }))
}

test('sniff tells file kinds by their first bytes', () => {
  assert.equal(sniff(Uint8Array.from([0x08, 0x09, 0xfe, 0x02, 1, 8])), 'dgn7')
  assert.equal(sniff(Uint8Array.from([0xc8, 0x09, 0xfe, 0x02])), 'dgn7')
  assert.equal(sniff(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), 'cfb')
  assert.equal(sniff(Buffer.from('AC1032\0\0')), 'dwg')
  assert.equal(sniff(Buffer.from('PK\x03\x04....')), 'zip')
  assert.equal(sniff(Buffer.from('%PDF-1.7')), 'pdf')
  assert.equal(sniff(Buffer.from('ACME corp notes')), 'other')
  assert.equal(sniff(new Uint8Array(0)), 'other')
})

test('compound file: big and small streams, storages, paths', () => {
  const big = Buffer.alloc(9000, 0)
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 255
  const small = Buffer.from('small stream in the mini stream')
  const file = compound([['/Big', big], ['/Folder/Small', small], ['/Empty', Buffer.alloc(0)]])
  const cfb = new Cfb(bufferSource(file))
  const paths = cfb.streams().map((e) => e.path)
  assert.ok(paths.includes('Big') && paths.includes('Folder/Small'), paths.join())
  assert.ok(cfb.read(cfb.find('big')).equals(big))
  assert.ok(cfb.read(cfb.find('Folder/Small')).equals(small))
  assert.equal(cfb.read(cfb.find('Big'), 10).length, 10)
  assert.equal(cfb.find('Folder'), undefined, 'storages are not streams')
})

test('compound file: garbage and truncation throw instead of hanging', () => {
  assert.throws(() => new Cfb(bufferSource(Buffer.alloc(600))), /Not a compound file/)
  const file = compound([['/Big', Buffer.alloc(20000, 1)]])
  assert.throws(() => {
    const c = new Cfb(bufferSource(file.subarray(0, 2048)))
    c.read(c.find('Big'))
  })
  // FAT chain that points at itself
  const loop = Buffer.from(file)
  const fatSector = loop.readUInt32LE(76)
  const start = new Cfb(bufferSource(file)).find('Big').start
  loop.writeUInt32LE(start, (fatSector + 1) * 512 + start * 4)
  assert.throws(() => {
    const c = new Cfb(bufferSource(loop))
    c.read(c.find('Big'))
  }, /chain/i)
})

test('summary information: text properties and thumbnail variants', () => {
  const s = readSummary(summary(null))
  assert.deepEqual(s.props, [['Title', 'P&ID 1601'], ['Author', 'Kävi Müller']])
  assert.equal(s.thumb, null)
  const d = readSummary(summary(dib()))
  assert.equal(d.thumb.kind, 'bmp')
  assert.equal(d.thumb.data.subarray(0, 2).toString(), 'BM')
  const p = readSummary(summary(png(), 0xffffffff, 0))
  assert.equal(p.thumb.kind, 'png')
  // metafile picture: 8-byte mapping header, then an EMF
  const emf = Buffer.alloc(96)
  emf.writeUInt32LE(1, 0)
  emf.writeUInt32LE(0x464d4520, 40)
  const m = readSummary(summary(Buffer.concat([Buffer.alloc(8), emf]), 0xffffffff, 3))
  assert.equal(m.thumb.kind, 'emf')
  assert.equal(readSummary(Buffer.alloc(10)).props.length, 0)
  // a thumbnail whose stated size runs past the stream is ignored
  const cut = summary(dib())
  assert.equal(readSummary(cut.subarray(0, cut.length - 200)).thumb, null)
  assert.equal(sniffImage(Buffer.alloc(64)), null)
})

test('OLE preview: found only where a preview is really stored', () => {
  const none = readOlePreview(bufferSource(compound([['/PSMroots', Buffer.alloc(64)], ['/JSite1/CONTENTS', Buffer.concat([Buffer.from('BM'), Buffer.alloc(5000)])], ['/\u0005SummaryInformation', summary(null)]])))
  assert.equal(none.app, 'SmartSketch')
  assert.equal(none.data, null, 'an embedded picture is not a preview')
  assert.deepEqual(none.props, [['Title', 'P&ID 1601'], ['Author', 'Kävi Müller']])
  const v8 = readOlePreview(bufferSource(compound([['/Dgn~H', Buffer.alloc(64)], ['/\u0005SummaryInformation', summary(dib())]])))
  assert.equal(v8.app, 'MicroStation V8')
  assert.equal(v8.kind, 'bmp')
  assert.equal(v8.stored, 'thumbnail property')
  const named = readOlePreview(bufferSource(compound([['/PreviewPicture', png()]])))
  assert.equal(named.kind, 'png')
})

test('SmartSketch title block fields are read from the tagged text streams', () => {
  const r = readOlePreview(
    bufferSource(
      compound([
        ['/PSMroots', Buffer.alloc(64)],
        ['/TaggedTxtData/TitleArea', Buffer.from('<TitleArea><Border/><DrawingNumber>MM-950 &amp; 951</DrawingNumber><Sheet/></TitleArea>')],
        ['/TaggedTxtData/Revision', Buffer.from('<Revision><RevisionRecord><MajorRev_ForRevise>E1</MajorRev_ForRevise><RevisedBy>S.Y</RevisedBy></RevisionRecord></Revision>')]
      ])
    )
  )
  assert.deepEqual(r.props, [['Drawing Number', 'MM-950 & 951'], ['Revision record', 'Major Rev: E1 · Revised By: S.Y']])
})

function dwg(version, entries, { seeker = 0x80, sequentialOnly = false } = {}) {
  const sentinel = Buffer.from([0x1f, 0x25, 0x6d, 0x07, 0xd4, 0x36, 0x28, 0x28, 0x9d, 0x57, 0xca, 0x3f, 0x9d, 0x44, 0x10, 0x2b])
  const head = Buffer.alloc(seeker)
  head.write(version, 0, 'latin1')
  head.writeUInt32LE(seeker, 13)
  const dirSize = 5 + entries.length * 9
  let pos = seeker + 16 + dirSize
  const dir = []
  for (const [code, data] of entries) {
    dir.push(Buffer.from([code]), le32(sequentialOnly ? 0xfffffff0 : pos), le32(data.length))
    pos += data.length
  }
  const body = Buffer.concat(entries.map((e) => e[1]))
  return Buffer.concat([head, sentinel, le32(dirSize - 4 + body.length), Buffer.from([entries.length]), ...dir, body, Buffer.alloc(16)])
}

test('DWG: version names and saved preview in BMP and PNG form', () => {
  assert.equal(dwgVersion(Buffer.from('AC1027\0')), 'AC1027')
  assert.equal(dwgVersion(Buffer.from('hello!')), '')
  const b = readDwgThumbnail(bufferSource(dwg('AC1015', [[1, Buffer.alloc(80)], [2, dib()]])))
  assert.deepEqual([b.version, b.release, b.kind], ['AC1015', 'AutoCAD 2000', 'bmp'])
  assert.equal(b.data.subarray(0, 2).toString(), 'BM')
  assert.equal(b.data.readUInt32LE(10), 14 + 40 + 1024, 'pixel offset skips the colour table')
  assert.equal(b.data.readUInt32LE(2), b.data.length)
  const p = readDwgThumbnail(bufferSource(dwg('AC1032', [[1, Buffer.alloc(80)], [6, png()]])))
  assert.deepEqual([p.release, p.kind], ['AutoCAD 2018', 'png'])
  assert.ok(p.data.equals(png()))
  // offsets in the directory are wrong: the block layout still finds the picture
  const s = readDwgThumbnail(bufferSource(dwg('AC1024', [[1, Buffer.alloc(80)], [2, dib()]], { sequentialOnly: true })))
  assert.equal(s.kind, 'bmp')
})

test('DWG: no preview, old versions and damaged blocks give null, never garbage', () => {
  assert.equal(readDwgThumbnail(bufferSource(dwg('AC1027', [[1, Buffer.alloc(80)]]))).kind, null)
  assert.equal(readDwgThumbnail(bufferSource(dwg('AC1009', [[2, dib()]]))).kind, null, 'R12 has no preview block')
  assert.equal(readDwgThumbnail(bufferSource(dwg('AC1015', [[2, Buffer.alloc(2000, 0xee)]]))).kind, null, 'not a bitmap header')
  assert.equal(readDwgThumbnail(bufferSource(dwg('AC1015', [[6, dib()]]))).kind, null, 'not a PNG')
  const good = dwg('AC1015', [[2, dib()]])
  assert.equal(readDwgThumbnail(bufferSource(good.subarray(0, good.length - 600))).kind, null, 'truncated picture')
  const stub = readDwgThumbnail(bufferSource(good.subarray(0, 100)))
  assert.deepEqual([stub.kind, stub.cutShort], [null, true], 'preview pointer beyond the end of the file')
  assert.equal(readDwgThumbnail(bufferSource(dwg('AC1027', [[1, Buffer.alloc(80)]]))).cutShort, undefined)
  const noSentinel = Buffer.from(good)
  noSentinel.fill(0, 0x80, 0x90)
  assert.equal(readDwgThumbnail(bufferSource(noSentinel)).kind, null)
  assert.throws(() => readDwgThumbnail(bufferSource(Buffer.from('not a drawing at all'))), /Not a DWG/)
  assert.equal(dibToBmp(Buffer.alloc(40)), null)
})

test('spreadsheet: sheets, formatted text, merges, widths, hidden rows, caps', async () => {
  const wb = XLSX.utils.book_new()
  const rows = [['Line', 'Size', 'Date', 'Ok'], ['P-101', 6.5, new Date(Date.UTC(2026, 9, 8)), true]]
  for (let i = 0; i < MAX_ROWS + 500; i++) rows.push([`L-${i}`, i])
  const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: false })
  ws.B2.z = '0.00'
  ws['!merges'] = [{ s: { r: 4, c: 0 }, e: { r: 5, c: 2 } }]
  ws['!cols'] = [{ wpx: 120 }, { wpx: 60, hidden: true }]
  ws['!rows'] = [{}, {}, { hidden: true }]
  XLSX.utils.book_append_sheet(wb, ws, 'Lines')
  const wide = XLSX.utils.aoa_to_sheet([Array.from({ length: MAX_COLS + 20 }, (_, i) => i)])
  XLSX.utils.book_append_sheet(wb, wide, 'Wide')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'Empty')
  wb.Workbook = { Sheets: [{}, { Hidden: 1 }, {}] }
  const buf = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true }))

  const book = await sheetBook(buf, 'xlsx')
  assert.deepEqual(book.sheets, [{ name: 'Lines', hidden: false }, { name: 'Wide', hidden: true }, { name: 'Empty', hidden: false }])

  const g = await sheetGrid(buf, 'xlsx', 0)
  assert.equal(g.name, 'Lines')
  assert.equal(g.rows, MAX_ROWS)
  assert.equal(g.totalRows, MAX_ROWS + 502)
  assert.equal(g.capped, true)
  const at = (r, c) => g.cells.find((x) => x.r === r && x.c === c)
  assert.deepEqual(at(0, 0), { r: 0, c: 0, t: 'Line', k: 's' })
  assert.equal(at(1, 1).t, '6.50', 'text follows the number format')
  assert.equal(at(1, 1).k, 'n')
  assert.equal(at(1, 3).t, 'TRUE')
  assert.match(at(1, 2).t, /\d/)
  assert.deepEqual(g.merges, [[4, 0, 5, 2]])
  assert.equal(g.widths[0], 120)
  assert.deepEqual(g.hiddenCols, [1])
  assert.deepEqual(g.hiddenRows, [2])
  assert.ok(g.cells.every((c) => c.r < MAX_ROWS && c.c < MAX_COLS))

  const w = await sheetGrid(buf, 'xlsx', 1)
  assert.equal(w.cols, MAX_COLS)
  assert.equal(w.totalCols, MAX_COLS + 20)
  assert.equal(w.capped, true)
  const e = await sheetGrid(buf, 'xlsx', 2)
  assert.equal(e.rows, 0)
  assert.equal((await sheetGrid(buf, 'xlsx', 9)).rows, 0, 'missing sheet index')
})

test('spreadsheet: formulas show their stored value and are not evaluated', async () => {
  const ws = XLSX.utils.aoa_to_sheet([[1, 2]])
  ws.C1 = { t: 'n', v: 99, f: 'A1+B1' } // stored result deliberately wrong
  ws.D1 = { t: 's', v: 'x', f: 'HYPERLINK("http://example.invalid/","x")' }
  ws['!ref'] = 'A1:D1'
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'S')
  const g = await sheetGrid(Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })), 'xlsx', 0)
  assert.equal(g.cells.find((c) => c.c === 2).t, '99')
  assert.ok(g.cells.every((c) => !('f' in c)))
})

test('spreadsheet: csv keeps text as written; legacy xls reads too', async () => {
  const csv = Buffer.from('Tag,Code,Date\r\nP-1,007,01/02/2026\r\n"A, B",1E5,\r\n')
  const book = await sheetBook(csv, 'csv')
  assert.equal(book.sheets.length, 1)
  const g = await sheetGrid(csv, 'csv', 0)
  const t = (r, c) => g.cells.find((x) => x.r === r && x.c === c)?.t
  assert.equal(t(1, 1), '007', 'leading zeros survive')
  assert.equal(t(1, 2), '01/02/2026', 'dates are not reinterpreted')
  assert.equal(t(2, 0), 'A, B')
  assert.equal(t(2, 1), '1E5')
  const tsv = await sheetGrid(Buffer.from('a\tb,c\n1\t2\n'), 'tsv', 0)
  assert.equal(tsv.cells.find((x) => x.r === 0 && x.c === 1).t, 'b,c')

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['old', 1.5]]), 'Legacy')
  const xls = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'biff8' }))
  assert.equal((await sheetBook(xls, 'xls')).sheets[0].name, 'Legacy')
  assert.equal((await sheetGrid(xls, 'xls', 0)).cells[0].t, 'old')
  await assert.rejects(sheetBook(Buffer.from('PK\x03\x04 broken zip'), 'xlsx'))
  // text saved under a workbook extension is shown, and said to be what it is
  const fake = await sheetBook(Buffer.from('Tag\tSize\nP-1\t6\n'), 'xls')
  assert.ok(fake.notes.some((n) => /not a real \.xls workbook/.test(n)))
  assert.equal((await sheetBook(xls, 'xls')).notes.length, 0)
})

/** Minimal .docx: a zip (through SheetJS's container writer) with one document part. */
function docx(bodyXml, extra = []) {
  const zip = XLSX.CFB.utils.cfb_new()
  const add = (name, text) => XLSX.CFB.utils.cfb_add(zip, name, Buffer.isBuffer(text) ? text : Buffer.from(text))
  add('/[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="emf" ContentType="image/x-emf"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  add('/_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  add('/word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${extra.map(([id, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/>`).join('')}</Relationships>`)
  add('/word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${bodyXml}</w:body></w:document>`)
  for (const [, target, data] of extra) add(`/word/${target}`, data)
  return Buffer.from(XLSX.CFB.write(zip, { type: 'buffer', fileType: 'zip' }))
}
const para = (t, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`
const picture = (id) => `<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="${id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`

test('Word: text and tables become HTML, pictures are inlined or reported', async () => {
  const table = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Line</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>6"</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
  const r = await docxToHtml(docx(para('Scope of work', 'Heading1') + para('Tie-in &lt;TP-12&gt; at rack 3') + table + picture('rId5') + picture('rId6'), [['rId5', 'media/a.png', png()], ['rId6', 'media/b.emf', Buffer.alloc(200)]]))
  assert.match(r.html, /<h1>Scope of work<\/h1>/)
  assert.match(r.html, /Tie-in &lt;TP-12&gt; at rack 3/, 'text stays escaped')
  assert.match(r.html, /<table>.*<td><p>Line<\/p><\/td>/s)
  assert.match(r.html, /<img src="data:image\/png;base64,[A-Za-z0-9+/=]+"/)
  assert.match(r.html, /alt="Picture not shown \(EMF\)"/)
  assert.ok(r.notes.some((n) => /1 EMF picture cannot be shown/.test(n)))
  assert.ok(r.notes[0].startsWith('Simplified view'))
  assert.ok(!/<script/i.test(r.html))
  const empty = await docxToHtml(docx(''))
  assert.ok(empty.notes.some((n) => /No text/.test(n)))
  await assert.rejects(docxToHtml(Buffer.from('this is not a zip')))
})

// Real files: set HOPPER_PREVIEW_SAMPLES to a folder with .dwg / .sha / .dgn (V8) / .xls* / .docx files.
const samples = process.env.HOPPER_PREVIEW_SAMPLES
test('real samples read without errors', { skip: !samples && 'HOPPER_PREVIEW_SAMPLES not set' }, async () => {
  for (const f of readdirSync(samples)) {
    const buf = readFileSync(join(samples, f))
    const kind = sniff(buf.subarray(0, 16))
    const ext = f.split('.').pop().toLowerCase()
    if (kind === 'dwg') {
      const t = readDwgThumbnail(bufferSource(buf))
      assert.ok(t.release, `${f}: release name`)
      if (t.data) assert.ok(['bmp', 'png', 'wmf'].includes(t.kind))
    } else if (kind === 'cfb' && ['sha', 'dgn', 'doc'].includes(ext)) {
      const o = readOlePreview(bufferSource(buf))
      if (ext === 'sha') assert.equal(o.app, 'SmartSketch', f)
    } else if (['xlsx', 'xlsm', 'xlsb', 'xls'].includes(ext)) {
      const book = await sheetBook(buf, ext)
      assert.ok(book.sheets.length > 0, f)
      const g = await sheetGrid(buf, ext, 0)
      assert.ok(g.rows <= MAX_ROWS && g.cols <= MAX_COLS, f)
    } else if (ext === 'docx') {
      assert.ok((await docxToHtml(buf)).html.length > 0, f)
    }
  }
})
