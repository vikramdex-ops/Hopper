// Folder watch: snapshot diff, burst batching, ignore rules, own paths, quiet hours, wording
// (src/shared/folderwatch.ts via Node type stripping).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  Batcher, OwnPaths, batchBody, batchTitle, cleanWatched, connectText, diffSnapshots, filterBatch, folderName, inQuietHours, isIgnoredName,
  isIgnoredPath, isWithin, newWatchedFolder, snapshotOf, WATCH_SETTLE_MS, WATCH_MAX_HOLD_MS
} from '../../src/shared/folderwatch.ts'

const f = (rel, size = 1, mtime = 1000, extra = {}) => ({ rel, dir: false, size, mtime, ...extra })
const d = (rel) => ({ rel, dir: true, size: 0, mtime: 1000 })

test('ignore rules: temp, lock and system files', () => {
  for (const n of ['~$Report.docx', 'x.tmp', 'X.TMP', '.~lock.sheet.xlsx#', 'P-101.dwl', 'P-101.dwl2', 'Thumbs.db', 'desktop.ini', 'a.pdf.hopper-part', 'b.txt.hopper-save', '.x.pdf.123.hopper-tmp', 'a.pdf.hopper-rn3', '.hopper-extract-abc']) {
    assert.equal(isIgnoredName(n), true, n)
  }
  for (const n of ['Report.docx', 'tmp.pdf', 'P-101.dwg', 'lock.txt', 'thumbs.png', 'ISO-1001_RevA.pdf']) assert.equal(isIgnoredName(n), false, n)
  assert.equal(isIgnoredPath('sub\\.hopper-extract-x\\a.pdf'), true)
  assert.equal(isIgnoredPath('sub\\a.pdf'), false)
})

test('snapshotOf drops ignored entries and keys by lower case', () => {
  const s = snapshotOf([f('A.pdf'), f('~$A.docx'), f('Sub\\Thumbs.db'), d('Sub')])
  assert.deepEqual([...s.keys()].sort(), ['a.pdf', 'sub'])
})

test('diffSnapshots: added, changed (size or time beyond 2 s), removed, unchanged', () => {
  const prev = snapshotOf([f('same.pdf', 10, 1000), f('size.pdf', 10, 1000), f('time.pdf', 10, 1000), f('round.pdf', 10, 1000), f('gone.pdf'), d('Folder')])
  const next = snapshotOf([f('same.pdf', 10, 1000), f('size.pdf', 11, 1000), f('time.pdf', 10, 9000), f('round.pdf', 10, 2900), f('new.pdf'), d('Folder'), d('New folder')])
  const r = diffSnapshots(prev, next)
  assert.deepEqual(r.added.sort(), ['New folder', 'new.pdf'])
  assert.deepEqual(r.changed.sort(), ['size.pdf', 'time.pdf'])
  assert.deepEqual(r.removed, ['gone.pdf'])
  // a case-only rename is not a change
  assert.deepEqual(diffSnapshots(snapshotOf([f('a.pdf')]), snapshotOf([f('A.PDF')])), { added: [], changed: [], removed: [] })
  // a file replaced by a folder of the same name
  const swapped = diffSnapshots(snapshotOf([f('x')]), snapshotOf([d('x')]))
  assert.deepEqual(swapped, { added: ['x'], changed: [], removed: ['x'] })
})

test('diffSnapshots partial (entry limit hit): no deletions, only recently created additions', () => {
  const prev = snapshotOf([f('a.pdf'), f('b.pdf')])
  const next = snapshotOf([f('a.pdf'), f('old-copy.pdf', 1, 1000, { ctime: 50_000 }), f('fresh.pdf', 1, 1000, { ctime: 100_500 }), f('written.pdf', 1, 101_000)])
  const r = diffSnapshots(prev, next, { since: 100_000 })
  assert.deepEqual(r.added.sort(), ['fresh.pdf', 'written.pdf'])
  assert.deepEqual(r.removed, [])
})

test('Batcher: one batch per burst, settles after 5 s of quiet', () => {
  const b = new Batcher()
  assert.equal(b.pending, false)
  const t0 = 1_000_000
  // a 300-file copy seen over three listings
  for (let k = 0; k < 3; k++) b.add({ added: Array.from({ length: 100 }, (_, i) => `f${k * 100 + i}.pdf`), changed: [], removed: [] }, t0 + k * 2000)
  assert.equal(b.due(t0 + 4000 + WATCH_SETTLE_MS - 1), false)
  assert.equal(b.due(t0 + 4000 + WATCH_SETTLE_MS), true)
  const out = b.take()
  assert.equal(out.added.length, 300)
  assert.equal(b.pending, false)
  assert.equal(b.due(t0 + 999_999), false)
})

test('Batcher: a folder that keeps changing still reports after the maximum hold', () => {
  const b = new Batcher()
  let t = 0
  for (; t < WATCH_MAX_HOLD_MS; t += 2000) b.add({ added: [`f${t}`], changed: [], removed: [] }, t + 1)
  assert.equal(b.due(WATCH_MAX_HOLD_MS), false)
  assert.equal(b.due(WATCH_MAX_HOLD_MS + 1), true)
})

