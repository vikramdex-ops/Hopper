// Dexterity Share supervisor against a stand-in cloudflared (pubshare-fake-cloudflared.mjs) and a
// local mock of GitHub's contents API. No tunnel is opened and nothing leaves this PC.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { TEST_WORK } from './pubshare-hooks.mjs'
import * as V from '../../server/dexterity-share/supervisor.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FAKE = path.join(HERE, 'pubshare-fake-cloudflared.mjs')
const SUPERVISOR = path.join(HERE, '..', '..', 'server', 'dexterity-share', 'supervisor.mjs')
const WORK = path.join(TEST_WORK, 'sup')
fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
async function until(fn, ms = 20000, what = 'condition') {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

// ---- a minimal GitHub contents API ------------------------------------------------------------
const gh = { files: new Map(), puts: 0, conflictNext: 0, token: 'test-token-123', seenAuth: new Set() }
const ghServer = http.createServer(async (req, res) => {
  gh.seenAuth.add(req.headers.authorization)
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
  if (req.headers.authorization !== `Bearer ${gh.token}`) return send(401, { message: 'Bad credentials' })
  const m = /^\/repos\/([\w.-]+\/[\w.-]+)\/contents\/([^?]+)(?:\?ref=(.+))?$/.exec(req.url)
  if (!m) return send(404, { message: 'Not Found' })
  const key = `${m[1]}:${decodeURIComponent(m[2])}`
  const cur = gh.files.get(key)
  if (req.method === 'GET') return cur ? send(200, { sha: cur.sha, content: Buffer.from(cur.text).toString('base64'), encoding: 'base64' }) : send(404, { message: 'Not Found' })
  if (req.method === 'PUT') {
    let body = ''
    for await (const c of req) body += c
    const j = JSON.parse(body)
    gh.puts++
    if (gh.conflictNext > 0) { gh.conflictNext--; return send(409, { message: 'is at abc but expected def' }) }
    if (cur && j.sha !== cur.sha) return send(cur && !j.sha ? 422 : 409, { message: 'sha mismatch' })
    const text = Buffer.from(j.content, 'base64').toString('utf8')
    gh.files.set(key, { text, sha: crypto.createHash('sha1').update(text).digest('hex'), branch: j.branch })
    return send(cur ? 200 : 201, { content: { sha: gh.files.get(key).sha } })
  }
  send(405, {})
})
await new Promise((r) => ghServer.listen(0, '127.0.0.1', r))
const GH = `http://127.0.0.1:${ghServer.address().port}`
after(() => ghServer.close())

function makeConfig(name, { mode = 'quick', script = [{ url: 'https://calm-river-12ab.trycloudflare.com' }], pointer = true, extra = {} } = {}) {
  const dir = path.join(WORK, name)
  const store = path.join(dir, 'store')
  const fake = path.join(dir, 'fake')
  fs.mkdirSync(store, { recursive: true })
  fs.mkdirSync(fake, { recursive: true })
  fs.writeFileSync(path.join(fake, 'script.json'), JSON.stringify(script))
  fs.writeFileSync(path.join(dir, 'pointer-token.txt'), gh.token + '\n')
  fs.writeFileSync(path.join(dir, 'tunnel-token.txt'), 'eyJhIjoiTEST-TUNNEL-TOKEN\n')
  return { dir, store, fake, file: path.join(dir, 'config.json'), write: async () => {
    const port = await freePort()
    process.env.FAKE_CF_DIR = fake // the stand-in reads its script from here (tests in this file run one at a time)
    const cfg = {
      server: { port, store, allowedOrigins: ['https://vikramdex-ops.github.io'] },
      tunnel: { mode, command: [process.execPath, '--no-warnings', FAKE], checkSeconds: 0.4, verifySeconds: 4, ...(mode !== 'quick' ? { publicBase: 'https://share.dexterity.example' } : {}), ...(mode === 'named' ? { tokenFile: 'tunnel-token.txt' } : {}), ...extra },
      ...(pointer ? { pointer: { github: { api: GH, repo: 'dexterity/share-pointer', path: 'pointer.json' } } } : {})
    }
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2))
    return port
  } }
}

