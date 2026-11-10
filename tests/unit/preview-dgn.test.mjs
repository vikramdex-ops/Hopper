// MicroStation V7 reader (src/engine/preview/dgn7.ts) against design files built in code:
// byte orders, element geometry, colour table, shared cells, rasters, and damaged input.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from './preview-hooks.mjs'

const { parseDgn7, isDgn7, vaxDouble, int32me } = await load('engine/preview/dgn7.ts')

// ---- writers for the on-disk encodings ----
const me32 = (v) => {
  const u = v >>> 0
  return [(u >>> 16) & 255, (u >>> 24) & 255, u & 255, (u >>> 8) & 255]
}
function vax(v) {
  if (v === 0) return [0, 0, 0, 0, 0, 0, 0, 0]
  const sign = v < 0 ? 0x8000 : 0
  let m = Math.abs(v)
  let e = 0
  while (m >= 1) (m /= 2), e++
  while (m < 0.5) (m *= 2), e--
  // m in [0.5, 1): 56-bit fraction with the leading bit hidden
  let f = BigInt(Math.round(m * 2 ** 53)) << 3n
  const w0 = sign | ((e + 128) << 7) | Number((f >> 48n) & 0x7fn)
  const w = [w0, Number((f >> 32n) & 0xffffn), Number((f >> 16n) & 0xffffn), Number(f & 0xffffn)]
  return w.flatMap((x) => [x & 255, x >> 8])
}
const u16 = (v) => [v & 255, (v >> 8) & 255]

/** One element: 36-byte header (range left zero) plus body, padded to whole words. */
function elem(type, level, body, { complex = false, deleted = false, color = 0, weight = 0, style = 0, is3d = false, attr = [], range = null } = {}) {
  let bytes = [...body, ...attr]
  if (bytes.length % 2) bytes.push(0)
  const size = 36 + bytes.length
  const head = new Array(36).fill(0)
  head[0] = (level & 63) | (complex ? 0x80 : 0) | (is3d ? 0x40 : 0)
  head[1] = type | (deleted ? 0x80 : 0)
  head.splice(2, 2, ...u16(size / 2 - 2))
  // range block: low x, y, z then high x, y, z, stored with the sign bit flipped
  if (range) [4, 8, 16, 20].forEach((o, i) => head.splice(o, 4, ...me32(range[i] ^ 0x80000000)))
  head.splice(30, 2, ...u16((36 + body.length + (body.length % 2) - 32) / 2))
  head.splice(32, 2, ...u16(attr.length ? 0x0800 : 0))
  head[34] = (style & 7) | (weight << 3)
  head[35] = color
  return [...head, ...bytes]
}
function tcb(is3d = false) {
  const b = new Array(1536).fill(0)
  b[0] = 8 | (is3d ? 0x40 : 0)
  b[1] = 9
  b[2] = 0xfe
  b[3] = 0x02
  b.splice(1112, 4, ...me32(1000))
  b.splice(1116, 4, ...me32(80))
  b[1120] = 0x6d // "m "
  b[1121] = 0x20
  b[1122] = 0x6d // "mm"
  b[1123] = 0x6d
  return b
}
const file = (...els) => Buffer.from([...els.flat(), 0xff, 0xff])
const line2d = (x0, y0, x1, y1) => [...me32(x0), ...me32(y0), ...me32(x1), ...me32(y1)]
const text2d = (s, x, y, { h = 1000, w = 800, rot = 0 } = {}) => [3, 0, ...me32(w), ...me32(h), ...me32(rot * 360000), ...me32(x), ...me32(y), s.length, 0, ...Buffer.from(s, 'latin1')]

