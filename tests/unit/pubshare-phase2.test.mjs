// Dexterity Share, plug-and-play additions: bandwidth limit and schedule, the gist pointer (token
// check, create, publish) against a local stand-in for GitHub, self-contained link addresses, and
// the supervisor running the server in-process the way Hopper hosts it.
import { TEST_WORK } from './pubshare-hooks.mjs'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable, Writable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import * as S from '../../server/dexterity-share/server.mjs'
import * as V from '../../server/dexterity-share/supervisor.mjs'

const P = await import('../../src/shared/pubshare.ts')
const WORK = path.join(TEST_WORK, 'phase2')
fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
fs.mkdirSync(WORK, { recursive: true })
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pubshare-fake-cloudflared.mjs')
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
async function until(fn, ms = 20000, what = 'condition') {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

// ---- stand-in for GitHub's user and gist API ------------------------------------------------------
const gh = { gists: new Map(), tokens: new Map([['ghp_gistonly', { login: 'vikramdex-ops', scopes: 'gist' }], ['ghp_toomuch', { login: 'vikramdex-ops', scopes: 'repo, gist, workflow' }], ['ghp_nogist', { login: 'someone', scopes: 'read:user' }], ['github_pat_fine', { login: 'vikramdex-ops', scopes: null }]]), patches: 0 }
const ghServer = http.createServer(async (req, res) => {
  const send = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)) }
  const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '')
  const who = gh.tokens.get(auth)
  let body = ''
  for await (const c of req) body += c
  const gist = /^\/gists\/([0-9a-f]+)$/.exec(req.url)
  if (req.method === 'GET' && gist && !auth) return gh.gists.has(gist[1]) ? send(200, gh.gists.get(gist[1])) : send(404, {})
  if (!who) return send(401, { message: 'Bad credentials' })
  const scopeHeader = who.scopes == null ? {} : { 'X-OAuth-Scopes': who.scopes }
  const canGist = who.scopes == null || who.scopes.split(', ').includes('gist')
  if (req.url === '/user') return send(200, { login: who.login }, scopeHeader)
  if (req.url === '/gists' && req.method === 'POST') {
    if (!canGist) return send(404, { message: 'Not Found' })
    const j = JSON.parse(body)
    const id = crypto.randomBytes(16).toString('hex')
    gh.gists.set(id, { id, public: j.public, owner: { login: who.login }, description: j.description, files: Object.fromEntries(Object.entries(j.files).map(([n, f]) => [n, { filename: n, content: f.content }])) })
    return send(201, gh.gists.get(id))
  }
  if (gist) {
    const g = gh.gists.get(gist[1])
    if (!g) return send(404, {})
    if (req.method === 'GET') return send(200, g)
    if (req.method === 'PATCH') {
      if (!canGist || g.owner.login !== who.login) return send(404, { message: 'Not Found' })
      gh.patches++
      for (const [n, f] of Object.entries(JSON.parse(body).files)) g.files[n] = { filename: n, content: f.content }
      return send(200, g)
    }
  }
  send(404, {})
})
await new Promise((r) => ghServer.listen(0, '127.0.0.1', r))
const GH = `http://127.0.0.1:${ghServer.address().port}`
after(() => ghServer.close())

test('currentLimit: total limit, office-hours limit, schedule edges', () => {
  const at = (day, h, m = 0) => new Date(2026, 10, 8 + day, h, m) // 8 Nov 2026 is a Sunday
  assert.equal(S.currentLimit(undefined), 0)
  assert.equal(S.currentLimit({ mbps: 0, officeMbps: 0 }), 0)
  assert.equal(S.currentLimit({ mbps: 40, officeMbps: 0 }, at(1, 11)), 5_000_000)
  const bw = { mbps: 40, officeMbps: 8, officeDays: [1, 2, 3, 4, 5, 6], officeFrom: '09:00', officeTo: '19:00' }
  assert.equal(S.currentLimit(bw, at(1, 11)), 1_000_000, 'Monday 11:00 is office time')
  assert.equal(S.currentLimit(bw, at(1, 8, 59)), 5_000_000, 'before opening')
  assert.equal(S.currentLimit(bw, at(1, 9, 0)), 1_000_000, 'from opening')
  assert.equal(S.currentLimit(bw, at(1, 19, 0)), 5_000_000, 'closing time is outside')
  assert.equal(S.currentLimit(bw, at(0, 11)), 5_000_000, 'Sunday')
  assert.equal(S.currentLimit({ ...bw, mbps: 0 }, at(0, 11)), 0, 'no total limit: unlimited outside office hours')
  assert.equal(S.currentLimit({ ...bw, mbps: 0 }, at(2, 15)), 1_000_000)
  assert.equal(S.currentLimit({ ...bw, mbps: 4 }, at(2, 15)), 500_000, 'the lower of the two applies')
  assert.equal(S.currentLimit({ mbps: -5, officeMbps: 'x' }), 0, 'nonsense is "no limit", never a crash')
  assert.equal(S.currentLimit({ ...bw, officeFrom: 'soon', officeTo: '' }, at(1, 10)), 1_000_000, 'bad times fall back to 09:00–19:00')
})

