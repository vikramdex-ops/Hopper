// Dexterity Share server: range parsing, tokens, password verifier, manifest validation,
// path guards, rate limiter and log rotation (pure functions of server/dexterity-share/server.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as S from '../../server/dexterity-share/server.mjs'
import { TEST_WORK } from './pubshare-hooks.mjs'

const WORK = path.join(TEST_WORK, 'unit')
const ID = 'abcdefghijklmnopqrstuvwxyz'.slice(0, 20) + '234567'

test('share id pattern', () => {
  assert.ok(S.ID_RE.test(ID))
  for (const bad of ['', ID.slice(1), ID + 'a', ID.toUpperCase(), ID.slice(0, 25) + '1', ID.slice(0, 25) + '.', '..', ID.slice(0, 25) + '/', ID.slice(0, 25) + '\n']) assert.equal(S.ID_RE.test(bad), false, JSON.stringify(bad))
})

test('parseRange: forms', () => {
  assert.equal(S.parseRange(undefined, 100), null)
  assert.equal(S.parseRange('', 100), null)
  assert.deepEqual(S.parseRange('bytes=0-', 100), { start: 0, end: 99 })
  assert.deepEqual(S.parseRange('bytes=10-19', 100), { start: 10, end: 19 })
  assert.deepEqual(S.parseRange('bytes=0-0', 100), { start: 0, end: 0 })
  assert.deepEqual(S.parseRange('bytes=99-', 100), { start: 99, end: 99 })
  assert.deepEqual(S.parseRange('bytes=50-5000', 100), { start: 50, end: 99 })
  assert.deepEqual(S.parseRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(S.parseRange('bytes=-1000', 100), { start: 0, end: 99 })
  assert.deepEqual(S.parseRange(' Bytes = 5 - 9 ', 100), { start: 5, end: 9 })
})

test('parseRange: unsatisfiable, ignored and hostile input', () => {
  assert.equal(S.parseRange('bytes=100-', 100), 'unsatisfiable')
  assert.equal(S.parseRange('bytes=100-200', 100), 'unsatisfiable')
  assert.equal(S.parseRange('bytes=-0', 100), 'unsatisfiable')
  assert.equal(S.parseRange('bytes=0-', 0), 'unsatisfiable')
  assert.equal(S.parseRange('bytes=99999999999999999999999999-', 100), 'unsatisfiable')
  assert.equal(S.parseRange('bytes=20-10', 100), null)
  assert.equal(S.parseRange('bytes=0-1,5-6', 100), null)
  assert.equal(S.parseRange('items=0-1', 100), null)
  assert.equal(S.parseRange('bytes=-', 100), null)
  assert.equal(S.parseRange('bytes=a-b', 100), null)
  assert.equal(S.parseRange('bytes=1.5-3', 100), null)
  assert.equal(S.parseRange('bytes=-1-3', 100), null)
  assert.equal(S.parseRange('bytes=0x10-', 100), null)
})

test('parseRange: beyond 2^31 and 2^32', () => {
  const size = 5 * 2 ** 30 + 123
  assert.deepEqual(S.parseRange('bytes=2147483648-2147483657', size), { start: 2147483648, end: 2147483657 })
  assert.deepEqual(S.parseRange('bytes=4294967296-', size), { start: 4294967296, end: size - 1 })
  assert.deepEqual(S.parseRange('bytes=-5', size), { start: size - 5, end: size - 1 })
  assert.equal(S.parseRange(`bytes=${size}-`, size), 'unsatisfiable')
})

test('contentDisposition: RFC 5987 with an ASCII fallback', () => {
  const cases = ['plain.zip', 'Lot 07 isometrics (rev B).zip', 'Zeichnung – Übersicht ✓ 図面.pdf', 'a "quoted"; name%20.pdf', "it's (1)*.txt", 'x'.repeat(200) + '.dwg']
  for (const name of cases) {
    const h = S.contentDisposition(name)
    assert.match(h, /^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''[A-Za-z0-9.%_~!#$&+^`|-]+$/, name)
    assert.equal(decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(h)[1]), name)
    const fallback = /filename="([^"]*)"/.exec(h)[1]
    assert.ok(!/["\\%;]/.test(fallback), fallback)
    assert.equal(fallback.length, name.length)
  }
  assert.equal(S.contentDisposition('..\\..\\secret\r\nSet-Cookie: x=1').includes('\n'), false)
  assert.match(S.contentDisposition('a/b\\c.txt'), /filename="a_b_c\.txt"/)
  assert.match(S.contentDisposition(''), /filename="download"/)
})

test('unlock token: bound to share, password and time', () => {
  const secret = crypto.randomBytes(32)
  const now = 1_800_000_000_000
  const t = S.signToken(secret, ID, 'hashA', 3_600_000, now)
  assert.match(t, /^[0-9a-z]+\.[A-Za-z0-9_-]{43}$/)
  assert.equal(S.verifyToken(secret, ID, 'hashA', t, now + 1000), true)
  assert.equal(S.verifyToken(secret, ID, 'hashA', t, now + 3_600_000), false, 'expired')
  assert.equal(S.verifyToken(secret, ID.replace('a', 'b'), 'hashA', t, now), false, 'other share')
  assert.equal(S.verifyToken(secret, ID, 'hashB', t, now), false, 'password changed')
  assert.equal(S.verifyToken(crypto.randomBytes(32), ID, 'hashA', t, now), false, 'other server key')
  const [exp, mac] = t.split('.')
  const later = (parseInt(exp, 36) + 86_400_000).toString(36)
  assert.equal(S.verifyToken(secret, ID, 'hashA', `${later}.${mac}`, now), false, 'expiry tampered')
  const flipped = mac.slice(0, -2) + (mac.at(-2) === 'A' ? 'B' : 'A') + mac.at(-1)
  assert.equal(S.verifyToken(secret, ID, 'hashA', `${exp}.${flipped}`, now), false, 'mac tampered')
  for (const bad of [undefined, null, '', 'x', '.', `${exp}.`, `.${mac}`, `${exp}.${mac}.x`, 'a'.repeat(500), 12345, {}]) assert.equal(S.verifyToken(secret, ID, 'hashA', bad, now), false)
})

test('password verifier: scrypt, constant-time, bounded', async () => {
  const v = await S.hashPassword('Corr3ct-horse', { N: 1024 })
  assert.equal(v.kdf, 'scrypt')
  assert.ok(!JSON.stringify(v).includes('Corr3ct'))
  assert.equal(await S.verifyPassword('Corr3ct-horse', v), true)
  assert.equal(await S.verifyPassword('corr3ct-horse', v), false)
  assert.equal(await S.verifyPassword('', v), false)
  assert.equal(await S.verifyPassword('x'.repeat(257), v), false)
  assert.equal(await S.verifyPassword(undefined, v), false)
  assert.equal(await S.verifyPassword({ toString: () => 'Corr3ct-horse' }, v), false)
  // the same password typed with a compatibility form of a character still matches (NFKC)
  const u = await S.hashPassword('pa\uFB01n', { N: 1024 })
  assert.equal(await S.verifyPassword('pafin', u), true)
  // hostile verifiers are refused before any work is done
  for (const bad of [null, {}, { ...v, kdf: 'md5' }, { ...v, N: 1 << 30 }, { ...v, N: 1000 }, { ...v, r: 999 }, { ...v, p: 0 }, { ...v, hash: 'AAAA' }, { ...v, salt: '' }]) {
    assert.equal(S.validVerifier(bad), false)
    assert.equal(await S.verifyPassword('Corr3ct-horse', bad), false)
  }
  const a = await S.hashPassword('same', { N: 1024 })
  const b = await S.hashPassword('same', { N: 1024 })
  assert.notEqual(a.hash, b.hash, 'salted')
})

test('validateManifest', () => {
  const ok = { v: 1, id: ID, title: 'Lot 07', message: '', sender: 'Asha', createdAt: 1, expiresAt: 2, files: [{ name: 'a.zip', size: 10, sha256: 'a'.repeat(64) }], password: null, maxDownloads: 0, owner: { user: 'v', host: 'h' } }
  assert.ok(S.validateManifest(ok, ID))
  assert.equal(S.validateManifest(ok, ID.replace('a', 'b')), null, 'id must match its folder')
  const bad = [
    { v: 2 }, { id: 'x' }, { title: 5 }, { title: 'x'.repeat(301) }, { createdAt: '1' }, { expiresAt: 1.5 }, { files: [] }, { files: 'x' },
    { files: [{ name: '', size: 1, sha256: 'a'.repeat(64) }] }, { files: [{ name: 'a', size: -1, sha256: 'a'.repeat(64) }] }, { files: [{ name: 'a', size: 1, sha256: 'xyz' }] },
    { files: [{ name: 'a', size: 2 ** 60, sha256: 'a'.repeat(64) }] }, { files: Array.from({ length: 501 }, () => ok.files[0]) }, { password: { kdf: 'plain' } }, { maxDownloads: -1 }
  ]
  for (const patch of bad) assert.equal(S.validateManifest({ ...ok, ...patch }, ID), null, JSON.stringify(patch).slice(0, 60))
  assert.equal(S.validateManifest(null, ID), null)
  assert.equal(S.validateManifest('x', ID), null)
})

test('path guards', () => {
  const store = path.resolve(WORK, 'store')
  assert.equal(S.inside(path.join(store, ID), store), true)
  assert.equal(S.inside(path.join(store, ID, 'data', '0'), store), true)
  assert.equal(S.inside(store, store), false)
  assert.equal(S.inside(path.join(store, '..'), store), false)
  assert.equal(S.inside(path.join(store, '..', 'other'), store), false)
  assert.equal(S.inside(path.join(store, ID, '..', '..', 'x'), store), false)
  assert.equal(S.inside(store + '-evil', store), false)
  assert.equal(S.storeLooksSafe(store), true)
  for (const bad of ['', 'relative\\dir', 'C:\\', 'U:\\', '/', '\\\\server\\share\\', '\\\\server\\share']) assert.equal(S.storeLooksSafe(bad), false, bad)
  assert.equal(S.storeLooksSafe('\\\\server\\share\\PublicShares'), true)
})

test('loadConfig: file, env overrides, refusals', () => {
  fs.mkdirSync(WORK, { recursive: true })
  const file = path.join(WORK, 'config.json')
  const store = path.join(WORK, 'store')
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ port: 5000, store, allowedOrigins: ['https://Example.com/'] }))
  const c = S.loadConfig(file, {})
  assert.equal(c.port, 5000)
  assert.equal(c.store, path.resolve(store))
  assert.deepEqual(c.allowedOrigins, ['https://example.com'])
  assert.equal(c.stateDir, path.join(WORK, 'state'))
  assert.equal(S.loadConfig(file, { DXSHARE_PORT: '6000', DXSHARE_ORIGINS: 'https://a.test, https://b.test' }).port, 6000)
  assert.deepEqual(S.loadConfig(file, { DXSHARE_ORIGINS: 'https://a.test, https://b.test' }).allowedOrigins, ['https://a.test', 'https://b.test'])
  assert.throws(() => S.loadConfig(file, { DXSHARE_PORT: '0' }), /port/)
  assert.throws(() => S.loadConfig(file, { DXSHARE_STORE: 'C:\\' }), /store/)
  assert.throws(() => S.loadConfig(path.join(WORK, 'missing.json'), {}), /store/)
  // a supervisor config nests the server settings
  fs.writeFileSync(file, JSON.stringify({ server: { port: 5001, store }, tunnel: { mode: 'quick' } }))
  assert.equal(S.loadConfig(file, {}).port, 5001)
})

