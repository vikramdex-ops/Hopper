// "Who has it open" and shared status labels: lock-file parsing (src/shared/locks.ts), the label
// store's merge and keys (src/shared/labels.ts), the label: filter and group by label
// (src/shared/listing.ts), and the LAN message validation and holder aggregation (src/shared/unlock.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isLockFile, lockTarget, matchLocks, parseOfficeOwner, parseDwl, parseDwl2, parseLibreLock, parseLock, lockSummary } from '../../src/shared/locks.ts'
import { cleanLabelDefs, DEFAULT_LABELS, findLabel, shardOf, cleanShard, mergeShards, prune, applyPatch, movedItems, isLive, TOMBSTONE_MS } from '../../src/shared/labels.ts'
import { folderKey, parseFilters, passesFilters, compileQuery, groupItems, parseLabelFilter, NO_LABEL } from '../../src/shared/listing.ts'
import {
  cleanPath, cleanPaths, cleanQuery, cleanReply, cleanClose, cleanNotify, cleanForce, cleanStatus, serverLocalPath, serverUncPath,
  aggregateHolders, holderWho, isBusyError, opPaths, within, MAX_PATHS
} from '../../src/shared/unlock.ts'

// ---------------------------------------------------------------------------
// lock files

/** An Office owner file: length byte + ANSI name, padding, then a 16-bit length + UTF-16 name at `at`. */
function ownerFile(name, at, size, pad = 0x20) {
  const b = Buffer.alloc(size, pad)
  const ansi = Buffer.from(name, 'latin1')
  b[0] = ansi.length
  ansi.copy(b, 1)
  b.writeUInt16LE(name.length, at)
  Buffer.from(name, 'utf16le').copy(b, at + 2)
  return b
}

test('lock file names', () => {
  for (const n of ['~$port.docx', '~$Budget.xlsx', 'P-101.dwl', 'P-101.DWL2', '.~lock.report.odt#']) assert.equal(isLockFile(n), true, n)
  for (const n of ['report.docx', '~$', 'a.dwg', '.~lock.x', 'dwl', 'plan.dwl.bak']) assert.equal(isLockFile(n), false, n)
})

test('lockTarget: Office keeps short names and drops one or two characters of long Word names', () => {
  const files = ['Document1.docx', 'abc.docx', 'Budget 2026.xlsx', 'P-101.dwg', 'report.odt']
  assert.equal(lockTarget('~$abc.docx', files), 'abc.docx')
  assert.equal(lockTarget('~$Budget 2026.xlsx', files), 'Budget 2026.xlsx')
  assert.equal(lockTarget('~$cument1.docx', files), 'Document1.docx')
  assert.equal(lockTarget('P-101.dwl', files), 'P-101.dwg')
  assert.equal(lockTarget('p-101.dwl2', files), 'P-101.dwg')
  assert.equal(lockTarget('.~lock.report.odt#', files), 'report.odt')
  assert.equal(lockTarget('~$missing.docx', files), null)
  // two files could own "~$port.docx": never guessed
  assert.equal(lockTarget('~$port.docx', ['Report.docx', 'xport.docx', 'eport.docx']), null)
  assert.equal(lockTarget('~$port.docx', ['Report.docx', 'Other.docx']), 'Report.docx')
})

test('matchLocks maps each owner file to its lock files', () => {
  const m = matchLocks(['A.dwg', 'A.dwl', 'A.dwl2', 'b.xlsx', '~$b.xlsx', 'c.pdf'])
  assert.deepEqual(m.get('a.dwg'), ['A.dwl', 'A.dwl2'])
  assert.deepEqual(m.get('b.xlsx'), ['~$b.xlsx'])
  assert.equal(m.has('c.pdf'), false)
  assert.equal(matchLocks(['x.pdf']).size, 0)
})

