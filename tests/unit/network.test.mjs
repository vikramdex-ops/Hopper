// Network node: address parsing, merging discovery sources, share filtering and error wording
// (src/shared/network.ts via Node type stripping). No network access.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAddress, validHost, hostKey, samePlacePath, mergeComputers, visibleShares, netError, netCallError, isAccessDenied,
  networkHostPath, networkHostOf, serverOnlyUnc, shareRootHost, defaultNetworkSettings
} from '../../src/shared/network.ts'

const ok = (input) => {
  const a = parseAddress(input)
  assert.equal(a.ok, true, `${input}: ${a.message}`)
  return a
}
const refused = (input, code) => {
  const a = parseAddress(input)
  assert.equal(a.ok, false, `${input} should be refused`)
  assert.equal(a.code, code, `${input}: ${a.message}`)
  assert.ok(a.message.length > 10)
  return a
}

test('parseAddress: UNC forms normalise to \\\\host\\share', () => {
  assert.deepEqual(ok('\\\\nas01\\Projects'), { ok: true, host: 'nas01', share: 'Projects', rest: '', unc: '\\\\nas01\\Projects', kind: 'share' })
  assert.equal(ok('\\\\nas01\\Projects\\').unc, '\\\\nas01\\Projects')
  assert.equal(ok('//nas01/Projects').unc, '\\\\nas01\\Projects')
  assert.equal(ok('  "\\\\nas01\\Projects"  ').unc, '\\\\nas01\\Projects')
  assert.equal(ok('\\\\nas01\\Projects\\2026\\Lot 07').unc, '\\\\nas01\\Projects\\2026\\Lot 07')
  assert.equal(ok('\\\\nas01\\Projects\\2026\\Lot 07').kind, 'folder')
  assert.equal(ok('\\\\nas01\\Projects\\\\2026').unc, '\\\\nas01\\Projects\\2026')
})

test('parseAddress: servers on their own, bare names and IP addresses', () => {
  assert.deepEqual(ok('\\\\nas01'), { ok: true, host: 'nas01', share: '', rest: '', unc: '\\\\nas01', kind: 'server' })
  assert.equal(ok('\\\\nas01\\').kind, 'server')
  assert.equal(ok('nas01').unc, '\\\\nas01')
  assert.equal(ok('nas01\\Projects').unc, '\\\\nas01\\Projects')
  assert.equal(ok('192.168.10.20').unc, '\\\\192.168.10.20')
  assert.equal(ok('\\\\192.168.10.20\\scans').unc, '\\\\192.168.10.20\\scans')
  assert.equal(ok('\\\\files.example.local\\x').host, 'files.example.local')
  assert.equal(ok('\\\\fe80--1.ipv6-literal.net\\x').host, 'fe80--1.ipv6-literal.net')
})

test('parseAddress: smb:// and cifs:// addresses', () => {
  assert.equal(ok('smb://nas01/Projects').unc, '\\\\nas01\\Projects')
  assert.equal(ok('SMB://nas01/Projects/2026/').unc, '\\\\nas01\\Projects\\2026')
  assert.equal(ok('cifs://nas01/x').unc, '\\\\nas01\\x')
  assert.equal(ok('smb://nas01').kind, 'server')
  // a user name in the address is dropped: Hopper asks for it when the server needs one
  assert.equal(ok('smb://alice@nas01/Projects').unc, '\\\\nas01\\Projects')
  assert.equal(ok('smb://nas01:445/Projects').unc, '\\\\nas01\\Projects')
  refused('smb://nas01:8445/Projects', 'port')
})