test('VAX doubles and middle-endian integers decode exactly', () => {
  for (const v of [1, -1, 0.5, 1.4225, 12953, -1755864.1536273076, 1e-9, 3.141592653589793e12]) {
    const got = vaxDouble(Uint8Array.from(vax(v)), 0)
    assert.ok(Math.abs(got - v) <= Math.abs(v) * 1e-15, `${v} -> ${got}`)
  }
  // 1.0 in D_floating is 0x4080 followed by zeros (little-endian words)
  assert.equal(vaxDouble(Uint8Array.from([0x80, 0x40, 0, 0, 0, 0, 0, 0]), 0), 1)
  assert.equal(vaxDouble(new Uint8Array(8), 0), 0)
  for (const v of [0, 1, -1, 340, 0x12345678, -2147483648, 2147483647]) assert.equal(int32me(Uint8Array.from(me32(v)), 0), v)
  // high word first, each word little-endian
  assert.equal(int32me(Uint8Array.from([0x34, 0x12, 0x78, 0x56]), 0), 0x12345678)
})

test('recognises a V7 header and rejects other content', () => {
  assert.equal(isDgn7(Uint8Array.from([0x08, 0x09, 0xfe, 0x02])), true)
  assert.equal(isDgn7(Uint8Array.from([0xc8, 0x09, 0xfe, 0x02])), true)
  assert.equal(isDgn7(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0])), false)
  assert.equal(isDgn7(Uint8Array.from([0x08, 0x09])), false)
  assert.throws(() => parseDgn7(Buffer.from('AC1032 not a design file')), /V7/)
})

test('lines, line strings, shapes, arcs, ellipses and text become a display list', () => {
  const d = parseDgn7(
    file(
      tcb(),
      elem(3, 1, line2d(0, 0, 1000, 0), { color: 3, weight: 2, style: 1 }),
      elem(4, 2, [...u16(3), ...me32(0), ...me32(0), ...me32(500), ...me32(500), ...me32(1000), ...me32(0)]),
      elem(6, 2, [...u16(4), ...me32(0), ...me32(0), ...me32(100), ...me32(0), ...me32(100), ...me32(100), ...me32(0), ...me32(0)], { attr: [0x07, 0x10, 0x41, 0x00, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0] }),
      // arc: start 30 deg, sweep -90 deg (sign bit of the high word), radii 200 / 100, rotated 45 deg, centre (500, 500)
      elem(16, 3, [...me32(30 * 360000), ...me32((90 * 360000) | 0x80000000), ...vax(200), ...vax(100), ...me32(45 * 360000), ...vax(500), ...vax(500)]),
      elem(15, 3, [...vax(300), ...vax(300), ...me32(0), ...vax(-200), ...vax(700)]),
      elem(17, 4, text2d('PIPE 6"', 100, 200, { rot: 90 }), { color: 2 }),
      elem(3, 1, line2d(9, 9, 9, 9), { deleted: true })
    )
  )
  assert.equal(d.format, 'V7')
  assert.equal(d.is3d, false)
  assert.deepEqual(d.units, { master: 'm', sub: 'mm', subPerMaster: 1000, uorPerSub: 80 })
  assert.equal(d.deleted, 1)
  assert.equal(d.lineAttr.length / 5, 3)
  assert.deepEqual([...d.lineStart], [0, 2, 5, 9])
  const [ox, oy] = d.origin
  const pt = (i) => [d.lines[i * 2] + ox, d.lines[i * 2 + 1] + oy]
  assert.deepEqual(pt(0), [0, 0])
  assert.deepEqual(pt(1), [1000, 0])
  assert.deepEqual(pt(3), [500, 500])
  // attrs: level, colour, weight, style | flags, fill colour
  assert.deepEqual([...d.lineAttr.subarray(0, 5)], [1, 3, 2, 1, 0])
  assert.deepEqual([...d.lineAttr.subarray(10, 15)], [2, 0, 0, 0x30, 5], 'shape is closed and filled with colour 5')

  assert.equal(d.arcAttr.length / 5, 2)
  const a = d.arcs
  const close = (x, y, m) => assert.ok(Math.abs(x - y) < 1e-3, `${m}: ${x} vs ${y}`)
  close(a[0] + ox, 500, 'arc centre x')
  close(a[1] + oy, 500, 'arc centre y')
  close(Math.hypot(a[2], a[3]), 200, 'primary radius')
  close(Math.hypot(a[4], a[5]), 100, 'secondary radius')
  close(Math.atan2(a[3], a[2]), Math.PI / 4, 'rotation')
  close(a[6], Math.PI / 6, 'start angle')
  close(a[7], -Math.PI / 2, 'sweep keeps its sign')
  close(a[15], Math.PI * 2, 'ellipse is a full turn')
  close(a[8] + ox, -200, 'ellipse centre x')

  assert.equal(d.texts.length, 1)
  const t = d.texts[0]
  assert.equal(t.s, 'PIPE 6"')
  assert.deepEqual([t.x + ox, t.y + oy, t.level, t.color, t.font], [100, 200, 4, 2, 3])
  close(t.h, 6, 'height = multiplier * 6 / 1000')
  close(t.w, 4.8, 'width')
  close(t.ax, 0, 'baseline turned 90 degrees')
  close(t.ay, 1, 'baseline turned 90 degrees')
  assert.deepEqual(d.levels.map((l) => l.level), [1, 2, 3, 4])
  assert.equal(d.hasColorTable, false)
  assert.deepEqual([...d.colors.subarray(0, 12)], [255, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0], 'default table: white, blue, green, red')
})

