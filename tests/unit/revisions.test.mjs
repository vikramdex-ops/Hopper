// Revision parsing, comparison and grouping (src/shared/revisions.ts via Node type stripping).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRevision, compareRevs, groupRevisions } from '../../src/shared/revisions.ts'

const rules = {
  patterns: [
    '^(?<base>.+?)[ _\\-.]+rev[ _\\-.]?(?<rev>[0-9A-Z]{1,3})$',
    '^(?<base>.+?)[ _\\-.]+R(?<rev>[0-9]{1,2})$'
  ],
  order: []
}

test('parseRevision: common spellings', () => {
  assert.deepEqual(parseRevision('P-101_RevA.pdf', rules), { base: 'P-101', rev: 'A', ext: 'pdf' })
  assert.deepEqual(parseRevision('P-101 Rev 0.PDF', rules), { base: 'P-101', rev: '0', ext: 'pdf' })
  assert.deepEqual(parseRevision('P-101-R12.dwg', rules), { base: 'P-101', rev: '12', ext: 'dwg' })
  assert.deepEqual(parseRevision('p-101_reva.pdf', rules), { base: 'p-101', rev: 'a', ext: 'pdf' })
  assert.deepEqual(parseRevision('Notes.txt', rules), { base: 'Notes', rev: null, ext: 'txt' })
  assert.deepEqual(parseRevision('README', rules), { base: 'README', rev: null, ext: '' })
})

test('parseRevision: pattern without base group, invalid pattern skipped', () => {
  const r = { patterns: ['(', '\\[(?<rev>[A-Z])\\]'], order: [] }
  assert.deepEqual(parseRevision('ISO-7 [C].pdf', r), { base: 'ISO-7', rev: 'C', ext: 'pdf' })
})

test('compareRevs without order list', () => {
  assert.ok(compareRevs('1', '2', rules) < 0)
  assert.ok(compareRevs('10', '9', rules) > 0)
  assert.equal(compareRevs('01', '1', rules), 0)
  assert.ok(compareRevs('A', 'B', rules) < 0)
  assert.ok(compareRevs('Z', 'AA', rules) < 0)
  assert.ok(compareRevs('b', 'A', rules) > 0)
  assert.equal(compareRevs('A', '0', rules), null)
  assert.equal(compareRevs('1A', '2', rules), null)
})

test('compareRevs with order list', () => {
  const r = { ...rules, order: ['A', 'B', '0', '1'] }
  assert.ok(compareRevs('B', '0', r) < 0)
  assert.ok(compareRevs('1', 'a', r) > 0)
  assert.equal(compareRevs('C', 'A', r), null)
})

const e = (name, mtime = 0) => ({ name, path: 'D:\\lot\\' + name, mtime })

test('groupRevisions: known order, latest, files without a rev left out', () => {
  const groups = groupRevisions([e('X_RevB.pdf'), e('X_RevA.pdf'), e('x_revC.pdf'), e('Y.pdf'), e('X_RevA.dwg')], rules)
  assert.equal(groups.length, 2)
  const g = groups.find((g) => g.ext === 'pdf')
  assert.equal(g.orderKnown, true)
  assert.deepEqual(g.items.map((i) => i.rev), ['A', 'B', 'C'])
  assert.equal(g.latest, 'D:\\lot\\x_revC.pdf')
  assert.deepEqual(g.outOfSequence, [])
})

test('groupRevisions: mixed classes are order unknown, latest null', () => {
  const groups = groupRevisions([e('X_RevB.pdf'), e('X_Rev0.pdf')], rules)
  assert.equal(groups[0].orderKnown, false)
  assert.equal(groups[0].latest, null)
})

test('groupRevisions: letter gaps not guessed without order list, numeric gaps reported', () => {
  const letters = groupRevisions([e('X_RevA.pdf'), e('X_RevC.pdf')], rules)[0]
  assert.deepEqual(letters.outOfSequence, [])
  const nums = groupRevisions([e('X_Rev0.pdf'), e('X_Rev3.pdf')], rules)[0]
  assert.deepEqual(nums.outOfSequence, ['missing 1 to 2'])
  assert.equal(nums.latest, 'D:\\lot\\X_Rev3.pdf')
})

test('groupRevisions: order list gaps and duplicates', () => {
  const r = { ...rules, order: ['A', 'B', 'C', '0', '1'] }
  const g = groupRevisions([e('X_RevA.pdf'), e('X_Rev0.pdf'), e('X Rev 0.pdf')], r)[0]
  assert.equal(g.orderKnown, true)
  assert.equal(g.latest, null) // latest revision exists twice
  assert.ok(g.outOfSequence.some((s) => s.startsWith('duplicate 0')))
  assert.ok(g.outOfSequence.includes('missing B to C'))
})

test('groupRevisions: unknown token with order list', () => {
  const r = { ...rules, order: ['A', 'B'] }
  const g = groupRevisions([e('X_RevA.pdf'), e('X_RevZ.pdf')], r)[0]
  assert.equal(g.orderKnown, false)
  assert.equal(g.latest, null)
  assert.deepEqual(g.outOfSequence, [])
})
