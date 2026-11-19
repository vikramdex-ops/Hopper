// "Who has it open" across processes: the authenticated 'ask' role over a real loopback TLS-PSK
// connection (an old Hopper without it simply does not answer), the LAN process's holder lookup
// with a stubbed native helper, and the shared label store on disk (atomic writes, merge with
// another PC's write, labels following a move). The native helper itself is tested separately.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { load } from './preview-hooks.mjs'

const P = await load('lan/protocol.ts')
const { TransferServer } = await load('lan/transfer-server.ts')
const { sendAsk } = await load('lan/transfer-client.ts')
const { Unlock } = await load('lan/unlock.ts')
const { Labels } = await load('engine/labels.ts')

const KEY = P.officeKeyBytes('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff')
const tmp = mkdtempSync(join(tmpdir(), 'hopper-unlock-'))
test.after(() => rmSync(tmp, { recursive: true, force: true }))

function lanCtx(user) {
  return {
    emit: () => {}, attention: () => {}, log: () => {}, dataDir: tmp, sevenZip: '', version: '2.8.0', office: null, settings: null,
    key: KEY, officePath: '', me: { user, displayName: user, host: 'PC-TEST', domain: '', email: '', status: 'online' }, inboxRoot: () => join(tmp, 'inbox')
  }
}

test('ask role: one authenticated question, one answer; a server without it does not answer', async () => {
  const seen = []
  const srv = new TransferServer(lanCtx('asha'), async () => true, () => {}, () => true, async (identity, frame, from) => {
    seen.push({ identity, frame, from })
    return { t: 'holders', holders: [], recent: [] }
  })
  const port = await srv.listen()
  assert.ok(port)
  const peer = { id: 'p', user: 'asha', displayName: 'Asha', host: 'PC', address: '127.0.0.1', port, version: '2.8.0', status: 'online', lastSeen: Date.now() }
  const r = await sendAsk(lanCtx('ravi'), peer, { t: 'holders', id: 'u12345678', paths: ['\\\\fs\\p\\a.pdf'] }, new AbortController().signal)
  assert.deepEqual(r, { t: 'holders', holders: [], recent: [] })
  assert.equal(seen[0].identity, 'ravi')
  assert.equal(seen[0].from.host, 'PC-TEST')
  assert.equal(seen[0].from.address, '127.0.0.1', 'the address comes from the socket')
  await srv.close()

  // an older Hopper (no 'ask' handler) closes the connection: the question just goes unanswered
  const old = new TransferServer(lanCtx('asha'), async () => true, () => {}, () => true)
  const port2 = await old.listen()
  await assert.rejects(sendAsk(lanCtx('ravi'), { ...peer, port: port2 }, { t: 'holders', id: 'u12345678', paths: ['D:\\a'] }, new AbortController().signal, 3000))
  await old.close()

  // the wrong office key never gets in
  const srv3 = new TransferServer(lanCtx('asha'), async () => true, () => {}, () => true, async () => ({ t: 'holders' }))
  const port3 = await srv3.listen()
  const intruder = { ...lanCtx('mallory'), key: P.officeKeyBytes('ff'.repeat(32)) }
  await assert.rejects(sendAsk(intruder, { ...peer, port: port3 }, { t: 'holders', id: 'u12345678', paths: ['D:\\a'] }, new AbortController().signal, 3000))
  await srv3.close()
})

function stubShell(answers) {
  const calls = []
  return {
    calls,
    call: async (cmd, args) => {
      calls.push({ cmd, args })
      const a = answers[cmd]
      if (a instanceof Error) throw a
      return typeof a === 'function' ? a(args) : a
    }
  }
}

const discovery = { id: 'me1', find: () => undefined, nameFor: (u) => u, online: () => [] }

const SERVER = hostname()
const ADMIN_IP = '192.168.50.7'
/** office set up by "boss": the account the server must see connected before a force close */
const office = { setup: { user: 'boss', pc: 'srv', at: 1 } }

