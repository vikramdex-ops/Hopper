// Dexterity Share end-to-end: creates links exactly as Hopper does (src/engine/pubshare.ts) into a
// scratch store, runs the real share server against it and attacks it from the client side.
// Everything is written under <work-folder>\_Claude_Work\temp\share-agent\e2e (never C: on office PCs).
//   node --no-warnings tests/e2e/pubshare.mjs [--only <text>] [--keep]
import { TEST_WORK } from '../unit/pubshare-hooks.mjs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import fs, { promises as fsp } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORK = path.join(TEST_WORK, 'e2e')
process.env.TEMP = process.env.TMP = path.dirname(WORK)
const STORE = path.join(WORK, 'store')
const SRC = path.join(WORK, 'src')
const SERVER_FILE = path.join(root, 'server', 'dexterity-share', 'server.mjs')
const ORIGIN = 'https://vikramdex-ops.github.io'
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].toLowerCase() : ''

const S = await import('../../server/dexterity-share/server.mjs')
const E = await import('../../src/engine/pubshare.ts')
const P = await import('../../src/shared/pubshare.ts')

// ---- tiny harness ------------------------------------------------------------------------------
const results = []
async function check(name, fn) {
  if (only && !name.toLowerCase().includes(only)) return
  const t0 = Date.now()
  try {
    const note = await fn()
    results.push({ name, ok: true, ms: Date.now() - t0, note })
    console.log(`  ok    ${name}${note ? `  [${note}]` : ''}  (${Date.now() - t0} ms)`)
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: e })
    console.log(`  FAIL  ${name}\n        ${String(e?.stack ?? e).split('\n').slice(0, 6).join('\n        ')}`)
  }
}
function eq(a, b, msg = '') {
  if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}
function ok(v, msg) {
  if (!v) throw new Error(msg || 'assertion failed')
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// ---- raw HTTP client (fetch would tidy up "..", which is exactly what must be tested raw) --------
let PORT = 0
function request(reqPath, { method = 'GET', headers = {}, body, port = PORT, onResponse, limit = Infinity } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers, agent: false }, (res) => {
      if (onResponse) return onResponse(res, req, resolve, reject)
      const chunks = []
      let n = 0
      res.on('data', (c) => {
        chunks.push(c)
        n += c.length
        if (n >= limit) req.destroy()
      })
      const fin = (aborted) => resolve({ status: res.statusCode, headers: res.headers, raw: res.rawHeaders, body: Buffer.concat(chunks), aborted })
      res.on('end', () => fin(false))
      res.on('error', () => fin(true))
      res.on('close', () => fin(!res.complete))
    })
    // once a response has started, a broken connection is reported by the response, not here
    req.on('error', (e) => (req.res ? null : reject(e)))
    req.end(body)
  })
}
const json = (r) => JSON.parse(r.body.toString('utf8'))
const getJson = async (p, opts) => {
  const r = await request(p, opts)
  return { ...r, json: r.body.length ? json(r) : null }
}

// ---- Hopper's engine with a stand-in job queue ---------------------------------------------------
class Cancelled extends Error {}
function fakeJobs() {
  const jobs = new Map()
  let seq = 0
  return {
    jobs,
    cancelAfter: Infinity,
    create(kind, title, run) {
      const id = `j${++seq}`
      const info = { id, kind, title, state: 'running', done: 0, total: 0, files: 0, filesTotal: 0, errors: [] }
      let checkpoints = 0
      const self = this
      const ctl = {
        info,
        signal: new AbortController().signal,
        get cancelled() {
          return false
        },
        async checkpoint() {
          if (++checkpoints > self.cancelAfter) throw new Cancelled('cancelled')
        },
        add(b, f = 0) {
          info.done += b
          info.files += f
        },
        setCurrent(p) {
          info.current = p
        },
        setTotal(b, f) {
          info.total = b
          info.filesTotal = f
        },
        fail(p, m) {
          info.errors.push({ path: p, message: m })
        }
      }
      const promise = run(ctl).then((out) => ((info.state = 'done'), (info.output = out), info), (e) => ((info.state = 'failed'), (info.error = e.message), Promise.reject(e)))
      promise.catch(() => {})
      jobs.set(id, { info, promise })
      return id
    },
    wait(id) {
      return jobs.get(id).promise
    }
  }
}

let undoRecords = 0
function engine({ user = 'asha', displayName = 'Asha K', store = STORE, enabled = true, fetchImpl } = {}) {
  const jobs = fakeJobs()
  const ctx = {
    office: { publicShare: { enabled, store, pageUrl: 'https://vikramdex-ops.github.io/Hopper/share/', defaultDays: 7 } },
    settings: { officeConfigPath: path.join(WORK, 'office.json'), profile: { displayName }, archivePresets: [] },
    jobs,
    sevenZip: path.join(root, 'vendor', '7zip', '7z.exe'),
    undo: { record: () => undoRecords++ },
    emit() {}
  }
  const h = E.pubshareHandlers(ctx, { user: () => ({ user, host: 'PC-TEST-07' }), ...(fetchImpl ? { fetch: fetchImpl } : {}) })
  return {
    h,
    jobs,
    async create(spec) {
      const r = await h['pubshare.create'](spec)
      const info = await jobs.wait(r.jobId)
      return { ...r, info, manifest: JSON.parse(await fsp.readFile(path.join(store, r.id, 'manifest.json'), 'utf8')) }
    }
  }
}

function putFile(name, bytes) {
  const file = path.join(SRC, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof bytes === 'number' ? crypto.randomBytes(bytes) : bytes)
  return file
}

/** A share written by hand (for states Hopper would never produce). */
async function rawShare({ id = P.encodeShareId(crypto.randomBytes(16)), files = [Buffer.from('hello')], names, expiresAt = Date.now() + 7 * P.DAY_MS, patch = {}, store = STORE } = {}) {
  const dir = path.join(store, id)
  await fsp.mkdir(path.join(dir, 'data'), { recursive: true })
  const list = []
  for (let n = 0; n < files.length; n++) {
    await fsp.writeFile(path.join(dir, 'data', String(n)), files[n])
    list.push({ name: names?.[n] ?? `file-${n}.bin`, size: files[n].length, sha256: sha(files[n]) })
  }
  const manifest = { v: 1, id, title: 'Raw share', message: '', sender: 'Tester', createdAt: Date.now(), expiresAt, files: list, password: null, maxDownloads: 0, owner: { user: 'asha', host: 'PC-TEST-07' }, ...patch }
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  return { id, dir, manifest }
}

const serverConfig = (extra = {}) => ({
  port: 0,
  store: STORE,
  allowedOrigins: [ORIGIN],
  stateDir: path.join(WORK, 'state'),
  logDir: path.join(WORK, 'logs'),
  manifestCacheMs: 150,
  revokeCheckMs: 250,
  statsFlushMs: 300,
  maxConcurrentDownloads: 24,
  maxDownloadsPerIp: 6,
  // nearly every check here comes from 127.0.0.1; the per-minute limits get their own check below
  apiPerMinutePerIp: 100000,
  filePerMinutePerIp: 100000,
  ...extra
})

