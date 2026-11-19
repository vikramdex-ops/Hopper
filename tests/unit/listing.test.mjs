// Group-by buckets, search filters and the per-folder view key (src/shared/listing.ts).
// Dates are built with the local-time Date constructor, so the tests hold in any time zone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dateMarks, dateGroup, sizeGroup, nameGroup, groupItems, DATE_GROUPS, SIZE_GROUPS,
  parseDateFilter, parseSizeFilter, parseTypeFilter, parseFilters, passesFilters, compileQuery, extOfName,
  folderKey, rememberView
} from '../../src/shared/listing.ts'

// Thursday 19 November 2026, 15:30 local
const NOW = new Date(2026, 10, 19, 15, 30).getTime()
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime()
const marks = dateMarks(NOW, 1)
const KB = 1024
const MB = KB * 1024
const GB = MB * 1024

test('dateMarks: local midnights, Monday week start', () => {
  assert.equal(marks.today, new Date(2026, 10, 19).getTime())
  assert.equal(marks.yesterday, new Date(2026, 10, 18).getTime())
  assert.equal(marks.week, new Date(2026, 10, 16).getTime())
  assert.equal(marks.lastWeek, new Date(2026, 10, 9).getTime())
  assert.equal(marks.month, new Date(2026, 10, 1).getTime())
  assert.equal(marks.lastMonth, new Date(2026, 9, 1).getTime())
  assert.equal(marks.year, new Date(2026, 0, 1).getTime())
  // Sunday week start
  assert.equal(dateMarks(NOW, 0).week, new Date(2026, 10, 15).getTime())
  // January: last month is December of the year before
  assert.equal(dateMarks(at(2027, 1, 5), 1).lastMonth, new Date(2026, 11, 1).getTime())
})

test('dateGroup: every bucket', () => {
  const g = (t) => DATE_GROUPS[dateGroup(t, marks)]
  assert.equal(g(at(2026, 11, 19, 1)), 'Today')
  assert.equal(g(at(2026, 11, 25)), 'Today') // future dates count as today
  assert.equal(g(at(2026, 11, 18, 23)), 'Yesterday')
  assert.equal(g(at(2026, 11, 16)), 'Earlier this week')
  assert.equal(g(at(2026, 11, 10)), 'Last week')
  assert.equal(g(at(2026, 11, 3)), 'Earlier this month')
  assert.equal(g(at(2026, 10, 2)), 'Last month')
  assert.equal(g(at(2026, 2, 2)), 'Earlier this year')
  assert.equal(g(at(2025, 12, 31)), 'A long time ago')
  assert.equal(g(0), 'A long time ago')
})

test('sizeGroup and nameGroup boundaries', () => {
  const s = (size, dir = false) => SIZE_GROUPS[sizeGroup({ dir, size })]
  assert.equal(s(0, true), 'Folders')
  assert.equal(s(0), 'Empty')
  assert.equal(s(1), 'Tiny (under 16 KB)')
  assert.equal(s(16 * KB - 1), 'Tiny (under 16 KB)')
  assert.equal(s(16 * KB), 'Small (16 KB to 1 MB)')
  assert.equal(s(MB), 'Medium (1 to 128 MB)')
  assert.equal(s(128 * MB), 'Large (128 MB to 1 GB)')
  assert.equal(s(GB), 'Huge (over 1 GB)')
  assert.deepEqual(['apple', 'Hat', 'iso', 'Pump', 'q', 'zeta', 'Élan', '07 lot', '_tmp', ''].map(nameGroup), [0, 0, 1, 1, 2, 2, 0, 3, 3, 3])
})

const E = (name, o = {}) => ({ name, dir: false, ext: extOfName(name), size: 100, mtime: NOW, ...o })

test('groupItems: type groups folders first, order kept inside groups', () => {
  const items = [E('Lot 07', { dir: true, ext: '' }), E('b.pdf'), E('a.dwg'), E('A.PDF'), E('notes')]
  const label = (ext, dir) => (dir ? 'File folder' : ext ? `${ext.toUpperCase()} file` : 'File')
  const groups = groupItems(items, 'type', { typeLabel: label })
  assert.deepEqual(groups.map((g) => g.label), ['File folder', 'DWG file', 'File', 'PDF file'])
  assert.deepEqual(groups[3].items.map((e) => e.name), ['b.pdf', 'A.PDF'])
})