test('text length comes from the element range box when it is believable', () => {
  const t = (rot, range) => parseDgn7(file(tcb(), elem(17, 1, text2d('ABCDEFGHIJ', 0, 0, { rot }), { range }))).texts[0]
  // 10 characters x 4.8 = 48 nominal
  assert.equal(t(0, [0, -3, 36, 9]).len, 36, 'proportional font: shorter than nominal')
  assert.equal(t(90, [-9, 0, 3, 40]).len, 40, 'vertical text: length is the box height')
  const a = (30 * Math.PI) / 180
  const box = [0, 0, Math.round(40 * Math.cos(a) + 12 * Math.sin(a)), Math.round(40 * Math.sin(a) + 12 * Math.cos(a))]
  assert.ok(Math.abs(t(30, box).len - 40) < 1.5, 'rotated text: solved from both box sides')
  assert.equal(t(0, [0, 0, 0, 0]).len, 0, 'empty box: unknown')
  assert.equal(t(0, [0, 0, 900, 12]).len, 0, 'box far wider than the string could be: ignored')
  assert.equal(t(45, [0, 0, 37, 37]).len, 0, '45 degrees cannot be solved')
})

test('colour table element replaces the default table', () => {
  const table = new Array(768).fill(0)
  table.splice(0, 3, 10, 20, 30) // entry 255 (background) is stored first
  table.splice(3, 3, 1, 2, 3) // entry 0
  table.splice(6, 3, 4, 5, 6) // entry 1
  const d = parseDgn7(file(tcb(), elem(5, 1, [0, 0, ...table]), elem(3, 1, line2d(0, 0, 1, 1))))
  assert.equal(d.hasColorTable, true)
  assert.deepEqual([...d.colors.subarray(0, 6)], [1, 2, 3, 4, 5, 6])
  assert.deepEqual([...d.colors.subarray(765, 768)], [10, 20, 30])
})

