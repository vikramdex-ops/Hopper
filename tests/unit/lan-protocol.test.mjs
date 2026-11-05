// Pure-JS checks of the LAN wire format: beacon MAC, PSK derivation, ranges, path safety and
// frame/raw interleaving over a real loopback TLS-PSK connection.
// protocol.ts is loaded through Node's built-in type stripping (Node >= 22.18 / 23.6).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, connect } from 'node:tls'
import { Writable } from 'node:stream'

const P = await import('../../src/lan/protocol.ts')

const KEY = P.officeKeyBytes('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff')
const beacon = { v: 1, id: 'abc123', user: 'asha', displayName: 'Asha', host: 'PC-01', email: 'v@x.com', port: 47821, version: '2.0.0', status: 'online', t: Date.now() }

test('office key validation', () => {
  assert.equal(P.officeKeyBytes(''), null)
  assert.equal(P.officeKeyBytes('abc'), null)
  assert.equal(P.officeKeyBytes('zz'.repeat(16)), null)
  assert.equal(P.officeKeyBytes('ab'.repeat(16)).length, 16)
})

test('beacon round trip and tamper detection', () => {
  const mk = P.beaconKey(KEY)
  const buf = P.sealBeacon(beacon, mk)
  assert.deepEqual(P.openBeacon(buf, mk), { ...beacon, bye: false })
  // other office key
  assert.equal(P.openBeacon(buf, P.beaconKey(P.officeKeyBytes('ff'.repeat(32)))), null)
  // altered payload, same MAC
  const outer = JSON.parse(buf.toString())
  outer.d = outer.d.replace('"asha"', '"mallory"')
  assert.equal(P.openBeacon(Buffer.from(JSON.stringify(outer)), mk), null)
  // missing MAC, junk, oversize
  assert.equal(P.openBeacon(Buffer.from(JSON.stringify({ d: outer.d })), mk), null)
  assert.equal(P.openBeacon(Buffer.from('not json'), mk), null)
  assert.equal(P.openBeacon(Buffer.alloc(P.MAX_BEACON + 1, 32), mk), null)
})

test('psk is per identity and case-insensitive', () => {
  assert.equal(P.pskFor(KEY, 'Asha').toString('hex'), P.pskFor(KEY, 'asha').toString('hex'))
  assert.notEqual(P.pskFor(KEY, 'asha').toString('hex'), P.pskFor(KEY, 'anil').toString('hex'))
  assert.notEqual(P.pskFor(KEY, 'asha').toString('hex'), P.beaconKey(KEY).toString('hex'))
})

test('splitRanges covers the file exactly', () => {
  assert.deepEqual(P.splitRanges(0), [[0, 0]])
  assert.deepEqual(P.splitRanges(1000), [[0, 1000]])
  for (const size of [P.SPLIT_MIN, P.SPLIT_MIN + 1, 5_000_000_123]) {
    const r = P.splitRanges(size)
    assert.ok(r.length > 1 && r.length <= P.MAX_STREAMS)
    assert.equal(r[0][0], 0)
    assert.equal(r[r.length - 1][1], size)
    for (let i = 1; i < r.length; i++) assert.equal(r[i][0], r[i - 1][1])
  }
})

test('safeRel rejects traversal and Windows-hostile names', () => {
  assert.equal(P.safeRel('a/b/c.pdf'), 'a\\b\\c.pdf')
  for (const bad of ['', '../x', 'a/../b', '/abs', 'C:/x', 'a//b', 'con', 'a/NUL.txt', 'x?.pdf', 'trail.', 'sp ', 'a\u0001b', 42]) {
    assert.equal(P.safeRel(bad), null, String(bad))
  }
})

test('names and stamps', () => {
  assert.equal(P.sanitizeName('A/B:C*'), 'A_B_C_')
  assert.equal(P.sanitizeName('...'), 'unknown')
  assert.match(P.stamp(new Date(2026, 10, 5, 9, 7)), /^2026-11-05 0907$/)
  assert.equal(P.formatBytes(420 * 1024 * 1024), '420 MB')
  assert.equal(P.formatBytes(1536), '1.5 KB')
})

