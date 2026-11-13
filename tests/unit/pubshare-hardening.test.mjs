// Dexterity Share, hostile-world checks against a real server on loopback:
// - only loopback and the tunnel's public host names are answered (DNS-rebinding guard);
// - nothing in the store can point the server outside it (symbolic links, junctions, swaps);
// - no response, header or error page names this PC, its user, its paths or its software.
// Links/junctions need a local NTFS folder: set DXSHARE_LINK_WORK (e.g. a folder on D:) when the
// normal test folder is on a network drive, or those checks are skipped and say so.
import { TEST_WORK } from './pubshare-hooks.mjs'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as S from '../../server/dexterity-share/server.mjs'

const id = () => S.encodeId(crypto.randomBytes(16))

function req(port, p, { host = `127.0.0.1:${port}`, method = 'GET', headers = {}, body, stop } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { Host: host, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, setHost: false }, (res) => {
      if (stop) {
        // read only the headers, then hold the connection open (a download in progress)
        return resolve({ status: res.statusCode, headers: res.headers, res, close: () => r.destroy() })
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    r.on('error', reject)
    r.end(body)
  })
}

function writeShare(store, sid, files, extra = {}) {
  const dir = path.join(store, sid)
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true })
  const list = files.map((body, n) => {
    fs.writeFileSync(path.join(dir, 'data', String(n)), body)
    return { name: extra.names?.[n] ?? `file${n}.txt`, size: Buffer.byteLength(body), sha256: crypto.createHash('sha256').update(body).digest('hex') }
  })
  const now = Date.now()
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ v: 1, id: sid, title: 'T', message: '', sender: 'S', createdAt: now, expiresAt: now + 86400000, files: list, password: extra.password ?? null, maxDownloads: extra.maxDownloads ?? 0, owner: { user: os.userInfo().username, host: os.hostname() } }))
  return dir
}

async function start(root) {
  const store = path.join(root, `store-${process.pid}-${crypto.randomBytes(3).toString('hex')}`)
  fs.mkdirSync(store, { recursive: true })
  const app = S.createShareServer({ port: 0, store, stateDir: path.join(store, '..', 'state-' + path.basename(store)), logDir: '', allowedOrigins: ['https://page.example'], allowedHosts: ['*.trycloudflare.com', 'share.example.com'] }, { log: { info() {}, warn() {}, error() {} } })
  const port = await app.listen()
  after(async () => {
    await app.close(0)
    fs.rmSync(store, { recursive: true, force: true })
    fs.rmSync(path.join(store, '..', 'state-' + path.basename(store)), { recursive: true, force: true })
  })
  return { app, port, store }
}

test('hostAllowed: loopback and listed names only', () => {
  const allow = ['*.trycloudflare.com', 'share.example.com']
  for (const h of ['127.0.0.1', '127.0.0.1:47880', 'localhost:47880', '[::1]:47880', 'abc-def.trycloudflare.com', 'ABC.TRYCLOUDFLARE.COM', 'share.example.com', 'share.example.com.'])
    assert.equal(S.hostAllowed(h, allow), true, h)
  for (const h of [undefined, '', 'trycloudflare.com', 'eviltrycloudflare.com', 'x.trycloudflare.com.evil.net', 'evil.net', 'share.example.com.evil.net', '10.0.0.5', '10.0.0.2:47880', '127.0.0.2', 'localhost.evil.net', 'a b', 'x.trycloudflare.com@evil.net', '0.0.0.0'])
    assert.equal(S.hostAllowed(h, allow), false, String(h))
  assert.deepEqual(S.publicHostOf('https://Share.Example.com/x'), ['share.example.com'])
  assert.deepEqual(S.publicHostOf('nonsense'), [])
})

test('a request through an unknown Host name is refused before any route (DNS rebinding)', async () => {
  const { port, store } = await start(TEST_WORK)
  const sid = id()
  writeShare(store, sid, ['hello'])
  for (const host of ['attacker.example', 'rebind.attacker.example:47880', '10.0.0.2:47880']) {
    for (const p of ['/healthz', `/api/s/${sid}`, `/d/${sid}/0`, '/api/staff/me']) {
      const r = await req(port, p, { host, headers: { 'cf-connecting-ip': '1.2.3.4' } })
      assert.equal(r.status, 421, `${host} ${p}`)
      assert.ok(!r.body.includes('hello'))
    }
  }
  // the tunnel's names and loopback still work
  for (const host of ['quick-name-here.trycloudflare.com', 'share.example.com', `127.0.0.1:${port}`]) {
    assert.equal((await req(port, `/d/${sid}/0`, { host })).body, 'hello', host)
  }
})