/** fetch as the supervisor sees the world: public names resolve to the local server only while "reachable". */
function world(port, reachable) {
  return (url, init) => {
    const u = String(url)
    const m = /^https:\/\/([a-z0-9.-]+)(\/.*)$/.exec(u)
    if (m && !u.startsWith(GH)) {
      if (!reachable.has(m[1])) return Promise.reject(new TypeError('fetch failed'))
      return fetch(`http://127.0.0.1:${port}${m[2]}`, init)
    }
    return fetch(u, init)
  }
}

test('parseQuickUrl: the lines cloudflared prints', () => {
  assert.equal(V.parseQuickUrl('2026-11-10T08:00:01Z INF |  https://calm-river-12ab.trycloudflare.com                                                   |'), 'https://calm-river-12ab.trycloudflare.com')
  assert.equal(V.parseQuickUrl('INF |  https://Paper-Lamps-Xyz-Demo.trycloudflare.com  |'), 'https://paper-lamps-xyz-demo.trycloudflare.com')
  assert.equal(V.parseQuickUrl('\u001b[32mINF\u001b[0m https://abc.trycloudflare.com\u001b[0m'), 'https://abc.trycloudflare.com')
  for (const line of [
    'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded',
    'INF Requesting new quick Tunnel on trycloudflare.com...',
    'INF Thank you for trying Cloudflare Tunnel ... (https://www.cloudflare.com/website-terms/)',
    'http://plain.trycloudflare.com', 'https://evil.trycloudflare.com.attacker.example/', 'https://trycloudflare.com', 'https://a.b.trycloudflare.com', 'https://-bad.trycloudflare.com', ''
  ]) assert.equal(V.parseQuickUrl(line), null, line)
})

test('normalizeBase: https origins only', () => {
  assert.equal(V.normalizeBase('https://share.example.com/'), 'https://share.example.com')
  assert.equal(V.normalizeBase('https://Share.Example.com:8443/path?x#y'), 'https://share.example.com:8443')
  for (const bad of ['http://share.example.com', 'ftp://x', 'javascript:alert(1)', 'https://user:pw@x.test', 'share.example.com', '', null]) assert.equal(V.normalizeBase(bad), null)
})

test('pointer: signed by the server key; the browser-side check (WebCrypto) accepts it and rejects tampering', async () => {
  const stateDir = path.join(WORK, 'key-state')
  const { privateKey, publicJwk } = V.loadPointerKey(stateDir)
  assert.deepEqual(Object.keys(publicJwk), ['kty', 'crv', 'x', 'y'], 'public parts only')
  assert.ok(!fs.readFileSync(path.join(stateDir, 'pointer-public.json'), 'utf8').includes('"d"'))
  const again = V.loadPointerKey(stateDir)
  assert.deepEqual(again.publicJwk, publicJwk, 'the key is created once and reused')
  const p = V.buildPointer('https://calm-river-12ab.trycloudflare.com', privateKey, '2026-11-10T08:00:00.000Z')
  assert.equal(V.verifyPointer(p, crypto.createPublicKey({ key: publicJwk, format: 'jwk' })), true)
  // exactly what site/share/share.js does
  const key = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const check = (q) => crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(q.sig, 'base64url'), new TextEncoder().encode(`dxshare-pointer-v1\n${q.base}\n${q.updated}`))
  assert.equal(await check(p), true)
  assert.equal(await check({ ...p, base: 'https://evil-site-0000.trycloudflare.com' }), false)
  assert.equal(await check({ ...p, updated: '2027-01-01T00:00:00.000Z' }), false)
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
  assert.equal(await check(V.buildPointer(p.base, other, p.updated)), false, 'signed with another key')
  assert.equal(V.buildPointer('https://x.test', null).sig, undefined)
})

