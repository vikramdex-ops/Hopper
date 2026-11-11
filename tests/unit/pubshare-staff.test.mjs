// Dexterity Share for staff (links made from a browser): the sign-in link format, the office
// setting, and the server's pure helpers (file name rules shared with Hopper, archive signatures).
import './pubshare-hooks.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const P = await import('../../src/shared/pubshare.ts')
const S = await import('../../server/dexterity-share/server.mjs')

test('sign-in link: create/ beside the client page, everything in the fragment, pointer as on client links', () => {
  const id = P.encodeShareId(crypto.randomBytes(16))
  const secret = crypto.randomBytes(32).toString('base64url')
  assert.equal(P.staffPassUrl('https://example.test/Hopper/share/', id, secret), `https://example.test/Hopper/share/create/#${id}.${secret}`)
  assert.equal(P.staffPassUrl('https://example.test/Hopper/share', id, secret), `https://example.test/Hopper/share/create/#${id}.${secret}`)
  assert.equal(P.staffPassUrl('https://example.test/share/index.html#x', id, secret), `https://example.test/share/create/#${id}.${secret}`)
  const ptr = { gist: 'a'.repeat(32), key: 'b'.repeat(20) }
  const url = P.staffPassUrl('https://example.test/share/', id, secret, ptr)
  assert.deepEqual(P.parseStaffRef(url.split('#')[1]), { id, secret, gist: ptr.gist, key: ptr.key })
  assert.equal(P.staffPassUrl('https://example.test/share/', id, secret, { gist: 'nope', key: 'x' }).endsWith(`#${id}.${secret}`), true, 'a bad pointer is left out')
  assert.equal(P.parseStaffRef(id), null, 'a client link is not a sign-in link')
  assert.equal(P.parseStaffRef(`${id}.short`), null)
  assert.equal(P.parseShareRef(`${id}.${secret}`), null, 'and a sign-in link is not a client link')
})

test('office setting publicShare.web: on, 5 GB unless set otherwise', () => {
  assert.deepEqual(P.normalizeStaffWeb(undefined), { enabled: true, maxGB: 5 })
  assert.deepEqual(P.normalizeStaffWeb({ enabled: false }), { enabled: false, maxGB: 5 })
  assert.deepEqual(P.normalizeStaffWeb({ enabled: true, maxGB: 12.5 }), { enabled: true, maxGB: 12.5 })
  assert.deepEqual(P.normalizeStaffWeb({ maxGB: -1 }), { enabled: true, maxGB: 5 })
  assert.deepEqual(P.normalizeStaffWeb({ maxGB: 'x' }), { enabled: true, maxGB: 5 })
})

test('server staff settings: chunk never above 90 MB, limits in range', () => {
  const d = S.staffSettings(undefined)
  assert.equal(d.enabled, true)
  assert.equal(d.chunkBytes, 16 * 1048576)
  assert.equal(d.maxBytes, 5 * 2 ** 30)
  assert.equal(S.staffSettings({ chunkMB: 500 }).chunkBytes, 90_000_000)
  assert.equal(S.staffSettings({ chunkBytes: 10 }).chunkBytes, 65536)
  assert.equal(S.staffSettings({ enabled: false }).enabled, false)
  assert.equal(S.staffSettings({ defaultDays: 5 }).defaultDays, 7)
  assert.equal(S.staffSettings({}, 2).minFreeBytes, 2 * 2 ** 30)
})

test('file names: the server applies exactly Hopper\'s safeFileName', () => {
  for (const n of ['Lot 07.zip', 'a/b.zip', '..\\x.zip', 'name.zip. ', 'ctrl\u0001.rar', 'C:\\x.7z', '', 'x'.repeat(300), 'e\u0301.zip']) {
    assert.equal(S.safeFileName(n), P.safeFileName(n), JSON.stringify(n))
  }
})

test('archive signatures: zip (incl. empty), RAR 4 and 5, 7z; anything else is not an archive', () => {
  assert.equal(S.archiveKind(Buffer.from('PK\x03\x04rest', 'latin1')), 'zip')
  assert.equal(S.archiveKind(Buffer.from('PK\x05\x06', 'latin1')), 'zip')
  assert.equal(S.archiveKind(Buffer.from('Rar!\x1a\x07\x00', 'latin1')), 'rar')
  assert.equal(S.archiveKind(Buffer.from('Rar!\x1a\x07\x01\x00', 'latin1')), 'rar')
  assert.equal(S.archiveKind(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4])), '7z')
  assert.equal(S.archiveKind(Buffer.from('%PDF-1.7', 'latin1')), null)
  assert.equal(S.archiveKind(Buffer.from('PK', 'latin1')), null)
  assert.equal(S.archiveKind(Buffer.alloc(0)), null)
})

test('server ids are share ids', () => {
  for (let i = 0; i < 50; i++) assert.match(S.encodeId(crypto.randomBytes(16)), P.SHARE_ID_RE)
  const b = crypto.randomBytes(16)
  assert.equal(S.encodeId(b), P.encodeShareId(b))
})