test('no response names this PC, its user, its store path or its software', async () => {
  const { port, store } = await start(TEST_WORK)
  const sid = id()
  writeShare(store, sid, ['payload'])
  fs.rmSync(path.join(store, sid, 'data', '0')) // unavailable payload: an error path
  const secrets = [os.hostname(), os.userInfo().username, store, path.basename(store), TEST_WORK, 'node', 'electron', 'Windows', '\\\\', 'C:\\', 'U:\\', 'D:\\'].filter((s) => s && s.length > 2)
  const probes = [
    ['/healthz'], [`/api/s/${sid}`], [`/api/s/${id()}`], [`/d/${sid}/0`], [`/d/${sid}/0`, { headers: { Accept: 'text/html' } }], [`/d/${sid}/7`],
    [`/api/s/${sid}/unlock`, { method: 'POST' }], ['/api/staff/me'], ['/api/staff/me', { headers: { Authorization: 'Bearer x' } }],
    ['/../../windows/win.ini'], ['/%2e%2e/%2e%2e/manifest.json'], [`/${sid}/manifest.json`], ['/_server.json'], ['/_staff/'], ['/state/secret.key'], ['/robots.txt'], ['/' + 'a'.repeat(600)]
  ]
  for (const [p, o] of probes) {
    const r = await req(port, p, o)
    const text = JSON.stringify(r.headers) + r.body
    for (const s of secrets) assert.ok(!text.toLowerCase().includes(s.toLowerCase()), `${p} reveals ${JSON.stringify(s)}: ${text.slice(0, 300)}`)
    assert.equal(r.headers['server'], undefined, p)
    assert.equal(r.headers['x-powered-by'], undefined, p)
  }
})

function linkWork() {
  // junctions and symbolic links cannot be made on a network drive
  for (const base of [process.env.DXSHARE_LINK_WORK, TEST_WORK].filter(Boolean)) {
    const probe = path.join(base, `link-probe-${process.pid}`)
    try {
      fs.mkdirSync(path.join(probe, 't'), { recursive: true })
      fs.symlinkSync(path.join(probe, 't'), path.join(probe, 'j'), 'junction')
      fs.rmSync(probe, { recursive: true, force: true })
      return base
    } catch {
      fs.rmSync(probe, { recursive: true, force: true })
    }
  }
  return null
}

test('symbolic links and junctions in the store are never followed', async (t) => {
  const base = linkWork()
  if (!base) return t.skip('no folder here can hold junctions; set DXSHARE_LINK_WORK to a local NTFS folder')
  const { port, store } = await start(base)
  // something outside the store the attacker wants served
  const outside = path.join(store, '..', `outside-${process.pid}`)
  fs.mkdirSync(path.join(outside, 'data'), { recursive: true })
  after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.writeFileSync(path.join(outside, 'data', '0'), 'SECRET')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET')

  // 1. the whole share folder is a junction to a folder outside the store
  const a = id()
  const fake = writeShare(outside, a, ['SECRET'])
  fs.symlinkSync(fake, path.join(store, a), 'junction')
  assert.equal((await req(port, `/api/s/${a}`)).status, 404)
  assert.equal((await req(port, `/d/${a}/0`)).status, 404)

  // 2. data\ is a junction
  const b = id()
  const dirB = writeShare(store, b, ['SECRET'])
  fs.rmSync(path.join(dirB, 'data'), { recursive: true })
  fs.symlinkSync(path.join(outside, 'data'), path.join(dirB, 'data'), 'junction')
  const rb = await req(port, `/d/${b}/0`)
  assert.equal(rb.status, 404)
  assert.ok(!rb.body.includes('SECRET'))

  // 3. the payload is a file symbolic link (needs Developer Mode or admin; skipped otherwise)
  const c = id()
  const dirC = writeShare(store, c, ['SECRET'])
  fs.rmSync(path.join(dirC, 'data', '0'))
  let made = true
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dirC, 'data', '0'), 'file')
  } catch {
    made = false
  }
  if (made) {
    const rc = await req(port, `/d/${c}/0`)
    assert.equal(rc.status, 404)
    assert.ok(!rc.body.includes('SECRET'))
  } else t.diagnostic('file symbolic links need Developer Mode here; case 3 not run')

  // and a plain share next to them still downloads
  const d = id()
  writeShare(store, d, ['fine'])
  assert.equal((await req(port, `/d/${d}/0`)).body, 'fine')
})