test('Office owner file: Word (UTF-16 at 54) and Excel (UTF-16 at 55) layouts', () => {
  assert.equal(parseOfficeOwner(ownerFile('Asha Rao', 54, 162, 0)), 'Asha Rao')
  assert.equal(parseOfficeOwner(ownerFile('Ravi Kumar', 55, 165, 0x20)), 'Ravi Kumar')
  // a name the ANSI copy cannot hold comes from the UTF-16 copy
  assert.equal(parseOfficeOwner(ownerFile('Zoë Ünal', 54, 162, 0)), 'Zoë Ünal')
  // only the ANSI copy
  const ansi = Buffer.alloc(54, 0)
  ansi[0] = 4
  Buffer.from('Mina').copy(ansi, 1)
  assert.equal(parseOfficeOwner(ansi), 'Mina')
  // garbage is "unknown", never a made-up name
  assert.equal(parseOfficeOwner(Buffer.from([0xff, 0, 1, 2])), null)
  assert.equal(parseOfficeOwner(Buffer.alloc(0)), null)
  assert.deepEqual(parseLock('~$abc.docx', ownerFile('Asha Rao', 54, 162, 0)), { kind: 'office', lock: '~$abc.docx', name: 'Asha Rao' })
  assert.deepEqual(parseLock('~$abc.docx', Buffer.alloc(10, 0xff)), { kind: 'office', lock: '~$abc.docx' })
})

test('AutoCAD .dwl / .dwl2 and LibreOffice lock contents', () => {
  assert.deepEqual(parseDwl('asha\r\nPC-07\r\n19/11/2026 10:02\r\n'), { user: 'asha', pc: 'PC-07', since: '19/11/2026 10:02' })
  const xml = '<?xml version="1.0" encoding="UTF-8"?><whoHasIt><username>Asha Rao</username><machinename>PC-07</machinename><loginname>asha</loginname></whoHasIt>'
  assert.deepEqual(parseDwl2(xml), { name: 'Asha Rao', user: 'asha', pc: 'PC-07', since: undefined })
  assert.deepEqual(parseLibreLock('Rao\\, Asha,asha,PC-07,19.11.2026 10:02,file:///C:/Users/asha/AppData/Roaming/LibreOffice/4;'), { name: 'Rao, Asha', user: 'asha', pc: 'PC-07', since: '19.11.2026 10:02' })
  const dwl = parseLock('A.dwl', Buffer.from('asha\r\nPC-07\r\n'))
  assert.deepEqual(dwl, { kind: 'autocad', lock: 'A.dwl', user: 'asha', pc: 'PC-07' })
  assert.equal(lockSummary([dwl]), 'Open by asha on PC-07')
  assert.equal(lockSummary([{ kind: 'office', lock: '~$a.docx' }]), 'Open (lock file present, owner not recorded)')
  assert.equal(lockSummary([{ kind: 'office', lock: '~$a.docx', name: 'Asha Rao' }, { kind: 'office', lock: '~$a.docx', name: 'Asha Rao' }]), 'Open by Asha Rao')
})

// ---------------------------------------------------------------------------
// labels

test('label definitions: validated, defaults when missing, found by id or name', () => {
  assert.equal(cleanLabelDefs(undefined), DEFAULT_LABELS)
  assert.deepEqual(cleanLabelDefs([{ id: 'ok', name: ' OK ', color: '#00FF00' }, { id: 'bad id', name: 'x', color: '#000000' }, { id: 'ok', name: 'dup', color: '#000000' }, { id: 'c', name: 'C', color: 'red' }]), [{ id: 'ok', name: 'OK', color: '#00ff00' }])
  assert.equal(cleanLabelDefs([]), DEFAULT_LABELS)
  assert.equal(findLabel(DEFAULT_LABELS, 'checked')?.id, 'checked')
  assert.equal(findLabel(DEFAULT_LABELS, 'Sent to client')?.id, 'sent')
  assert.equal(findLabel(DEFAULT_LABELS, 'sent-to-client')?.id, 'sent')
  assert.equal(findLabel(DEFAULT_LABELS, 'nope'), null)
})

