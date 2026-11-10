// MicroStation V7 design file (ISFF) reader: turns the elements Hopper can draw faithfully into a
// compact display list. Anything it cannot draw (dimensions, multi-lines, rasters, B-splines,
// reference files) is counted and reported, never approximated.
// Byte order notes: 16-bit words are little-endian; 32-bit integers are "middle-endian" (high word
// first, each word little-endian); floating point is VAX D_floating in four such words.
import { defaultColors, tableToColors } from './colortable'
import type { DgnDrawing, DgnText } from './types'

export interface DgnLimits {
  maxVertices: number
  maxArcs: number
  maxTexts: number
}

export const DGN_LIMITS: DgnLimits = { maxVertices: 3_000_000, maxArcs: 400_000, maxTexts: 60_000 }

/** True when the bytes start with a V7 design file header (type 9 element on level 8, 766 words). */
export function isDgn7(head: Uint8Array) {
  return head.length >= 4 && (head[0] & 0x3f) === 8 && head[1] === 0x09 && head[2] === 0xfe && head[3] === 0x02
}

export function vaxDouble(b: Uint8Array, o: number) {
  const w0 = b[o] | (b[o + 1] << 8)
  const e = (w0 >> 7) & 0xff
  if (!e) return 0
  const frac =
    ((w0 & 0x7f) | 0x80) * 2 ** -8 + (b[o + 2] | (b[o + 3] << 8)) * 2 ** -24 + (b[o + 4] | (b[o + 5] << 8)) * 2 ** -40 + (b[o + 6] | (b[o + 7] << 8)) * 2 ** -56
  return (w0 & 0x8000 ? -1 : 1) * frac * 2 ** (e - 128)
}

/** Signed middle-endian 32-bit integer. */
export const int32me = (b: Uint8Array, o: number) => (b[o + 1] << 24) | (b[o] << 16) | (b[o + 3] << 8) | b[o + 2]

class Grow {
  a = new Float64Array(4096)
  n = 0
  push2(x: number, y: number) {
    if (this.n + 2 > this.a.length) this.grow(this.n + 2)
    this.a[this.n++] = x
    this.a[this.n++] = y
  }
  push8(v: number[]) {
    if (this.n + 8 > this.a.length) this.grow(this.n + 8)
    for (let i = 0; i < 8; i++) this.a[this.n++] = v[i]
  }
  private grow(min: number) {
    const next = new Float64Array(Math.max(min, this.a.length * 2))
    next.set(this.a.subarray(0, this.n))
    this.a = next
  }
}

/** Geometry gathered for the drawing or for one shared cell definition. */
class Bucket {
  pv = new Grow()
  pStart: number[] = [0]
  pAttr: number[] = []
  av = new Grow()
  aAttr: number[] = []
  texts: DgnText[] = []
}

type Mat = [number, number, number, number, number, number, number, number, number]
const IDENT: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1]

/**
 * Orientation of an element in a 3D file, as its own X, Y and Z axes in world space (rows of the
 * result). The file stores a quaternion (w, x, y, z); the axes are the rows of that quaternion's
 * rotation matrix. Checked against the cones of real plant models: only this reading puts the
 * circle normal along the line joining the two end centres.
 */
function quatAxes(b: Uint8Array, o: number): Mat {
  const k = 1 / 2147483648
  const w = int32me(b, o) * k
  const x = int32me(b, o + 4) * k
  const y = int32me(b, o + 8) * k
  const z = int32me(b, o + 12) * k
  const n = w * w + x * x + y * y + z * z
  if (!(n > 1e-12)) return IDENT
  const s = 2 / n
  return [
    1 - s * (y * y + z * z), s * (x * y - w * z), s * (x * z + w * y),
    s * (x * y + w * z), 1 - s * (x * x + z * z), s * (y * z - w * x),
    s * (x * z - w * y), s * (y * z + w * x), 1 - s * (x * x + y * y)
  ]
}

const TYPE_NAMES: Record<number, string> = {
  11: 'curve',
  21: 'B-spline pole set',
  22: 'point string',
  24: 'B-spline surface',
  27: 'B-spline curve',
  33: 'dimension',
  37: 'multi-line',
  87: 'raster image',
  90: 'raster image'
}
// 87 here means a raster in a storage format that is not read (see case 87).

interface CellDef {
  bucket: Bucket
  skipped: Map<number, number>
}

