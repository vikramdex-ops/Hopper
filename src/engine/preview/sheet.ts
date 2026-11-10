// Spreadsheet preview through SheetJS: sheet names first, then one capped grid per sheet on demand.
// Read-only by construction: only stored values and their formatted text are read; macros are not
// loaded (bookVBA off), formulas are not evaluated and external links are never followed.
// (This module is itself loaded on demand by the preview worker, so the static import of the
// library costs nothing until the first spreadsheet is previewed.)
import * as XLSX from 'xlsx'
import type { SheetBook, SheetCell, SheetGrid } from './types'

export const MAX_ROWS = 2000
export const MAX_COLS = 100
const MAX_CELL_TEXT = 2000
const TEXT_EXT = new Set(['csv', 'tsv', 'txt', 'prn'])

function decodeText(buf: Buffer) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf)
  const bad = (text.match(/�/g) ?? []).length
  return bad > 2 && bad > text.length / 200 ? new TextDecoder('windows-1252').decode(buf) : text
}

/** Options that keep parsing bounded and inert. */
function readOpts(ext: string, extra: Record<string, unknown>) {
  return { dense: true, cellFormula: false, cellHTML: false, cellStyles: true, bookVBA: false, bookFiles: false, bookDeps: false, WTF: false, ...(TEXT_EXT.has(ext) ? { raw: true } : {}), ...extra }
}

function read(data: Buffer, ext: string, extra: Record<string, unknown>): any {
  const X: any = XLSX
  if (TEXT_EXT.has(ext)) return X.read(decodeText(data), { type: 'string', ...readOpts(ext, extra), ...(ext === 'tsv' ? { FS: '\t' } : {}) })
  return X.read(data, { type: 'buffer', ...readOpts(ext, extra) })
}

export async function sheetBook(data: Buffer, ext: string, truncatedInput = false): Promise<SheetBook> {
  // An empty sheet list reads the workbook's own records (names, hidden flags) without parsing
  // any sheet; formats that ignore the option are held to one row per sheet.
  const wb = read(data, ext, { sheets: [], sheetRows: 1 })
  const meta: any[] = wb.Workbook?.Sheets ?? []
  const notes: string[] = []
  if (truncatedInput) notes.push('Large text file: only its first part was read.')
  const zip = data[0] === 0x50 && data[1] === 0x4b
  const ole = data[0] === 0xd0 && data[1] === 0xcf
  if (!TEXT_EXT.has(ext) && !zip && !ole) notes.push(`This is not a real .${ext} workbook: the file holds text or HTML, shown here as it reads.`)
  return {
    sheets: (wb.SheetNames as string[]).map((name, i) => ({ name, hidden: !!meta[i]?.Hidden })),
    format: String(wb.bookType ?? ext),
    notes
  }
}

export async function sheetGrid(data: Buffer, ext: string, index: number): Promise<SheetGrid> {
  const wb = read(data, ext, { sheets: index, sheetRows: MAX_ROWS })
  const name: string = wb.SheetNames[index]
  const ws = name === undefined ? undefined : wb.Sheets[name]
  const empty: SheetGrid = { index, name: name ?? '', rows: 0, cols: 0, totalRows: 0, totalCols: 0, capped: false, cells: [], merges: [], widths: [], hiddenRows: [], hiddenCols: [] }
  if (!ws || !ws['!ref']) return empty
  const full = XLSX.utils.decode_range(ws['!fullref'] ?? ws['!ref'])
  const totalRows = full.e.r + 1
  const totalCols = full.e.c + 1
  const rows = Math.min(totalRows, MAX_ROWS)
  const cols = Math.min(totalCols, MAX_COLS)
  const cells: SheetCell[] = []
  const grid: any[][] = ws['!data'] ?? []
  for (let r = 0; r < rows; r++) {
    const row = grid[r]
    if (!row) continue
    for (let c = 0; c < cols; c++) {
      const cell = row[c]
      if (!cell || cell.t === 'z') continue
      let t: string = cell.w ?? (cell.v === undefined || cell.v === null ? '' : cell.t === 'b' ? (cell.v ? 'TRUE' : 'FALSE') : String(cell.v))
      if (!t) continue
      if (t.length > MAX_CELL_TEXT) t = `${t.slice(0, MAX_CELL_TEXT)}…`
      cells.push({ r, c, t, k: cell.t })
    }
  }
  const merges: SheetGrid['merges'] = []
  for (const m of (ws['!merges'] ?? []) as any[]) {
    if (m.s.r >= rows || m.s.c >= cols || merges.length >= 5000) continue
    merges.push([m.s.r, m.s.c, Math.min(m.e.r, rows - 1), Math.min(m.e.c, cols - 1)])
  }
  const colInfo: any[] = ws['!cols'] ?? []
  const widths: (number | null)[] = []
  const hiddenCols: number[] = []
  for (let c = 0; c < cols; c++) {
    const ci = colInfo[c]
    const px = ci?.wpx ?? (ci?.wch ? ci.wch * 7 + 5 : ci?.width ? ci.width * 7 : null)
    widths.push(px && px > 0 ? Math.round(Math.max(16, Math.min(600, px))) : null)
    if (ci?.hidden) hiddenCols.push(c)
  }
  const hiddenRows: number[] = []
  const rowInfo: any[] = ws['!rows'] ?? []
  for (let r = 0; r < rows; r++) if (rowInfo[r]?.hidden) hiddenRows.push(r)
  return { index, name, rows, cols, totalRows, totalCols, capped: totalRows > rows || totalCols > cols, cells, merges, widths, hiddenRows, hiddenCols }
}