test('a PC answers with its programs, Explorer windows, its own handles (released) and the server view', async () => {
  const dir = join(tmp, 'share', 'Job 1')
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(tmp, 'share', 'Job 10'), { recursive: true })
  const file = join(dir, 'a.dwg')
  writeFileSync(file, 'x')
  const shell = stubShell({
    drives: [],
    rmHolders: ({ paths }) => [
      { path: paths[0], pid: 11, start: '100', app: 'AutoCAD', exe: 'C:\\Program Files\\Autodesk\\acad.exe', user: 'DOM\\asha', type: 'window', session: 1 },
      { path: paths[0], pid: 12, start: '101', app: 'Hopper', exe: process.execPath, user: 'DOM\\asha', type: 'window', session: 1 }
    ],
    explorerWindows: [{ path: dir }],
    shares: [{ name: 'Share', path: join(tmp, 'share') }],
    smbOpenFiles: () => ({ ok: true, files: [{ id: 5, path: file, user: 'DOM\\kiran', locks: 2 }, { id: 6, path: join(tmp, 'share', 'Job 10', 'b.dwg'), user: 'DOM\\kiran', locks: 0 }] }),
    smbSessions: { ok: true, sessions: [{ client: `\\\\${ADMIN_IP}`, user: 'boss' }, { client: '192.168.50.8', user: 'ravi' }] }
  })
  const events = []
  const ctx = { ...lanCtx('asha'), office, emit: (e, d) => events.push([e, d]), settings: { recentFiles: [file.toUpperCase()] } }
  const u = new Unlock(ctx, discovery, shell)
  const r = await u.localHolders([dir])
  assert.deepEqual(r.holders.map((h) => h.kind).sort(), ['app', 'explorer', 'hopper'])
  const app = r.holders.find((h) => h.kind === 'app')
  assert.equal(app.user, 'asha')
  assert.equal(app.pid, 11)
  assert.equal(r.holders.find((h) => h.kind === 'hopper').status, 'released')
  assert.ok(events.some(([e]) => e === 'unlock-release'), 'Hopper lets go of its own handles')
  assert.equal(r.server, undefined, 'a local path is not served by this PC')

  // the same folder by its UNC path on this PC: the server agent answers too
  const unc = `\\\\${SERVER}\\Share\\Job 1`
  const q = { t: 'holders', id: 'u12345678', paths: [unc] }
  const asNobody = await u.onAsk('ravi', q, { fromName: 'Ravi', host: 'PC-2', address: '192.168.50.8' })
  assert.deepEqual(asNobody.server, { agent: true, ok: true })
  const smb = asNobody.holders.filter((h) => h.kind === 'smb')
  // NetFileEnum's prefix match also returns "Job 10": only what is inside "Job 1" is kept
  assert.deepEqual(smb.map((h) => h.path.toLowerCase()), [`${unc}\\a.dwg`.toLowerCase()])
  assert.equal(smb[0].user, 'kiran')
  assert.equal(smb[0].fileId, undefined, 'no open-file ids for someone the server does not know as an admin')
  const asAdmin = await u.onAsk('ravi', q, { fromName: 'Ravi', host: 'PC-2', address: `::ffff:${ADMIN_IP}` })
  assert.equal(asAdmin.holders.find((h) => h.kind === 'smb').fileId, 5, 'an admin connected from that address gets the ids')

  for (const bad of ['D:\\Work\\a.dwg', '\\\\localhost\\Share\\a.dwg', `\\\\${SERVER}\\C$\\a.dwg`, '\\\\attacker-host\\x\\a.dwg']) {
    const before = shell.calls.length
    const a = await u.onAsk('ravi', { t: 'holders', id: 'u12345678', paths: [bad] }, { fromName: '', host: '', address: '192.168.50.8' })
    assert.deepEqual(a, { t: 'holders', holders: [], recent: [] }, bad)
    assert.ok(!shell.calls.slice(before).some((c) => c.cmd === 'rmHolders' || c.cmd === 'explorerWindows' || c.cmd === 'smbOpenFiles'), `nothing looked at ${bad}`)
  }
  assert.deepEqual(await u.onAsk('ravi', { t: 'holders', id: 'bad', paths: ['x'] }, { fromName: '', host: '' }), { t: 'err', code: 'bad-request' })
  assert.deepEqual(await u.onAsk('ravi', { t: 'rm -rf' }, { fromName: '', host: '' }), { t: 'err', code: 'unknown-request' })
})

