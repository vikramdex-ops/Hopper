// Transmittal documents for a packaged lot: an .xlsx (exceljs) and an A4 .pdf (pdf-lib).
// Both list the files exactly as packaged; a revision column is blank when none was parsed.
import ExcelJS from 'exceljs'
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { localDateTime, writeAtomic } from './util'
import type { TransmittalInfo } from './types'

export interface TransmittalRow {
  name: string
  rev: string | null
  size: number
  mtime: number
}

export interface TransmittalDoc {
  office: string
  info: TransmittalInfo
  rows: TransmittalRow[]
}

const kb = (bytes: number) => Math.ceil(bytes / 1024)
const kbText = (bytes: number) => `${kb(bytes).toLocaleString('en-US')} KB`

function headerPairs(t: TransmittalInfo): [string, string][][] {
  return [
    [['Project', t.project], ['Transmittal No.', t.number]],
    [['Client', t.client ?? ''], ['Date', t.date]],
    [['To', t.to], ['Purpose', t.purpose]],
    [['From', t.from], ['', '']]
  ]
}

// ---------------------------------------------------------------------------
// Excel

export async function writeXlsx(doc: TransmittalDoc, out: string) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Hopper'
  wb.created = new Date()
  const ws = wb.addWorksheet('Transmittal', {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } },
    headerFooter: { oddFooter: '&L&"Arial"&8Transmittal ' + doc.info.number.replace(/&/g, '&&') + '&R&"Arial"&8Page &P of &N' }
  })
  ws.columns = [{ width: 7 }, { width: 52 }, { width: 11 }, { width: 13 }, { width: 18 }]
  const font = (extra: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> => ({ name: 'Arial', size: 10, ...extra })
  const thin: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: 'FFBFBFBF' } }

  ws.mergeCells('A1:E1')
  ws.getCell('A1').value = doc.office
  ws.getCell('A1').font = font({ size: 14, bold: true })
  ws.mergeCells('A2:E2')
  ws.getCell('A2').value = 'TRANSMITTAL'
  ws.getCell('A2').font = font({ size: 12, bold: true, color: { argb: 'FF404040' } })
  ws.getCell('A2').border = { bottom: { style: 'medium', color: { argb: 'FF404040' } } }
  for (const c of ['B2', 'C2', 'D2', 'E2']) ws.getCell(c).border = { bottom: { style: 'medium', color: { argb: 'FF404040' } } }

  let r = 4
  for (const [[l1, v1], [l2, v2]] of headerPairs(doc.info)) {
    ws.mergeCells(`A${r}:B${r}`)
    ws.mergeCells(`C${r}:E${r}`)
    const rich = (l: string, v: string) => (l ? { richText: [{ text: `${l}:  `, font: font({ bold: true }) }, { text: v, font: font() }] } : '')
    ws.getCell(`A${r}`).value = rich(l1, v1)
    ws.getCell(`C${r}`).value = rich(l2, v2)
    r++
  }
  if (doc.info.notes) {
    ws.mergeCells(`A${r}:E${r}`)
    const c = ws.getCell(`A${r}`)
    c.value = { richText: [{ text: 'Notes:  ', font: font({ bold: true }) }, { text: doc.info.notes, font: font() }] }
    c.alignment = { wrapText: true, vertical: 'top' }
    ws.getRow(r).height = Math.min(120, 14 * Math.max(1, Math.ceil(doc.info.notes.length / 95) + (doc.info.notes.match(/\n/g)?.length ?? 0)))
    r++
  }

  r++
  const headRow = r
  const head = ws.getRow(headRow)
  head.values = ['S.No', 'File name', 'Revision', 'Size (KB)', 'Modified']
  head.eachCell((c, col) => {
    c.font = font({ bold: true })
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7E9EC' } }
    c.border = { top: thin, bottom: { style: 'thin', color: { argb: 'FF808080' } }, left: thin, right: thin }
    c.alignment = { vertical: 'middle', horizontal: col === 2 ? 'left' : 'center' }
  })
  head.height = 18

  // exceljs stores Dates as UTC serials; shift so Excel shows the local wall-clock time.
  const local = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000)
  doc.rows.forEach((row, i) => {
    const x = ws.getRow(headRow + 1 + i)
    x.values = [i + 1, row.name, row.rev ?? '', kb(row.size), local(row.mtime)]
    x.eachCell({ includeEmpty: true }, (c, col) => {
      c.font = font()
      c.border = { top: thin, bottom: thin, left: thin, right: thin }
      c.alignment = { vertical: 'middle', horizontal: col === 2 ? 'left' : col === 4 ? 'right' : 'center' }
    })
    x.getCell(4).numFmt = '#,##0'
    x.getCell(5).numFmt = 'yyyy-mm-dd hh:mm'
  })

  ws.views = [{ state: 'frozen', ySplit: headRow, xSplit: 0, topLeftCell: `A${headRow + 1}`, activeCell: `A${headRow + 1}` }]
  if (doc.rows.length) ws.autoFilter = { from: { row: headRow, column: 1 }, to: { row: headRow + doc.rows.length, column: 5 } }
  ws.pageSetup.printTitlesRow = `${headRow}:${headRow}`

  const buf = await wb.xlsx.writeBuffer()
  await writeAtomic(out, new Uint8Array(buf as ArrayBuffer))
}

