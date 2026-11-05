// Generates the Hopper icon with zero dependencies: build/icon.png (512), build/icon.ico
// (16-256, PNG entries) and site/assets/icon-*.png. Shapes are signed-distance fields, so every
// size is anti-aliased from the same geometry.
//   node tools/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

function ico(images) {
  const head = Buffer.alloc(6)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  let offset = 6 + 16 * images.length
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    return e
  })
  return Buffer.concat([head, ...entries, ...images.map((i) => i.data)])
}

// --- geometry in a 100x100 design space ------------------------------------------------------
const roundRect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r
  const qy = Math.abs(y - cy) - hh + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
// distance to a quadratic bezier, sampled (fine for an icon)
const curve = (() => {
  const pts = []
  const [ax, ay, bx, by, cx, cy] = [30, 33, 50, 6, 68, 30]
  for (let i = 0; i <= 60; i++) {
    const t = i / 60
    pts.push([(1 - t) ** 2 * ax + 2 * (1 - t) * t * bx + t * t * cx, (1 - t) ** 2 * ay + 2 * (1 - t) * t * by + t * t * cy])
  }
  return pts
})()
const segDist = (px, py, [ax, ay], [bx, by]) => {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}
const arcDist = (x, y) => {
  let d = Infinity
  for (let i = 1; i < curve.length; i++) d = Math.min(d, segDist(x, y, curve[i - 1], curve[i]))
  return d
}
// arrow head: triangle pointing down-right at the curve's end
const tri = (x, y) => {
  const P = [[61, 26], [75, 25], [69, 39]]
  let inside = true
  let d = Infinity
  for (let i = 0; i < 3; i++) {
    const a = P[i]
    const b = P[(i + 1) % 3]
    const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])
    if (cross < 0) inside = false
    d = Math.min(d, segDist(x, y, a, b))
  }
  return inside ? -d : d
}

function render(size) {
  const px = Buffer.alloc(size * size * 4)
  const s = 100 / size
  const aa = s * 0.75
  const cov = (d) => Math.max(0, Math.min(1, 0.5 - d / aa))
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) * s
      const y = (j + 0.5) * s
      // tile with a vertical gradient
      const tile = cov(roundRect(x, y, 50, 50, 46, 46, 22))
      const g = y / 100
      let r = 26 + (12 - 26) * g
      let gr = 125 + (88 - 125) * g
      let b = 241 + (208 - 241) * g
      // panes (left solid, right translucent) and the hop arc
      const left = cov(roundRect(x, y, 32, 62, 15, 22, 6))
      const right = cov(roundRect(x, y, 68, 62, 15, 22, 6))
      const arc = Math.max(cov(arcDist(x, y) - 3.6), cov(tri(x, y)))
      const white = (k) => {
        r += (255 - r) * k
        gr += (255 - gr) * k
        b += (255 - b) * k
      }
      white(right * 0.62)
      white(left)
      // list lines on the left pane
      for (const ly of [52, 61, 70]) {
        const line = cov(roundRect(x, y, 31, ly, 9, 1.6, 1.6)) * left
        r += (40 - r) * line * 0.5
        gr += (110 - gr) * line * 0.5
        b += (220 - b) * line * 0.5
      }
      white(arc)
      const o = (j * size + i) * 4
      px[o] = Math.round(r)
      px[o + 1] = Math.round(gr)
      px[o + 2] = Math.round(b)
      px[o + 3] = Math.round(255 * tile)
    }
  }
  return png(size, px)
}

mkdirSync(join(ROOT, 'build'), { recursive: true })
mkdirSync(join(ROOT, 'site', 'assets'), { recursive: true })
writeFileSync(join(ROOT, 'build', 'icon.png'), render(512))
writeFileSync(join(ROOT, 'build', 'icon.ico'), ico([16, 20, 24, 32, 40, 48, 64, 128, 256].map((size) => ({ size, data: render(size) }))))
for (const s of [32, 180, 512]) writeFileSync(join(ROOT, 'site', 'assets', `icon-${s}.png`), render(s))
console.log('icons written: build/icon.png, build/icon.ico, site/assets/icon-*.png')
