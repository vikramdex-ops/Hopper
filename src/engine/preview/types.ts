// Result shapes of the preview.* engine methods, shared with the renderer's viewers (types only).

export interface PreviewImage {
  /** image/png, image/bmp or image/jpeg: something Chromium decodes */
  mime: string
  data: Uint8Array
}

export type FileSniff = 'dgn7' | 'cfb' | 'dwg' | 'zip' | 'pdf' | 'other'

export interface DwgPreview {
  /** version tag from the file, e.g. AC1032 */
  version: string
  /** AutoCAD release name for that tag, '' when unknown */
  release: string
  image: PreviewImage | null
  /** how the saved preview was stored in the drawing */
  stored: 'bmp' | 'png' | 'wmf' | null
  note: string
}

export interface OlePreview {
  /** what the compound file is, as far as its streams tell */
  app: 'SmartSketch' | 'MicroStation V8' | 'Word' | 'Excel' | 'compound file'
  image: PreviewImage | null
  stored: string | null
  /** document properties stored in the file (title, author, saved by…) */
  props: [string, string][]
  note: string
}

export interface SheetMeta {
  name: string
  hidden: boolean
}

export interface SheetBook {
  sheets: SheetMeta[]
  /** file format as detected by the reader, e.g. xlsx, biff8, csv */
  format: string
  notes: string[]
}

export interface SheetCell {
  /** row and column inside the returned grid */
  r: number
  c: number
  /** text as formatted by the cell's number format */
  t: string
  /** n number, s text, b boolean, e error, d date */
  k: string
}

export interface SheetGrid {
  index: number
  name: string
  rows: number
  cols: number
  /** rows and columns in the sheet's used range (before the cap) */
  totalRows: number
  totalCols: number
  capped: boolean
  cells: SheetCell[]
  /** start row, start col, end row, end col (inclusive), inside the grid */
  merges: [number, number, number, number][]
  /** column widths in px, where the file states them */
  widths: (number | null)[]
  /** rows the file marks hidden */
  hiddenRows: number[]
  hiddenCols: number[]
}

export interface DocxPreview {
  html: string
  /** things the conversion could not carry over */
  notes: string[]
}

export interface DgnText {
  x: number
  y: number
  /** character height and width in the drawing's units (UOR) */
  h: number
  w: number
  /** length of the string along its baseline taken from the element's range box, 0 if unknown */
  len: number
  /** baseline direction and up direction (unit vectors, or shorter when tilted out of the view) */
  ax: number
  ay: number
  bx: number
  by: number
  s: string
  level: number
  color: number
  font: number
  mirror: number
}

export interface DgnDrawing {
  format: 'V7'
  is3d: boolean
  units: { master: string; sub: string; subPerMaster: number; uorPerSub: number }
  /** design-file coordinates (UOR) of the display list's origin */
  origin: [number, number]
  /** box to fit on open, and box of everything drawn: minX, minY, maxX, maxY */
  fit: [number, number, number, number]
  extents: [number, number, number, number]
  /** polyline vertices x,y and the index of each polyline's first vertex (n + 1 entries) */
  lines: Float32Array
  lineStart: Uint32Array
  /** 5 bytes per polyline: level, colour, weight, style | 0x10 closed | 0x20 filled, fill colour */
  lineAttr: Uint8Array
  /** 8 floats per arc: centre x,y, primary axis vector, secondary axis vector, start, sweep (radians) */
  arcs: Float32Array
  arcAttr: Uint8Array
  texts: DgnText[]
  /** embedded raster images: top-left corner, size in pixels, drawing units per pixel */
  images: { x: number; y: number; w: number; h: number; pixel: number; level: number; rgba: Uint8Array }[]
  /** 256 RGB triplets */
  colors: Uint8Array
  hasColorTable: boolean
  levels: { level: number; count: number }[]
  elements: number
  drawn: number
  deleted: number
  truncated: boolean
  notices: string[]
}