test('publishPointer: create, unchanged, update, conflict retry, bad token', async () => {
  const base = { api: GH, repo: 'dexterity/unit-pointer', branch: 'main', file: 'pointer.json', token: gh.token }
  const p1 = V.buildPointer('https://one-aaaa.trycloudflare.com', null)
  assert.equal(await V.publishPointer({ ...base, pointer: p1 }), 'published')
  assert.equal(JSON.parse(gh.files.get('dexterity/unit-pointer:pointer.json').text).base, p1.base)
  const puts = gh.puts
  assert.equal(await V.publishPointer({ ...base, pointer: V.buildPointer(p1.base, null) }), 'unchanged')
  assert.equal(gh.puts, puts, 'no commit when the address has not changed')
  assert.equal(await V.publishPointer({ ...base, pointer: V.buildPointer('https://two-bbbb.trycloudflare.com', null) }), 'published')
  gh.conflictNext = 1
  assert.equal(await V.publishPointer({ ...base, pointer: V.buildPointer('https://three-cccc.trycloudflare.com', null) }), 'published')
  assert.equal(JSON.parse(gh.files.get('dexterity/unit-pointer:pointer.json').text).base, 'https://three-cccc.trycloudflare.com')
  gh.conflictNext = 5
  await assert.rejects(V.publishPointer({ ...base, pointer: V.buildPointer('https://four-dddd.trycloudflare.com', null) }), /409/)
  gh.conflictNext = 0
  const err = await V.publishPointer({ ...base, token: 'wrong-token-VALUE', pointer: p1 }).catch((e) => e)
  assert.match(err.message, /401.*check the token/)
  assert.ok(!err.message.includes('wrong-token-VALUE'))
  await assert.rejects(V.publishPointer({ ...base, repo: '../../etc', pointer: p1 }), /owner\/name/)
})

test('config: modes and their requirements', async () => {
  const c = makeConfig('cfg')
  await c.write()
  const cfg = V.loadSupervisorConfig(c.file, {})
  assert.equal(cfg.tunnel.mode, 'quick')
  assert.equal(cfg.pointer.repo, 'dexterity/share-pointer')
  assert.equal(cfg.pointer.tokenFile, path.join(c.dir, 'pointer-token.txt'))
  const raw = JSON.parse(fs.readFileSync(c.file, 'utf8'))
  const tryWith = (tunnel) => { fs.writeFileSync(c.file, JSON.stringify({ ...raw, tunnel })); return V.loadSupervisorConfig(c.file, {}) }
  assert.throws(() => tryWith({ mode: 'magic' }), /tunnel\.mode/)
  assert.throws(() => tryWith({ mode: 'external' }), /publicBase/)
  assert.throws(() => tryWith({ mode: 'external', publicBase: 'http://insecure.example' }), /publicBase/)
  assert.throws(() => tryWith({ mode: 'named', publicBase: 'https://s.example.com' }), /tokenFile/)
  assert.equal(tryWith({ mode: 'external', publicBase: 'https://s.example.com/' }).tunnel.publicBase, 'https://s.example.com')
})

