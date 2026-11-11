// Dexterity Share, Hopper side: ids, link addresses, expiry choices, passwords and the e-mail text
// (src/shared/pubshare.ts), and that a password verifier made by Hopper is accepted by the server.
import './pubshare-hooks.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const P = await import('../../src/shared/pubshare.ts')
const E = await import('../../src/engine/pubshare.ts')
const S = await import('../../server/dexterity-share/server.mjs')

test('share ids: 26 base32 characters from 16 random bytes, same pattern as the server', () => {
  assert.equal(P.SHARE_ID_RE.source, S.ID_RE.source)
  const seen = new Set()
  for (let i = 0; i < 2000; i++) {
    const id = P.encodeShareId(crypto.randomBytes(16))
    assert.match(id, P.SHARE_ID_RE)
    seen.add(id)
  }
  assert.equal(seen.size, 2000)
  assert.equal(P.encodeShareId(new Uint8Array(16)), 'a'.repeat(26))
  assert.equal(P.encodeShareId(new Uint8Array(16).fill(255)), '7'.repeat(25) + '4')
  // every bit matters: flipping any one changes the id
  const base = crypto.randomBytes(16)
  for (let bit = 0; bit < 128; bit++) {
    const b = Buffer.from(base)
    b[bit >> 3] ^= 1 << (bit & 7)
    assert.notEqual(P.encodeShareId(b), P.encodeShareId(base))
  }
  assert.throws(() => P.encodeShareId(new Uint8Array(15)))
  assert.equal(P.isShareId('a'.repeat(26)), true)
  assert.equal(P.isShareId('A'.repeat(26)), false)
  assert.equal(P.isShareId(null), false)
})

test('link address keeps the id in the fragment', () => {
  const id = 'a'.repeat(26)
  assert.equal(P.shareUrl(undefined, id), `https://vikramdex-ops.github.io/Hopper/share/#${id}`)
  assert.equal(P.shareUrl('https://share.example.com', id), `https://share.example.com/#${id}`)
  assert.equal(P.shareUrl(' https://x.test/share/ ', id), `https://x.test/share/#${id}`)
  assert.equal(P.shareUrl('https://x.test/share/index.html#old', id), `https://x.test/share/index.html#${id}`)
  assert.equal(new URL(P.shareUrl(undefined, id)).search, '')
})

test('expiry choices', () => {
  assert.deepEqual([...P.EXPIRY_DAYS], [1, 3, 7, 14, 30, 60, 90])
  for (const d of P.EXPIRY_DAYS) assert.equal(P.normalizeDays(d), d)
  assert.equal(P.normalizeDays('14'), 14)
  assert.equal(P.normalizeDays(5), 7)
  assert.equal(P.normalizeDays(undefined), 7)
  assert.equal(P.normalizeDays(1000, 30), 30)
  assert.equal(P.normalizeDays(-1, 2), 7)
  const now = Date.UTC(2026, 10, 10, 9, 0)
  assert.equal(P.daysLeft(now + 7 * P.DAY_MS, now), 7)
  assert.equal(P.daysLeft(now + 1, now), 1)
  assert.equal(P.daysLeft(now + P.DAY_MS + 1, now), 2)
  assert.equal(P.daysLeft(now - 1, now), 0)
})

test('generated passwords: shape, alphabet, spread', () => {
  const counts = new Map()
  for (let i = 0; i < 500; i++) {
    const pw = P.generatePassword()
    assert.match(pw, /^[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}$/)
    for (const ch of pw.replace(/-/g, '')) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  }
  assert.equal(counts.size, 56, 'every character of the alphabet appears')
  assert.ok(Math.max(...counts.values()) < 3 * Math.min(...counts.values()), 'no character dominates')
  // bytes that would bias the choice are rejected, not folded in
  let calls = 0
  const pw = P.generatePassword((n) => (calls++ === 0 ? new Uint8Array(n).fill(255) : new Uint8Array(n).fill(0)))
  assert.equal(pw, 'AAAA-AAAA-AAAA')
})

test('safeFileName', () => {
  assert.equal(P.safeFileName('Lot 07: isos <rev B>?.zip'), 'Lot 07_ isos _rev B__.zip')
  assert.equal(P.safeFileName('..\\..\\x'), '.._.._x')
  assert.equal(P.safeFileName('name. . '), 'name')
  assert.equal(P.safeFileName('\u0001\u0002'), '__')
  assert.equal(P.safeFileName('   '), 'file')
  assert.equal(P.safeFileName('図面 – Übersicht.pdf'), '図面 – Übersicht.pdf')
  assert.equal(P.safeFileName('x'.repeat(400)).length, 180)
})