// ==================================================================================================
console.log(`Dexterity Share e2e — work folder ${WORK}`)
await fsp.rm(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
await fsp.mkdir(STORE, { recursive: true })
await fsp.mkdir(SRC, { recursive: true })
// Things next to and above the shares that must never be reachable or deleted.
await fsp.writeFile(path.join(STORE, 'secret.txt'), 'TOP-SECRET-IN-STORE')
await fsp.writeFile(path.join(WORK, 'secret.txt'), 'TOP-SECRET-ABOVE-STORE')
await fsp.writeFile(path.join(STORE, '_server.json'), '{}')

let app = S.createShareServer(serverConfig())
PORT = await app.listen()
const hopper = engine()

const big = putFile('Lot 07 isometrics (rev B).zip', 6 * 1024 * 1024 + 321)
const bigBytes = fs.readFileSync(big)
let main // the plain share most checks use

await check('create: single file, manifest written last, payload stored under a number', async () => {
  main = await hopper.create({ paths: [big], title: 'Lot 07 isometrics', message: 'Rev B as discussed.', days: 7 })
  ok(P.SHARE_ID_RE.test(main.id), 'id shape')
  eq(main.url, `https://vikramdex-ops.github.io/Hopper/share/#${main.id}`)
  const names = (await fsp.readdir(path.join(STORE, main.id))).sort()
  eq(names.join(','), 'data,manifest.json', 'share folder content')
  eq((await fsp.readdir(path.join(STORE, main.id, 'data'))).join(','), '0')
  const m = main.manifest
  eq(m.files[0].name, 'Lot 07 isometrics (rev B).zip')
  eq(m.files[0].size, bigBytes.length)
  eq(m.files[0].sha256, sha(bigBytes))
  eq(m.sender, 'Asha K')
  eq(m.password, null)
  ok(Math.abs(m.expiresAt - m.createdAt - 7 * P.DAY_MS) < 5, 'expires in 7 days')
  eq(main.info.done, main.info.total, 'progress reached 100%')
  ok(S.validateManifest(m, main.id), 'server accepts the manifest')
})

await check('metadata: public fields only, nothing about paths, host or owner', async () => {
  const r = await getJson(`/api/s/${main.id}`)
  eq(r.status, 200)
  eq(r.json.title, 'Lot 07 isometrics')
  eq(r.json.message, 'Rev B as discussed.')
  eq(r.json.sender, 'Asha K')
  eq(r.json.needsPassword, false)
  eq(r.json.files.length, 1)
  eq(r.json.files[0].sha256, sha(bigBytes))
  eq(r.json.totalSize, bigBytes.length)
  ok(Math.abs(r.json.now - Date.now()) < 5000, 'server clock included')
  eq(Object.keys(r.json).sort().join(','), 'createdAt,expiresAt,fileCount,files,message,needsPassword,now,sender,title,totalSize,unlocked,v')
  const text = r.body.toString()
  for (const leak of ['owner', 'asha"', 'PC-TEST-07', 'store', 'share-agent', os.hostname(), 'U:\\', '192.168']) ok(!text.includes(leak), `leaks ${leak}`)
  eq(r.headers['cache-control'], 'no-store')
})

await check('full download: bytes, SHA-256, headers', async () => {
  const r = await request(`/d/${main.id}/0`)
  eq(r.status, 200)
  eq(sha(r.body), main.manifest.files[0].sha256, 'sha256')
  eq(r.headers['content-length'], String(bigBytes.length))
  eq(r.headers['content-type'], 'application/octet-stream')
  eq(r.headers['accept-ranges'], 'bytes')
  eq(r.headers['x-content-type-options'], 'nosniff')
  ok(/^attachment; filename="Lot 07 isometrics \(rev B\)\.zip"; filename\*=UTF-8''Lot%2007%20isometrics%20%28rev%20B%29\.zip$/.test(r.headers['content-disposition']), r.headers['content-disposition'])
  ok(/^"[0-9a-f]{32}"$/.test(r.headers.etag), 'strong etag')
  ok(r.headers['last-modified'], 'last-modified')
  eq(r.headers['cache-control'], 'private, no-transform, max-age=0')
})

await check('resume: interrupted download continued with Range + If-Range', async () => {
  const first = await request(`/d/${main.id}/0`, { limit: 1_500_000 })
  ok(first.aborted && first.body.length >= 1_500_000 && first.body.length < bigBytes.length, `partial ${first.body.length}`)
  const got = first.body.length
  const rest = await request(`/d/${main.id}/0`, { headers: { Range: `bytes=${got}-`, 'If-Range': first.headers.etag } })
  eq(rest.status, 206)
  eq(rest.headers['content-range'], `bytes ${got}-${bigBytes.length - 1}/${bigBytes.length}`)
  eq(rest.headers['content-length'], String(bigBytes.length - got))
  eq(sha(Buffer.concat([first.body, rest.body])), sha(bigBytes), 'joined file')
  // resume by date validator too (what some browsers send)
  const byDate = await request(`/d/${main.id}/0`, { headers: { Range: 'bytes=100-199', 'If-Range': first.headers['last-modified'] } })
  eq(byDate.status, 206)
  ok(byDate.body.equals(bigBytes.subarray(100, 200)))
  return `resumed at byte ${got}`
})

await check('ranges: suffix, single byte, clamp, 416, stale If-Range, multi-range', async () => {
  const size = bigBytes.length
  const tail = await request(`/d/${main.id}/0`, { headers: { Range: 'bytes=-1000' } })
  eq(tail.status, 206)
  ok(tail.body.equals(bigBytes.subarray(size - 1000)))
  const one = await request(`/d/${main.id}/0`, { headers: { Range: 'bytes=0-0' } })
  eq(one.status, 206)
  eq(one.headers['content-range'], `bytes 0-0/${size}`)
  eq(one.body.length, 1)
  const clamp = await request(`/d/${main.id}/0`, { headers: { Range: `bytes=${size - 10}-${size + 5000}` } })
  eq(clamp.headers['content-range'], `bytes ${size - 10}-${size - 1}/${size}`)
  const beyond = await request(`/d/${main.id}/0`, { headers: { Range: `bytes=${size}-` } })
  eq(beyond.status, 416)
  eq(beyond.headers['content-range'], `bytes */${size}`)
  eq(beyond.body.length, 0)
  const stale = await request(`/d/${main.id}/0`, { headers: { Range: 'bytes=10-19', 'If-Range': '"0123456789abcdef0123456789abcdef"' } })
  eq(stale.status, 200, 'changed file is sent whole')
  eq(stale.body.length, size)
  const multi = await request(`/d/${main.id}/0`, { headers: { Range: 'bytes=0-9,20-29' } })
  eq(multi.status, 200)
  const junk = await request(`/d/${main.id}/0`, { headers: { Range: 'bytes=abc' } })
  eq(junk.status, 200)
})

await check('conditional: If-None-Match gives 304', async () => {
  const r = await request(`/d/${main.id}/0`, { method: 'HEAD' })
  const again = await request(`/d/${main.id}/0`, { headers: { 'If-None-Match': r.headers.etag } })
  eq(again.status, 304)
  eq(again.body.length, 0)
})

await check('HEAD: metadata and file answer without a body', async () => {
  const h = await request(`/d/${main.id}/0`, { method: 'HEAD' })
  eq(h.status, 200)
  eq(h.body.length, 0)
  eq(h.headers['content-length'], String(bigBytes.length))
  ok(h.headers['content-disposition'])
  const hr = await request(`/d/${main.id}/0`, { method: 'HEAD', headers: { Range: 'bytes=5-9' } })
  eq(hr.status, 206)
  eq(hr.headers['content-length'], '5')
  const hm = await request(`/api/s/${main.id}`, { method: 'HEAD' })
  eq(hm.status, 200)
  eq(hm.body.length, 0)
  ok(Number(hm.headers['content-length']) > 50)
  const hz = await request('/healthz', { method: 'HEAD' })
  eq(hz.status, 200)
})

await check('parallel: 6 downloads at once per client; the 7th is asked to wait; other clients unaffected', async () => {
  const slow = (ip) =>
    request(`/d/${main.id}/0`, {
      headers: { 'CF-Connecting-IP': ip },
      onResponse: (res, req, resolve) => {
        if (res.statusCode !== 200) return res.resume().on('end', () => resolve({ status: res.statusCode, headers: res.headers }))
        res.pause() // hold the connection open without reading
        resolve({ status: 200, finish: () => new Promise((done) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => done(Buffer.concat(c))); res.resume() }) })
      }
    })
  const held = await Promise.all(Array.from({ length: 6 }, () => slow('203.0.113.9')))
  ok(held.every((h) => h.status === 200), 'six accepted')
  eq(app.activeDownloads, 6)
  const seventh = await slow('203.0.113.9')
  eq(seventh.status, 429)
  eq(seventh.headers['retry-after'], '30')
  const other = await request(`/d/${main.id}/0`, { headers: { 'CF-Connecting-IP': '198.51.100.7' } })
  eq(other.status, 200, 'another client is served')
  const bodies = await Promise.all(held.map((h) => h.finish()))
  ok(bodies.every((b) => sha(b) === sha(bigBytes)), 'all six complete and correct')
  await sleep(50)
  eq(app.activeDownloads, 0)
})

await check('global cap: more clients than maxConcurrentDownloads get 429 busy, then recover', async () => {
  const small = S.createShareServer(serverConfig({ maxConcurrentDownloads: 3, logDir: path.join(WORK, 'logs-cap') }))
  const port = await small.listen()
  const hold = (i) => request(`/d/${main.id}/0`, { port, headers: { 'CF-Connecting-IP': `203.0.113.${i}` }, onResponse: (res, req, resolve) => { res.pause(); resolve({ status: res.statusCode, res, req }) } })
  const three = await Promise.all([1, 2, 3].map(hold))
  ok(three.every((h) => h.status === 200))
  const fourth = await getJson(`/d/${main.id}/0`, { port, headers: { 'CF-Connecting-IP': '203.0.113.4' } })
  eq(fourth.status, 429)
  eq(fourth.json.error, 'busy')
  three.forEach((h) => h.req.destroy())
  await sleep(200)
  const after = await request(`/d/${main.id}/0`, { port, headers: { 'CF-Connecting-IP': '203.0.113.4', Range: 'bytes=0-9' } })
  eq(after.status, 206)
  await small.close(500)
})