interface Raster {
  x: number
  y: number
  pixel: number
  w: number
  h: number
  level: number
  index: Uint8Array
}

const MAX_RASTER_PIXELS = 16_000_000

export function parseDgn7(buf: Uint8Array, limits: DgnLimits = DGN_LIMITS): DgnDrawing {
  if (!isDgn7(buf)) throw new Error('Not a MicroStation V7 design file')
  const is3d = (buf[0] & 0x40) !== 0
  const u16 = (o: number) => buf[o] | (buf[o + 1] << 8)
  const main = new Bucket()
  let out = main
  const defs = new Map<string, CellDef>()
  const instances: { name: string; m: Mat; ox: number; oy: number; level: number }[] = []
  let colors: Uint8Array | null = null
  const references: string[] = []
  const skipped = new Map<number, number>()
  const levelCount = new Uint32Array(64)
  let elements = 0
  let drawn = 0
  let deleted = 0
  let truncated = false
  let brokenAt = -1
  let units = { master: '', sub: '', subPerMaster: 1, uorPerSub: 1 }
  let inDef = false
  let defSkipped = skipped
  let curves = 0
  const rasters: Raster[] = []
  let raster: Raster | null = null
  let rasterPixels = 0

  const full = () => main.pv.n / 2 >= limits.maxVertices || main.av.n / 8 >= limits.maxArcs

  // attrs: level, colour, weight, style | flags (0x10 closed, 0x20 filled), fill colour
  const poly = (pts: number[], level: number, color: number, weight: number, style: number, flags = 0, fill = 0) => {
    if (pts.length < 4) return
    for (let i = 0; i < pts.length; i += 2) out.pv.push2(pts[i], pts[i + 1])
    out.pStart.push(out.pv.n / 2)
    out.pAttr.push(level, color, weight, style | flags, fill)
  }
  const arc = (cx: number, cy: number, ux: number, uy: number, vx: number, vy: number, start: number, sweep: number, level: number, color: number, weight: number, style: number, flags = 0, fill = 0) => {
    if (![cx, cy, ux, uy, vx, vy, start, sweep].every(Number.isFinite)) return
    out.av.push8([cx, cy, ux, uy, vx, vy, start, sweep])
    out.aAttr.push(level, color, weight, style | flags, fill)
  }

  /** Colour of a solid fill stored in the element's attribute linkages, or -1. */
  const fillOf = (p: number, size: number) => {
    if (!(u16(p + 32) & 0x0800)) return -1
    let o = p + 32 + u16(p + 30) * 2
    const end = p + size
    for (let guard = 0; o + 4 <= end && guard < 64; guard++) {
      let len: number
      if (buf[o] === 0 && (buf[o + 1] === 0 || buf[o + 1] === 0x80)) len = 8
      else if (buf[o + 1] & 0x10) {
        len = buf[o] * 2 + 2
        if (u16(o + 2) === 0x0041 && len >= 9 && o + 9 <= end) return buf[o + 8]
      } else break
      if (len < 4) break
      o += len
    }
    return -1
  }

  let p = 0
  const len = buf.length
  while (p + 4 <= len) {
    if (buf[p] === 0xff && buf[p + 1] === 0xff) break
    const size = (u16(p + 2) + 2) * 2
    if (p + size > len) {
      brokenAt = p
      break
    }
    const type = buf[p + 1] & 0x7f
    const level = buf[p] & 0x3f
    const complex = (buf[p] & 0x80) !== 0
    const start = p
    p += size
    if (buf[start + 1] & 0x80) {
      deleted++
      continue
    }
    elements++

    if (type === 9 && start === 0 && size >= 1264) {
      units = {
        subPerMaster: int32me(buf, 1112),
        uorPerSub: int32me(buf, 1116),
        master: String.fromCharCode(buf[1120], buf[1121]).replace(/[^\x20-\x7e]/g, '').trim(),
        sub: String.fromCharCode(buf[1122], buf[1123]).replace(/[^\x20-\x7e]/g, '').trim()
      }
      continue
    }
    if (type === 5) {
      if (level === 1 && size >= 38 + 768 && !colors) colors = tableToColors(buf, start + 38)
      else if (level === 9 && size >= 40) {
        const n = Math.min(u16(start + 36), 64, size - 38)
        const name = Buffer.from(buf.buffer, buf.byteOffset + start + 38, n).toString('latin1').replace(/\0.*$/, '').trim()
        if (name) references.push(name)
      }
      continue
    }
    // Everything below is a displayable element with the 36-byte display header.
    if (type < 2 || type === 8 || type === 9 || type === 10 || size < 36) continue
    if (!complex) {
      inDef = false
      out = main
      defSkipped = skipped
      raster = null
    }
    if (type === 34) {
      // Shared cell definition: its components are a template, drawn only through instances.
      if (!complex && size >= 180) {
        const name = cString(buf, start + 164, Math.min(16, size - 164))
        const def: CellDef = { bucket: new Bucket(), skipped: new Map() }
        defs.set(name, def)
        out = def.bucket
        defSkipped = def.skipped
        inDef = true
      }
      continue
    }
    if (full() && !inDef) {
      truncated = true
      continue
    }
    const style = buf[start + 34] & 7
    const weight = (buf[start + 34] >> 3) & 31
    const color = buf[start + 35]
    const before = out.pAttr.length + out.aAttr.length + out.texts.length

    switch (type) {
      case 3: {
        if (is3d ? size >= 60 : size >= 52) {
          const o = start + 36
          poly(is3d ? [int32me(buf, o), int32me(buf, o + 4), int32me(buf, o + 12), int32me(buf, o + 16)] : [int32me(buf, o), int32me(buf, o + 4), int32me(buf, o + 8), int32me(buf, o + 12)], level, color, weight, style)
        }
        break
      }
      case 4:
      case 6:
      case 11: {
        const stride = is3d ? 12 : 8
        let n = u16(start + 36)
        if (n < 1 || 38 + n * stride > size) break
        let first = 0
        if (type === 11) {
          // The first and last two points of a curve only set its end tangents.
          if (n < 6) break
          first = 2
          n -= 2
          curves++
        }
        const pts: number[] = []
        for (let i = first; i < n; i++) pts.push(int32me(buf, start + 38 + i * stride), int32me(buf, start + 42 + i * stride))
        if (pts.length === 2) pts.push(pts[0], pts[1])
        const fill = type === 6 ? fillOf(start, size) : -1
        poly(pts, level, color, weight, style, (type === 6 ? 0x10 : 0) | (fill >= 0 ? 0x20 : 0), Math.max(0, fill))
        break
      }
      case 15:
      case 16: {
        let o = start + 36
        let a0 = 0
        let sweep = 360
        if (type === 16) {
          if (size < (is3d ? 100 : 80)) break
          a0 = int32me(buf, o) / 360000
          const raw = int32me(buf, o + 4)
          const mag = (raw & 0x7fffffff) / 360000
          sweep = mag === 0 ? 360 : raw < 0 ? -mag : mag
          o += 8
        } else if (size < (is3d ? 92 : 72)) break
        const prim = vaxDouble(buf, o)
        const sec = vaxDouble(buf, o + 8)
        let ux: number, uy: number, vx: number, vy: number, cx: number, cy: number
        if (is3d) {
          const m = quatAxes(buf, o + 16)
          ux = m[0] * prim
          uy = m[1] * prim
          vx = m[3] * sec
          vy = m[4] * sec
          cx = vaxDouble(buf, o + 32)
          cy = vaxDouble(buf, o + 40)
        } else {
          const r = (int32me(buf, o + 16) / 360000) * (Math.PI / 180)
          ux = Math.cos(r) * prim
          uy = Math.sin(r) * prim
          vx = -Math.sin(r) * sec
          vy = Math.cos(r) * sec
          cx = vaxDouble(buf, o + 20)
          cy = vaxDouble(buf, o + 28)
        }
        const fill = type === 15 ? fillOf(start, size) : -1
        arc(cx, cy, ux, uy, vx, vy, (a0 * Math.PI) / 180, (sweep * Math.PI) / 180, level, color, weight, style, fill >= 0 ? 0x20 : 0, Math.max(0, fill))
        break
      }
      case 17: {
        const o = start + 36
        const head = is3d ? 40 : 24
        if (size < 36 + head) break
        const w = (int32me(buf, o + 2) * 6) / 1000
        const h = (int32me(buf, o + 6) * 6) / 1000
        let ax = 1, ay = 0, bx = 0, by = 1, x: number, y: number
        if (is3d) {
          const m = quatAxes(buf, o + 10)
          ax = m[0]
          ay = m[1]
          bx = m[3]
          by = m[4]
          x = int32me(buf, o + 26)
          y = int32me(buf, o + 30)
        } else {
          const r = (int32me(buf, o + 10) / 360000) * (Math.PI / 180)
          ax = Math.cos(r)
          ay = Math.sin(r)
          bx = -ay
          by = ax
          x = int32me(buf, o + 14)
          y = int32me(buf, o + 18)
        }
        const count = Math.min(buf[o + head - 2], size - 36 - head)
        const s = textOf(buf, o + head, count)
        const len = textLength(int32me(buf, start + 16) - int32me(buf, start + 4), int32me(buf, start + 20) - int32me(buf, start + 8), Math.abs(ax), Math.abs(ay), s.length * Math.abs(w))
        if (s.trim() && h !== 0 && out.texts.length < limits.maxTexts) out.texts.push({ x, y, h: Math.abs(h), w: Math.abs(w), len, ax, ay, bx, by, s, level, color, font: buf[o], mirror: (w < 0 ? 1 : 0) | (h < 0 ? 2 : 0) })
        else if (out.texts.length >= limits.maxTexts) truncated = true
        break
      }
      case 23: {
        // Cone / cylinder: both end circles and four rule lines, as MicroStation's wireframe.
        if (!is3d || size < 118) break
        const o = start + 36
        const m = quatAxes(buf, o + 2)
        const c1 = [vaxDouble(buf, o + 18), vaxDouble(buf, o + 26)]
        const r1 = vaxDouble(buf, o + 42)
        const c2 = [vaxDouble(buf, o + 50), vaxDouble(buf, o + 58)]
        const r2 = vaxDouble(buf, o + 74)
        const tau = Math.PI * 2
        if (r1 > 0) arc(c1[0], c1[1], m[0] * r1, m[1] * r1, m[3] * r1, m[4] * r1, 0, tau, level, color, weight, style)
        if (r2 > 0) arc(c2[0], c2[1], m[0] * r2, m[1] * r2, m[3] * r2, m[4] * r2, 0, tau, level, color, weight, style)
        for (const [i, sg] of [[0, 1], [0, -1], [3, 1], [3, -1]] as const) {
          poly([c1[0] + m[i] * r1 * sg, c1[1] + m[i + 1] * r1 * sg, c2[0] + m[i] * r2 * sg, c2[1] + m[i + 1] * r2 * sg], level, color, weight, style)
        }
        break
      }
      case 35: {
        if (size < 180) break
        const o = start + 76
        const m: Mat = is3d
          ? [vaxDouble(buf, o), vaxDouble(buf, o + 8), vaxDouble(buf, o + 16), vaxDouble(buf, o + 24), vaxDouble(buf, o + 32), vaxDouble(buf, o + 40), 0, 0, 1]
          : [vaxDouble(buf, o), vaxDouble(buf, o + 8), 0, vaxDouble(buf, o + 16), vaxDouble(buf, o + 24), 0, 0, 0, 1]
        const dv = new DataView(buf.buffer, buf.byteOffset + start + 148, 8)
        if (!inDef) instances.push({ name: cString(buf, start + 164, Math.min(16, size - 164)), m, ox: dv.getInt32(0, true), oy: dv.getInt32(4, true), level })
        break
      }
      case 87: {
        // Raster header; its scan lines follow as type 88 components. Only the byte-per-pixel
        // format with horizontal scan lines is read (colour index per pixel, 255 = background).
        const flags = u16(start + 40)
        const w = u16(start + 44)
        const h = u16(start + 46)
        const pixel = size >= 80 ? vaxDouble(buf, start + 60) : 0
        if (inDef || size < 80 || ((flags >> 3) & 31) !== 2 || !(flags & 4) || !w || !h || !(pixel > 0) || rasterPixels + w * h > MAX_RASTER_PIXELS) {
          defSkipped.set(87, (defSkipped.get(87) ?? 0) + 1)
          continue
        }
        rasterPixels += w * h
        raster = { x: int32me(buf, start + 68), y: int32me(buf, start + 72), pixel, w, h, level, index: new Uint8Array(w * h).fill(255) }
        rasters.push(raster)
        drawn++
        levelCount[level]++
        continue
      }
      case 88: {
        if (!raster || size < 46) continue
        const x = u16(start + 40)
        const y = u16(start + 42)
        const n = Math.min(u16(start + 44), size - 46, raster.w - x)
        if (y < raster.h && n > 0) raster.index.set(buf.subarray(start + 46, start + 46 + n), y * raster.w + x)
        continue
      }
      case 2: case 7: case 12: case 14: case 18: case 19:
        // Headers of cells, text nodes, chains and solids: their component elements follow.
        continue
      default:
        if (TYPE_NAMES[type]) defSkipped.set(type, (defSkipped.get(type) ?? 0) + 1)
        continue
    }
    const added = out.pAttr.length + out.aAttr.length + out.texts.length - before
    if (added && !inDef) {
      drawn++
      levelCount[level]++
    }
  }
  if (brokenAt < 0 && p + 4 > len && !(buf[p] === 0xff && buf[p + 1] === 0xff)) brokenAt = -2

  // Place shared cell instances: point' = M * point + origin.
  let missingDefs = 0
  for (const inst of instances) {
    const def = defs.get(inst.name)
    if (!def) {
      missingDefs++
      continue
    }
    if (full()) {
      truncated = true
      break
    }
    const { m, ox, oy } = inst
    const b = def.bucket
    for (const [t, n] of def.skipped) skipped.set(t, (skipped.get(t) ?? 0) + n)
    const tx = (x: number, y: number) => m[0] * x + m[1] * y + ox
    const ty = (x: number, y: number) => m[3] * x + m[4] * y + oy
    for (let i = 0; i < b.pAttr.length / 5; i++) {
      for (let v = b.pStart[i]; v < b.pStart[i + 1]; v++) main.pv.push2(tx(b.pv.a[v * 2], b.pv.a[v * 2 + 1]), ty(b.pv.a[v * 2], b.pv.a[v * 2 + 1]))
      main.pStart.push(main.pv.n / 2)
      main.pAttr.push(b.pAttr[i * 5], b.pAttr[i * 5 + 1], b.pAttr[i * 5 + 2], b.pAttr[i * 5 + 3], b.pAttr[i * 5 + 4])
      levelCount[b.pAttr[i * 5]]++
    }
    for (let i = 0; i < b.aAttr.length / 5; i++) {
      const a = b.av.a.subarray(i * 8, i * 8 + 8)
      main.av.push8([tx(a[0], a[1]), ty(a[0], a[1]), m[0] * a[2] + m[1] * a[3], m[3] * a[2] + m[4] * a[3], m[0] * a[4] + m[1] * a[5], m[3] * a[4] + m[4] * a[5], a[6], a[7]])
      main.aAttr.push(b.aAttr[i * 5], b.aAttr[i * 5 + 1], b.aAttr[i * 5 + 2], b.aAttr[i * 5 + 3], b.aAttr[i * 5 + 4])
      levelCount[b.aAttr[i * 5]]++
    }
    for (const t of b.texts) {
      if (main.texts.length >= limits.maxTexts) break
      const sx = Math.hypot(m[0], m[3])
      const sy = Math.hypot(m[1], m[4])
      const ax = (m[0] * t.ax + m[1] * t.ay) / (sx || 1)
      const ay = (m[3] * t.ax + m[4] * t.ay) / (sx || 1)
      const bx = (m[0] * t.bx + m[1] * t.by) / (sy || 1)
      const by = (m[3] * t.bx + m[4] * t.by) / (sy || 1)
      main.texts.push({ ...t, x: tx(t.x, t.y), y: ty(t.x, t.y), w: t.w * sx, h: t.h * sy, len: t.len * sx, ax, ay, bx, by })
      levelCount[t.level]++
    }
    drawn++
  }

  // Extents of what was drawn. A stray element far from the sheet would make "fit" useless, so
  // the fit box keeps only geometry near the bulk of the drawing; the full box is reported too.
  const nPoly = main.pAttr.length / 5
  const nArc = main.aAttr.length / 5
  const boxes = new Float64Array((nPoly + nArc + main.texts.length + rasters.length) * 4)
  let nb = 0
  const pv = main.pv.a
  for (let i = 0; i < nPoly; i++) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let v = main.pStart[i]; v < main.pStart[i + 1]; v++) {
      const x = pv[v * 2], y = pv[v * 2 + 1]
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    boxes.set([x0, y0, x1, y1], nb++ * 4)
  }
  for (let i = 0; i < nArc; i++) {
    const a = main.av.a.subarray(i * 8, i * 8 + 8)
    // Sampled along the sweep: a shallow arc of a large radius covers far less than its circle.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let k = 0; k <= 24; k++) {
      const t = a[6] + (a[7] * k) / 24
      const x = a[0] + a[2] * Math.cos(t) + a[4] * Math.sin(t), y = a[1] + a[3] * Math.cos(t) + a[5] * Math.sin(t)
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    boxes.set([x0, y0, x1, y1], nb++ * 4)
  }
  for (const t of main.texts) {
    // Trailing blanks take no room on the sheet.
    const run = ((t.len || t.w * t.s.length) * t.s.trimEnd().length) / t.s.length
    const dir = t.mirror & 1 ? -run : run
    const lx = t.ax * dir, ly = t.ay * dir
    boxes.set([Math.min(t.x, t.x + lx), Math.min(t.y, t.y + ly), Math.max(t.x, t.x + lx) + t.h, Math.max(t.y, t.y + ly) + t.h], nb++ * 4)
  }
  for (const r of rasters) boxes.set([r.x, r.y - r.h * r.pixel, r.x + r.w * r.pixel, r.y], nb++ * 4)
  const all = [Infinity, Infinity, -Infinity, -Infinity]
  for (let i = 0; i < nb; i++) grow(all, boxes, i)
  let fit = all.slice()
  let strays = 0
  if (nb > 20) {
    const cxs = new Float64Array(nb), cys = new Float64Array(nb)
    for (let i = 0; i < nb; i++) {
      cxs[i] = (boxes[i * 4] + boxes[i * 4 + 2]) / 2
      cys[i] = (boxes[i * 4 + 1] + boxes[i * 4 + 3]) / 2
    }
    cxs.sort()
    cys.sort()
    const lo = Math.ceil((nb - 1) * 0.02), hi = Math.floor((nb - 1) * 0.98)
    const mx = Math.max(cxs[hi] - cxs[lo], 1), my = Math.max(cys[hi] - cys[lo], 1)
    const m = Math.max(mx, my) * 1.5
    const near = [cxs[lo] - m, cys[lo] - m, cxs[hi] + m, cys[hi] + m]
    fit = [Infinity, Infinity, -Infinity, -Infinity]
    for (let i = 0; i < nb; i++) {
      if (boxes[i * 4] >= near[0] && boxes[i * 4 + 1] >= near[1] && boxes[i * 4 + 2] <= near[2] && boxes[i * 4 + 3] <= near[3]) grow(fit, boxes, i)
      else strays++
    }
    if (!Number.isFinite(fit[0])) fit = all.slice()
  }
  if (!nb) fit = [0, 0, 1, 1]
  const ox = (fit[0] + fit[2]) / 2
  const oy = (fit[1] + fit[3]) / 2

  const lines = new Float32Array(main.pv.n)
  for (let i = 0; i < main.pv.n; i += 2) {
    lines[i] = pv[i] - ox
    lines[i + 1] = pv[i + 1] - oy
  }
  const arcs = new Float32Array(main.av.n)
  for (let i = 0; i < main.av.n; i += 8) {
    const a = main.av.a
    arcs[i] = a[i] - ox
    arcs[i + 1] = a[i + 1] - oy
    for (let k = 2; k < 8; k++) arcs[i + k] = a[i + k]
  }
  for (const t of main.texts) {
    t.x -= ox
    t.y -= oy
  }

  const table = colors ?? defaultColors()
  const images = rasters.map((r) => {
    const rgba = new Uint8Array(r.w * r.h * 4)
    for (let i = 0; i < r.index.length; i++) {
      const c = r.index[i]
      if (c === 255) continue
      rgba[i * 4] = table[c * 3]
      rgba[i * 4 + 1] = table[c * 3 + 1]
      rgba[i * 4 + 2] = table[c * 3 + 2]
      rgba[i * 4 + 3] = 255
    }
    return { x: r.x - ox, y: r.y - oy, w: r.w, h: r.h, pixel: r.pixel, level: r.level, rgba }
  })

  const notices: string[] = []
  if (is3d) notices.push('3D file, shown in Top view (looking down the Z axis).')
  if (references.length) notices.push(`${references.length} reference file${references.length === 1 ? ' is' : 's are'} attached and not shown: ${[...new Set(references.map(baseName))].slice(0, 8).join(', ')}${references.length > 8 ? ', …' : ''}.`)
  const notDrawn = [...skipped].filter(([t]) => TYPE_NAMES[t]).map(([t, n]) => `${n} ${TYPE_NAMES[t]}${n === 1 ? '' : 's'}`)
  if (notDrawn.length) notices.push(`Not drawn: ${notDrawn.join(', ')}.`)
  if (curves) notices.push(`${curves} curve element${curves === 1 ? ' is' : 's are'} drawn as straight segments through ${curves === 1 ? 'its' : 'their'} points.`)
  if (missingDefs) notices.push(`${missingDefs} shared cell${missingDefs === 1 ? '' : 's'} could not be placed (definition not in this file).`)
  if (strays) notices.push(`${strays} element${strays === 1 ? ' lies' : 's lie'} far from the rest of the drawing; Fit ignores ${strays === 1 ? 'it' : 'them'}.`)
  if (truncated) notices.push(`Large file: only the first ${(main.pv.n / 2).toLocaleString('en-GB')} points are shown.`)
  if (brokenAt !== -1) notices.push('The file ends in the middle of an element; everything before that point is shown.')
  if (main.texts.length) notices.push('Text is drawn in a system font, not the MicroStation font, so letter shapes and exact widths differ.')

  const levels: { level: number; count: number }[] = []
  for (let i = 0; i < 64; i++) if (levelCount[i]) levels.push({ level: i, count: levelCount[i] })
  return {
    format: 'V7',
    is3d,
    units,
    origin: [ox, oy],
    fit: [fit[0] - ox, fit[1] - oy, fit[2] - ox, fit[3] - oy],
    extents: [all[0] - ox, all[1] - oy, all[2] - ox, all[3] - oy],
    lines,
    lineStart: Uint32Array.from(main.pStart),
    lineAttr: Uint8Array.from(main.pAttr),
    arcs,
    arcAttr: Uint8Array.from(main.aAttr),
    texts: main.texts,
    images,
    colors: table,
    hasColorTable: !!colors,
    levels,
    elements,
    drawn,
    deleted,
    truncated,
    notices
  }
}