test('label keys: mapped drive = UNC, any case; one shard per server share', () => {
  const drives = [{ root: 'P:\\', remote: '\\\\FS01\\Projects' }]
  const a = folderKey('P:\\Job 12\\Iso.pdf', drives)
  const b = folderKey('\\\\fs01\\projects\\JOB 12\\iso.PDF', drives)
  assert.equal(a, b)
  assert.equal(a, '\\\\fs01\\projects\\job 12\\iso.pdf')
  assert.equal(shardOf(a), 'fs01-projects')
  assert.equal(shardOf(folderKey('D:\\Work\\x.pdf')), 'local-d')
  assert.equal(shardOf('\\\\srv\\a$ b\\x'), 'srv-a_b')
})

test('label shards: malformed items dropped, newest writer per item wins, tombstones expire', () => {
  const s = cleanShard({ items: { 'D:\\A': { label: 'checked', by: 'asha', at: 10 }, 'd:\\b': { label: 'Bad Label', by: 'x', at: 5 }, 'd:\\c': { by: 'x' }, 'd:\\n': { note: 'x'.repeat(900), by: 'r', at: 3 } } })
  assert.deepEqual(Object.keys(s.items).sort(), ['d:\\a', 'd:\\b', 'd:\\n'])
  assert.equal(s.items['d:\\b'].label, undefined)
  assert.equal(s.items['d:\\n'].note.length, 500)
  assert.deepEqual(cleanShard('nonsense'), { v: 1, items: {} })

  const mine = { v: 1, items: { 'k1': { label: 'hold', by: 'asha', at: 200 }, 'k2': { label: 'final', by: 'asha', at: 100 } } }
  const disk = { v: 1, items: { 'k1': { label: 'sent', by: 'ravi', at: 150 }, 'k2': { label: 'revise', by: 'ravi', at: 300 }, 'k3': { note: 'n', by: 'ravi', at: 50 } } }
  const m = mergeShards(disk, mine)
  assert.equal(m.items.k1.label, 'hold')
  assert.equal(m.items.k2.label, 'revise')
  assert.equal(m.items.k3.note, 'n')
  // a tie keeps the copy already on disk
  assert.equal(mergeShards({ v: 1, items: { k: { label: 'a', by: 'x', at: 1 } } }, { v: 1, items: { k: { label: 'b', by: 'y', at: 1 } } }).items.k.label, 'a')

  const cleared = applyPatch(m.items.k1, { label: null }, 'asha', 'Asha', 400)
  assert.deepEqual(cleared, { label: '', note: '', by: 'asha', byName: 'Asha', at: 400 })
  assert.equal(isLive(cleared), false)
  const now = 400 + TOMBSTONE_MS + 1
  const pr = prune({ v: 1, items: { gone: cleared, fresh: { ...cleared, at: now - 1000 }, live: m.items.k2 } }, now)
  assert.deepEqual(Object.keys(pr.items).sort(), ['fresh', 'live'])
  // a note keeps the label, and the other way round
  const both = applyPatch({ label: 'checked', by: 'a', at: 1 }, { note: '  see markup  ' }, 'b', '', 2)
  assert.deepEqual(both, { label: 'checked', note: 'see markup', by: 'b', at: 2 })
})

