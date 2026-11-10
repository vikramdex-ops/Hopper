// Pure-JS checks of the LAN additions in protocol.ts: key fingerprints, join invites, share
// kinds and folder links from the wire, and announcement cleaning/merging.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

const P = await import('../../src/lan/protocol.ts')

const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
const invite = { v: 1, id: 'a1b2c3d4e5f60718', officeName: 'Dexterity Design Services', adminUser: 'asha', adminName: 'Asha', host: 'WS-030', configPath: '\\\\10.0.0.2\\share\\_Hopper\\office.json', key: KEY, t: Date.now() }

test('key fingerprint is the first 8 hex of SHA-256 of the key bytes', () => {
  const want = createHash('sha256').update(Buffer.from(KEY, 'hex')).digest('hex').slice(0, 8)
  assert.equal(P.keyFingerprint(KEY), want)
  assert.equal(P.keyFingerprint(KEY.toUpperCase()), want)
  assert.equal(P.keyFingerprint(P.officeKeyBytes(KEY)), want)
  assert.equal(P.keyFingerprint(''), '')
  assert.equal(P.keyFingerprint('abc'), '')
  assert.equal(P.keyFingerprint(null), '')
  assert.notEqual(P.keyFingerprint('ff'.repeat(32)), want)
})

test('invite round trip', () => {
  const buf = P.sealInvite(invite)
  assert.ok(buf.length <= P.MAX_BEACON)
  assert.equal(buf.subarray(0, 18).toString(), '{"hopper":"invite"')
  assert.deepEqual(P.openInvite(buf), invite)
})

test('an invite is not a beacon and a beacon is not an invite', () => {
  const mk = P.beaconKey(P.officeKeyBytes(KEY))
  assert.equal(P.openBeacon(P.sealInvite(invite), mk), null)
  const beacon = P.sealBeacon({ v: 1, id: 'abc123', user: 'asha', displayName: 'Asha', host: 'PC', email: '', port: 47821, version: '2.1.0', status: 'online', t: Date.now() }, mk)
  assert.equal(P.openInvite(beacon), null)
})

test('malformed invites are rejected', () => {
  const bad = (patch) => P.openInvite(Buffer.from(JSON.stringify({ hopper: 'invite', ...invite, ...patch })))
  assert.equal(bad({ key: 'not-hex' }), null)
  assert.equal(bad({ key: 'ab'.repeat(8) }), null) // too short
  assert.equal(bad({ key: 'ab'.repeat(80) }), null) // absurdly long
  assert.equal(bad({ id: '../x' }), null)
  assert.equal(bad({ adminUser: '' }), null)
  assert.equal(bad({ v: 2 }), null)
  assert.equal(P.openInvite(Buffer.from('not json')), null)
  assert.equal(P.openInvite(Buffer.alloc(P.MAX_BEACON + 1, 32)), null)
  assert.equal(P.openInvite(Buffer.from(JSON.stringify({ ...invite }))), null) // no marker
})

test('invite text is cleaned and capped', () => {
  const i = P.openInvite(Buffer.from(JSON.stringify({ hopper: 'invite', ...invite, officeName: 'Evil\r\nOffice\u0000', adminUser: 'ASHA', adminName: 'x'.repeat(500), key: KEY.toUpperCase() })))
  assert.equal(i.officeName, 'Evil Office')
  assert.equal(i.adminUser, 'asha')
  assert.equal(i.adminName.length, 80)
  assert.equal(i.key, KEY)
})

test('share kinds from the wire', () => {
  assert.equal(P.parseKind(undefined), 'files')
  assert.equal(P.parseKind('files'), 'files')
  assert.equal(P.parseKind('message'), 'message')
  assert.equal(P.parseKind('link'), 'link')
  assert.equal(P.parseKind('request'), 'request')
  assert.equal(P.parseKind('exec'), null)
  assert.equal(P.parseKind(7), null)
})