test('groupItems: date, size, name and none', () => {
  const items = [E('x', { mtime: at(2026, 11, 19) }), E('y', { mtime: at(2020, 1, 1) }), E('z', { mtime: at(2026, 11, 18) })]
  assert.deepEqual(groupItems(items, 'mtime', { now: NOW }).map((g) => [g.label, g.items.length]), [['Today', 1], ['Yesterday', 1], ['A long time ago', 1]])
  const sized = [E('a', { size: 2 * GB }), E('b', { size: 0 }), E('c', { dir: true, size: 0 })]
  assert.deepEqual(groupItems(sized, 'size').map((g) => g.label), ['Folders', 'Empty', 'Huge (over 1 GB)'])
  assert.deepEqual(groupItems([E('zz'), E('1a'), E('bb')], 'name').map((g) => g.label), ['A–H', 'Q–Z', '0–9 and other'])
  const none = groupItems(items, 'none')
  assert.equal(none.length, 1)
  assert.equal(none[0].items.length, 3)
})

test('groupItems: 50,000 items stay fast', () => {
  const big = Array.from({ length: 50000 }, (_, i) => E(`file-${i}.${['pdf', 'dwg', 'txt', 'i01'][i % 4]}`, { size: i * 997, mtime: NOW - i * 3600000 }))
  for (const by of ['type', 'mtime', 'size', 'name']) {
    const t = performance.now()
    const g = groupItems(big, by, { now: NOW })
    assert.equal(g.reduce((a, x) => a + x.items.length, 0), 50000)
    assert.ok(performance.now() - t < 500, `${by} took too long`)
  }
})

test('parseDateFilter: named periods', () => {
  assert.deepEqual(parseDateFilter('today', marks), { min: marks.today })
  assert.deepEqual(parseDateFilter('Yesterday', marks), { min: marks.yesterday, max: marks.today - 1 })
  assert.deepEqual(parseDateFilter('thisweek', marks), { min: marks.week })
  assert.deepEqual(parseDateFilter('this-week', marks), { min: marks.week })
  assert.deepEqual(parseDateFilter('lastweek', marks), { min: marks.lastWeek, max: marks.week - 1 })
  assert.deepEqual(parseDateFilter('thismonth', marks), { min: marks.month })
  assert.deepEqual(parseDateFilter('thisyear', marks), { min: marks.year })
})

test('parseDateFilter: ages', () => {
  const sevenDaysAgo = new Date(2026, 10, 12, 15, 30).getTime()
  assert.deepEqual(parseDateFilter('<7d', marks), { min: sevenDaysAgo })
  assert.deepEqual(parseDateFilter('7d', marks), { min: sevenDaysAgo })
  assert.deepEqual(parseDateFilter('>7d', marks), { max: sevenDaysAgo })
  assert.deepEqual(parseDateFilter('<2w', marks), { min: new Date(2026, 10, 5, 15, 30).getTime() })
  assert.deepEqual(parseDateFilter('>1mo', marks), { max: new Date(2026, 9, 19, 15, 30).getTime() })
  assert.deepEqual(parseDateFilter('<1y', marks), { min: new Date(2025, 10, 19, 15, 30).getTime() })
  assert.deepEqual(parseDateFilter('<3h', marks), { min: NOW - 3 * 3600000 })
})

test('parseDateFilter: days and ranges in local time', () => {
  const d1 = new Date(2026, 10, 1).getTime()
  const d2 = new Date(2026, 10, 2).getTime()
  assert.deepEqual(parseDateFilter('2026-11-01', marks), { min: d1, max: d2 - 1 })
  assert.deepEqual(parseDateFilter('>2026-11-01', marks), { min: d2 })
  assert.deepEqual(parseDateFilter('>=2026-11-01', marks), { min: d1 })
  assert.deepEqual(parseDateFilter('<2026-11-01', marks), { max: d1 - 1 })
  assert.deepEqual(parseDateFilter('<=2026-11-01', marks), { max: d2 - 1 })
  assert.deepEqual(parseDateFilter('2026-11-01..2026-11-15', marks), { min: d1, max: new Date(2026, 10, 16).getTime() - 1 })
  // reversed range is swapped, not rejected
  assert.deepEqual(parseDateFilter('2026-11-15..2026-11-01', marks), { min: d1, max: new Date(2026, 10, 16).getTime() - 1 })
})

test('parseDateFilter: invalid values', () => {
  for (const v of ['2026-02-30', '2026-13-01', 'soon', '>7x', '7', '2026-11-01..', '..2026-11-01', 'last week']) assert.equal(parseDateFilter(v, marks), null, v)
})