test('quick tunnel: address learnt, verified from outside, pointer signed and published, heartbeat written; new address after the tunnel dies; restart when the address stops answering; clean stop', { timeout: 120000 }, async () => {
  const c = makeConfig('quick', { script: [{ fail: true }, { url: 'https://first-aaaa-1111.trycloudflare.com', liveMs: 6000 }, { url: 'https://second-bbbb-2222.trycloudflare.com' }, { url: 'https://third-cccc-3333.trycloudflare.com' }] })
  const port = await c.write()
  const cfg = V.loadSupervisorConfig(c.file, {})
  const reachable = new Set(['first-aaaa-1111.trycloudflare.com', 'second-bbbb-2222.trycloudflare.com', 'third-cccc-3333.trycloudflare.com'])
  const sup = new V.Supervisor(cfg, { fetch: world(port, reachable) })
  const seen = (ev, pred = () => true) => sup.events.some((e) => e.event === ev && pred(e))
  const pointer = () => { const f = gh.files.get('dexterity/share-pointer:pointer.json'); return f ? JSON.parse(f.text) : null }
  const beat = () => { try { return JSON.parse(fs.readFileSync(path.join(c.store, '_server.json'), 'utf8')) } catch { return null } }
  await sup.start()
  try {
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).ok, true, 'share server is up')
    // launch 1 fails to get a tunnel (and prints the api.trycloudflare.com address, which must not be taken for ours)
    await until(() => seen('tunnel-exited'), 15000, 'first tunnel failure')
    assert.equal(sup.base, null)
    assert.equal(pointer(), null, 'nothing published from a failed launch')
    // launch 2 works
    await until(() => seen('pointer-published', (e) => e.base === 'https://first-aaaa-1111.trycloudflare.com'), 20000, 'first address published')
    const p1 = pointer()
    assert.equal(p1.base, 'https://first-aaaa-1111.trycloudflare.com')
    const pub = crypto.createPublicKey({ key: JSON.parse(fs.readFileSync(path.join(cfg.server.stateDir, 'pointer-public.json'), 'utf8')), format: 'jwk' })
    assert.equal(V.verifyPointer(p1, pub), true, 'published pointer carries a valid signature')
    await until(() => beat()?.base === p1.base && beat().healthy === true, 5000, 'heartbeat')
    assert.equal(beat().mode, 'quick')
    // it dies after 6 s; launch 3 brings a different address, which replaces the pointer
    await until(() => pointer()?.base === 'https://second-bbbb-2222.trycloudflare.com', 30000, 'second address published')
    assert.equal(V.verifyPointer(pointer(), pub), true)
    await until(() => beat()?.base === 'https://second-bbbb-2222.trycloudflare.com', 5000, 'heartbeat follows')
    assert.ok(seen('tunnel-exited', (e) => e.restartInMs >= 2000), 'restart is delayed (back-off)')
    // the address stops answering from outside (tunnel up, route dead): three failed checks, then a fresh tunnel
    reachable.delete('second-bbbb-2222.trycloudflare.com')
    await until(() => seen('tunnel-restart', (e) => /stopped answering/.test(e.why)), 15000, 'restart after failed public checks')
    assert.ok(sup.events.filter((e) => e.event === 'public-check-failed').length >= 3)
    await until(() => pointer()?.base === 'https://third-cccc-3333.trycloudflare.com', 40000, 'third address published')
    // the share server crashing is noticed and repaired without touching the tunnel
    const serverPid = sup.server.pid
    const launchesBefore = Number(fs.readFileSync(path.join(c.fake, 'launches.txt'), 'utf8'))
    process.kill(serverPid)
    await until(() => seen('server-exited'), 5000, 'server exit noticed')
    await until(async () => sup.server && sup.server.pid !== serverPid && (await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false)), 20000, 'server restarted')
    assert.equal(Number(fs.readFileSync(path.join(c.fake, 'launches.txt'), 'utf8')), launchesBefore, 'tunnel left alone')
    // nothing secret in the supervisor log
    const logText = fs.readFileSync(path.join(cfg.server.logDir, 'supervisor.log'), 'utf8')
    assert.ok(!logText.includes(gh.token) && !logText.includes('BEGIN PRIVATE KEY'))
    assert.deepEqual([...gh.seenAuth].filter((a) => a !== `Bearer ${gh.token}` && a !== 'Bearer wrong-token-VALUE'), [], 'token only ever sent to the pointer API')
  } finally {
    const pids = [sup.server?.pid, sup.tunnel?.pid].filter(Boolean)
    await sup.stop()
    await sleep(300)
    for (const pid of pids) assert.equal(alive(pid), false, `child ${pid} still running after stop`)
    assert.equal(beat().base, null)
    assert.equal(beat().stopped, true)
    assert.ok(!fs.existsSync(path.join(cfg.server.stateDir, 'cloudflared.pid')))
  }
})