await check('large file: 5 GB sparse — Content-Length and ranges beyond 2^31 and 2^32', async () => {
  const id = P.encodeShareId(crypto.randomBytes(16))
  const dir = path.join(STORE, id)
  await fsp.mkdir(path.join(dir, 'data'), { recursive: true })
  const size = 5 * 2 ** 30 + 12345
  const marks = [[2 ** 31 - 3, 'AT-2G-BOUNDARY'], [2 ** 32 - 3, 'AT-4G-BOUNDARY'], [size - 12, 'END-OF-FILE!']]
  const fh = await fsp.open(path.join(dir, 'data', '0'), 'w')
  await fh.truncate(size)
  for (const [pos, text] of marks) await fh.write(Buffer.from(text), 0, text.length, pos)
  await fh.close()
  eq((await fsp.stat(path.join(dir, 'data', '0'))).size, size)
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ v: 1, id, title: 'Model export', message: '', sender: 'T', createdAt: Date.now(), expiresAt: Date.now() + P.DAY_MS, files: [{ name: 'model.rvm', size, sha256: 'c'.repeat(64) }], password: null, maxDownloads: 0 }))
  const meta = await getJson(`/api/s/${id}`)
  eq(meta.json.files[0].size, size)
  const head = await request(`/d/${id}/0`, { method: 'HEAD' })
  eq(head.headers['content-length'], String(size))
  for (const [pos, text] of marks) {
    const r = await request(`/d/${id}/0`, { headers: { Range: `bytes=${pos}-${pos + text.length - 1}` } })
    eq(r.status, 206, `range at ${pos}`)
    eq(r.headers['content-range'], `bytes ${pos}-${pos + text.length - 1}/${size}`)
    eq(r.body.toString(), text)
  }
  const open = await request(`/d/${id}/0`, { headers: { Range: `bytes=${2 ** 32}-` }, limit: 1 << 20 })
  eq(open.status, 206)
  eq(open.headers['content-length'], String(size - 2 ** 32))
  eq(open.headers['content-range'], `bytes ${2 ** 32}-${size - 1}/${size}`)
  const tail = await request(`/d/${id}/0`, { headers: { Range: 'bytes=-12' } })
  eq(tail.body.toString(), 'END-OF-FILE!')
  eq((await request(`/d/${id}/0`, { headers: { Range: `bytes=${size}-` } })).status, 416)
  // a full GET announces the whole 5 GB; read 3 MB of it and hang up
  const full = await request(`/d/${id}/0`, { limit: 3 << 20 })
  eq(full.headers['content-length'], String(size))
  await fsp.rm(path.join(dir, 'manifest.json'))
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  return `${(size / 2 ** 30).toFixed(2)} GB`
})

let locked
const PW = 'k7Hd-Qm3x-9TpW'
await check('password: file names hidden, download refused, unlock gives a token that works', async () => {
  locked = await hopper.create({ paths: [putFile('Confidential P&ID set.pdf', 300_000)], title: 'P&ID set', days: 3, password: PW })
  ok(!JSON.stringify(locked.manifest).includes(PW), 'password never stored')
  eq(locked.manifest.password.kdf, 'scrypt')
  const meta = await getJson(`/api/s/${locked.id}`)
  eq(meta.json.needsPassword, true)
  eq(meta.json.unlocked, false)
  eq(meta.json.files, null)
  eq(meta.json.fileCount, 1)
  ok(!meta.body.toString().includes('Confidential'), 'file name hidden before unlock')
  ok(!meta.body.toString().includes(locked.manifest.password.hash), 'verifier never sent')
  eq((await getJson(`/d/${locked.id}/0`)).status, 401)
  eq((await getJson(`/d/${locked.id}/0?t=garbage`)).json.error, 'locked')
  eq((await request(`/d/${locked.id}/0`, { method: 'HEAD' })).status, 401)
  const post = (pw, ip = '203.0.113.50', type = 'application/json') => getJson(`/api/s/${locked.id}/unlock`, { method: 'POST', headers: { 'Content-Type': type, 'CF-Connecting-IP': ip }, body: JSON.stringify({ password: pw }) })
  const wrong = await post('nope-nope')
  eq(wrong.status, 403)
  eq(wrong.json.error, 'wrong_password')
  eq(wrong.json.attemptsLeft, 7)
  const good = await post(PW)
  eq(good.status, 200)
  ok(/^[0-9a-z]+\.[A-Za-z0-9_-]{43}$/.test(good.json.token))
  eq(good.json.files[0].name, 'Confidential P&ID set.pdf')
  eq(good.json.expiresIn, 12 * 3600)
  const dl = await request(`/d/${locked.id}/0?t=${good.json.token}`)
  eq(dl.status, 200)
  eq(sha(dl.body), locked.manifest.files[0].sha256)
  const meta2 = await getJson(`/api/s/${locked.id}?t=${good.json.token}`)
  eq(meta2.json.unlocked, true)
  eq(meta2.json.files.length, 1)
  // a token is good for its own share only
  eq((await request(`/d/${main.id}/0?t=${good.json.token}`, { method: 'HEAD' })).status, 200, 'open share ignores tokens')
  const other = await hopper.create({ paths: [putFile('other.bin', 1000)], title: 'Other', days: 1, password: 'another-pass' })
  eq((await getJson(`/d/${other.id}/0?t=${good.json.token}`)).status, 401, 'token from another share')
  eq((await post(PW, '203.0.113.51', 'text/plain')).status, 415)
  eq((await getJson(`/api/s/${locked.id}/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' })).status, 400)
  eq((await getJson(`/api/s/${locked.id}/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'x'.repeat(9000) }) }).catch(() => ({ status: 413 }))).status, 413)
  eq((await getJson(`/api/s/${main.id}/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"x"}' })).status, 400, 'share without a password')
  locked.token = good.json.token
})

await check('brute force: per-client lockout with Retry-After, then a per-link lockout across clients', async () => {
  const s = await hopper.create({ paths: [putFile('guess.bin', 100)], title: 'Guess', days: 1, password: 'right-password' })
  const post = (pw, ip) => getJson(`/api/s/${s.id}/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ password: pw }) })
  const statuses = []
  for (let i = 0; i < 8; i++) statuses.push((await post(`guess-${i}`, '203.0.113.60')).status)
  eq(statuses.join(','), Array(8).fill(403).join(','))
  const lockedOut = await post('right-password', '203.0.113.60')
  eq(lockedOut.status, 429, 'even the right password is refused during the lockout')
  ok(Number(lockedOut.headers['retry-after']) > 0 && Number(lockedOut.headers['retry-after']) <= 600, 'Retry-After')
  eq((await post('right-password', '203.0.113.61')).status, 200, 'another client is not locked out')
  // 20 parallel guesses from one new client: at most 8 are even evaluated
  const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => post(`burst-${i}`, '203.0.113.62')))
  eq(burst.filter((r) => r.status === 403).length, 8, 'parallel guesses evaluated')
  eq(burst.filter((r) => r.status === 429).length, 12)
  // a spread-out attack: many clients, a few guesses each, trips the per-link limit (40 per hour)
  let n = 16
  let tripped = 0
  for (let c = 0; c < 10 && !tripped; c++) {
    for (let i = 0; i < 5; i++) {
      const r = await post(`spread-${c}-${i}`, `198.51.100.${c + 10}`)
      n++
      if (r.status === 429) {
        tripped = n
        break
      }
    }
  }
  ok(tripped > 0 && tripped <= 42, `per-link lockout after ${tripped} failures`)
  eq((await post('right-password', '198.51.100.99')).status, 429, 'link locked for everyone for the rest of the hour')
  return `link locked after ${tripped - 1} wrong guesses`
})

