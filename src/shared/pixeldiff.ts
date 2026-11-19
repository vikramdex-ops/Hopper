// Visual diff of two rendered pages (RGBA, as from canvas getImageData). Pure arithmetic, no DOM,
// so it runs in a worker and in node:test. It only says where the ink differs; it never judges
// what a difference means.
//
// A pixel is "ink" when it is darker than `ink` (luminance over white paper, 0..255). Pages are
// aligned at the top-left; whatever lies outside a smaller page counts as white paper.
//   ink in both        -> dark grey
//   ink only in older  -> red
//   ink only in newer  -> green
//   ink in neither     -> white
// Changed pixels are counted on a grid of `cell` x `cell` squares; squares with at least
// `minPixels` changed pixels are joined (gaps up to `join` squares) into change boxes.

export interface DiffOptions {
  /** luminance below which a pixel is ink, default 200 */
  ink?: number
  /** grid square in pixels, default 16 */
  cell?: number
  /** changed pixels a square needs to count, default 3 (single anti-aliasing pixels are ignored) */
  minPixels?: number
  /** squares between two changes that still join them into one box, default 1 */
  join?: number
}

export interface ChangeBox {
  x: number
  y: number
  w: number
  h: number
  /** changed pixels inside */
  pixels: number
}

export interface DiffResult {
  width: number
  height: number
  /** RGBA overlay image, width x height */
  out: Uint8ClampedArray
  onlyOld: number
  onlyNew: number
  both: number
  cols: number
  rows: number
  cell: number
  /** changed pixels per grid square, row by row (for the heatmap) */
  cells: Uint32Array
  /** reading order: top to bottom, then left to right */
  boxes: ChangeBox[]
}

export const COLORS = {
  both: [40, 40, 40],
  onlyOld: [220, 38, 38],
  onlyNew: [22, 150, 70],
  paper: [255, 255, 255]
} as const

function inkMask(px: Uint8ClampedArray | Uint8Array, w: number, h: number, W: number, H: number, ink: number) {
  const m = new Uint8Array(W * H)
  for (let y = 0; y < h; y++) {
    let i = y * w * 4
    let o = y * W
    for (let x = 0; x < w; x++, i += 4, o++) {
      const a = px[i + 3]
      // composite over white paper, Rec. 601 luminance in 0..255
      const lum = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000
      const l = 255 - (a * (255 - lum)) / 255
      if (l < ink) m[o] = 1
    }
  }
  return m
}

export function pixelDiff(
  a: Uint8ClampedArray | Uint8Array, aw: number, ah: number,
  b: Uint8ClampedArray | Uint8Array, bw: number, bh: number,
  opts: DiffOptions = {}
): DiffResult {
  if (a.length < aw * ah * 4 || b.length < bw * bh * 4) throw new Error('pixel buffer is smaller than its size')
  const ink = opts.ink ?? 200
  const cell = Math.max(1, Math.floor(opts.cell ?? 16))
  const minPixels = Math.max(1, opts.minPixels ?? 3)
  const join = Math.max(0, Math.floor(opts.join ?? 1))
  const W = Math.max(aw, bw)
  const H = Math.max(ah, bh)
  const ma = inkMask(a, aw, ah, W, H, ink)
  const mb = inkMask(b, bw, bh, W, H, ink)
  const out = new Uint8ClampedArray(W * H * 4)
  const cols = Math.ceil(W / cell)
  const rows = Math.ceil(H / cell)
  const cells = new Uint32Array(cols * rows)
  let onlyOld = 0
  let onlyNew = 0
  let both = 0
  for (let y = 0; y < H; y++) {
    const crow = Math.floor(y / cell) * cols
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const ia = ma[i]
      const ib = mb[i]
      const c = ia && ib ? COLORS.both : ia ? COLORS.onlyOld : ib ? COLORS.onlyNew : COLORS.paper
      const o = i * 4
      out[o] = c[0]
      out[o + 1] = c[1]
      out[o + 2] = c[2]
      out[o + 3] = 255
      if (ia && ib) both++
      else if (ia || ib) {
        if (ia) onlyOld++
        else onlyNew++
        cells[crow + Math.floor(x / cell)]++
      }
    }
  }
  return { width: W, height: H, out, onlyOld, onlyNew, both, cols, rows, cell, cells, boxes: changeBoxes(cells, cols, rows, cell, W, H, minPixels, join) }
}

/** Join changed grid squares (8-connected, bridging `join` empty squares) into boxes in pixels. */
export function changeBoxes(cells: Uint32Array, cols: number, rows: number, cell: number, W: number, H: number, minPixels = 3, join = 1): ChangeBox[] {
  const seen = new Uint8Array(cols * rows)
  const boxes: ChangeBox[] = []
  const r = 1 + join
  const stack: number[] = []
  for (let start = 0; start < cells.length; start++) {
    if (seen[start] || cells[start] < minPixels) continue
    seen[start] = 1
    stack.push(start)
    let c0 = cols, c1 = -1, r0 = rows, r1 = -1, pixels = 0
    while (stack.length) {
      const k = stack.pop()!
      const cx = k % cols
      const cy = (k - cx) / cols
      pixels += cells[k]
      if (cx < c0) c0 = cx
      if (cx > c1) c1 = cx
      if (cy < r0) r0 = cy
      if (cy > r1) r1 = cy
      for (let dy = -r; dy <= r; dy++) {
        const ny = cy + dy
        if (ny < 0 || ny >= rows) continue
        for (let dx = -r; dx <= r; dx++) {
          const nx = cx + dx
          if (nx < 0 || nx >= cols) continue
          const n = ny * cols + nx
          if (seen[n] || cells[n] < minPixels) continue
          seen[n] = 1
          stack.push(n)
        }
      }
    }
    const x = c0 * cell
    const y = r0 * cell
    boxes.push({ x, y, w: Math.min(W, (c1 + 1) * cell) - x, h: Math.min(H, (r1 + 1) * cell) - y, pixels })
  }
  return boxes.sort((p, q) => p.y - q.y || p.x - q.x)
}

/**
 * Canvas pixels per PDF point for comparing two pages at `dpi`, lowered so that the larger page's
 * long side stays within `maxSide` pixels and its area within `maxPixels`. Both pages use the
 * same scale, so equal lengths on paper stay equal on screen.
 */
export function compareScale(pages: { w: number; h: number }[], dpi: number, maxSide = 8000, maxPixels = 32_000_000) {
  const want = dpi / 72
  const W = Math.max(1, ...pages.map((p) => p.w))
  const H = Math.max(1, ...pages.map((p) => p.h))
  const side = maxSide / Math.max(W, H)
  const area = Math.sqrt(maxPixels / (W * H))
  return Math.min(want, side, area)
}