test('parseSizeFilter', () => {
  assert.deepEqual(parseSizeFilter('>10mb'), { min: 10 * MB + 1 })
  assert.deepEqual(parseSizeFilter('>=10MB'), { min: 10 * MB })
  assert.deepEqual(parseSizeFilter('<500kb'), { max: 500 * KB - 1 })
  assert.deepEqual(parseSizeFilter('<=1g'), { max: GB })
  assert.deepEqual(parseSizeFilter('1mb..5mb'), { min: MB, max: 5 * MB })
  assert.deepEqual(parseSizeFilter('5mb..1mb'), { min: MB, max: 5 * MB })
  assert.deepEqual(parseSizeFilter('1.5mb'), { min: 1.5 * MB, max: 1.5 * MB })
  assert.deepEqual(parseSizeFilter('2048'), { min: 2048, max: 2048 })
  assert.deepEqual(parseSizeFilter('empty'), { min: 0, max: 0 })
  assert.deepEqual(parseSizeFilter('huge'), { min: GB })
  for (const v of ['big', '>mb', '10xb', '1mb..', '..1mb', '>', '-5mb']) assert.equal(parseSizeFilter(v), null, v)
})

test('parseTypeFilter', () => {
  assert.deepEqual(parseTypeFilter('folder'), { dirs: true })
  assert.deepEqual(parseTypeFilter('files'), { dirs: false })
  assert.deepEqual(parseTypeFilter('folder,file'), {})
  assert.deepEqual(parseTypeFilter('pdf'), { dirs: false, exts: ['pdf'] })
  assert.deepEqual(parseTypeFilter('drawing'), { dirs: false, exts: ['dwg', 'dgn', 'dxf', 'i01'] })
  assert.deepEqual(parseTypeFilter('Sheet').exts, ['xls', 'xlsx', 'xlsm', 'csv', 'ods'])
  assert.deepEqual(parseTypeFilter('document').exts, ['doc', 'docx', 'odt', 'rtf', 'txt'])
  assert.ok(parseTypeFilter('image').exts.includes('png'))
  assert.ok(parseTypeFilter('archive').exts.includes('7z'))
  assert.deepEqual(parseTypeFilter('pdf,drawing').exts, ['pdf', 'dwg', 'dgn', 'dxf', 'i01'])
  assert.equal(parseTypeFilter('movie'), null)
  assert.equal(parseTypeFilter('folder,pdf'), null)
})

test('parseFilters: tokens out, text kept, invalid ones hinted and ignored', () => {
  const p = parseFilters('iso 07 date:today size:>1mb type:pdf modified:soon', { now: NOW })
  assert.equal(p.text, 'iso 07')
  assert.deepEqual(p.used, ['date:today', 'size:>1mb', 'type:pdf'])
  assert.equal(p.hints.length, 1)
  assert.match(p.hints[0], /modified:soon not understood/)
  assert.deepEqual(p.filters, { mtime: { min: marks.today }, size: { min: MB + 1 }, dirs: false, exts: ['pdf'] })
  assert.deepEqual(parseFilters('size:', { now: NOW }).hints, ['size: needs a value'])
  // two filters on the same field narrow each other
  assert.deepEqual(parseFilters('size:>1mb size:<2mb').filters.size, { min: MB + 1, max: 2 * MB - 1 })
  assert.equal(parseFilters('size:>2mb size:<1mb').filters.never, true)
  assert.equal(parseFilters('type:folder type:file').filters.never, true)
  assert.equal(parseFilters('type:pdf type:drawing').filters.never, true)
  // words with a colon that are not filters stay words
  assert.equal(parseFilters('foo:bar').text, 'foo:bar')
})

test('passesFilters', () => {
  const f = parseFilters('size:>1mb date:thisweek', { now: NOW }).filters
  assert.equal(passesFilters({ dir: false, size: 2 * MB, mtime: at(2026, 11, 17) }, f), true)
  assert.equal(passesFilters({ dir: false, size: 2 * MB, mtime: at(2026, 11, 10) }, f), false)
  assert.equal(passesFilters({ dir: false, size: MB, mtime: at(2026, 11, 17) }, f), false)
  // folders have no size: a size filter shows files only
  assert.equal(passesFilters({ dir: true, size: 5 * MB, mtime: NOW }, f), false)
  assert.equal(passesFilters({ dir: true, size: 0, mtime: NOW }, parseFilters('type:folder').filters), true)
  assert.equal(passesFilters({ dir: false, size: 0, mtime: NOW }, parseFilters('type:folder').filters), false)
  assert.equal(passesFilters({ dir: false, size: 0, mtime: NOW }, parseFilters('size:empty').filters), true)
})