await check('expired: 410 with the same body shape as 404; extending from Hopper revives it', async () => {
  const s = await rawShare({ expiresAt: Date.now() - 60_000 })
  const meta = await getJson(`/api/s/${s.id}`)
  eq(meta.status, 410)
  eq(JSON.stringify(meta.json), '{"error":"expired"}')
  const missing = await getJson(`/api/s/${P.encodeShareId(crypto.randomBytes(16))}`)
  eq(missing.status, 404)
  eq(JSON.stringify(missing.json), '{"error":"not_found"}')
  eq(Object.keys(meta.headers).filter((h) => h !== 'date').sort().join(), Object.keys(missing.headers).filter((h) => h !== 'date').sort().join(), 'same header set')
  eq((await getJson(`/d/${s.id}/0`)).status, 410)
  eq((await request(`/d/${s.id}/0`, { method: 'HEAD' })).status, 410)
  eq((await getJson(`/api/s/${s.id}/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"x"}' })).status, 410)
  const until = await hopper.h['pubshare.extend'](s.id, 3)
  ok(Math.abs(until - (Date.now() + 3 * P.DAY_MS)) < 5000, 'extended from today')
  await sleep(200)
  eq((await getJson(`/api/s/${s.id}`)).status, 200, 'alive again')
  eq((await request(`/d/${s.id}/0`)).body.toString(), 'hello')
  // a link that expires while its page is open: the next request says so
  const soon = await rawShare({ expiresAt: Date.now() + 600 })
  eq((await getJson(`/api/s/${soon.id}`)).status, 200)
  await sleep(800)
  eq((await getJson(`/api/s/${soon.id}`)).status, 410)
})

await check('timing: missing and expired links answer in the same time class', async () => {
  const exp = await rawShare({ expiresAt: Date.now() - 1000 })
  const time = async (p) => {
    const t = []
    for (let i = 0; i < 40; i++) {
      const t0 = process.hrtime.bigint()
      await request(p)
      t.push(Number(process.hrtime.bigint() - t0) / 1e6)
    }
    return t.sort((a, b) => a - b)[20]
  }
  const a = await time(`/api/s/${P.encodeShareId(crypto.randomBytes(16))}`)
  const b = await time(`/api/s/${exp.id}`)
  const c = await time(`/api/s/${main.id}?quiet`)
  return `median ms — missing ${a.toFixed(1)}, expired ${b.toFixed(1)}, live ${c.toFixed(1)} (ids are 128-bit random, so timing cannot be used to find one)`
})

await check('revoke during a download: the transfer is cut, the link is gone, the folder is removed', async () => {
  const s = await hopper.create({ paths: [putFile('revoke-me.bin', 48 << 20)], title: 'Revoke me', days: 7 })
  const state = await request(`/d/${s.id}/0`, {
    onResponse: (res, req, resolve) => {
      let got = 0
      res.once('data', (c) => {
        got += c.length
        res.pause() // a client that has started and is now slow
        resolve({ status: res.statusCode, res, wait: new Promise((done) => { res.on('data', (x) => (got += x.length)); res.on('close', () => done({ complete: res.complete, got })) }) })
      })
    }
  })
  eq(state.status, 200)
  eq(app.activeDownloads, 1)
  await hopper.h['pubshare.revoke'](s.id)
  await sleep(200)
  const meta = await getJson(`/api/s/${s.id}`)
  eq(meta.status, 404, 'metadata gone at once')
  eq((await getJson(`/d/${s.id}/0`)).status, 404, 'new downloads refused')
  state.res.resume()
  const end = await state.wait
  ok(!end.complete && end.got < 48 << 20, `in-flight download was cut (${end.got} of ${48 << 20} bytes)`)
  await sleep(300)
  eq(app.activeDownloads, 0)
  // Hopper could not delete a file the server still had open; the server's clean-up finishes it
  await app.cleanup()
  ok(!fs.existsSync(path.join(STORE, s.id)), 'folder removed')
  ok(!(await hopper.h['pubshare.list']()).some((l) => l.id === s.id), 'gone from My links')
  return `cut after ${end.got} bytes`
})

await check('traversal and malformed ids: every one is the same 404, and no outside file is readable', async () => {
  const id = main.id
  const paths = [
    '/', '/d', '/d/', '/api', '/api/s', '/api/s/', `/d/${id}`, `/d/${id}/`, `/d/${id}/0/`, `/d/${id}/00`, `/d/${id}/01`, `/d/${id}/-1`, `/d/${id}/1e0`, `/d/${id}/0x0`, `/d/${id}/1`, `/d/${id}/99999`, `/d/${id}/0.0`,
    `/d/${id}/../manifest.json`, `/d/${id}/..%2fmanifest.json`, `/d/${id}/manifest.json`, `/d/${id}/data/0`, `/d/${id}/0/../../secret.txt`, `/d/${id}/..`, `/d/${id}/%2e%2e/secret.txt`,
    '/d/../secret.txt', '/d/..%2f..%2fsecret.txt', '/d/%2e%2e/%2e%2e/secret.txt', '/d/..\\..\\secret.txt', '/d/....//secret.txt', '/../secret.txt', '/..%5c..%5csecret.txt', '/secret.txt', '/_server.json', '/store/secret.txt',
    `/d/${id}%2f0`, `/d/${id}%2F0`, `/d%2f${id}%2f0`, `/d/${id}/%30`, `/d/${id.toUpperCase()}/0`, `/api/s/${id.toUpperCase()}`, `/api/s/${id}a`, `/api/s/${id.slice(1)}`, `/api/s/${id}/`, `/api/s/${id}/unlock/`, `/api/s/${id}%00`, `/api/s/${id}%0a`,
    `/api/s/${'a'.repeat(27)}`, `/api/s/${'a'.repeat(400)}`, '/api/s/..', '/api/s/%2e%2e', '/api/s/' + encodeURIComponent('図面図面図面図面図面図面図面図面図面'), `//d/${id}/0`, `/d//${id}/0`, `/D/${id}/0`, `/API/s/${id}`,
    `/d/${id}/0;x=1`, `/d/${id}/0#frag`, `/api/s/*`, `/api/s/${id.slice(0, 25)}*`, `/api/s/${id.slice(0, 25)}?`, '/api/s/manifest.json', '/.git/config', '/.env', '/admin', '/index.html', '/favicon.ico', `http://evil.example/d/${id}/../../secret.txt`
  ]
  let n = 0
  for (const p of paths) {
    const r = await request(p).catch((e) => ({ status: -1, body: Buffer.from(String(e)) }))
    const text = r.body.toString()
    ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`)
    if (r.status === 404) eq(text, '{"error":"not_found"}', p)
    ok(!text.includes('TOP-SECRET') && !text.includes('"sha256"'), `${p} leaked data`)
    n++
  }
  const long = await getJson('/api/s/' + 'a'.repeat(600))
  eq(long.status, 414)
  // raw bytes a normal client cannot send: NUL, backslashes and a bare ".." on the request line
  const rawLine = (line) => new Promise((resolve) => {
    const sock = net.connect(PORT, '127.0.0.1', () => sock.write(`GET ${line} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`))
    let out = ''
    sock.on('data', (d) => (out += d))
    sock.on('close', () => resolve(out))
    sock.on('error', () => resolve(out))
  })
  for (const line of ['/api/s/аааааааааааааааааааааааааа', '/d/\u0000/0', `/d/${id}/0\u0000.txt`, '/d/..\\..\\secret.txt', `/d/${id}/../../secret.txt`, '/d/' + '../'.repeat(40) + 'Windows/win.ini', 'secret.txt', '*']) {
    const out = await rawLine(line)
    ok(/^HTTP\/1\.1 (400|404)/.test(out), `raw ${JSON.stringify(line)} -> ${out.slice(0, 20)}`)
    ok(!out.includes('TOP-SECRET') && !/\[fonts\]|for 16-bit/i.test(out), 'leak')
    n++
  }
  // a manifest that lies about its file name still only ever serves data/<n>
  const evil = await rawShare({ files: [Buffer.from('payload-zero')], names: ['..\\..\\secret.txt'] })
  const r = await request(`/d/${evil.id}/0`)
  eq(r.body.toString(), 'payload-zero')
  ok(/filename="\.\._\.\._secret\.txt"/.test(r.headers['content-disposition']), r.headers['content-disposition'])
  // a share folder copied under another id is not served (the id inside must match the folder)
  const copyId = P.encodeShareId(crypto.randomBytes(16))
  await fsp.cp(path.join(STORE, main.id), path.join(STORE, copyId), { recursive: true })
  eq((await getJson(`/api/s/${copyId}`)).status, 404)
  await fsp.rm(path.join(STORE, copyId), { recursive: true, force: true })
  // payload missing or the wrong size: a clean 503, never a short or wrong file
  const broken = await rawShare({ files: [Buffer.from('12345')] })
  await fsp.writeFile(path.join(broken.dir, 'data', '0'), '123')
  const b = await getJson(`/d/${broken.id}/0`)
  eq(b.status, 503)
  eq(b.json.error, 'unavailable')
  return `${n} hostile paths`
})

await check('wrong methods: 405 with Allow, nothing is ever written', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    // (Node's client sends a DELETE body without framing, which is a malformed request of its own)
    const r = await getJson(`/d/${main.id}/0`, { method, body: method === 'DELETE' ? undefined : 'x' })
    eq(r.status, 405, `${method} /d`)
    eq(r.headers.allow, 'GET, HEAD, OPTIONS')
  }
  for (const method of ['PUT', 'DELETE', 'POST', 'PATCH']) eq((await getJson(`/api/s/${main.id}`, { method, body: method === 'DELETE' ? undefined : 'x' })).status, 405, `${method} meta`)
  for (const method of ['GET', 'PUT', 'DELETE']) eq((await getJson(`/api/s/${main.id}/unlock`, { method })).status, 405, `${method} unlock`)
  eq((await getJson('/healthz', { method: 'POST' })).status, 405)
  eq((await getJson(`/api/s/${main.id}`, { method: 'OPTIONS' })).status, 403, 'OPTIONS without Origin')
  const trace = await request(`/d/${main.id}/0`, { method: 'TRACE' }).catch(() => ({ status: 400 }))
  ok([400, 405].includes(trace.status), `TRACE -> ${trace.status}`)
  eq(sha(fs.readFileSync(path.join(STORE, main.id, 'data', '0'))), sha(bigBytes), 'payload untouched')
})

await check('CORS: the client page is allowed, every other site is refused', async () => {
  const pre = await request(`/api/s/${main.id}/unlock`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } })
  eq(pre.status, 204)
  eq(pre.headers['access-control-allow-origin'], ORIGIN)
  ok(/POST/.test(pre.headers['access-control-allow-methods']))
  eq(pre.headers['access-control-allow-headers'], 'Content-Type')
  eq(pre.headers.vary, 'Origin')
  const preRange = await request(`/d/${main.id}/0`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' } })
  eq(preRange.status, 204)
  eq(preRange.headers['access-control-allow-headers'], 'Range, If-Range')
  const evilPre = await request(`/api/s/${main.id}/unlock`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } })
  eq(evilPre.status, 403)
  eq(evilPre.headers['access-control-allow-origin'], undefined)
  const good = await getJson(`/api/s/${main.id}?quiet`, { headers: { Origin: ORIGIN } })
  eq(good.status, 200)
  eq(good.headers['access-control-allow-origin'], ORIGIN)
  ok(/Content-Range/.test(good.headers['access-control-expose-headers']))
  for (const origin of ['https://evil.example', 'http://vikramdex-ops.github.io', 'https://vikramdex-ops.github.io.evil.example', 'https://vikramdex-ops.github.io:444', 'null']) {
    const r = await getJson(`/api/s/${main.id}?quiet`, { headers: { Origin: origin } })
    eq(r.status, 403, origin)
    eq(r.headers['access-control-allow-origin'], undefined, origin)
    ok(!r.body.toString().includes('Lot 07'), 'no data for other origins')
  }
  const none = await getJson(`/api/s/${main.id}?quiet`)
  eq(none.status, 200)
  eq(none.headers['access-control-allow-origin'], undefined, 'no wildcard')
  // file downloads are plain navigations; a script on another site still cannot read them
  const dl = await request(`/d/${main.id}/0`, { headers: { Origin: 'https://evil.example', Range: 'bytes=0-9' } })
  eq(dl.headers['access-control-allow-origin'], undefined)
  const dlOk = await request(`/d/${main.id}/0`, { headers: { Origin: ORIGIN, Range: 'bytes=0-9' } })
  eq(dlOk.headers['access-control-allow-origin'], ORIGIN)
})

await check('headers: hardened on every kind of response, nothing identifies the machine', async () => {
  const samples = [
    await request('/healthz'), await request(`/api/s/${main.id}?quiet`), await request('/nothing'), await request(`/d/${main.id}/0`, { headers: { Range: 'bytes=0-9' } }),
    await request(`/d/${main.id}/0`, { headers: { Range: 'bytes=999999999-' } }), await request(`/d/${main.id}/0`, { method: 'DELETE' }), await request(`/api/s/${main.id}`, { headers: { Origin: 'https://evil.example' } }),
    await request(`/d/${locked.id}/0`), await request('/robots.txt')
  ]
  for (const r of samples) {
    for (const banned of ['server', 'x-powered-by', 'via', 'x-aspnet-version']) eq(r.headers[banned], undefined, `${banned} on ${r.status}`)
    eq(r.headers['x-content-type-options'], 'nosniff')
    eq(r.headers['x-frame-options'], 'DENY')
    eq(r.headers['referrer-policy'], 'no-referrer')
    ok(/noindex/.test(r.headers['x-robots-tag']))
    ok(/default-src 'none'/.test(r.headers['content-security-policy']))
    ok(r.headers['strict-transport-security'])
    const all = r.raw.join('\n') + r.body.subarray(0, 2000).toString('latin1')
    for (const leak of [os.hostname(), 'share-agent', 'Xplorer2', 'node', 'U:\\', '\\\\192.168', process.version]) ok(!all.toLowerCase().includes(leak.toLowerCase()), `"${leak}" appears in a ${r.status} response`)
  }
  eq(samples.at(-1).body.toString(), 'User-agent: *\nDisallow: /\n')
  const hz = await getJson('/healthz')
  eq(Object.keys(hz.json).join(), 'ok,i')
  // a person who lands on a dead download link in a browser gets a readable page, not JSON
  const page = await request(`/d/${P.encodeShareId(crypto.randomBytes(16))}/0`, { headers: { Accept: 'text/html,application/xhtml+xml' } })
  eq(page.status, 404)
  ok(/^text\/html/.test(page.headers['content-type']) && page.body.toString().includes('This link is not available') && page.body.toString().includes('Dexterity Share'))
  ok(!/<script/i.test(page.body.toString()))
})

await check('file names: unicode, quotes, very long and spaced names arrive intact (RFC 5987)', async () => {
  const names = ['Zeichnung – Übersicht ✓ 図面.pdf', 'a "quoted"; name%20 & more.pdf', 'नक्शा पाइपिंग लेआउट.dwg', `${'Very long drawing title '.repeat(7)}end.pdf`, "it's (final) [v2] {x} #1 @home +plus =eq ~t.txt", '   leading and trailing   .txt', 'emoji 📐 isometric.pdf']
  const s = await rawShare({ files: names.map((n) => Buffer.from(n)), names })
  for (let n = 0; n < names.length; n++) {
    const r = await request(`/d/${s.id}/${n}`)
    eq(r.status, 200)
    const cd = r.headers['content-disposition']
    ok(/^[\x20-\x7e]+$/.test(cd), 'header is pure ASCII on the wire')
    eq(decodeURIComponent(/filename\*=UTF-8''([^;]+)$/.exec(cd)[1]), names[n], 'filename*')
    ok(/^attachment; filename="[^"\\]*"; /.test(cd), cd)
  }
  // and through Hopper: names are cleaned for Windows and de-duplicated without losing files
  const a = putFile('dup/A/Report.pdf', 10)
  const b = putFile('dup/B/report.pdf', 20)
  const c = putFile('Ünïcödé — plan ✓.pdf', 30)
  const made = await hopper.create({ paths: [a, b, c], title: 'Names', days: 1, zip: null })
  eq(made.manifest.files.map((f) => f.name).join('|'), 'Report.pdf|report (2).pdf|Ünïcödé — plan ✓.pdf')
  eq((await request(`/d/${made.id}/1`)).body.length, 20)
})

await check('many small files: 300 files in one link, all downloaded and verified', async () => {
  const paths = []
  for (let i = 0; i < 300; i++) paths.push(putFile(`small/ISO-${String(1000 + i)}_Rev${'ABC'[i % 3]}.pdf`, 800 + (i * 37) % 1500))
  const t0 = Date.now()
  const s = await hopper.create({ paths, title: '300 isometrics', days: 14, zip: null })
  const made = Date.now() - t0
  eq(s.manifest.files.length, 300)
  eq(s.info.files, 300)
  const meta = await getJson(`/api/s/${s.id}`)
  eq(meta.json.files.length, 300)
  eq(meta.json.files[299].n, 299)
  let done = 0
  const t1 = Date.now()
  for (let i = 0; i < 300; i += 6) {
    await Promise.all([0, 1, 2, 3, 4, 5].map(async (k) => {
      const n = i + k
      const r = await request(`/d/${s.id}/${n}`)
      eq(r.status, 200)
      eq(sha(r.body), meta.json.files[n].sha256, `file ${n}`)
      eq(r.body.length, meta.json.files[n].size)
      done++
    }))
  }
  eq(done, 300)
  eq((await getJson(`/d/${s.id}/300`)).status, 404)
  await app.flushStats()
  const st = JSON.parse(await fsp.readFile(path.join(STORE, s.id, 'stats.json'), 'utf8'))
  eq(st.downloads, 300)
  ok(st.files.every((f) => f.completed === 1))
  // more than 500 loose files is refused with advice, before anything is copied
  const tooMany = Array.from({ length: 501 }, () => paths[0])
  const before = (await fsp.readdir(STORE)).length
  const r = await hopper.h['pubshare.create']({ paths: tooMany, title: 'x', days: 1, zip: null })
  const err = await hopper.jobs.wait(r.jobId).then(() => null, (e) => e)
  ok(/at most 500 files/.test(err?.message ?? ''), err?.message)
  eq((await fsp.readdir(STORE)).length, before, 'nothing left behind')
  return `created in ${made} ms, downloaded in ${Date.now() - t1} ms`
})

await check('zip first: real 7-Zip into the store, one file, checksum of what the server holds, no undo entry', async () => {
  if (!fs.existsSync(path.join(root, 'vendor', '7zip', '7z.exe'))) throw new Error('vendor/7zip/7z.exe missing')
  const paths = [putFile('zipme/ISO-2001_RevA.pdf', 200_000), putFile('zipme/ISO-2002_RevA.pdf', 300_000), putFile('zipme/Transmittal ✓.txt', Buffer.from('transmittal'))]
  undoRecords = 0
  const s = await hopper.create({ paths, title: 'Lot 09: isometrics', days: 30, zip: { presetId: 'balanced' } })
  eq(s.manifest.files.length, 1)
  eq(s.manifest.files[0].name, 'Lot 09_ isometrics.zip')
  eq((await fsp.readdir(path.join(STORE, s.id, 'data'))).join(), '0', 'no temp files left')
  const onDisk = await fsp.readFile(path.join(STORE, s.id, 'data', '0'))
  eq(s.manifest.files[0].sha256, sha(onDisk))
  eq(s.manifest.files[0].size, onDisk.length)
  eq(undoRecords, 0, 'not in the undo journal')
  eq(s.info.done, s.info.total, 'progress reached 100%')
  const dl = await request(`/d/${s.id}/0`)
  eq(sha(dl.body), sha(onDisk))
  const out = path.join(WORK, 'downloaded.zip')
  await fsp.writeFile(out, dl.body)
  const t = spawnSync(path.join(root, 'vendor', '7zip', '7z.exe'), ['l', '-ba', '-sccUTF-8', out], { encoding: 'utf8' })
  eq(t.status, 0, '7z lists the downloaded archive')
  for (const n of ['ISO-2001_RevA.pdf', 'ISO-2002_RevA.pdf', 'Transmittal ✓.txt']) ok(t.stdout.includes(n), `archive contains ${n}`)
  eq(spawnSync(path.join(root, 'vendor', '7zip', '7z.exe'), ['t', out]).status, 0, '7z test passes')
  // default: several items are zipped without being asked; a folder without zip is refused
  const auto = await hopper.create({ paths: paths.slice(0, 2), title: 'Auto', days: 1 })
  eq(auto.manifest.files.length, 1)
  ok(auto.manifest.files[0].name.endsWith('.zip'))
  const r = await hopper.h['pubshare.create']({ paths: [path.join(SRC, 'zipme')], title: 'Folder', days: 1, zip: null })
  const err = await hopper.jobs.wait(r.jobId).then(() => null, (e) => e)
  ok(/Folders are sent as one zip/.test(err?.message ?? ''), err?.message)
})

await check('create: cancel mid-copy and failures leave nothing behind; validation messages', async () => {
  const before = (await fsp.readdir(STORE)).sort().join()
  const h2 = engine()
  h2.jobs.cancelAfter = 3
  const r = await h2.h['pubshare.create']({ paths: [putFile('cancel.bin', 40 << 20)], title: 'Cancel', days: 1 })
  const err = await h2.jobs.wait(r.jobId).then(() => null, (e) => e)
  ok(err, 'job rejected')
  ok(!fs.existsSync(path.join(STORE, r.id)), 'cancelled share removed')
  eq((await getJson(`/api/s/${r.id}`)).status, 404)
  const r2 = await hopper.h['pubshare.create']({ paths: [path.join(SRC, 'does-not-exist.pdf')], title: 'Missing', days: 1 })
  ok(await hopper.jobs.wait(r2.jobId).then(() => false, () => true), 'missing source fails')
  eq((await fsp.readdir(STORE)).sort().join(), before, 'store unchanged')
  const fails = async (fn, re) => ok(re.test(await fn().then(() => '', (e) => e.message)), String(re))
  await fails(() => hopper.h['pubshare.create']({ paths: [], title: 'x', days: 1 }), /Nothing selected/)
  await fails(() => hopper.h['pubshare.create']({ paths: [big], title: 'x', days: 1, password: '123' }), /at least 6/)
  await fails(() => engine({ enabled: false }).h['pubshare.create']({ paths: [big], title: 'x', days: 1 }), /not switched on/)
  await fails(() => hopper.h['pubshare.revoke']('../' + main.id), /valid link id/)
  await fails(() => hopper.h['pubshare.revoke']('..'), /valid link id/)
  await fails(() => hopper.h['pubshare.extend']('a'.repeat(26), 7), /no longer exists/)
  // every expiry choice lands on the right day; an odd value falls back to the office default
  for (const d of P.EXPIRY_DAYS) {
    const made = await hopper.h['pubshare.create']({ paths: [putFile('tiny.txt', 5)], title: `d${d}`, days: d })
    ok(Math.abs(made.expiresAt - Date.now() - d * P.DAY_MS) < 3000, `${d} days`)
    await hopper.jobs.wait(made.jobId)
    await hopper.h['pubshare.revoke'](made.id)
  }
  const odd = await hopper.h['pubshare.create']({ paths: [putFile('tiny.txt', 5)], title: 'odd', days: 5 })
  ok(Math.abs(odd.expiresAt - Date.now() - 7 * P.DAY_MS) < 3000, 'falls back to 7')
  await hopper.jobs.wait(odd.jobId)
  await hopper.h['pubshare.revoke'](odd.id)
})

await check('download limit: the configured number of complete downloads, then 410', async () => {
  const s = await hopper.create({ paths: [putFile('once.bin', 50_000)], title: 'Once', days: 1, maxDownloads: 1 })
  eq((await request(`/d/${s.id}/0`, { headers: { Range: 'bytes=0-99' } })).status, 206, 'a partial read does not use it up')
  eq((await request(`/d/${s.id}/0`, { method: 'HEAD' })).status, 200)
  eq((await request(`/d/${s.id}/0`)).status, 200)
  const again = await getJson(`/d/${s.id}/0`)
  eq(again.status, 410)
  eq(again.json.error, 'limit')
})

await check('stats.json: views, started, completed and bytes; visible in Hopper\'s list; partial downloads do not count', async () => {
  const s = await hopper.create({ paths: [putFile('stats.bin', 200_000)], title: 'Stats', days: 1 })
  await getJson(`/api/s/${s.id}`)
  await getJson(`/api/s/${s.id}`)
  await getJson(`/api/s/${s.id}?quiet`)
  await request(`/d/${s.id}/0`)
  await request(`/d/${s.id}/0`, { headers: { Range: 'bytes=0-999' } })
  await request(`/d/${s.id}/0`, { headers: { Range: 'bytes=100000-' } }) // the tail of a resumed download
  await sleep(700) // the periodic flush
  const st = JSON.parse(await fsp.readFile(path.join(STORE, s.id, 'stats.json'), 'utf8'))
  eq(st.views, 2)
  eq(st.started, 3)
  eq(st.downloads, 2, 'full + resumed tail')
  eq(st.bytes, 200_000 + 1000 + 100_000)
  ok(st.lastDownloadAt > Date.now() - 10_000)
  ok(!fs.readdirSync(path.join(STORE, s.id)).some((n) => n.endsWith('.tmp')), 'atomic write left no temp file')
  const mine = await hopper.h['pubshare.list']()
  const row = mine.find((l) => l.id === s.id)
  eq(row.stats.downloads, 2)
  eq(row.bytes, 200_000)
  eq(row.url, s.url)
  // stats of a revoked share are dropped, never written back into a deleted folder
  await request(`/d/${s.id}/0`)
  await hopper.h['pubshare.revoke'](s.id)
  await app.flushStats()
  ok(!fs.existsSync(path.join(STORE, s.id)), 'no folder resurrected by a late stats write')
})

await check('Hopper list / extend / revoke / status', async () => {
  const other = engine({ user: 'priya', displayName: 'Priya S' })
  const theirs = await other.create({ paths: [putFile('theirs.txt', 10)], title: 'From Priya', days: 1 })
  const mine = await hopper.h['pubshare.list']()
  ok(mine.length >= 3 && mine.every((l) => l.owner === 'asha'), 'only my links')
  ok(mine.every((l, i) => i === 0 || mine[i - 1].createdAt >= l.createdAt), 'newest first')
  ok(!mine.some((l) => l.id === theirs.id))
  const all = await hopper.h['pubshare.list']('all')
  ok(all.some((l) => l.id === theirs.id && l.sender === 'Priya S'))
  const lockedRow = mine.find((l) => l.id === locked.id)
  eq(lockedRow.hasPassword, true)
  ok(!JSON.stringify(lockedRow).includes(locked.manifest.password.hash), 'verifier not sent to the UI')
  const before = mine.find((l) => l.id === main.id).expiresAt
  const after = await hopper.h['pubshare.extend'](main.id, 14)
  eq(after, before + 14 * P.DAY_MS)
  await sleep(200)
  eq((await getJson(`/api/s/${main.id}?quiet`)).json.expiresAt, after, 'server sees the new date')
  const capped = await hopper.h['pubshare.extend'](main.id, 5000)
  ok(capped <= Date.now() + 365 * P.DAY_MS + 1000, 'never more than a year ahead')
  await hopper.h['pubshare.extend'](main.id, 1)
  ok(S.validateManifest(JSON.parse(await fsp.readFile(path.join(STORE, main.id, 'manifest.json'), 'utf8')), main.id), 'manifest still valid after edits')
  await hopper.h['pubshare.revoke'](theirs.id)
  await hopper.h['pubshare.revoke'](theirs.id) // twice is harmless
  eq((await getJson(`/api/s/${theirs.id}`)).status, 404)

  // status(): store, heartbeat and the public health check
  let st = await engine({ store: path.join(WORK, 'no-such-store') }).h['pubshare.status']()
  eq(st.storeOk, false)
  ok(/does not exist/.test(st.storeError))
  st = await hopper.h['pubshare.status']()
  eq(st.storeOk, true)
  eq(st.healthy, false)
  ok(/not reported in/.test(st.healthError))
  await fsp.writeFile(path.join(STORE, '_server.json'), JSON.stringify({ base: 'https://demo-tunnel.trycloudflare.com', updated: Date.now() }))
  const viaLocal = (url, init) => fetch(String(url).replace('https://demo-tunnel.trycloudflare.com', `http://127.0.0.1:${PORT}`), init)
  st = await engine({ fetchImpl: viaLocal }).h['pubshare.status']()
  eq(st.healthy, true)
  eq(st.base, 'https://demo-tunnel.trycloudflare.com')
  st = await engine({ fetchImpl: () => fetch('http://127.0.0.1:9/healthz') }).h['pubshare.status']()
  eq(st.healthy, false)
  ok(/not reachable/.test(st.healthError), st.healthError)
  const t0 = Date.now()
  st = await engine({ fetchImpl: (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason))) }).h['pubshare.status']()
  ok(Date.now() - t0 >= 4900 && Date.now() - t0 < 6500 && /within 5 seconds/.test(st.healthError), `timeout after ${Date.now() - t0} ms: ${st.healthError}`)
  await fsp.writeFile(path.join(STORE, '_server.json'), JSON.stringify({ base: 'javascript:alert(1)', updated: 1 }))
  st = await hopper.h['pubshare.status']()
  eq(st.base, undefined, 'a strange address in the heartbeat is ignored')
})

await check('clean-up: deletes expired, revoked and abandoned shares — and nothing else', async () => {
  const store = path.join(WORK, 'store-cleanup')
  await fsp.mkdir(store, { recursive: true })
  const srv = S.createShareServer(serverConfig({ store, graceHours: 24, logDir: path.join(WORK, 'logs-cleanup') }))
  const H = 3_600_000
  const newId = () => P.encodeShareId(crypto.randomBytes(16))
  const old = (file, hours) => fsp.utimes(file, new Date(Date.now() - hours * H), new Date(Date.now() - hours * H))
  const gone = {}
  const kept = {}
  gone.expiredPastGrace = (await rawShare({ store, expiresAt: Date.now() - 25 * H })).id
  kept.expiredInGrace = (await rawShare({ store, expiresAt: Date.now() - 23 * H })).id
  kept.active = (await rawShare({ store })).id
  kept.expiresSoon = (await rawShare({ store, expiresAt: Date.now() + 1000 })).id
  // revoked by Hopper while a download held the folder open
  gone.revoked = newId()
  await fsp.mkdir(path.join(store, gone.revoked, 'data'), { recursive: true })
  await fsp.writeFile(path.join(store, gone.revoked, 'revoked.json'), '{}')
  await fsp.writeFile(path.join(store, gone.revoked, 'data', '0'), 'x')
  // a PC died half-way through creating a link, two days ago / a minute ago
  gone.abandoned = newId()
  await fsp.mkdir(path.join(store, gone.abandoned, 'data'), { recursive: true })
  await fsp.writeFile(path.join(store, gone.abandoned, 'creating.json'), '{}')
  await old(path.join(store, gone.abandoned, 'creating.json'), 49)
  kept.beingCreated = newId()
  await fsp.mkdir(path.join(store, kept.beingCreated, 'data'), { recursive: true })
  await fsp.writeFile(path.join(store, kept.beingCreated, 'creating.json'), '{}')
  // a damaged manifest: kept for a week (someone may be fixing it), then removed
  kept.badManifestYoung = newId()
  await fsp.mkdir(path.join(store, kept.badManifestYoung))
  await fsp.writeFile(path.join(store, kept.badManifestYoung, 'manifest.json'), '{not json')
  gone.badManifestOld = newId()
  await fsp.mkdir(path.join(store, gone.badManifestOld))
  await fsp.writeFile(path.join(store, gone.badManifestOld, 'manifest.json'), '{not json')
  await old(path.join(store, gone.badManifestOld, 'manifest.json'), 8 * 24)
  // things that are not shares, however much they look like one
  kept.idNameNoMarker = newId()
  await fsp.mkdir(path.join(store, kept.idNameNoMarker, 'data'), { recursive: true })
  await fsp.writeFile(path.join(store, kept.idNameNoMarker, 'data', 'drawing.dwg'), 'x')
  kept.projectFolder = 'Projects'
  await fsp.mkdir(path.join(store, 'Projects'))
  await fsp.writeFile(path.join(store, 'Projects', 'manifest.json'), JSON.stringify({ v: 1, id: 'Projects', expiresAt: 0 }))
  kept.almostId = 'a'.repeat(25)
  await fsp.mkdir(path.join(store, kept.almostId))
  await fsp.writeFile(path.join(store, kept.almostId, 'manifest.json'), JSON.stringify({ v: 1, expiresAt: 0 }))
  kept.upperId = 'A'.repeat(26)
  await fsp.mkdir(path.join(store, kept.upperId))
  await fsp.writeFile(path.join(store, kept.upperId, 'revoked.json'), '{}')
  kept.fileNamedLikeId = newId()
  await fsp.writeFile(path.join(store, kept.fileNamedLikeId), 'a file, not a folder')
  kept.heartbeat = '_server.json'
  await fsp.writeFile(path.join(store, '_server.json'), '{}')
  kept.looseFile = 'Important.xlsx'
  await fsp.writeFile(path.join(store, 'Important.xlsx'), 'x')
  // an expired manifest whose id is someone else's: not this folder's manifest, so not "expired" — invalid and young
  kept.foreignManifest = newId()
  await fsp.mkdir(path.join(store, kept.foreignManifest))
  await fsp.writeFile(path.join(store, kept.foreignManifest, 'manifest.json'), JSON.stringify({ ...(await rawShare({ store, expiresAt: Date.now() - 100 * H })).manifest }))
  const foreignSource = JSON.parse(await fsp.readFile(path.join(store, kept.foreignManifest, 'manifest.json'), 'utf8')).id
  gone.foreignSource = foreignSource
  // a junction that points outside the store, named like an expired share
  let junction = null
  const outside = path.join(WORK, 'outside-target')
  await fsp.mkdir(outside, { recursive: true })
  await fsp.writeFile(path.join(outside, 'manifest.json'), JSON.stringify({ v: 1, expiresAt: 0 }))
  await fsp.writeFile(path.join(outside, 'precious.txt'), 'must survive')
  try {
    junction = newId()
    await fsp.symlink(outside, path.join(store, junction), 'junction')
  } catch {
    junction = null
  }

  const removed = (await srv.cleanup()).sort()
  eq(removed.join(), Object.values(gone).sort().join(), 'exactly the expected shares were removed')
  for (const [k, id] of Object.entries(gone)) ok(!fs.existsSync(path.join(store, id)), `${k} should be gone`)
  for (const [k, name] of Object.entries(kept)) ok(fs.existsSync(path.join(store, name)), `${k} must be kept`)
  ok(fs.existsSync(path.join(store, kept.idNameNoMarker, 'data', 'drawing.dwg')))
  ok(fs.existsSync(path.join(outside, 'precious.txt')), 'junction target untouched')
  ok(fs.existsSync(path.join(WORK, 'secret.txt')), 'nothing above the store touched')
  eq((await srv.cleanup()).length, 0, 'second pass removes nothing')
  // a store that vanishes (share offline) is reported, not crashed on
  const lost = S.createShareServer(serverConfig({ store: path.join(WORK, 'vanished-store'), logDir: path.join(WORK, 'logs-cleanup') }))
  eq((await lost.cleanup()).length, 0)
  await lost.listen().then(() => { throw new Error('should not start without a store') }, (e) => ok(/store folder not found/.test(e.message)))
  return `removed ${removed.length}, kept ${Object.keys(kept).length}${junction ? ', junction skipped' : ' (junction could not be created here)'}`
})

await check('rate limits: API and file requests per client per minute, 429 with Retry-After, other clients unaffected', async () => {
  const srv = S.createShareServer(serverConfig({ apiPerMinutePerIp: 30, filePerMinutePerIp: 50, logDir: path.join(WORK, 'logs-rate') }))
  const port = await srv.listen()
  const from = (ip, p, extra = {}) => request(p, { port, ...extra, headers: { 'CF-Connecting-IP': ip, ...(extra.headers ?? {}) } })
  const api = []
  for (let i = 0; i < 35; i++) api.push((await from('203.0.113.80', `/api/s/${main.id}?quiet`)).status)
  eq(api.filter((s) => s === 200).length, 30)
  eq(api.slice(30).join(), '429,429,429,429,429')
  const limited = await from('203.0.113.80', `/api/s/${main.id}?quiet`)
  ok(Number(limited.headers['retry-after']) >= 1 && Number(limited.headers['retry-after']) <= 60, 'Retry-After')
  eq(limited.body.toString(), '{"error":"rate_limited"}')
  eq((await from('203.0.113.81', `/api/s/${main.id}?quiet`)).status, 200, 'another client')
  // guessing ids is throttled the same way, and file requests have their own, larger allowance
  const guesses = []
  for (let i = 0; i < 35; i++) guesses.push((await from('203.0.113.82', `/api/s/${P.encodeShareId(crypto.randomBytes(16))}`)).status)
  eq(guesses.filter((s) => s === 404).length, 30)
  const files = []
  for (let i = 0; i < 55; i++) files.push((await from('203.0.113.80', `/d/${main.id}/0`, { method: 'HEAD' })).status)
  eq(files.filter((s) => s === 200).length, 50, 'file allowance is separate from the API allowance')
  eq(files.filter((s) => s === 429).length, 5)
  // a spoofed, malformed client-address header falls back to the socket address instead of being trusted
  eq((await from('not an ip; DROP', `/api/s/${main.id}?quiet`)).status, 200)
  await srv.close(300)
})

await check('stalled client: an idle download is dropped and its slot freed', async () => {
  const srv = S.createShareServer(serverConfig({ idleTimeoutSeconds: 1, logDir: path.join(WORK, 'logs-idle') }))
  const port = await srv.listen()
  const s = await hopper.create({ paths: [putFile('stall.bin', 32 << 20)], title: 'Stall', days: 1 })
  const t0 = Date.now()
  const end = await request(`/d/${s.id}/0`, { port, onResponse: (res, req, resolve) => { res.pause(); res.on('close', () => resolve({ complete: res.complete })); res.on('error', () => {}); setTimeout(() => res.resume(), 4000) } })
  ok(!end.complete, 'connection was dropped by the server')
  eq(srv.activeDownloads, 0)
  // a client that keeps reading slowly is not dropped
  const slow = await request(`/d/${s.id}/0`, { port, headers: { Range: 'bytes=0-3999999' }, onResponse: (res, req, resolve) => { let n = 0; res.on('data', (c) => { n += c.length; res.pause(); setTimeout(() => res.resume(), 30) }); res.on('close', () => resolve({ complete: res.complete, n })) } })
  ok(slow.complete && slow.n === 4_000_000, 'slow but alive completes')
  await srv.close(500)
  return `dropped after ${Date.now() - t0} ms`
})

await check('listens on loopback only: the LAN address refuses connections', async () => {
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)
  if (!lan) return 'no LAN interface to test from'
  eq(app.server.address().address, '127.0.0.1')
  const r = await new Promise((resolve) => {
    const sock = net.connect({ host: lan.address, port: PORT, timeout: 3000 })
    sock.on('connect', () => { sock.destroy(); resolve('connected') })
    sock.on('timeout', () => { sock.destroy(); resolve('timeout') })
    sock.on('error', (e) => resolve(e.code))
  })
  ok(r !== 'connected', `LAN address ${lan.address}:${PORT} accepted a connection`)
  return `${lan.address} -> ${r}`
})