test('links must be absolute Windows paths', () => {
  assert.deepEqual(P.parseLink({ path: '\\\\server\\share\\P12513\\02_Working' }), { path: '\\\\server\\share\\P12513\\02_Working', dir: true })
  assert.deepEqual(P.parseLink({ path: 'U:\\Projects\\a.pdf', dir: false }), { path: 'U:\\Projects\\a.pdf', dir: false })
  assert.deepEqual(P.parseLink({ path: '  D:\\x  ' }), { path: 'D:\\x', dir: true })
  for (const path of ['relative\\path', '..\\up', 'https://example.com/x', 'file:///c:/x', '\\\\server', '\\\\server\\share\\..\\other', 'C:\\a\u0000b', 'C:\\a|b', '', 'x'.repeat(2000)]) {
    assert.equal(P.parseLink({ path }), null, path.slice(0, 40))
  }
  assert.equal(P.parseLink(null), null)
  assert.equal(P.parseLink({ path: 7 }), null)
})

test('reply ids', () => {
  assert.equal(P.replyId('mabc123-0a1b2c3d'), 'mabc123-0a1b2c3d')
  assert.equal(P.replyId('../../x'), undefined)
  assert.equal(P.replyId(5), undefined)
})

test('announcements are cleaned', () => {
  const a = P.cleanAnnouncement({
    id: 'mabc123-0a1b2c3d',
    title: '  P12513 folder is\nalmost full ',
    body: 'Back up locally.\r\nClean old exports.\u0007',
    level: 'urgent',
    path: '\\\\server\\share\\P12513',
    expires: 1900000000000,
    at: 1800000000000,
    by: 'Asha',
    byName: 'Asha',
    host: 'WS-030',
    extra: 'dropped'
  })
  assert.deepEqual(a, {
    id: 'mabc123-0a1b2c3d',
    title: 'P12513 folder is almost full',
    body: 'Back up locally.\nClean old exports.',
    level: 'urgent',
    at: 1800000000000,
    by: 'asha',
    byName: 'Asha',
    host: 'WS-030',
    path: '\\\\server\\share\\P12513',
    expires: 1900000000000
  })
  assert.equal(P.cleanAnnouncement({ id: 'x', title: 't', by: 'a', at: 1 }), null) // id too short
  assert.equal(P.cleanAnnouncement({ id: 'abcdef', title: '  ', by: 'a', at: 1 }), null)
  assert.equal(P.cleanAnnouncement({ id: 'abcdef', title: 't', by: '', at: 1 }), null)
  assert.equal(P.cleanAnnouncement({ id: 'abcdef', title: 't', by: 'a' }), null)
  assert.equal(P.cleanAnnouncement(null), null)
  // unknown level falls back to info; a bad path is dropped, not trusted
  const b = P.cleanAnnouncement({ id: 'abcdef', title: 't', by: 'a', at: 5, level: 'panic', path: 'relative' })
  assert.equal(b.level, 'info')
  assert.equal('path' in b, false)
})

test('announcement expiry and withdrawal', () => {
  const base = { id: 'abcdef', title: 't', body: '', level: 'info', at: 1000, by: 'a', byName: 'A' }
  assert.equal(P.announcementLive(base, 5000), true)
  assert.equal(P.announcementLive({ ...base, expires: 4000 }, 5000), false)
  assert.equal(P.announcementLive({ ...base, expires: 6000 }, 5000), true)
  assert.equal(P.announcementLive({ ...base, withdrawn: true }, 5000), false)
})

test('merge keeps one per id, newest first, withdrawn wins, capped', () => {
  const mk = (id, at, extra = {}) => ({ id, title: id, body: '', level: 'info', at, by: 'a', byName: 'A', ...extra })
  const merged = P.mergeAnnouncements([[mk('aaaaaa', 1), mk('bbbbbb', 3)], [mk('cccccc', 2), mk('aaaaaa', 1, { withdrawn: true })]])
  assert.deepEqual(merged.map((a) => a.id), ['bbbbbb', 'cccccc', 'aaaaaa'])
  assert.equal(merged[2].withdrawn, true)
  // order of the lists does not matter for a withdrawal
  assert.equal(P.mergeAnnouncements([[mk('aaaaaa', 1, { withdrawn: true })], [mk('aaaaaa', 1)]])[0].withdrawn, true)
  const many = Array.from({ length: 250 }, (_, i) => mk(`id${String(i).padStart(4, '0')}`, i))
  const capped = P.mergeAnnouncements([many])
  assert.equal(capped.length, 200)
  assert.equal(capped[0].id, 'id0249')
})