test('Throttle: holds a stream to its allowance, passes everything unchanged, no limit = no delay', async () => {
  const data = crypto.randomBytes(600_000)
  const run = async (rate) => {
    const chunks = []
    const t0 = Date.now()
    await pipeline(Readable.from([data.subarray(0, 250_000), data.subarray(250_000)]), new S.Throttle(() => rate), new Writable({ write(c, _e, cb) { chunks.push(c); cb() } }))
    return { ms: Date.now() - t0, out: Buffer.concat(chunks) }
  }
  const free = await run(0)
  assert.ok(free.out.equals(data))
  assert.ok(free.ms < 300, `unlimited took ${free.ms} ms`)
  const slow = await run(400_000) // 600 kB at 400 kB/s: about 1.5 s
  assert.ok(slow.out.equals(data), 'bytes intact and in order')
  assert.ok(slow.ms > 1000 && slow.ms < 2600, `limited to 400 kB/s took ${slow.ms} ms`)
})

test('link addresses: self-contained form, parsing, old form still valid', () => {
  const id = 'a'.repeat(26)
  const pointer = { gist: 'a684999d09445ad681c92b7d695085a2', key: '0123456789abcdef0123' }
  const url = P.shareUrl('https://vikramdex-ops.github.io/Hopper/share/', id, pointer)
  assert.equal(url, `https://vikramdex-ops.github.io/Hopper/share/#${id}.${pointer.gist}.${pointer.key}`)
  assert.equal(new URL(url).search, '')
  assert.deepEqual(P.parseShareRef(new URL(url).hash), { id, ...pointer })
  assert.deepEqual(P.parseShareRef('#' + id), { id, gist: null, key: null })
  assert.equal(P.shareUrl(undefined, id, null), `https://dexterity-share.pages.dev/#${id}`)
  assert.equal(P.shareUrl(undefined, id, { gist: 'not-hex', key: pointer.key }), `https://dexterity-share.pages.dev/#${id}`, 'a damaged pointer setting never produces a broken link')
  for (const bad of ['', '#x', `#${id}.`, `#${id}.${pointer.gist}`, `#${id}.${pointer.gist}.short`, `#${id}.${pointer.gist}.${pointer.key}.more`, `#${id.toUpperCase()}`]) assert.equal(P.parseShareRef(bad), null, bad)
  assert.ok(url.length < 140, 'fits on one line of an e-mail')
})

test('pointer key fingerprint: 80 bits of the public key, stable, different per key', () => {
  const a = V.loadPointerKey(path.join(WORK, 'key-a'))
  const b = V.loadPointerKey(path.join(WORK, 'key-b'))
  assert.match(V.keyHash(a.publicJwk), /^[0-9a-f]{20}$/)
  assert.equal(V.keyHash(a.publicJwk), V.keyHash(V.loadPointerKey(path.join(WORK, 'key-a')).publicJwk))
  assert.notEqual(V.keyHash(a.publicJwk), V.keyHash(b.publicJwk))
  const p = V.buildPointer('https://x-1.trycloudflare.com', a.privateKey, undefined, a.publicJwk)
  assert.equal(p.v, 2)
  assert.deepEqual(p.key, a.publicJwk)
  assert.ok(!JSON.stringify(p).includes('"d"'), 'never the private part')
  assert.equal(V.verifyPointer(p, crypto.createPublicKey({ key: p.key, format: 'jwk' })), true)
})