test('Limiter: windows, peek, prune', () => {
  const l = new S.Limiter()
  let now = 1000
  for (let i = 0; i < 3; i++) assert.equal(l.hit('k', 3, 1000, now).ok, true)
  const over = l.hit('k', 3, 1000, now)
  assert.equal(over.ok, false)
  assert.equal(over.retryAfter, 1)
  assert.equal(l.peek('k', 3, 1000, now).ok, false)
  assert.equal(l.peek('other', 3, 1000, now).ok, true)
  now += 1000
  assert.equal(l.peek('k', 3, 1000, now).ok, true, 'window rolled over')
  l.prune(now + 5000)
  assert.equal(l.map.size, 0)
})

test('Log: JSON lines, rotation keeps a bounded set', () => {
  const dir = path.join(WORK, 'logs')
  fs.rmSync(dir, { recursive: true, force: true })
  const log = new S.Log(dir, 't', 2000, 3)
  for (let i = 0; i < 200; i++) log.info('line', { i, pad: 'x'.repeat(50) })
  const files = fs.readdirSync(dir).sort()
  assert.deepEqual(files, ['t.1.log', 't.2.log', 't.3.log', 't.log'])
  for (const f of files) {
    assert.ok(fs.statSync(path.join(dir, f)).size <= 2000)
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n')) assert.equal(JSON.parse(line).event, 'line')
  }
  const last = fs.readFileSync(path.join(dir, 't.log'), 'utf8').trim().split('\n').pop()
  assert.equal(JSON.parse(last).i, 199)
  // a log that cannot be written must not throw
  new S.Log(path.join(dir, 't.log', 'impossible'), 'x').info('ignored')
})
