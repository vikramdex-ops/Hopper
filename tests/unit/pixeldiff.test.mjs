// Visual PDF compare core (src/shared/pixeldiff.ts): small synthetic RGBA pages.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pixelDiff, changeBoxes, compareScale, COLORS } from '../../src/shared/pixeldiff.ts'

/** white w x h page with black squares [x, y, size] */
function page(w, h, squares = []) {
  const px = new Uint8ClampedArray(w * h * 4).fill(255)
  for (const [sx, sy, s] of squares) {
    for (let y = sy; y < sy + s; y++) for (let x = sx; x < sx + s; x++) {
      const o = (y * w + x) * 4
      px[o] = px[o + 1] = px[o + 2] = 0
    }
  }
  return px
}
const color = (r, x, y) => Array.from(r.out.slice((y * r.width + x) * 4, (y * r.width + x) * 4 + 3))

test('identical pages: no changes, ink shown dark grey', () => {
  const a = page(64, 48, [[10, 10, 8]])
  const r = pixelDiff(a, 64, 48, a.slice(), 64, 48)
  assert.equal(r.boxes.length, 0)
  assert.equal(r.onlyOld + r.onlyNew, 0)
  assert.equal(r.both, 64)
  assert.deepEqual(color(r, 12, 12), [...COLORS.both])
  assert.deepEqual(color(r, 40, 40), [...COLORS.paper])
})

test('removed ink is red, added ink is green, each change gets a box', () => {
  const a = page(128, 96, [[8, 8, 8], [100, 70, 6]])
  const b = page(128, 96, [[8, 8, 8], [60, 20, 10]])
  const r = pixelDiff(a, 128, 96, b, 128, 96, { cell: 16 })
  assert.equal(r.onlyOld, 36)
  assert.equal(r.onlyNew, 100)
  assert.deepEqual(color(r, 102, 72), [...COLORS.onlyOld])
  assert.deepEqual(color(r, 65, 25), [...COLORS.onlyNew])
  assert.deepEqual(color(r, 10, 10), [...COLORS.both])
  assert.equal(r.boxes.length, 2)
  // reading order: the top one (added square at y 20) first
  assert.ok(r.boxes[0].y < r.boxes[1].y)
  const [top, bottom] = r.boxes
  assert.ok(top.x <= 60 && top.x + top.w >= 70 && top.y <= 20 && top.y + top.h >= 30, JSON.stringify(top))
  assert.ok(bottom.x <= 100 && bottom.x + bottom.w >= 106, JSON.stringify(bottom))
  assert.equal(top.pixels + bottom.pixels, 136)
})

test('a single stray pixel (anti-aliasing) does not make a change box', () => {
  const a = page(32, 32)
  const b = page(32, 32, [[5, 5, 1]])
  const r = pixelDiff(a, 32, 32, b, 32, 32)
  assert.equal(r.onlyNew, 1)
  assert.equal(r.boxes.length, 0)
})

test('light grey is paper, dark grey is ink; transparent pixels are paper', () => {
  const a = new Uint8ClampedArray([230, 230, 230, 255, 90, 90, 90, 255, 0, 0, 0, 0])
  const b = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255])
  const r = pixelDiff(a, 3, 1, b, 3, 1, { minPixels: 1 })
  assert.equal(r.onlyOld, 1)
  assert.deepEqual(color(r, 0, 0), [...COLORS.paper])
  assert.deepEqual(color(r, 1, 0), [...COLORS.onlyOld])
  assert.deepEqual(color(r, 2, 0), [...COLORS.paper])
})

test('different page sizes: aligned top-left, the larger size wins, outside is paper', () => {
  const a = page(40, 30, [[2, 2, 4]])
  const b = page(60, 50, [[2, 2, 4], [50, 40, 5]])
  const r = pixelDiff(a, 40, 30, b, 60, 50)
  assert.equal(r.width, 60)
  assert.equal(r.height, 50)
  assert.equal(r.both, 16)
  assert.equal(r.onlyNew, 25)
  assert.equal(r.boxes.length, 1)
  assert.deepEqual(color(r, 52, 42), [...COLORS.onlyNew])
  // the older page's missing area is paper, not ink
  assert.deepEqual(color(r, 45, 5), [...COLORS.paper])
})

test('nearby changes join into one box, distant ones stay apart', () => {
  const cells = new Uint32Array(10 * 4)
  cells[0] = 5
  cells[2] = 5 // one empty square between: joined with join = 1
  cells[9] = 5
  const joined = changeBoxes(cells, 10, 4, 10, 100, 40, 3, 1)
  assert.equal(joined.length, 2)
  assert.deepEqual(joined[0], { x: 0, y: 0, w: 30, h: 10, pixels: 10 })
  assert.equal(changeBoxes(cells, 10, 4, 10, 100, 40, 3, 0).length, 3)
  // a box at the edge is clipped to the page
  assert.equal(changeBoxes(cells, 10, 4, 10, 95, 40, 3, 0)[2].w, 5)
})

test('pixelDiff rejects a buffer smaller than its stated size', () => {
  assert.throws(() => pixelDiff(new Uint8ClampedArray(4), 2, 2, new Uint8ClampedArray(16), 2, 2), /smaller/)
})

test('compareScale: dpi, capped by the long side and the area of the larger page', () => {
  const a4 = { w: 595, h: 842 }
  assert.equal(compareScale([a4, a4], 144), 2)
  const a0 = { w: 2384, h: 3370 }
  const s = compareScale([a4, a0], 300)
  assert.ok(3370 * s <= 8000 + 1e-6)
  assert.ok(2384 * s * 3370 * s <= 32_000_000 + 1)
  assert.ok(Math.abs(compareScale([a0], 200, 8000, 1e12) - 8000 / 3370) < 1e-9)
})