test('gist token check: only-gist accepted, too-broad reported, no-gist and bad tokens refused with advice', async () => {
  const ok = await V.checkGistToken({ api: GH, token: 'ghp_gistonly' })
  assert.deepEqual(ok, { login: 'vikramdex-ops', scopes: ['gist'], extra: [] })
  const broad = await V.checkGistToken({ api: GH, token: 'ghp_toomuch' })
  assert.deepEqual(broad.extra, ['repo', 'workflow'])
  const fine = await V.checkGistToken({ api: GH, token: 'github_pat_fine' })
  assert.equal(fine.scopes, null, 'fine-grained tokens do not list scopes; creating the gist is the real test')
  await assert.rejects(V.checkGistToken({ api: GH, token: 'ghp_nogist' }), /only the "gist" box/)
  await assert.rejects(V.checkGistToken({ api: GH, token: 'ghp_wrong' }), /does not accept this token/)
  await assert.rejects(V.checkGistToken({ api: GH, token: 'two words' }), /whole token/)
  await assert.rejects(V.checkGistToken({ api: 'http://127.0.0.1:9', token: 'ghp_gistonly' }), /could not be reached/)
})

test('gist pointer: create (unlisted), publish, unchanged, wrong owner, deleted gist', async () => {
  const key = V.loadPointerKey(path.join(WORK, 'key-a'))
  const p1 = V.buildPointer('https://one-aaaa.trycloudflare.com', key.privateKey, undefined, key.publicJwk)
  const id = await V.createPointerGist({ api: GH, token: 'ghp_gistonly', pointer: p1 })
  assert.match(id, /^[0-9a-f]{32}$/)
  assert.equal(gh.gists.get(id).public, false, 'not listed on the profile')
  assert.deepEqual(Object.keys(gh.gists.get(id).files), ['pointer.json'])
  assert.equal(await V.publishGistPointer({ api: GH, gistId: id, token: 'ghp_gistonly', pointer: V.buildPointer(p1.base, key.privateKey, undefined, key.publicJwk) }), 'unchanged')
  assert.equal(gh.patches, 0)
  assert.equal(await V.publishGistPointer({ api: GH, gistId: id, token: 'ghp_gistonly', pointer: V.buildPointer('https://two-bbbb.trycloudflare.com', key.privateKey, undefined, key.publicJwk) }), 'published')
  const stored = JSON.parse(gh.gists.get(id).files['pointer.json'].content)
  assert.equal(stored.base, 'https://two-bbbb.trycloudflare.com')
  assert.equal(V.verifyPointer(stored, crypto.createPublicKey({ key: stored.key, format: 'jwk' })), true)
  // a new signing key (state folder lost) replaces the stored one even though the address is the same
  const other = V.loadPointerKey(path.join(WORK, 'key-b'))
  assert.equal(await V.publishGistPointer({ api: GH, gistId: id, token: 'ghp_gistonly', pointer: V.buildPointer('https://two-bbbb.trycloudflare.com', other.privateKey, undefined, other.publicJwk) }), 'published')
  gh.tokens.set('ghp_other', { login: 'another-account', scopes: 'gist' })
  await assert.rejects(V.publishGistPointer({ api: GH, gistId: id, token: 'ghp_other', pointer: p1 }), /must belong to the account that owns the gist/)
  await assert.rejects(V.publishGistPointer({ api: GH, gistId: 'f'.repeat(32), token: 'ghp_gistonly', pointer: p1 }), /no longer exists/)
  await assert.rejects(V.publishGistPointer({ api: GH, gistId: '../x', token: 'ghp_gistonly', pointer: p1 }), /not valid/)
  await assert.rejects(V.createPointerGist({ api: GH, token: 'ghp_nogist', pointer: p1 }), /only the "gist" box/)
  await assert.rejects(V.publishGistPointer({ api: GH, gistId: id, token: 'ghp_revoked', pointer: p1 }), /no longer accepts the saved token/)
})