test('labels follow a rename or move, including everything inside a folder', () => {
  const items = {
    '\\\\fs\\p\\job\\a.pdf': { label: 'checked', by: 'a', at: 1 },
    '\\\\fs\\p\\job\\sub\\b.pdf': { note: 'x', by: 'a', at: 1 },
    '\\\\fs\\p\\job2\\c.pdf': { label: 'hold', by: 'a', at: 1 },
    '\\\\fs\\p\\job\\gone.pdf': { label: '', note: '', by: 'a', at: 1 }
  }
  const { put, clear } = movedItems(items, '\\\\fs\\p\\job', '\\\\fs\\p\\archive\\job', 9)
  assert.deepEqual(Object.keys(put).sort(), ['\\\\fs\\p\\archive\\job\\a.pdf', '\\\\fs\\p\\archive\\job\\sub\\b.pdf'])
  assert.equal(put['\\\\fs\\p\\archive\\job\\a.pdf'].at, 9)
  assert.deepEqual(clear.sort(), ['\\\\fs\\p\\job\\a.pdf', '\\\\fs\\p\\job\\sub\\b.pdf'])
  assert.deepEqual(movedItems(items, 'x', 'x', 1), { put: {}, clear: [] })
})

test('label: filter and group by label', () => {
  const labels = DEFAULT_LABELS
  assert.deepEqual(parseLabelFilter('checked', labels), ['checked'])
  assert.deepEqual(parseLabelFilter('sent-to-client,none', labels), ['sent', ''])
  assert.deepEqual(parseLabelFilter('any', labels), ['*'])
  assert.equal(parseLabelFilter('nope', labels), null)
  const p = parseFilters('iso label:checked', { labels })
  assert.equal(p.text, 'iso')
  assert.deepEqual(p.filters.labels, ['checked'])
  assert.deepEqual(parseFilters('label:any label:hold', { labels }).filters.labels, ['hold'])
  assert.equal(parseFilters('label:hold label:final', { labels }).filters.never, true)
  assert.match(parseFilters('label:nope', { labels }).hints[0], /not understood/)
  const e = (label) => ({ dir: false, size: 1, mtime: 1, label })
  assert.equal(passesFilters(e('checked'), p.filters), true)
  assert.equal(passesFilters(e('hold'), p.filters), false)
  assert.equal(passesFilters(e(undefined), parseFilters('label:none').filters), true)
  assert.equal(passesFilters(e('hold'), parseFilters('label:none').filters), false)
  assert.equal(passesFilters(e('hold'), parseFilters('label:any').filters), true)
  const q = compileQuery('label:checked', { labels })
  assert.equal(q.filtered, true)
  assert.equal(q.test('anything.pdf'), true)

  const items = [{ name: 'a', dir: false, ext: '', size: 1, mtime: 1, label: 'final' }, { name: 'b', dir: false, ext: '', size: 1, mtime: 1 }, { name: 'c', dir: false, ext: '', size: 1, mtime: 1, label: 'checked' }, { name: 'd', dir: false, ext: '', size: 1, mtime: 1, label: 'old-one' }]
  const g = groupItems(items, 'label', { labels })
  assert.deepEqual(g.map((x) => x.label), ['Checked', 'Final', 'old-one', NO_LABEL])
  assert.deepEqual(g.map((x) => x.items.map((i) => i.name).join('')), ['c', 'a', 'd', 'b'])
})

// ---------------------------------------------------------------------------
// LAN messages

test('paths on the wire: absolute drive or UNC, nothing else', () => {
  assert.equal(cleanPath('\\\\fs01\\Projects\\a.pdf'), '\\\\fs01\\Projects\\a.pdf')
  assert.equal(cleanPath('D:\\x\\y.dwg'), 'D:\\x\\y.dwg')
  for (const bad of ['a.pdf', '..\\x', 'D:\\x\\..\\y', 'D:\\a*.pdf', '\\\\fs01', 'D:\\x\u0000', 42, '', 'D:\\' + 'x'.repeat(1100), 'file:///D:/x']) assert.equal(cleanPath(bad), null, String(bad).slice(0, 30))
  assert.equal(cleanPaths([]), null)
  assert.equal(cleanPaths(['D:\\a', 'b']), null)
  assert.equal(cleanPaths(Array(MAX_PATHS + 1).fill('D:\\a')), null)
  assert.deepEqual(cleanPaths(['D:\\a']), ['D:\\a'])
})