test('quick tunnel whose address never becomes reachable is thrown away and replaced; pointer stays untouched meanwhile', { timeout: 60000 }, async () => {
  const c = makeConfig('unreachable', { script: [{ url: 'https://dead-dddd-0000.trycloudflare.com' }, { url: 'https://live-eeee-9999.trycloudflare.com' }], extra: { verifySeconds: 2 } })
  const port = await c.write()
  const cfg = V.loadSupervisorConfig(c.file, {})
  gh.files.delete('dexterity/share-pointer:pointer.json')
  const sup = new V.Supervisor(cfg, { fetch: world(port, new Set(['live-eeee-9999.trycloudflare.com'])) })
  await sup.start()
  try {
    await until(() => sup.events.some((e) => e.event === 'public-address-not-reachable'), 15000, 'dead address detected')
    assert.equal(gh.files.has('dexterity/share-pointer:pointer.json'), false, 'an unverified address is never published')
    await until(() => gh.files.get('dexterity/share-pointer:pointer.json')?.text.includes('live-eeee-9999'), 30000, 'working address published')
  } finally {
    await sup.stop()
  }
})

test('pointer publishing failure is retried on later checks (GitHub down, then back)', { timeout: 60000 }, async () => {
  const c = makeConfig('gh-down', { script: [{ url: 'https://retry-ffff-4444.trycloudflare.com' }] })
  const port = await c.write()
  const cfg = V.loadSupervisorConfig(c.file, {})
  gh.files.delete('dexterity/share-pointer:pointer.json')
  let githubUp = false
  const w = world(port, new Set(['retry-ffff-4444.trycloudflare.com']))
  const sup = new V.Supervisor(cfg, { fetch: (u, i) => (String(u).startsWith(GH) && !githubUp ? Promise.reject(new TypeError('fetch failed')) : w(u, i)) })
  await sup.start()
  try {
    await until(() => sup.events.some((e) => e.event === 'pointer-failed'), 20000, 'failure logged')
    // Hopper still learns the address from the store (the heartbeat is written right after the failed publish)
    await until(() => { try { return JSON.parse(fs.readFileSync(path.join(c.store, '_server.json'), 'utf8')).base === 'https://retry-ffff-4444.trycloudflare.com' } catch { return false } }, 5000, 'heartbeat with the address')
    githubUp = true
    await until(() => gh.files.get('dexterity/share-pointer:pointer.json')?.text.includes('retry-ffff-4444'), 15000, 'published once GitHub is back')
  } finally {
    await sup.stop()
  }
})

test('named tunnel: fixed address, token handed over in the environment (never on the command line)', { timeout: 60000 }, async () => {
  const c = makeConfig('named', { mode: 'named', pointer: false })
  const port = await c.write()
  const cfg = V.loadSupervisorConfig(c.file, {})
  const sup = new V.Supervisor(cfg, { fetch: world(port, new Set(['share.dexterity.example'])) })
  await sup.start()
  try {
    await until(() => sup.events.some((e) => e.event === 'public-address-verified'), 20000, 'verified')
    assert.equal(sup.base, 'https://share.dexterity.example')
    await until(() => fs.existsSync(path.join(c.fake, 'launch-log.jsonl')), 10000, 'tunnel process to start')
    const launch = JSON.parse(fs.readFileSync(path.join(c.fake, 'launch-log.jsonl'), 'utf8').trim().split('\n')[0])
    assert.deepEqual(launch.args, ['tunnel', '--no-autoupdate', 'run'])
    assert.equal(launch.token, 'eyJhIjoiTEST-TUNNEL-TOKEN')
    assert.ok(!launch.args.join(' ').includes('TEST-TUNNEL-TOKEN'))
    assert.ok(!fs.readFileSync(path.join(cfg.server.logDir, 'supervisor.log'), 'utf8').includes('TEST-TUNNEL-TOKEN'))
    await until(() => JSON.parse(fs.readFileSync(path.join(c.store, '_server.json'), 'utf8')).base === 'https://share.dexterity.example', 5000, 'heartbeat')
  } finally {
    await sup.stop()
  }
})