test('3D files: Top view, quaternion axes, cones', () => {
  const k = 2147483648
  // 90 degrees about X: w = x = sqrt(1/2). The element's Y axis then points along world Z,
  // so a circle in that plane is seen edge-on from the top.
  const q = [Math.SQRT1_2, Math.SQRT1_2, 0, 0].map((v) => me32(Math.round(v * (k - 1)))).flat()
  const ident = [...me32(k - 1), ...me32(0), ...me32(0), ...me32(0)]
  const d = parseDgn7(
    file(
      tcb(true),
      elem(3, 5, [...me32(0), ...me32(0), ...me32(77), ...me32(100), ...me32(50), ...me32(88)], { is3d: true }),
      elem(15, 5, [...vax(10), ...vax(10), ...q, ...vax(0), ...vax(0), ...vax(0)], { is3d: true }),
      elem(23, 6, [0, 0, ...ident, ...vax(0), ...vax(0), ...vax(0), ...vax(5), ...vax(0), ...vax(0), ...vax(100), ...vax(5)], { is3d: true })
    )
  )
  assert.equal(d.is3d, true)
  assert.ok(d.notices.some((n) => /Top view/.test(n)))
  const [ox, oy] = d.origin
  assert.deepEqual([d.lines[0] + ox, d.lines[1] + oy, d.lines[2] + ox, d.lines[3] + oy], [0, 0, 100, 50], 'Z is dropped')
  // edge-on circle: primary axis stays in X, secondary axis has no extent in the view
  assert.ok(Math.abs(d.arcs[2] - 10) < 1e-3 && Math.abs(d.arcs[3]) < 1e-3)
  assert.ok(Math.hypot(d.arcs[4], d.arcs[5]) < 1e-3)
  // cylinder along Z: two circles and four rule lines (which are points in Top view)
  assert.equal(d.arcAttr.length / 5, 3)
  assert.equal(d.lineAttr.length / 5, 5)
})

test('shared cell definitions are drawn only where they are placed', () => {
  const name = (s) => [...Buffer.from(s.padEnd(16, '\0'), 'latin1')]
  const pad = (n) => new Array(n).fill(0)
  const def = elem(34, 0, [...pad(128), ...name('DOT')])
  const comp = elem(3, 7, line2d(0, 0, 10, 0), { complex: true })
  // instance: matrix [[0,-2],[2,0]] (turn 90 degrees, scale 2), origin (1000, 2000) as plain little-endian ints
  const le = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255]
  const inst = elem(35, 7, [...pad(40), ...vax(0), ...vax(-2), ...vax(2), ...vax(0), ...pad(40), ...le(1000), ...le(2000), ...le(0), ...pad(4), ...name('DOT')])
  const missing = elem(35, 7, [...pad(40), ...vax(1), ...vax(0), ...vax(0), ...vax(1), ...pad(40), ...le(0), ...le(0), ...le(0), ...pad(4), ...name('NOPE')])
  const d = parseDgn7(file(tcb(), def, comp, inst, missing))
  assert.equal(d.lineAttr.length / 5, 1, 'the template itself is not drawn')
  const [ox, oy] = d.origin
  assert.deepEqual([d.lines[0] + ox, d.lines[1] + oy, d.lines[2] + ox, d.lines[3] + oy], [1000, 2000, 1000, 2020])
  assert.ok(d.notices.some((n) => /1 shared cell could not be placed/.test(n)))
})

test('byte-per-pixel rasters are decoded through the colour table; others are reported', () => {
  const hdr = (w, h, flags) => [0, 0, 0, 0, ...u16(flags), 0, 1, ...u16(w), ...u16(h), 0, 0, 0, 0, ...vax(0), ...vax(2.5), ...me32(100), ...me32(400), ...me32(0), 0, 0]
  const scan = (y, px) => [...u16(0x0514), 0, 1, ...u16(0), ...u16(y), ...u16(px.length), ...px]
  const d = parseDgn7(
    file(tcb(), elem(87, 9, hdr(2, 2, 0x0514)), elem(88, 9, scan(0, [1, 255]), { complex: true }), elem(88, 9, scan(1, [3, 2]), { complex: true }), elem(87, 9, hdr(2, 2, 0x0048)), elem(3, 1, line2d(0, 0, 500, 500)))
  )
  assert.equal(d.images.length, 1)
  const im = d.images[0]
  assert.deepEqual([im.w, im.h, im.pixel, im.level], [2, 2, 2.5, 9])
  assert.deepEqual([im.x + d.origin[0], im.y + d.origin[1]], [100, 400])
  assert.deepEqual([...im.rgba], [0, 0, 255, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 255, 0, 255], 'blue, transparent, red, green')
  assert.ok(d.notices.some((n) => /Not drawn: 1 raster image\./.test(n)))
})