// ---------------------------------------------------------------------------
// PDF

const A4: [number, number] = [595.28, 841.89]
const M = 40
const COLS = [
  { title: 'S.No', w: 34, align: 'center' as const },
  { title: 'File name', w: 261, align: 'left' as const },
  { title: 'Revision', w: 55, align: 'center' as const },
  { title: 'Size', w: 70, align: 'right' as const },
  { title: 'Modified', w: 95, align: 'center' as const }
]
const INK = rgb(0.13, 0.13, 0.13)
const GREY = rgb(0.45, 0.45, 0.45)
const RULE = rgb(0.75, 0.75, 0.75)

/** Standard fonts only cover WinAnsi; anything else is shown as "?" instead of failing. */
function safeText(font: PDFFont, text: string, memo: Map<string, boolean>) {
  let out = ''
  for (const ch of text.replace(/\t/g, ' ').replace(/\r\n?/g, '\n')) {
    if (ch === '\n') {
      out += ch // kept for wrap(); never drawn directly
      continue
    }
    let ok = memo.get(ch)
    if (ok === undefined) {
      try {
        font.encodeText(ch)
        ok = true
      } catch {
        ok = false
      }
      memo.set(ch, ok)
    }
    out += ok ? ch : '?'
  }
  return out
}

function fit(font: PDFFont, text: string, size: number, width: number) {
  if (font.widthOfTextAtSize(text, size) <= width) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (font.widthOfTextAtSize(text.slice(0, mid) + '...', size) <= width) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + '...'
}

function wrap(font: PDFFont, text: string, size: number, width: number) {
  const lines: string[] = []
  for (const para of text.split(/\r?\n/)) {
    let line = ''
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(next, size) <= width || !line) line = next
      else {
        lines.push(line)
        line = word
      }
    }
    lines.push(line)
  }
  return lines.map((l) => fit(font, l, size, width))
}