test('force close: only an admin the server sees connected from the asking PC; logged with that account', async () => {
  const dir = join(tmp, 'share', 'Job 1')
  const file = join(dir, 'a.dwg')
  const answers = {
    drives: [],
    shares: [{ name: 'Share', path: join(tmp, 'share') }],
    smbOpenFiles: () => ({ ok: true, files: [{ id: 5, path: file, user: 'DOM\\kiran', locks: 2 }, { id: 6, path: join(tmp, 'share', 'Job 10', 'b.dwg'), user: 'x', locks: 0 }] }),
    smbSessions: { ok: true, sessions: [{ client: ADMIN_IP, user: 'DOM\\boss' }, { client: '192.168.50.8', user: 'ravi' }] },
    smbCloseFile: { ok: true },
    auditLog: { ok: true }
  }
  const shell = stubShell(answers)
  const u = new Unlock({ ...lanCtx('srv'), office }, discovery, shell)
  const unc = `\\\\${SERVER}\\Share\\Job 1\\a.dwg`
  const force = (fileId = 5) => ({ t: 'force', id: 'u12345678', fileId, path: unc })
  // claims to be the admin, but the server sees "ravi" connected from that address
  assert.deepEqual(await u.onAsk('boss', force(), { fromName: 'Boss', host: 'PC-2', address: '192.168.50.8' }), { t: 'err', code: 'not-admin' })
  // no SMB session from that address at all
  assert.deepEqual(await u.onAsk('boss', force(), { fromName: 'Boss', host: 'PC-9', address: '192.168.50.99' }), { t: 'err', code: 'no-session' })
  assert.deepEqual(await u.onAsk('boss', force(), { fromName: 'Boss', host: 'PC-9', address: '127.0.0.1' }), { t: 'err', code: 'no-session' })
  assert.deepEqual(await u.onAsk('boss', force(-5), { fromName: 'Boss', host: 'PC-2', address: ADMIN_IP }), { t: 'err', code: 'bad-request' })
  // an id that is open under "Job 10", not inside the requested path
  assert.deepEqual(await u.onAsk('boss', { ...force(6) }, { fromName: 'Boss', host: 'PC-2', address: ADMIN_IP }), { t: 'err', code: 'not-open' })
  assert.ok(!shell.calls.some((c) => c.cmd === 'smbCloseFile'), 'nothing was closed so far')
  // the real admin, from the PC the server sees them on
  const ok = await u.onAsk('mallory-says-boss', force(), { fromName: 'x', host: 'PC-1', address: ADMIN_IP })
  assert.equal(ok.t, 'forced')
  assert.equal(ok.by, 'boss')
  const log = JSON.parse(shell.calls.find((c) => c.cmd === 'auditLog').args.line)
  assert.equal(log.by, 'boss')
  assert.equal(log.claimed, 'mallory-says-boss')
  assert.equal(log.from, ADMIN_IP)
  assert.equal(log.user, 'kiran')
  // without a session list (no admin rights, no agent): refused, never guessed
  const u2 = new Unlock({ ...lanCtx('srv'), office }, discovery, stubShell({ ...answers, smbSessions: { ok: false, error: 'needs-admin' } }))
  assert.deepEqual(await u2.onAsk('boss', force(), { fromName: 'Boss', host: 'PC-1', address: ADMIN_IP }), { t: 'err', code: 'needs-admin' })
})

test('close prompts: path allow-list, real program name, a cap per person; status only from the PC asked', async () => {
  const shell = stubShell({
    drives: [{ root: 'P:\\', remote: '\\\\fs01\\projects' }],
    rmHolders: () => [{ path: '\\\\fs01\\projects\\a.docx', pid: 9, start: '1', app: 'Microsoft Word', exe: 'C:\\Office\\WINWORD.EXE', type: 'window', session: 1 }],
    shares: []
  })
  const events = []
  const disc = { ...discovery, find: (u) => (u === 'ravi' ? { user: 'ravi', displayName: 'Ravi (real)', host: 'PC-2', address: '192.168.50.8' } : undefined) }
  const u = new Unlock({ ...lanCtx('asha'), emit: (e, d) => events.push([e, d]) }, disc, shell)
  const close = (path, pid = 9) => ({ t: 'close', id: 'u12345678', holder: 'h1', path, kind: 'app', pid, start: '1', app: 'Totally Safe App', byName: 'Your Boss' })
  const from = { fromName: 'Your Boss', host: 'PC-2', address: '192.168.50.8' }
  assert.deepEqual(await u.onAsk('ravi', close('D:\\a.docx'), from), { t: 'err', code: 'path-not-allowed' })
  assert.deepEqual(await u.onAsk('ravi', close('\\\\evil\\x\\a.docx'), from), { t: 'err', code: 'path-not-allowed' })
  // not (or no longer) held by that process: no prompt
  assert.deepEqual(await u.onAsk('ravi', close('\\\\fs01\\projects\\a.docx', 10), from), { t: 'err', code: 'not-open' })
  assert.deepEqual(await u.onAsk('ravi', close('\\\\fs01\\projects\\a.docx'), from), { t: 'ok' })
  const shown = events.find(([e]) => e === 'unlock-prompt')[1]
  assert.equal(shown.app, 'Microsoft Word', 'the program name comes from this PC')
  assert.equal(shown.fromName, 'Ravi (real)', 'the requester is named by discovery, not by the request')
  assert.ok(!shell.calls.some((c) => c.cmd === 'rmShutdown'), 'nothing closes until the user answers')
  // at most three open prompts from one person
  for (const n of ['b', 'c']) assert.deepEqual(await u.onAsk('ravi', close(`\\\\fs01\\projects\\${n}.docx`), from), { t: 'ok' })
  assert.deepEqual(await u.onAsk('ravi', close('\\\\fs01\\projects\\d.docx'), from), { t: 'err', code: 'too-many' })
  const later = await u.answer(u.pending()[0].promptId, 'later')
  assert.equal(later.status, 'declined')
  assert.ok(!shell.calls.some((c) => c.cmd === 'rmShutdown'), '"Not now" closes nothing')
  // "closed on the file server" only from the file server
  assert.deepEqual(await u.onAsk('ravi', { t: 'notify', id: 'u12345678', path: '\\\\fs01\\projects\\a.docx', reason: 'forced', byName: 'x' }, from), { t: 'err', code: 'not-server' })
  // a status nobody asked for is refused; the asked person's is accepted
  assert.equal(u.onStatus('ravi', { t: 'unlock-status', id: 'u12345678', holder: 'h1', status: 'closed' }), 'unexpected-status')
  u.asked.set('u12345678|h1', { user: 'kiran', at: Date.now() })
  assert.equal(u.onStatus('ravi', { t: 'unlock-status', id: 'u12345678', holder: 'h1', status: 'closed' }), 'unexpected-status')
  assert.equal(u.onStatus('kiran', { t: 'unlock-status', id: 'u12345678', holder: 'h1', status: 'closed' }), true)
  assert.equal(u.onStatus('kiran', { t: 'unlock-status', id: 'u12345678', holder: 'h1', status: 'closed' }), 'unexpected-status', 'only once')
})