test('e-mail text states what, how big, the link and the expiry date', () => {
  const now = Date.UTC(2026, 10, 10, 6, 30)
  const one = P.buildEmail({ url: 'https://x.test/share/#' + 'a'.repeat(26), title: 'Lot 07 isometrics', message: 'Rev B as discussed.', sender: 'Asha K', files: [{ name: 'Lot 07.zip', size: 734003200 }], expiresAt: now + 7 * P.DAY_MS, now, hasPassword: false })
  assert.equal(one.subject, 'Lot 07 isometrics - files from Dexterity Design Services Private Limited')
  assert.ok(one.body.includes('https://x.test/share/#' + 'a'.repeat(26)))
  assert.ok(one.body.includes('Contents: Lot 07.zip (700 MB)'))
  assert.ok(one.body.includes('This link expires on Tuesday 17 November 2026 (7 days from today).'), one.body)
  assert.ok(one.body.includes('Rev B as discussed.'))
  assert.ok(!/password/i.test(one.body))
  assert.ok(one.body.endsWith('Asha K\r\nDexterity Design Services Private Limited'))
  assert.ok(!/[^\x00-\x7f]/.test(one.subject + one.body), 'plain ASCII survives every mail client')

  const many = P.buildEmail({ url: 'u', title: 'T', sender: 'S', files: [{ name: 'a.pdf', size: 1024 }, { name: 'b.pdf', size: 2048 }], expiresAt: now + P.DAY_MS, now, hasPassword: true })
  assert.ok(many.body.includes('Contents: 2 files (3.0 KB in total)'))
  assert.ok(many.body.includes('  - a.pdf (1.0 KB)'))
  assert.ok(many.body.includes('(1 day from today)'))
  assert.ok(many.body.includes('We will send you the password separately.'))
  assert.ok(many.body.includes('the files we have prepared'))
})

test('mailto: encodes, and drops the per-file list when it would be too long', () => {
  const url = P.mailtoUrl('A & B', 'line 1\r\nline 2?x=1#y')
  assert.equal(url, 'mailto:?subject=A%20%26%20B&body=line%201%0D%0Aline%202%3Fx%3D1%23y')
  const files = Array.from({ length: 12 }, (_, i) => ({ name: `ISO-${1000 + i} long drawing title for the client revision B sheet ${i} of twelve.pdf`, size: 1e6 }))
  const mail = P.buildEmail({ url: 'https://x.test/#' + 'a'.repeat(26), title: 'T', sender: 'S', files, expiresAt: Date.now() + P.DAY_MS, hasPassword: false })
  const m = P.mailtoUrl(mail.subject, mail.body)
  assert.ok(m.length < 2000, String(m.length))
  assert.ok(decodeURIComponent(m).includes('This link expires on'))
  assert.ok(!decodeURIComponent(m).includes('  - ISO-1000'))
})

test("Hopper's password verifier is the one the server checks", async () => {
  const v = await E.makeVerifier('k7Hd-Qm3x-9TpW')
  assert.equal(S.validVerifier(v), true)
  assert.equal(await S.verifyPassword('k7Hd-Qm3x-9TpW', v), true)
  assert.equal(await S.verifyPassword('k7Hd-Qm3x-9TpX', v), false)
  assert.equal(await E.checkVerifier('k7Hd-Qm3x-9TpW', v), true)
  assert.ok(!JSON.stringify(v).includes('k7Hd'))
  const fromServer = await S.hashPassword('pässword ✓')
  assert.equal(await E.checkVerifier('pässword ✓', fromServer), true)
})

test('publicShareConfig: defaults beside office.json', () => {
  const c = E.publicShareConfig({ office: {}, settings: { officeConfigPath: '\\\\srv\\share\\_Hopper\\office.json' } })
  assert.deepEqual(c, { enabled: false, store: '\\\\srv\\share\\_Hopper\\PublicShares', pageUrl: P.DEFAULT_PAGE_URL, defaultDays: 7, pointer: undefined, minFreeGB: 5, host: undefined, web: { enabled: true, maxGB: 5 } })
  const d = E.publicShareConfig({ office: { publicShare: { enabled: true, store: ' D:\\Shares ', pageUrl: 'https://s.example.com/', defaultDays: 30 } }, settings: null })
  assert.deepEqual(d, { enabled: true, store: 'D:\\Shares', pageUrl: 'https://s.example.com/', defaultDays: 30, pointer: undefined, minFreeGB: 5, host: undefined, web: { enabled: true, maxGB: 5 } })
  assert.deepEqual(E.publicShareConfig({ office: { publicShare: { web: { enabled: false, maxGB: 2 } } }, settings: null }).web, { enabled: false, maxGB: 2 })
  // a damaged pointer entry is ignored rather than producing broken links
  assert.equal(E.publicShareConfig({ office: { publicShare: { pointer: { gist: 'zz', key: 'x' } } }, settings: null }).pointer, undefined)
  assert.deepEqual(E.publicShareConfig({ office: { publicShare: { pointer: { gist: 'a'.repeat(32), key: 'b'.repeat(20) }, minFreeGB: 0 } }, settings: null }).pointer, { gist: 'a'.repeat(32), key: 'b'.repeat(20) })
  assert.equal(E.publicShareConfig({ office: null, settings: null }).store, '')
})