test('holders query, reply and close/notify/force/status frames are validated', () => {
  assert.deepEqual(cleanQuery({ t: 'holders', id: 'u12345678', paths: ['\\\\fs\\p\\a.pdf'] }), { id: 'u12345678', paths: ['\\\\fs\\p\\a.pdf'] })
  assert.equal(cleanQuery({ t: 'holders', id: 'x', paths: ['\\\\fs\\p\\a.pdf'] }), null)
  assert.equal(cleanQuery({ t: 'holders', id: 'u12345678', paths: ['relative'] }), null)
  assert.equal(cleanQuery({ t: 'close', id: 'u12345678', paths: ['D:\\a'] }), null)

  const r = cleanReply({ t: 'holders', holders: [
    { id: 'p:app:1', kind: 'app', path: '\\\\fs\\p\\a.pdf', app: 'Acrobat\u0007', pid: 42, start: '1339', user: 'asha', status: 'open' },
    { id: 'x', kind: 'evil', path: 'D:\\a' },
    { id: 'y', kind: 'app', path: 'nope' },
    { id: 's', kind: 'smb', path: '\\\\fs\\p\\a.pdf', fileId: 7, locks: 1, start: '12x', pid: -1 }
  ], recent: ['\\\\fs\\p\\a.pdf', 'bad'], server: { ok: false, error: 'needs-admin' } })
  assert.equal(r.holders.length, 2)
  assert.equal(r.holders[0].app, 'Acrobat')
  assert.equal(r.holders[1].start, undefined)
  assert.equal(r.holders[1].pid, undefined)
  assert.deepEqual(r.recent, ['\\\\fs\\p\\a.pdf'])
  assert.deepEqual(r.server, { agent: true, ok: false, error: 'needs-admin' })
  assert.equal(cleanReply({ t: 'holders', holders: Array(501).fill({}) }), null)

  assert.deepEqual(cleanClose({ t: 'close', id: 'u12345678', path: 'D:\\a.docx', kind: 'app', pid: 9, start: '123', app: 'Word', byName: 'Ravi' }), { id: 'u12345678', path: 'D:\\a.docx', pid: 9, start: '123', app: 'Word', kind: 'app', byName: 'Ravi' })
  assert.equal(cleanClose({ t: 'close', id: 'u12345678', path: 'D:\\a.docx', kind: 'app', pid: 9 }), null) // no start time: could hit a reused process id
  assert.equal(cleanClose({ t: 'close', id: 'u12345678', path: 'D:\\a.docx', kind: 'kill', pid: 9, start: '1' }), null)
  assert.deepEqual(cleanClose({ t: 'close', id: 'u12345678', path: 'D:\\dir', kind: 'explorer' }).kind, 'explorer')
  assert.equal(cleanNotify({ t: 'notify', id: 'u12345678', path: 'D:\\a', reason: 'whatever' }), null)
  assert.equal(cleanNotify({ t: 'notify', id: 'u12345678', path: 'D:\\a', reason: 'forced' }).reason, 'forced')
  assert.deepEqual(cleanForce({ t: 'force', id: 'u12345678', fileId: 12, path: '\\\\fs\\p\\a' }), { id: 'u12345678', fileId: 12, path: '\\\\fs\\p\\a' })
  for (const fileId of [-1, 1.5, '3', 2 ** 32]) assert.equal(cleanForce({ t: 'force', id: 'u12345678', fileId, path: '\\\\fs\\p\\a' }), null)
  assert.deepEqual(cleanStatus({ t: 'unlock-status', id: 'u12345678', holder: 'h1', status: 'closed' }), { id: 'u12345678', holder: 'h1', status: 'closed' })
  assert.equal(cleanStatus({ t: 'unlock-status', id: 'u12345678', holder: 'h1', status: 'nuked' }), null)
})