test('label store: atomic writes, merge with another PC, labels follow a move', async () => {
  const office = join(tmp, 'office')
  mkdirSync(office, { recursive: true })
  const emitted = []
  const ctx = { officePath: join(office, 'office.json'), dataDir: tmp, settings: { profile: { displayName: 'Asha' } }, shell: { call: async () => [{ root: 'P:\\', remote: '\\\\fs01\\projects' }] }, emit: (e, d) => emitted.push([e, d]) }
  const labels = new Labels(ctx)
  await labels.set(['P:\\Job\\a.pdf', '\\\\FS01\\Projects\\Job\\b.pdf'], { label: 'checked' })
  const file = join(office, 'labels', 'fs01-projects.json')
  const disk = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(Object.keys(disk.items).sort(), ['\\\\fs01\\projects\\job\\a.pdf', '\\\\fs01\\projects\\job\\b.pdf'])
  assert.equal(disk.items['\\\\fs01\\projects\\job\\a.pdf'].byName, 'Asha')
  const got = await labels.get(['\\\\fs01\\projects\\job\\A.pdf', 'P:\\Job\\b.pdf', 'P:\\Job\\c.pdf'])
  assert.deepEqual(Object.keys(got).sort(), ['\\\\fs01\\projects\\job\\a.pdf', 'p:\\job\\b.pdf'])

  // another PC writes its own label meanwhile (newer than ours for b, a new item c)
  disk.items['\\\\fs01\\projects\\job\\b.pdf'] = { label: 'hold', by: 'ravi', at: Date.now() + 60_000 }
  disk.items['\\\\fs01\\projects\\job\\c.pdf'] = { note: 'markup pending', by: 'ravi', at: Date.now() }
  writeFileSync(file, JSON.stringify(disk))
  await labels.set(['P:\\Job\\a.pdf'], { note: 'sent 19 Nov' })
  const merged = JSON.parse(readFileSync(file, 'utf8')).items
  assert.equal(merged['\\\\fs01\\projects\\job\\a.pdf'].label, 'checked')
  assert.equal(merged['\\\\fs01\\projects\\job\\a.pdf'].note, 'sent 19 Nov')
  assert.equal(merged['\\\\fs01\\projects\\job\\b.pdf'].label, 'hold', 'the newer write from the other PC stays')
  assert.equal(merged['\\\\fs01\\projects\\job\\c.pdf'].note, 'markup pending')

  // a folder moved through Hopper takes its labels along
  await labels.moved([['P:\\Job', 'P:\\Archive\\Job']])
  const after = await labels.get(['P:\\Archive\\Job\\a.pdf', 'P:\\Job\\a.pdf', 'P:\\Archive\\Job\\c.pdf'])
  assert.equal(after['p:\\archive\\job\\a.pdf'].label, 'checked')
  assert.equal(after['p:\\job\\a.pdf'], undefined)
  assert.equal(after['p:\\archive\\job\\c.pdf'].note, 'markup pending')
  assert.ok(emitted.some(([e]) => e === 'labels-changed'))

  // no office config: a local store in Hopper's data folder
  const local = new Labels({ ...ctx, officePath: '' })
  await local.set(['D:\\Work\\x.pdf'], { label: 'final' })
  assert.equal(JSON.parse(readFileSync(join(tmp, 'labels', 'local-d.json'), 'utf8')).items['d:\\work\\x.pdf'].label, 'final')
})