test('what cannot be drawn is counted, never guessed', () => {
  const d = parseDgn7(
    file(
      tcb(),
      elem(3, 1, line2d(0, 0, 10, 10)),
      elem(33, 1, new Array(40).fill(0)),
      elem(33, 1, new Array(40).fill(0)),
      elem(37, 1, new Array(40).fill(0)),
      elem(27, 1, new Array(20).fill(0)),
      elem(5, 9, [...u16(9), ...Buffer.from('BORDER.A1'.padEnd(66, '\0'), 'latin1')])
    )
  )
  const all = d.notices.join(' | ')
  assert.match(all, /2 dimensions/)
  assert.match(all, /1 multi-line/)
  assert.match(all, /1 B-spline curve/)
  assert.match(all, /1 reference file is attached and not shown: BORDER\.A1/)
  assert.equal(d.lineAttr.length / 5, 1)
})

test('damaged files: truncated elements and wild counts stop cleanly', () => {
  const good = [...tcb(), ...elem(3, 1, line2d(0, 0, 10, 10))]
  // element that claims more words than the file holds
  const cut = Buffer.from([...good, 0x01, 0x03, 0xff, 0x7f, 1, 2, 3, 4])
  const d = parseDgn7(cut)
  assert.equal(d.lineAttr.length / 5, 1)
  assert.ok(d.notices.some((n) => /ends in the middle/.test(n)))
  // line string whose vertex count runs past its own element is ignored
  const bad = parseDgn7(file(tcb(), elem(4, 1, [...u16(5000), ...me32(1), ...me32(2)]), elem(3, 1, line2d(0, 0, 10, 10))))
  assert.equal(bad.lineAttr.length / 5, 1)
  // header only
  const emptyFile = parseDgn7(file(tcb()))
  assert.equal(emptyFile.drawn, 0)
  assert.deepEqual(emptyFile.fit, [-0.5, -0.5, 0.5, 0.5])
})

test('a stray element far from the sheet does not spoil Fit', () => {
  const els = [tcb()]
  for (let i = 0; i < 60; i++) els.push(elem(3, 1, line2d(i * 10, 0, i * 10, 400)))
  els.push(elem(3, 1, line2d(90000000, 90000000, 90000100, 90000100)))
  const d = parseDgn7(file(...els))
  assert.ok(d.fit[2] - d.fit[0] < 1000, 'fit box covers the sheet only')
  assert.ok(d.extents[2] - d.extents[0] > 1e7, 'full extents still include the stray')
  assert.ok(d.notices.some((n) => /1 element lie far|1 element lies far/.test(n)))
})

test('element cap reports truncation', () => {
  const els = [tcb()]
  for (let i = 0; i < 50; i++) els.push(elem(3, 1, line2d(i, 0, i, 10)))
  const d = parseDgn7(file(...els), { maxVertices: 20, maxArcs: 10, maxTexts: 10 })
  assert.equal(d.truncated, true)
  assert.equal(d.lines.length / 2, 20)
  assert.ok(d.notices.some((n) => /only the first 20 points/.test(n)))
})

// Real files: set HOPPER_PREVIEW_SAMPLES to a folder of .dgn / .i01 files.
const samples = process.env.HOPPER_PREVIEW_SAMPLES
test('real V7 samples parse without errors', { skip: !samples && 'HOPPER_PREVIEW_SAMPLES not set' }, () => {
  let n = 0
  for (const f of readdirSync(samples)) {
    const buf = readFileSync(join(samples, f))
    if (!isDgn7(buf)) continue
    const d = parseDgn7(buf)
    n++
    assert.ok(d.drawn > 0, `${f}: nothing drawn`)
    assert.ok(d.fit.every(Number.isFinite), `${f}: fit box`)
    for (const v of [d.lines, d.arcs]) for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) assert.fail(`${f}: non-finite coordinate`)
  }
  assert.ok(n > 0, 'no V7 files in the sample folder')
})
