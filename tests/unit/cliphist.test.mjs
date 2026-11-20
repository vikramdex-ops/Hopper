// Hopper Clipboard model (src/shared/cliphist.ts via Node type stripping).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addEntry, byFilter, cleanClipSettings, dedupeKey, entryTitle, matches, textHint, tidy } from '../../src/shared/cliphist.ts'

let n = 0
const text = (t, extra = {}) => ({ id: `e${n++}`, kind: 'text', hash: dedupeKey({ kind: 'text', text: t }), at: n, first: n, count: 1, pinned: false, text: t, bytes: t.length, ...extra })
const files = (paths, extra = {}) => {
  const f = paths.map((p) => ({ path: p, dir: false }))
  return { id: `e${n++}`, kind: 'files', hash: dedupeKey({ kind: 'files', files: f }), at: n, first: n, count: 1, pinned: false, files: f, bytes: 0, ...extra }
}

test('text hints', () => {
  assert.equal(textHint('https://example.com/a?b=1'), 'url')
  assert.equal(textHint('www.dexterity.in'), 'url')
  assert.equal(textHint('D:\\Projects\\P1'), 'path')
  assert.equal(textHint('"D:\\a b"'), 'path')
  assert.equal(textHint('\\\\server\\share\\x'), 'path')
  assert.equal(textHint('someone@example.com'), 'email')
  assert.equal(textHint('#1a2B3c'), 'color')
  assert.equal(textHint('rgb(1, 2, 3)'), 'color')
  assert.equal(textHint('1,234.50'), 'number')
  assert.equal(textHint('const a = 1;\nfunction f() {\n  return a;\n}'), 'code')
  assert.equal(textHint('Please review the attached drawings.'), '')
  assert.equal(textHint('   '), '')
})

test('dedupe keys ignore outer whitespace, line endings and file order/case', () => {
  assert.equal(dedupeKey({ kind: 'text', text: ' a\r\nb ' }), dedupeKey({ kind: 'text', text: 'a\nb' }))
  assert.equal(dedupeKey({ kind: 'files', files: [{ path: 'C:\\B' }, { path: 'c:\\a' }] }), dedupeKey({ kind: 'files', files: [{ path: 'C:\\A' }, { path: 'C:\\b' }] }))
  assert.notEqual(dedupeKey({ kind: 'text', text: 'a' }), dedupeKey({ kind: 'files', files: [{ path: 'a' }] }))
})

test('addEntry moves a re-copied item to the top, keeps pin and count', () => {
  const a = text('alpha', { pinned: true })
  const b = text('beta')
  let { list, merged } = addEntry([b, a], text('alpha'), 10)
  assert.equal(merged, true)
  assert.equal(list.length, 2)
  assert.equal(list[0].id, a.id)
  assert.equal(list[0].count, 2)
  assert.equal(list[0].pinned, true)
  ;({ list, merged } = addEntry(list, text('gamma'), 10))
  assert.equal(merged, false)
  assert.equal(list[0].text, 'gamma')
})

test('addEntry evicts the oldest unpinned past max, never pinned ones', () => {
  const pinned = text('keep', { pinned: true })
  let list = [pinned]
  const dropped = []
  for (let i = 0; i < 5; i++) {
    const r = addEntry(list, text(`t${i}`), 3)
    list = r.list
    dropped.push(...r.dropped)
  }
  assert.equal(list.filter((e) => !e.pinned).length, 3)
  assert.ok(list.some((e) => e.id === pinned.id))
  assert.deepEqual(dropped.map((e) => e.text), ['t0', 't1'])
})

test('tidy removes whitespace variants, empty text and vanished files; keeps pinned', () => {
  const list = [text('a  b'), text('a b'), text('  '), files(['C:\\x'], { files: [{ path: 'C:\\x', dir: false, missing: true }] }), text('a b', { pinned: true, hash: 'other' })]
  const r = tidy(list)
  assert.equal(r.removed.length, 3)
  assert.equal(r.list.length, 2)
  assert.ok(r.list.some((e) => e.pinned))
})

test('search, filters and titles', () => {
  const t = text('Drawing ISO-1001 rev B', { source: 'OUTLOOK' })
  assert.equal(matches(t, 'iso-1001 rev'), true)
  assert.equal(matches(t, 'outlook'), true)
  assert.equal(matches(t, 'rev C'), false)
  const f = files(['D:\\P\\a.pdf', 'D:\\P\\b.pdf'])
  assert.equal(matches(f, 'b.pdf'), true)
  assert.equal(entryTitle(f), 'a.pdf and 1 more')
  assert.equal(byFilter(f, 'files'), true)
  assert.equal(byFilter(text('https://x.y', { hint: 'url' }), 'links'), true)
  assert.equal(byFilter(t, 'pinned'), false)
  assert.equal(entryTitle(text('x'.repeat(200))).length, 118)
})

test('settings are cleaned', () => {
  assert.deepEqual(cleanClipSettings(undefined), { enabled: true, winV: true, max: 500, pasteAfterPick: true })
  assert.equal(cleanClipSettings({ max: 1 }).max, 25)
  assert.equal(cleanClipSettings({ winV: false }).winV, false)
})