test('parseAddress: FTP is refused in plain words', () => {
  for (const a of ['ftp://files.example.com', 'FTP://files.example.com/pub', 'sftp://host/x', 'ftps://host', 'ftp.example.com']) {
    const r = refused(a, 'ftp')
    assert.match(r.message, /FTP isn't supported in Hopper yet/)
  }
})

test('parseAddress: other addresses and bad names are refused', () => {
  refused('', 'empty')
  refused('   ', 'empty')
  refused('https://intranet/share', 'web')
  refused('webdav://x/y', 'web')
  refused('nfs://nas/export', 'invalid')
  refused('C:\\Projects', 'local')
  refused('d:/x', 'local')
  refused('\\single\\slash', 'invalid')
  refused('\\\\', 'invalid')
  refused('\\\\bad name\\x', 'invalid')
  refused('\\\\bad*name', 'invalid')
  refused('\\\\-nas\\x', 'invalid')
  refused('\\\\999.1.1.1\\x', 'invalid')
  refused('\\\\nas01\\bad:share', 'invalid')
  refused('\\\\nas01\\' + 'x'.repeat(81), 'invalid')
  refused('\\\\nas01\\ok\\bad|folder', 'invalid')
  refused('\\\\nas01\\ok\\..', 'invalid')
})

test('validHost and hostKey', () => {
  assert.equal(validHost('NAS01'), true)
  assert.equal(validHost('pc_12'), true)
  assert.equal(validHost('a.b.c'), true)
  assert.equal(validHost('10.0.0.1'), true)
  assert.equal(validHost('10.0.0'), false)
  assert.equal(validHost('x y'), false)
  assert.equal(validHost('nas-'), false)
  assert.equal(hostKey('nas01'), 'NAS01')
  assert.equal(hostKey('\\\\NAS01\\share'), 'NAS01')
  assert.equal(hostKey('nas01.office.local'), 'NAS01')
  assert.equal(hostKey('10.0.0.5'), '10.0.0.5')
  assert.equal(samePlacePath('\\\\NAS01\\Projects\\', '\\\\nas01\\projects'), true)
  assert.equal(samePlacePath('\\\\NAS01\\Projects', '\\\\nas01\\other'), false)
})

test('virtual paths for the Network page', () => {
  assert.equal(networkHostPath('NAS 01'), 'hopper:network?host=NAS%2001')
  assert.equal(networkHostOf(networkHostPath('NAS 01')), 'NAS 01')
  assert.equal(networkHostOf('hopper:network'), null)
  assert.equal(networkHostOf('hopper:network?host='), null)
  assert.equal(networkHostOf('\\\\nas01'), null)
  assert.equal(serverOnlyUnc('\\\\nas01'), 'nas01')
  assert.equal(serverOnlyUnc('\\\\nas01\\'), 'nas01')
  assert.equal(serverOnlyUnc('\\\\nas01\\x'), null)
  assert.equal(serverOnlyUnc('C:\\'), null)
  assert.equal(shareRootHost('\\\\nas01\\x'), 'nas01')
  assert.equal(shareRootHost('\\\\nas01\\x\\'), 'nas01')
  assert.equal(shareRootHost('\\\\nas01\\x\\y'), null)
  assert.deepEqual(defaultNetworkSettings(), { places: [], showHidden: false, expanded: false })
})

test('mergeComputers: one entry per machine whichever sources saw it', () => {
  const list = mergeComputers(
    [
      { id: 'connected', items: [{ name: 'FILESRV' }, { name: 'filesrv' }, { name: 'nas01' }] },
      { id: 'wsd', items: [{ name: 'FILESRV', address: '10.0.0.2' }, { name: 'PC-07', address: '10.0.0.7' }, { name: '10.0.0.9', address: '10.0.0.9', unnamed: true }, { name: '10.0.0.7', address: '10.0.0.7', unnamed: true }] },
      { id: 'browse', items: [], error: 6118 },
      { id: 'serverEnum', items: [{ name: 'PC-07.office.local' }] }
    ],
    [
      { host: 'PC-07', displayName: 'Asha' },
      { host: 'PC-07', displayName: 'Ravi' },
      { host: 'PC-11', displayName: 'Meena' },
      { host: 'MYPC', displayName: 'Me', self: true }
    ],
    'mypc'
  )
  assert.deepEqual(list.map((c) => c.name), ['10.0.0.9', 'FILESRV', 'MYPC', 'NAS01', 'PC-07', 'PC-11'])
  const by = Object.fromEntries(list.map((c) => [c.key, c]))
  assert.deepEqual(by.FILESRV.sources, ['connected', 'wsd'])
  assert.equal(by.FILESRV.address, '10.0.0.2')
  assert.deepEqual(by['PC-07'].sources, ['wsd', 'serverEnum', 'peers'])
  assert.deepEqual(by['PC-07'].people, ['Asha', 'Ravi'])
  // the address-only reply for 10.0.0.7 is the same machine as PC-07 and is dropped; 10.0.0.9 is kept
  assert.equal(by['10.0.0.7'], undefined)
  assert.deepEqual(by['10.0.0.9'].sources, ['wsd'])
  assert.equal(by.MYPC.self, true)
  assert.equal(by.MYPC.people, undefined)
  assert.equal(by['PC-11'].self, undefined)
})

test('mergeComputers: ignores localhost, blanks and UNC decorations', () => {
  const list = mergeComputers([{ id: 'connected', items: [{ name: 'localhost' }, { name: '127.0.0.1' }, { name: ' ' }, { name: '\\\\Srv2\\share' }] }])
  assert.deepEqual(list.map((c) => c.name), ['Srv2'])
  assert.deepEqual(mergeComputers([]), [])
})

test('visibleShares: folders only; hidden shares only when asked', () => {
  const raw = [
    { name: 'Projects', type: 0, remark: 'Live jobs' },
    { name: 'scans', type: 0 },
    { name: 'IPC$', type: 0x80000003, remark: 'Remote IPC' },
    { name: 'ADMIN$', type: 0x80000000, remark: 'Remote Admin' },
    { name: 'C$', type: 0x80000000 },
    { name: 'Archive$', type: 0 },
    { name: 'HP LaserJet', type: 1 },
    { name: 'COM1', type: 2 },
    { name: 'Lot 10', type: 0 },
    { name: 'Lot 9', type: 0 }
  ]
  assert.deepEqual(visibleShares('nas01', raw).map((s) => s.name), ['Lot 9', 'Lot 10', 'Projects', 'scans'])
  const all = visibleShares('nas01', raw, true)
  assert.deepEqual(all.map((s) => s.name), ['ADMIN$', 'Archive$', 'C$', 'Lot 9', 'Lot 10', 'Projects', 'scans'])
  assert.deepEqual(all.filter((s) => s.hidden).map((s) => s.name), ['ADMIN$', 'Archive$', 'C$'])
  assert.equal(all.find((s) => s.name === 'Projects').path, '\\\\nas01\\Projects')
  assert.equal(all.find((s) => s.name === 'Projects').remark, 'Live jobs')
  assert.equal(all.find((s) => s.name === 'scans').remark, '')
})

test('netError: each Windows failure gets a plain sentence and the right next step', () => {
  const e = (stage, code) => netError({ stage, code }, 'NAS01')
  assert.equal(e('resolve', 53).code, 'notfound')
  assert.match(e('resolve', 53).message, /can't find a computer called NAS01/)
  assert.equal(e('resolve', 1460).code, 'timeout')
  assert.match(e('resolve', 1460).message, /Looking up NAS01 took too long/)
  assert.equal(e('connect', 1231).code, 'offline')
  assert.match(e('connect', 1231).message, /NAS01 isn't answering/)
  assert.equal(e('enum', 1460).code, 'timeout')
  assert.match(e('enum', 1460).message, /took too long to answer/)
  for (const code of [5, 65]) {
    const d = e('enum', code)
    assert.equal(d.code, 'denied')
    assert.equal(d.canSignIn, true)
    assert.match(d.message, /needs you to sign in/)
  }
  assert.match(e('signin', 5).message, /isn't allowed/)
  assert.equal(e('enum', 1272).code, 'denied')
  assert.match(e('enum', 1272).message, /guest access/)
  for (const code of [86, 1326]) {
    assert.equal(e('signin', code).code, 'badlogin')
    assert.equal(e('signin', code).message, 'The user name or password is incorrect.')
  }
  assert.equal(e('signin', 1327).code, 'badlogin')
  assert.equal(e('signin', 1330).code, 'badlogin')
  assert.equal(e('signin', 1909).code, 'badlogin')
  const c = e('signin', 1219)
  assert.equal(c.code, 'conflict')
  assert.equal(c.canSignIn, false)
  assert.match(c.message, /different account/)
  assert.equal(e('signin', 67).code, 'noshare')
  for (const code of [51, 53, 64, 1203, 1232]) assert.equal(e('enum', code).code, 'offline', String(code))
  for (const code of [50, 1722, 1726, 2114]) {
    const u = e('enum', code)
    assert.equal(u.code, 'unsupported', String(code))
    assert.match(u.message, /\\\\NAS01\\share/)
  }
  assert.equal(e('disconnect', 2401).code, 'busy')
  const f = e('enum', 12345)
  assert.equal(f.code, 'failed')
  assert.match(f.message, /Windows error 12345/)
  assert.equal(f.winerr, 12345)
  assert.equal(netError(undefined, '').code, 'failed')
})

test('netCallError and isAccessDenied', () => {
  assert.equal(netCallError(new Error('HopperShell netShares timed out'), 'NAS01').code, 'timeout')
  const x = netCallError(new Error("Error invoking remote method 'net:shares': Error: HopperShell exited"), 'NAS01')
  assert.equal(x.code, 'failed')
  assert.equal(x.message, "Hopper couldn't reach NAS01: HopperShell exited")
  assert.equal(isAccessDenied('Access denied: \\\\nas01\\Projects'), true)
  assert.equal(isAccessDenied('The user name or password is incorrect.'), true)
  assert.equal(isAccessDenied('Not found: \\\\nas01\\Projects'), false)
})