export async function writePdf(doc: TransmittalDoc, out: string) {
  const pdf = await PDFDocument.create()
  pdf.setTitle(`Transmittal ${doc.info.number}`)
  pdf.setSubject(doc.info.project)
  pdf.setCreator('Hopper')
  pdf.setProducer('Hopper (pdf-lib)')
  const reg = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const memo = new Map<string, boolean>()
  const s = (t: string) => safeText(reg, t, memo)
  const oneLine = (t: string) => s(t).replace(/\n/g, ' ')
  const W = A4[0] - 2 * M
  const rowH = 16
  const bottom = M + 28

  const text = (page: PDFPage, t: string, x: number, y: number, size: number, f = reg, color = INK) =>
    page.drawText(oneLine(t), { x, y, size, font: f, color })
  const rule = (page: PDFPage, y: number, thickness = 0.5, color = RULE) =>
    page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, thickness, color })

  const tableHead = (page: PDFPage, y: number) => {
    page.drawRectangle({ x: M, y: y - rowH + 4, width: W, height: rowH, color: rgb(0.91, 0.92, 0.93) })
    let x = M
    for (const c of COLS) {
      const tw = bold.widthOfTextAtSize(c.title, 9)
      const tx = c.align === 'left' ? x + 4 : c.align === 'right' ? x + c.w - 4 - tw : x + (c.w - tw) / 2
      text(page, c.title, tx, y - 8, 9, bold)
      x += c.w
    }
    rule(page, y - rowH + 4, 0.75, GREY)
    return y - rowH
  }

  // first page header block
  let page = pdf.addPage(A4)
  let y = A4[1] - M
  text(page, doc.office, M, y - 14, 14, bold)
  y -= 34
  text(page, 'TRANSMITTAL', M, y, 12, bold, GREY)
  y -= 8
  rule(page, y, 1.5, INK)
  y -= 18
  const colX = [M, M + W / 2 + 10]
  for (const pair of headerPairs(doc.info)) {
    pair.forEach(([label, value], i) => {
      if (!label) return
      text(page, `${label}:`, colX[i], y, 9.5, bold)
      text(page, fit(reg, oneLine(value), 9.5, W / 2 - 100), colX[i] + 85, y, 9.5)
    })
    y -= 15
  }
  if (doc.info.notes) {
    text(page, 'Notes:', M, y, 9.5, bold)
    for (const line of wrap(reg, s(doc.info.notes), 9.5, W - 85).slice(0, 12)) {
      text(page, line, M + 85, y, 9.5)
      y -= 13
    }
    y -= 2
  }
  y -= 10
  y = tableHead(page, y)

  doc.rows.forEach((row, i) => {
    if (y - rowH < bottom) {
      page = pdf.addPage(A4)
      y = A4[1] - M
      text(page, `Transmittal ${doc.info.number} (continued)`, M, y - 10, 9.5, bold, GREY)
      y -= 22
      y = tableHead(page, y)
    }
    const cells = [String(i + 1), row.name, row.rev ?? '', kbText(row.size), localDateTime(row.mtime)]
    let x = M
    COLS.forEach((c, k) => {
      const t = fit(reg, oneLine(cells[k]), 9, c.w - 8)
      const tw = reg.widthOfTextAtSize(t, 9)
      const tx = c.align === 'left' ? x + 4 : c.align === 'right' ? x + c.w - 4 - tw : x + (c.w - tw) / 2
      text(page, t, tx, y - 8, 9)
      x += c.w
    })
    rule(page, y - rowH + 4)
    y -= rowH
  })
  if (y - 20 < bottom) {
    page = pdf.addPage(A4)
    y = A4[1] - M
  }
  y -= 10
  const total = doc.rows.reduce((n, r) => n + r.size, 0)
  text(page, `${doc.rows.length} file${doc.rows.length === 1 ? '' : 's'}, ${kbText(total)}`, M, y - 4, 9, bold)

  const pages = pdf.getPages()
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: M + 14 }, end: { x: M + W, y: M + 14 }, thickness: 0.5, color: RULE })
    const footL = s(`Transmittal ${doc.info.number}`)
    p.drawText(fit(reg, footL, 8, W - 100), { x: M, y: M, size: 8, font: reg, color: GREY })
    const footR = `Page ${i + 1} of ${pages.length}`
    p.drawText(footR, { x: M + W - reg.widthOfTextAtSize(footR, 8), y: M, size: 8, font: reg, color: GREY })
  })

  await writeAtomic(out, await pdf.save())
}