test('compileQuery: words, wildcards, ext and type together', () => {
  const q = compileQuery('iso ext:pdf,dwg type:drawing date:today', { now: NOW })
  assert.deepEqual([...q.ext], ['dwg'])
  assert.equal(q.test('iso-1001.dwg'), true)
  assert.equal(q.test('iso-1001.pdf'), false)
  assert.equal(q.test('pump.dwg'), false)
  assert.equal(q.filtered, true)
  assert.deepEqual(q.plain, { words: ['iso'], exts: ['dwg'] })
  const w = compileQuery('ISO-10??_*.pdf')
  assert.equal(w.test('iso-1001_reva.pdf'), true)
  assert.equal(w.plain, undefined)
  // filters only: every name passes the name test
  const f = compileQuery('size:>100mb')
  assert.equal(f.test('anything.bin'), true)
  assert.equal(f.anchor, undefined)
  // no extension in common: nothing matches
  const none = compileQuery('ext:pdf type:drawing')
  assert.equal(none.test('a.pdf'), false)
  assert.equal(none.filters.never, true)
  assert.equal(compileQuery('plain words').filtered, false)
})

test('compileQuery: regex, and a broken regex falls back to text with a hint', () => {
  const r = compileQuery('/^iso-\\d+_rev[a-c]/')
  assert.equal(r.test('ISO-1001_RevB.pdf'.toLowerCase()), true)
  assert.equal(r.test('pump.pdf'), false)
  const rf = compileQuery('/^iso/ type:pdf')
  assert.equal(rf.test('iso-1.pdf'), true)
  assert.equal(rf.test('iso-1.dwg'), false)
  const bad = compileQuery('/iso(/')
  assert.equal(bad.hints.length, 1)
  assert.equal(bad.test('iso(.pdf'), true)
})

test('extOfName matches extname()', () => {
  assert.deepEqual(['a.PDF', '.bashrc', 'a.', 'a..b', 'noext', 'x.tar.gz'].map(extOfName), ['pdf', '', '', 'b', '', 'gz'])
})

test('folderKey: case, trailing slash, mapped drive = UNC, non-folders', () => {
  const drives = [{ root: 'U:\\', remote: '\\\\server\\share' }, { root: 'D:\\' }]
  assert.equal(folderKey('U:\\Projects\\Lot 07', drives), '\\\\server\\share\\projects\\lot 07')
  assert.equal(folderKey('\\\\SERVER\\Share\\Projects\\Lot 07\\', drives), '\\\\server\\share\\projects\\lot 07')
  assert.equal(folderKey('u:/projects/lot 07/', drives), '\\\\server\\share\\projects\\lot 07')
  assert.equal(folderKey('U:\\', drives), '\\\\server\\share')
  assert.equal(folderKey('D:\\Work', drives), 'd:\\work')
  assert.equal(folderKey('d:\\WORK\\', drives), 'd:\\work')
  assert.equal(folderKey('D:\\', drives), 'd:')
  assert.equal(folderKey('hopper:home', drives), null)
  assert.equal(folderKey('hopper:search?q=x', drives), null)
  assert.equal(folderKey('D:\\a.zip::inner', drives), null)
  assert.equal(folderKey('', drives), null)
})

test('rememberView: least recently used folders go first beyond the limit', () => {
  const v = { view: 'grid', sort: { key: 'name', dir: 1 }, groupBy: 'type' }
  let mem = {}
  for (let i = 0; i < 5; i++) mem = rememberView(mem, `d:\\f${i}`, v, i, 3)
  assert.deepEqual(Object.keys(mem).sort(), ['d:\\f2', 'd:\\f3', 'd:\\f4'])
  // touching f2 keeps it; f3 is now the oldest
  mem = rememberView(mem, 'd:\\f2', v, 10, 3)
  mem = rememberView(mem, 'd:\\f5', { ...v, revisions: true }, 11, 3)
  assert.deepEqual(Object.keys(mem).sort(), ['d:\\f2', 'd:\\f4', 'd:\\f5'])
  assert.equal(mem['d:\\f5'].revisions, true)
  assert.equal('revisions' in mem['d:\\f2'], false)
  // the input is not changed
  const before = { a: { ...v, at: 1 } }
  rememberView(before, 'b', v, 2, 1)
  assert.deepEqual(Object.keys(before), ['a'])
})