test('server agent: a UNC path maps to this server\'s share, and back', () => {
  const shares = [{ name: 'Projects', path: 'E:\\Data\\Projects' }, { name: 'Free', path: 'E:\\Free\\' }]
  const names = ['fs01', '192.168.1.10', 'localhost']
  assert.equal(serverLocalPath('\\\\FS01\\projects\\Job 1\\a.pdf', names, shares), 'E:\\Data\\Projects\\Job 1\\a.pdf')
  assert.equal(serverLocalPath('\\\\192.168.1.10\\Free', names, shares), 'E:\\Free')
  assert.equal(serverLocalPath('\\\\other\\Projects\\a.pdf', names, shares), null)
  assert.equal(serverLocalPath('\\\\fs01\\Nope\\a.pdf', names, shares), null)
  assert.equal(serverLocalPath('D:\\x', names, shares), null)
  assert.equal(serverUncPath('E:\\Data\\Projects\\Job 1\\a.pdf', 'fs01', shares), '\\\\fs01\\Projects\\Job 1\\a.pdf')
  assert.equal(serverUncPath('C:\\Windows\\x', 'fs01', shares), null)
  assert.equal(within('\\\\fs\\p\\a\\b', '\\\\FS\\p\\A\\'), true)
  assert.equal(within('\\\\fs\\p\\ab', '\\\\fs\\p\\a'), false)
})

test('holders from every PC become one list; the server row folds into the person\'s own row', () => {
  const app = { id: 'p1:app:1', kind: 'app', path: '\\\\fs\\p\\a.pdf', user: 'asha', person: 'Asha', pc: 'PC-07', peer: 'p1', app: 'Acrobat', pid: 5, start: '9', status: 'open' }
  const list = aggregateHolders([
    { id: 'h:hopper', kind: 'hopper', path: '\\\\fs\\p\\a.pdf', status: 'released' },
    { id: 'srv:smb:1', kind: 'smb', path: '\\\\FS\\p\\A.pdf', user: 'DOMAIN\\Asha', fileId: 77, peer: 'srv', status: 'open' },
    { id: 'srv:smb:2', kind: 'smb', path: '\\\\fs\\p\\a.pdf', user: 'kiran', fileId: 78, peer: 'srv', status: 'open' },
    { id: 'srv:smb:3', kind: 'smb', path: '\\\\fs\\p\\a.pdf', fileId: 79, peer: 'srv', status: 'open' },
    app,
    { ...app } // the same answer twice
  ])
  assert.deepEqual(list.map((h) => h.id), ['p1:app:1', 'srv:smb:2', 'srv:smb:3', 'h:hopper'])
  assert.deepEqual(list[0].fileIds, [77])
  assert.equal(holderWho(list[0]), 'Asha on PC-07')
  assert.equal(holderWho(list[1]), 'kiran (computer not known)')
  assert.equal(holderWho(list[2]), 'Unknown — the server still has it open')
})

test('busy errors and the paths an operation needs', () => {
  assert.equal(isBusyError("EBUSY: resource busy or locked, rename 'a' -> 'b'"), true)
  assert.equal(isBusyError("EPERM: operation not permitted, unlink 'a'"), true)
  assert.equal(isBusyError('The process cannot access the file because it is being used by another process.'), true)
  assert.equal(isBusyError('ENOENT: no such file or directory'), false)
  assert.deepEqual(opPaths({ kind: 'rename', from: 'D:\\a', to: 'D:\\b' }), ['D:\\a'])
  assert.deepEqual(opPaths({ kind: 'transfer', op: 'copy', items: [{ src: 'D:\\x\\a.dwg', destDir: '\\\\fs\\p\\job\\' }] }), ['D:\\x\\a.dwg', '\\\\fs\\p\\job\\a.dwg'])
})