test('a burst of parallel password guesses gets no more tries than the limit', async () => {
  const { port, store } = await start(TEST_WORK)
  const sid = id()
  writeShare(store, sid, ['locked'], { password: await S.hashPassword('right-one', { N: 1024 }) })
  const ip = { 'cf-connecting-ip': '203.0.113.9' }
  const all = await Promise.all(Array.from({ length: 40 }, (_, k) => req(port, `/api/s/${sid}/unlock`, { method: 'POST', headers: ip, body: JSON.stringify({ password: 'guess-' + k }) })))
  const tried = all.filter((r) => r.status === 403).length
  const refused = all.filter((r) => r.status === 429).length
  assert.ok(tried <= 8, `${tried} guesses were checked; the limit is 8`)
  assert.equal(tried + refused, 40)
  // and the right password from that address now waits too (the limit holds)
  assert.equal((await req(port, `/api/s/${sid}/unlock`, { method: 'POST', headers: ip, body: JSON.stringify({ password: 'right-one' }) })).status, 429)
  // another client is unaffected
  assert.equal((await req(port, `/api/s/${sid}/unlock`, { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.10' }, body: JSON.stringify({ password: 'right-one' }) })).status, 200)
})

test('file names a client sees carry no hidden direction characters', async () => {
  const { port, store } = await start(TEST_WORK)
  const sid = id()
  const evil = 'invoice\u202Efdp.exe'
  writeShare(store, sid, ['x'], { names: [evil] })
  const meta = JSON.parse((await req(port, `/api/s/${sid}`)).body)
  assert.equal(meta.files[0].name, 'invoicefdp.exe')
  const d = await req(port, `/d/${sid}/0`)
  assert.ok(!/%E2%80%AE|\u202e/i.test(d.headers['content-disposition']), d.headers['content-disposition'])
  assert.equal(S.safeFileName('a\u2066b\u200fc.pdf'), 'abc.pdf')
})

test('from outside, /healthz never says whether the office file server is reachable', async () => {
  const { app, port, store } = await start(TEST_WORK)
  fs.renameSync(store, store + '-gone')
  after(() => fs.rmSync(store + '-gone', { recursive: true, force: true }))
  await app.cleanup() // notices the store is gone
  assert.equal((await req(port, '/healthz')).status, 503) // the supervisor, on loopback, is told
  const pub = await req(port, '/healthz', { host: 'abc.trycloudflare.com' })
  assert.equal(pub.status, 200)
  assert.equal(JSON.parse(pub.body).ok, true)
  fs.renameSync(store + '-gone', store)
})

test('a download limit cannot be beaten by starting several downloads at once', async () => {
  const { port, store } = await start(TEST_WORK)
  const sid = id()
  writeShare(store, sid, ['z'.repeat(4 << 20)], { maxDownloads: 1 })
  const first = await req(port, `/d/${sid}/0`, { stop: true })
  assert.equal(first.status, 200)
  const second = await req(port, `/d/${sid}/0`)
  assert.equal(second.status, 410)
  first.close()
})

test('the client-address header is ignored behind a front that is not Cloudflare', () => {
  const dir = path.join(TEST_WORK, `cfg-${process.pid}`)
  fs.mkdirSync(path.join(dir, 'store'), { recursive: true })
  after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, JSON.stringify({ server: { store: path.join(dir, 'store') }, tunnel: { mode: 'external', publicBase: 'https://files.example.org' } }))
  const cfg = S.loadConfig(file, {})
  assert.equal(cfg.clientIpHeader, '')
  assert.ok(cfg.allowedHosts.includes('files.example.org'))
  fs.writeFileSync(file, JSON.stringify({ server: { store: path.join(dir, 'store') }, tunnel: { mode: 'quick' } }))
  assert.equal(S.loadConfig(file, {}).clientIpHeader, 'cf-connecting-ip')
})