function grow(box: number[], boxes: Float64Array, i: number) {
  if (boxes[i * 4] < box[0]) box[0] = boxes[i * 4]
  if (boxes[i * 4 + 1] < box[1]) box[1] = boxes[i * 4 + 1]
  if (boxes[i * 4 + 2] > box[2]) box[2] = boxes[i * 4 + 2]
  if (boxes[i * 4 + 3] > box[3]) box[3] = boxes[i * 4 + 3]
}

/**
 * Length of a text string along its baseline, worked out from the element's own range box
 * (which MicroStation computed with the real font). `c` and `s` are |cos| and |sin| of the
 * text angle, `nominal` is characters x character width. Returns 0 when the box cannot tell.
 */
function textLength(boxW: number, boxH: number, c: number, s: number, nominal: number) {
  if (Math.abs(c * c + s * s - 1) > 0.01 || !(nominal > 0)) return 0
  let len = 0
  if (s < 0.02) len = boxW
  else if (c < 0.02) len = boxH
  else if (Math.abs(c * c - s * s) > 0.2) len = (boxW * c - boxH * s) / (c * c - s * s)
  return len >= nominal * 0.35 && len <= nominal * 1.15 ? len : 0
}

const baseName = (p: string) => p.split(/[\\/:]/).pop() || p

function cString(b: Uint8Array, o: number, max: number) {
  let s = ''
  for (let i = 0; i < max && b[o + i]; i++) s += String.fromCharCode(b[o + i])
  return s.trim()
}

/** Text element string: single-byte, or 16-bit characters after an FF FD marker. */
function textOf(b: Uint8Array, o: number, n: number) {
  let s = ''
  if (n >= 2 && b[o] === 0xff && b[o + 1] === 0xfd) {
    for (let i = 2; i + 1 < n; i += 2) {
      const c = b[o + i] | (b[o + i + 1] << 8)
      if (c) s += String.fromCharCode(c)
    }
    return s
  }
  for (let i = 0; i < n; i++) {
    const c = b[o + i]
    s += c === 0 ? '' : c < 0x20 ? ' ' : String.fromCharCode(c)
  }
  return s
}