await check('log: requests recorded without passwords, tokens or full link ids', async () => {
  const text = fs.readFileSync(path.join(WORK, 'logs', 'share.log'), 'utf8')
  const lines = text.trim().split('\n').map((l) => JSON.parse(l))
  ok(lines.length > 100, `${lines.length} lines`)
  ok(lines.some((l) => l.event === 'req' && l.s === 206 && l.range), 'range requests logged')
  ok(lines.some((l) => l.event === 'unlock-failed'), 'failed unlocks logged')
  for (const secret of [PW, 'right-password', 'nope-nope', locked.token, locked.token.split('.')[1], main.id, locked.id, 'TOP-SECRET']) ok(!text.includes(secret), `log contains ${secret.slice(0, 8)}…`)
  ok(!/[?&]t=/.test(text), 'no query strings')
  ok(text.includes(main.id.slice(0, 6) + '~'), 'ids are shortened')
})

await app.close(1000)

// ---- the same server as a real process: restart, token survival, graceful stop --------------------
const childCfg = path.join(WORK, 'config.json')
let child = null
async function startChild(port) {
  await fsp.writeFile(childCfg, JSON.stringify({ ...serverConfig({ port }), logDir: path.join(WORK, 'logs-child') }))
  child = spawn(process.execPath, ['--no-warnings', SERVER_FILE], { env: { ...process.env, DXSHARE_CONFIG: childCfg }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  const exited = new Promise((r) => child.on('exit', (code) => r(code)))
  for (let i = 0; i < 100; i++) {
    if (/listening on/.test(out)) return { exited, out: () => out }
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${out}`)
    await sleep(100)
  }
  throw new Error(`server did not start: ${out}`)
}
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })

await check('server process: killed mid-download, restarted, download resumed; unlock token survives', async () => {
  PORT = await freePort()
  let run = await startChild(PORT)
  const s = await hopper.create({ paths: [putFile('restart.bin', 40 << 20)], title: 'Restart', days: 1 })
  const whole = fs.readFileSync(path.join(SRC, 'restart.bin'))
  const unlock = await getJson(`/api/s/${locked.id}/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.200' }, body: JSON.stringify({ password: PW }) })
  eq(unlock.status, 200)
  let etag
  const first = await request(`/d/${s.id}/0`, {
    onResponse: (res, req, resolve) => {
      etag = res.headers.etag
      const chunks = []
      let n = 0
      let killed = false
      res.on('data', (c) => {
        chunks.push(c)
        n += c.length
        if (n > 5 << 20 && !killed) {
          killed = true
          child.kill('SIGKILL') // power cut
        }
      })
      res.on('error', () => {})
      res.on('close', () => resolve({ body: Buffer.concat(chunks), complete: res.complete }))
    }
  })
  await run.exited
  ok(!first.complete && first.body.length < whole.length, `transfer broke at ${first.body.length}`)
  ok(first.body.equals(whole.subarray(0, first.body.length)), 'bytes received before the cut are correct')
  eq(await request('/healthz').then((r) => r.status, (e) => e.code), 'ECONNREFUSED', 'server is down')
  run = await startChild(PORT)
  const rest = await request(`/d/${s.id}/0`, { headers: { Range: `bytes=${first.body.length}-`, 'If-Range': etag } })
  eq(rest.status, 206, 'resume accepted after restart (same ETag)')
  eq(sha(Buffer.concat([first.body, rest.body])), sha(whole), 'resumed file is identical')
  eq((await request(`/d/${locked.id}/0?t=${unlock.json.token}`)).status, 200, 'token issued before the restart still works')
  // graceful stop: finishes a running download, flushes stats, exits 0
  const running = request(`/d/${s.id}/0`)
  await sleep(50)
  child.send('shutdown')
  const done = await running
  eq(sha(done.body), sha(whole), 'download in flight finished during shutdown')
  eq(await run.exited, 0, 'clean exit')
  const st = JSON.parse(await fsp.readFile(path.join(STORE, s.id, 'stats.json'), 'utf8'))
  // the killed process took its unsaved counters with it (at most a few seconds' worth); everything since is on disk
  ok(st.downloads === 2 && st.started === 2, `stats flushed on exit: ${JSON.stringify({ d: st.downloads, s: st.started })}`)
  return `cut at ${first.body.length} bytes`
})

await check('server process: second instance on the same port exits with a clear message; bad config refused', async () => {
  PORT = await freePort()
  const run = await startChild(PORT)
  const second = spawnSync(process.execPath, ['--no-warnings', SERVER_FILE], { env: { ...process.env, DXSHARE_CONFIG: childCfg }, encoding: 'utf8', timeout: 20000 })
  eq(second.status, 3)
  ok(/cannot start/.test(second.stderr), second.stderr)
  const bad = spawnSync(process.execPath, ['--no-warnings', SERVER_FILE], { env: { ...process.env, DXSHARE_CONFIG: childCfg, DXSHARE_STORE: 'U:\\' }, encoding: 'utf8', timeout: 20000 })
  eq(bad.status, 2)
  ok(/store/.test(bad.stderr), bad.stderr)
  const missing = spawnSync(process.execPath, ['--no-warnings', SERVER_FILE], { env: { ...process.env, DXSHARE_CONFIG: childCfg, DXSHARE_PORT: String(await freePort()), DXSHARE_STORE: path.join(WORK, 'nope') }, encoding: 'utf8', timeout: 20000 })
  eq(missing.status, 2)
  ok(/store folder not found/.test(missing.stderr), missing.stderr)
  child.send('shutdown')
  eq(await run.exited, 0)
})

// ---- summary ----------------------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
if (!process.argv.includes('--keep') && !failed.length) await fsp.rm(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {})
process.exit(failed.length ? 1 : 0)