test('hosted in-process (as Hopper runs it): server + stand-in tunnel + gist pointer + heartbeat with health; bandwidth changed live; clean stop', { timeout: 90000 }, async () => {
  const dir = path.join(WORK, 'hosted')
  const store = path.join(dir, 'store')
  const fake = path.join(dir, 'fake')
  fs.mkdirSync(store, { recursive: true })
  fs.mkdirSync(fake, { recursive: true })
  fs.writeFileSync(path.join(fake, 'script.json'), JSON.stringify([{ url: 'https://hosted-aaaa-1111.trycloudflare.com' }]))
  process.env.FAKE_CF_DIR = fake
  const port = await freePort()
  const stateDir = path.join(dir, 'state')
  const key = V.loadPointerKey(stateDir)
  const gistId = await V.createPointerGist({ api: GH, token: 'ghp_gistonly', pointer: V.buildPointer('https://not-started.trycloudflare.com', key.privateKey, undefined, key.publicJwk) })
  let token = 'ghp_gistonly'
  const viaLocal = (u, i) => (String(u).startsWith('https://hosted-') ? fetch(String(u).replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${port}`), i) : fetch(u, i))
  const changes = []
  const sup = new V.Supervisor({
    inProcess: true, file: '', hostName: 'PC-SERVER',
    server: { port, store, allowedOrigins: ['https://vikramdex-ops.github.io'], stateDir, logDir: path.join(dir, 'logs'), bandwidth: { mbps: 0, officeMbps: 0 }, shutdownGraceSeconds: 1 },
    tunnel: { mode: 'quick', cloudflared: 'cloudflared', command: [process.execPath, '--no-warnings', FAKE], tokenFile: '', publicBase: null, protocol: '', publicCheck: true, checkSeconds: 0.4, verifySeconds: 5 },
    pointer: { kind: 'gist', api: GH, gistId }
  }, { fetch: viaLocal, getToken: () => token, onChange: (ev) => changes.push(ev) })
  await sup.start()
  try {
    await until(() => sup.events.some((e) => e.event === 'pointer-published'), 20000, 'pointer published to the gist')
    const stored = JSON.parse(gh.gists.get(gistId).files['pointer.json'].content)
    assert.equal(stored.base, 'https://hosted-aaaa-1111.trycloudflare.com')
    assert.equal(V.keyHash(stored.key), V.keyHash(key.publicJwk), 'the page can match the key to the link')
    assert.equal(sup.server, null, 'no second process was started')
    assert.ok(sup.app, 'the server runs in this process')
    const beat = await until(() => { try { const b = JSON.parse(fs.readFileSync(path.join(store, '_server.json'), 'utf8')); return b.base ? b : null } catch { return null } }, 5000, 'heartbeat')
    assert.equal(beat.host, 'PC-SERVER')
    assert.equal(beat.activeDownloads, 0)
    assert.equal(typeof beat.uptimeSec, 'number')
    assert.equal(typeof beat.bytesToday, 'number')
    assert.ok(beat.baseSince > Date.now() - 60000)
    assert.ok(beat.freeBytes === null || beat.freeBytes > 0)
    assert.equal(beat.limitMbps, 0)
    sup.app.setBandwidth({ mbps: 16, officeMbps: 0 })
    assert.equal(sup.app.health().limitMbps, 16)
    assert.ok(changes.includes('public-address-verified') && changes.includes('pointer-published'), 'the wizard is told about every change')
    // the saved token stops working (revoked on GitHub): the reason is kept for the wizard, the server keeps serving
    token = 'ghp_revoked'
    sup.pointerDirty = true
    await sup.syncPointer()
    assert.match(sup.pointerError, /no longer accepts the saved token/)
    assert.ok(!sup.pointerError.includes('ghp_revoked'))
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).ok, true)
    token = 'ghp_gistonly'
    await sup.syncPointer()
    assert.equal(sup.pointerError, '')
  } finally {
    const pid = sup.tunnel?.pid
    await sup.stop()
    await sleep(300)
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`), 'server stopped')
    if (pid) assert.throws(() => process.kill(pid, 0), 'tunnel stopped')
    assert.equal(JSON.parse(fs.readFileSync(path.join(store, '_server.json'), 'utf8')).stopped, true)
  }
})

test('a second server on a busy port reports it in words and keeps trying', { timeout: 30000 }, async () => {
  const dir = path.join(WORK, 'busy')
  fs.mkdirSync(path.join(dir, 'store'), { recursive: true })
  const blocker = net.createServer().listen(0, '127.0.0.1')
  await new Promise((r) => blocker.once('listening', r))
  const sup = new V.Supervisor({ inProcess: true, file: '', server: { port: blocker.address().port, store: path.join(dir, 'store'), allowedOrigins: [], stateDir: path.join(dir, 'state'), logDir: path.join(dir, 'logs') }, tunnel: { mode: 'external', publicBase: 'https://x.example', publicCheck: false, checkSeconds: 60, verifySeconds: 1 }, pointer: null })
  sup.startServer()
  await until(() => sup.serverError, 5000, 'error recorded')
  assert.match(sup.serverError, /Port \d+ is already in use on this PC/)
  sup.stopping = true
  blocker.close()
})