test('Batcher: later news about the same path replaces earlier news', () => {
  const b = new Batcher()
  b.add({ added: ['copying.pdf', 'temp.bak'], changed: [], removed: ['replaced.pdf'] }, 1)
  b.add({ added: ['Replaced.pdf'], changed: ['copying.pdf'], removed: ['temp.bak'] }, 2)
  const out = b.take()
  assert.deepEqual(out.added, ['copying.pdf'])
  assert.deepEqual(out.changed, ['Replaced.pdf'])
  assert.deepEqual(out.removed, [])
  // empty diffs do not open a batch
  b.add({ added: [], changed: [], removed: [] }, 5)
  assert.equal(b.pending, false)
  assert.equal(b.due(10_000), false)
})

test('OwnPaths: exact paths and everything inside a folder, for a limited time', () => {
  const own = new OwnPaths(60_000)
  own.add(['D:\\Drop\\copied.pdf', 'D:\\Drop\\New folder\\'], 1000)
  assert.equal(own.has('d:\\drop\\COPIED.pdf', 2000), true)
  assert.equal(own.has('D:\\Drop\\New folder\\inside\\x.dwg', 2000), true)
  assert.equal(own.has('D:\\Drop\\other.pdf', 2000), false)
  assert.equal(own.has('D:\\Drop\\copied.pdf', 61_001), false)
  own.prune(200_000)
  assert.equal(own.has('D:\\Drop\\copied.pdf', 1000), false)
})

test('filterBatch: follows the notify settings and leaves out own paths', () => {
  const w = { ...newWatchedFolder('\\\\server\\jobs\\Drop'), notify: { added: true, changed: false, removed: true } }
  const own = new OwnPaths()
  own.add(['\\\\server\\jobs\\Drop\\mine.pdf'], 0)
  const out = filterBatch({ added: ['mine.pdf', 'theirs.pdf'], changed: ['edited.pdf'], removed: ['gone.pdf'], firstAt: 0, lastAt: 0 }, w, (p) => own.has(p, 10))
  assert.deepEqual(out.added, ['theirs.pdf'])
  assert.deepEqual(out.changed, [])
  assert.deepEqual(out.removed, ['gone.pdf'])
})

test('isWithin: case-insensitive, slashes, not a name prefix', () => {
  assert.equal(isWithin('D:\\Drop\\a', 'd:\\drop'), true)
  assert.equal(isWithin('D:\\Drop', 'D:\\Drop\\'), true)
  assert.equal(isWithin('D:\\Dropbox\\a', 'D:\\Drop'), false)
  assert.equal(isWithin('D:/Drop/a', 'D:\\Drop'), true)
})

test('quiet hours: off, same day, over midnight', () => {
  const at = (h, m = 0) => new Date(2026, 10, 20, h, m)
  assert.equal(inQuietHours({ on: false, from: '19:00', to: '08:00' }, at(23)), false)
  const night = { on: true, from: '19:00', to: '08:00' }
  assert.equal(inQuietHours(night, at(23)), true)
  assert.equal(inQuietHours(night, at(7, 59)), true)
  assert.equal(inQuietHours(night, at(8)), false)
  assert.equal(inQuietHours(night, at(12)), false)
  const lunch = { on: true, from: '13:00', to: '14:00' }
  assert.equal(inQuietHours(lunch, at(13, 30)), true)
  assert.equal(inQuietHours(lunch, at(14)), false)
  assert.equal(inQuietHours({ on: true, from: 'bad', to: '08:00' }, at(3)), false)
})

test('wording: titles, body, Connect text has no file names', () => {
  const many = { added: Array.from({ length: 300 }, (_, i) => `sub\\f${i}.pdf`), changed: [], removed: [] }
  assert.equal(batchTitle(many, 'Drop'), '300 new files in Drop')
  assert.equal(batchTitle({ added: [], changed: ['a.pdf'], removed: [] }, 'Drop'), '1 changed file in Drop')
  assert.equal(batchTitle({ added: ['a'], changed: ['b'], removed: ['c', 'd'] }, 'Drop'), '4 changes in Drop')
  assert.equal(batchBody(many), 'f0.pdf, f1.pdf, f2.pdf and 297 more')
  assert.equal(batchBody({ added: ['a.pdf'], changed: ['b.pdf'], removed: [] }), '1 new, 1 changed · a.pdf, b.pdf')
  const c = connectText({ added: ['secret-client-name.pdf'], changed: [], removed: ['x.dwg'] }, 'Drop')
  assert.equal(c, 'Hopper: 2 changes in Drop (1 new, 1 deleted)')
  assert.ok(!c.includes('secret'))
  assert.equal(folderName('\\\\server\\jobs\\Client drop\\'), 'Client drop')
  assert.equal(folderName('D:\\'), 'D:\\')
})

test('cleanWatched: fills defaults, rejects entries without a path', () => {
  assert.equal(cleanWatched(null), null)
  assert.equal(cleanWatched({ path: '  ' }), null)
  const w = cleanWatched({ id: 'x', path: 'D:\\Drop', quiet: { on: true, from: '25:00' } })
  assert.equal(w.id, 'x')
  assert.equal(w.subfolders, true)
  assert.deepEqual(w.notify, { added: true, changed: true, removed: false })
  assert.deepEqual(w.quiet, { on: true, from: '19:00', to: '08:00' })
  assert.equal(w.connect, false)
})
