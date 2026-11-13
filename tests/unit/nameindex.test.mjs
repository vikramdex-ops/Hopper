// The compact name index behind instant search: names, case, sizes, folders, deletes,
// compaction and the on-disk format all round-trip.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const { NameIndex } = await import('../../src/engine/nameindex.ts')

const words = (q) => {
  const ws = q.toLowerCase().split(/\s+/).filter(Boolean)
  return { anchor: ws.sort((a, b) => b.length - a.length)[0], test: (n) => ws.every((w) => n.includes(w)) }
}
const all = { test: () => true }
const names = (ix, m) => {
  const out = []
  ix.scan(m, (i) => void out.push(ix.hit(i).name))
  return out.sort()
}

function sample() {
  const ix = new NameIndex('D:\\')
  ix.add('Projects', 'D:\\', true, 0, 1700000000000)
  ix.add('P12513-ISO-001.PDF', 'D:\\Projects', false, 123456, 1700000123000)
  ix.add('readme.txt', 'D:\\Projects', false, 10, 1700000000000)
  ix.add('Ünïcödé Straße.dwg', 'D:\\Projects\\Ä', false, 5, 1700000000000)
  ix.add('İstanbul.txt', 'D:\\Projects', false, 1, 0) // lower-casing changes the length
  ix.add('Big.iso', 'D:\\Projects', false, 6 * 1024 ** 3, 1700000000000)
  ix.add('emoji 😀 Plan.xlsx', 'D:\\Projects', false, 1, 0)
  ix.add('Report – Final’s.docx', 'D:\\Projects', false, 1, 0)
  return ix
}

test('display names come back exactly, whatever the case or script', () => {
  const ix = sample()
  assert.deepEqual(names(ix, all), ['Big.iso', 'P12513-ISO-001.PDF', 'Projects', 'Report – Final’s.docx', 'emoji 😀 Plan.xlsx', 'readme.txt', 'Ünïcödé Straße.dwg', 'İstanbul.txt'].sort())
})

test('search is case-insensitive, AND-ed, and jumps by anchor', () => {
  const ix = sample()
  assert.deepEqual(names(ix, words('iso')), ['Big.iso', 'P12513-ISO-001.PDF'])
  assert.deepEqual(names(ix, words('iso pdf')), ['P12513-ISO-001.PDF'])
  assert.deepEqual(names(ix, words('straße')), ['Ünïcödé Straße.dwg'])
  assert.deepEqual(names(ix, words('😀')), ['emoji 😀 Plan.xlsx'])
  assert.deepEqual(names(ix, words('nothing-here')), [])
  // an anchor that spans two names must not match
  assert.deepEqual(names(ix, words('pdfreadme')), [])
})

test('sizes, times, folders and parent paths', () => {
  const ix = sample()
  const by = {}
  ix.scan(all, (i) => void (by[ix.hit(i).name] = ix.hit(i)))
  assert.equal(by['Big.iso'].size, 6 * 1024 ** 3)
  assert.equal(by['P12513-ISO-001.PDF'].size, 123456)
  assert.equal(by['P12513-ISO-001.PDF'].mtime, 1700000123000)
  assert.equal(by['P12513-ISO-001.PDF'].dir, 'D:\\Projects')
  assert.equal(by['Ünïcödé Straße.dwg'].dir, 'D:\\Projects\\Ä')
  assert.equal(by['Projects'].isDir, true)
  assert.equal(by['readme.txt'].isDir, false)
  assert.equal(ix.lookupDir('d:\\PROJECTS'), ix.lookupDir('D:\\Projects'))
  assert.equal(ix.lookupDir('D:\\Nope'), -1)
})

test('removing a folder\'s entries, re-adding, and compaction', () => {
  const ix = sample()
  ix.removeIn(new Set([ix.lookupDir('D:\\Projects')]))
  assert.deepEqual(names(ix, all), ['Projects', 'Ünïcödé Straße.dwg'])
  ix.add('readme.txt', 'D:\\Projects', false, 11, 0)
  assert.equal(ix.live, 3)
  const c = ix.compact()
  assert.equal(c.n, 3)
  assert.equal(c.dead, 0)
  assert.deepEqual(names(c, all), ['Projects', 'readme.txt', 'Ünïcödé Straße.dwg'])
})

test('many folders force the hash table to grow', () => {
  const ix = new NameIndex('X:\\')
  for (let d = 0; d < 5000; d++) ix.add(`File ${d}.txt`, `X:\\Folder ${d}`, false, d, 0)
  for (let d = 0; d < 5000; d += 499) assert.equal(ix.dirPath(ix.lookupDir(`x:\\folder ${d}`)), `X:\\Folder ${d}`)
  assert.equal(ix.nDirs, 5001) // the 5000 folders plus X:\ as their parent
  assert.deepEqual(names(ix, words('file 4999.')), ['File 4999.txt'])
})

test('save and load round-trip, then keep growing', async () => {
  const dir = mkdtempSync(join(process.env.TEMP || tmpdir(), 'hopper-ix-'))
  try {
    const ix = sample()
    ix.removeIn(new Set([ix.lookupDir('D:\\Projects\\Ä')]))
    ix.scannedAt = 42
    await ix.save(join(dir, 'a.ix2'))
    const back = await NameIndex.load(join(dir, 'a.ix2'))
    assert.equal(back.scannedAt, 42)
    assert.equal(back.live, ix.live)
    assert.deepEqual(names(back, all), names(ix, all))
    back.add('New Thing.pdf', 'D:\\Projects', false, 1, 0)
    assert.deepEqual(names(back, words('thing')), ['New Thing.pdf'])
    back.trim()
    assert.deepEqual(names(back, words('new')), ['New Thing.pdf'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