test('external mode (cloudflared service, Tailscale Funnel, ...): no tunnel process, health checks only', { timeout: 60000 }, async () => {
  const c = makeConfig('external', { mode: 'external', pointer: false })
  const port = await c.write()
  const cfg = V.loadSupervisorConfig(c.file, {})
  const reachable = new Set(['share.dexterity.example'])
  const sup = new V.Supervisor(cfg, { fetch: world(port, reachable) })
  await sup.start()
  try {
    await until(() => sup.events.some((e) => e.event === 'public-address-verified'), 20000, 'verified')
    assert.equal(sup.tunnel, null)
    assert.equal(fs.existsSync(path.join(c.fake, 'launches.txt')), false, 'cloudflared never started')
    reachable.clear()
    await until(() => sup.events.filter((e) => e.event === 'public-check-failed').length >= 4, 15000, 'failures logged')
    assert.equal(JSON.parse(fs.readFileSync(path.join(c.store, '_server.json'), 'utf8')).healthy, false, 'heartbeat says unhealthy')
    assert.ok(!sup.events.some((e) => e.event === 'tunnel-restart'))
  } finally {
    await sup.stop()
  }
})

test('as a process: --check reports; a hard-killed supervisor leaves no server behind; a stale pid that is not cloudflared is never killed', { timeout: 90000 }, async () => {
  const c = makeConfig('proc', { script: [{ url: 'https://proc-gggg-5555.trycloudflare.com' }], extra: { publicCheck: false } })
  const port = await c.write()
  const env = { ...process.env, DXSHARE_CONFIG: c.file, FAKE_CF_DIR: c.fake }
  const chk = spawnSync(process.execPath, ['--no-warnings', SUPERVISOR, '--check'], { env, encoding: 'utf8', timeout: 30000 })
  assert.equal(chk.status, 0, chk.stdout + chk.stderr)
  assert.match(chk.stdout, /ok\s+store folder/)
  assert.match(chk.stdout, /cloudflared: cloudflared version 2026\.1\.0/)
  assert.match(chk.stdout, /pointer public key.*"kty":"EC"/)
  assert.ok(!chk.stdout.includes(gh.token))
  // a bystander process whose id sits in the stale pid file: it is node, not cloudflared, and must survive
  const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' })
  fs.mkdirSync(path.join(c.dir, 'state'), { recursive: true })
  fs.writeFileSync(path.join(c.dir, 'state', 'cloudflared.pid'), String(bystander.pid))
  const sup = spawn(process.execPath, ['--no-warnings', SUPERVISOR], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  sup.stdout.on('data', (d) => (out += d))
  sup.stderr.on('data', (d) => (out += d))
  try {
    await until(() => /pointer-published/.test(out), 30000, `supervisor to publish (got: ${out.slice(-400)})`)
    assert.equal(alive(bystander.pid), true, 'unrelated process was not touched')
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).ok, true)
    assert.match(gh.files.get('dexterity/share-pointer:pointer.json').text, /proc-gggg-5555/)
    sup.kill('SIGKILL') // power-cut style: no chance to tidy up
    await until(() => fetch(`http://127.0.0.1:${port}/healthz`).then(() => false, () => true), 15000, 'orphaned share server to exit by itself')
  } finally {
    bystander.kill()
    sup.kill()
    // the stand-in tunnel is a plain node process the dead supervisor could not stop: end it here
    for (const line of fs.readFileSync(path.join(c.fake, 'launch-log.jsonl'), 'utf8').trim().split('\n')) { try { process.kill(JSON.parse(line).pid) } catch {} }
  }
})

test('bad configuration: the supervisor refuses to start with a readable message', () => {
  const dir = path.join(WORK, 'badcfg')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ server: { store: 'relative' } }))
  const r = spawnSync(process.execPath, ['--no-warnings', SUPERVISOR], { env: { ...process.env, DXSHARE_CONFIG: path.join(dir, 'config.json') }, encoding: 'utf8', timeout: 20000 })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /"store" must be an absolute folder path/)
})