test('frames and raw runs interleave over TLS-PSK with backpressure', async () => {
  const PAYLOAD = Buffer.alloc(3 * 1024 * 1024 + 17)
  for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = (i * 31) & 255
  let seenIdentity = ''
  const server = createServer(
    {
      ciphers: P.PSK_CIPHERS,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
      pskCallback: (_s, identity) => ((seenIdentity = identity), P.pskFor(KEY, identity))
    },
    async (sock) => {
      const c = new P.FrameConn(sock)
      const hello = await c.readFrame(5000)
      assert.equal(hello.t, 'hello')
      const put = await c.readFrame(5000)
      c.send({ t: 'from', offset: 0 })
      // slow sink forces the socket to pause
      const parts = []
      const sink = new Writable({
        highWaterMark: 64 * 1024,
        write(chunk, _e, cb) {
          parts.push(Buffer.from(chunk))
          setImmediate(cb)
        }
      })
      const n = await c.readRaw(put.end, sink)
      await new Promise((r) => sink.end(r))
      const after = await c.readFrame(5000)
      c.send({ t: 'ack', n, ok: Buffer.concat(parts).equals(PAYLOAD), after: after.t })
    }
  )
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    const sock = connect({
      host: '127.0.0.1',
      port,
      ciphers: P.PSK_CIPHERS,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
      pskCallback: () => ({ psk: P.pskFor(KEY, 'asha'), identity: 'asha' }),
      checkServerIdentity: () => undefined
    })
    await new Promise((r, j) => (sock.once('secureConnect', r), sock.once('error', j)))
    const c = new P.FrameConn(sock)
    c.send({ t: 'hello', v: 1 })
    c.send({ t: 'put', file: 0, start: 0, end: PAYLOAD.length })
    assert.deepEqual(await c.readFrame(5000), { t: 'from', offset: 0 })
    // raw bytes immediately followed by a frame in the same write
    sock.write(Buffer.concat([PAYLOAD, P.encodeFrame({ t: 'done' })]))
    const ack = await c.readFrame(10000)
    assert.deepEqual(ack, { t: 'ack', n: PAYLOAD.length, ok: true, after: 'done' })
    assert.equal(seenIdentity, 'asha')
    assert.match(sock.getCipher().name, /PSK/)
    sock.destroy()
  } finally {
    server.close()
  }
})

test('wrong office key fails the handshake', async () => {
  const server = createServer({ ciphers: P.PSK_CIPHERS, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', pskCallback: (_s, id) => P.pskFor(KEY, id) }, (s) => s.end())
  server.on('tlsClientError', () => {})
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const other = P.officeKeyBytes('ee'.repeat(32))
    const sock = connect({
      host: '127.0.0.1',
      port: server.address().port,
      ciphers: P.PSK_CIPHERS,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
      pskCallback: () => ({ psk: P.pskFor(other, 'asha'), identity: 'asha' }),
      checkServerIdentity: () => undefined
    })
    await assert.rejects(new Promise((r, j) => (sock.once('secureConnect', r), sock.once('error', j))))
    sock.destroy()
  } finally {
    server.close()
  }
})

test('readFrame rejects malformed and oversize frames, and on close', async () => {
  const { PassThrough } = await import('node:stream')
  const s1 = new PassThrough()
  const c1 = new P.FrameConn(s1)
  const bad = Buffer.from('{nope')
  const head = Buffer.alloc(4)
  head.writeUInt32BE(bad.length)
  s1.write(Buffer.concat([head, bad]))
  await assert.rejects(c1.readFrame(1000), /malformed/)
  const s2 = new PassThrough()
  const c2 = new P.FrameConn(s2)
  const big = Buffer.alloc(4)
  big.writeUInt32BE(P.MAX_FRAME + 1)
  s2.write(big)
  await assert.rejects(c2.readFrame(1000), /too large/)
  const s3 = new PassThrough()
  const c3 = new P.FrameConn(s3)
  const p = c3.readFrame(1000)
  s3.destroy()
  await assert.rejects(p, /closed|ended/)
})