test('remote questions: only UNC paths on known hosts, never drives, localhost or admin shares', async () => {
  const { acceptRemotePath, uncHost, normIp } = await import('../../src/shared/unlock.ts')
  const hosts = ['fs01', '192.168.1.10', 'localhost', '127.0.0.1']
  const B = String.fromCharCode(92)
  const unc = (...parts) => B + B + parts.join(B)
  assert.equal(acceptRemotePath(unc('FS01', 'Projects', 'a.pdf'), hosts), unc('FS01', 'Projects', 'a.pdf'))
  assert.equal(acceptRemotePath(unc('192.168.1.10', 'Free', 'x'), hosts), unc('192.168.1.10', 'Free', 'x'))
  for (const bad of ['D:' + B + 'a.pdf', unc('localhost', 'Projects', 'a'), unc('127.0.0.1', 'p', 'a'), unc('fs01', 'C$', 'a'), unc('fs01', 'ADMIN$'), unc('fs01', 'IPC$', 'x'), unc('evil', 'share', 'a'), unc('fs01', 'p', '..', 'a'), 42]) {
    assert.equal(acceptRemotePath(bad, hosts), null, String(bad))
  }
  assert.equal(uncHost(unc('FS01', 'p', 'a')), 'fs01')
  assert.equal(uncHost('D:' + B + 'x'), '')
  assert.equal(normIp('::ffff:192.168.1.5'), '192.168.1.5')
  assert.equal(normIp('[FE80::1]'), 'fe80::1')
})

test('force-close admin check uses the server\'s SMB sessions, not the claimed name', async () => {
  const { sessionAdmin } = await import('../../src/shared/unlock.ts')
  const admins = new Set(['boss'])
  const isAdmin = (u) => admins.has(u)
  const B = String.fromCharCode(92)
  const sessions = [{ client: B + B + '192.168.1.7', user: 'boss' }, { client: '192.168.1.8', user: 'OFFICE' + B + 'ravi' }, { client: '192.168.1.9', user: '' }]
  assert.deepEqual(sessionAdmin(sessions, '::ffff:192.168.1.7', isAdmin), { user: 'boss' })
  assert.deepEqual(sessionAdmin(sessions, '192.168.1.8', isAdmin), { error: 'not-admin' })
  assert.deepEqual(sessionAdmin(sessions, '192.168.1.9', isAdmin), { error: 'no-session' }) // anonymous session
  assert.deepEqual(sessionAdmin(sessions, '192.168.1.99', isAdmin), { error: 'no-session' })
  assert.deepEqual(sessionAdmin(sessions, '127.0.0.1', isAdmin), { error: 'no-session' })
  assert.deepEqual(sessionAdmin(sessions, '', isAdmin), { error: 'no-session' })
  // two sessions from one PC: the admin one counts
  assert.deepEqual(sessionAdmin([...sessions, { client: '192.168.1.8', user: 'Boss' }], '192.168.1.8', isAdmin), { user: 'boss' })
})

test('prompt cap: three open per person, six a minute', async () => {
  const { promptAllowed } = await import('../../src/shared/unlock.ts')
  const now = 1_000_000
  assert.equal(promptAllowed(0, [], now), true)
  assert.equal(promptAllowed(3, [], now), false)
  assert.equal(promptAllowed(1, Array(6).fill(now - 1000), now), false)
  assert.equal(promptAllowed(1, Array(6).fill(now - 61_000), now), true)
})

test('basepath is a prefix: within() is path-segment aware', () => {
  const B = String.fromCharCode(92)
  assert.equal(within('E:' + B + 'Share' + B + 'Job 10' + B + 'a.dwg', 'E:' + B + 'Share' + B + 'Job 1'), false)
  assert.equal(within('E:' + B + 'Share' + B + 'Job 1' + B + 'a.dwg', 'e:' + B + 'share' + B + 'job 1'), true)
  assert.equal(within('E:' + B + 'Share' + B + 'Job 1', 'E:' + B + 'Share' + B + 'Job 1' + B), true)
})
