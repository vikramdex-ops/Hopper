// Dexterity Share for staff: links created from a browser (site/share/create/) through the share
// server's /api/staff/ routes, signed in with a browser pass that Hopper's engine writes into the
// store. Runs the real server on a scratch store and attacks it from the client side.
//   node --no-warnings tests/e2e/pubshare-staff.mjs [--only <text>] [--keep]
import { TEST_WORK } from '../unit/pubshare-hooks.mjs'
import http from 'node:http'
import fs, { promises as fsp } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

const WORK = path.join(TEST_WORK, 'staff')
process.env.TEMP = process.env.TMP = path.dirname(WORK)
const STORE = path.join(WORK, 'store')
const SRC = path.join(WORK, 'src')
const ORIGIN = 'https://vikramdex-ops.github.io'
const CHUNK = 65536
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].toLowerCase() : ''

const S = await import('../../server/dexterity-share/server.mjs')
const E = await import('../../src/engine/pubshare.ts')
const P = await import('../../src/shared/pubshare.ts')

const results = []
async function check(name, fn) {
  if (only && !name.toLowerCase().includes(only)) return
  const t0 = Date.now()
  try {
    const note = await fn()
    results.push({ name, ok: true })
    console.log(`  ok    ${name}${note ? `  [${note}]` : ''}  (${Date.now() - t0} ms)`)
  } catch (e) {
    results.push({ name, ok: false })
    console.log(`  FAIL  ${name}\n        ${String(e?.stack ?? e).split('\n').slice(0, 6).join('\n        ')}`)
  }
}
const eq = (a, b, msg = '') => { if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const ok = (v, msg) => { if (!v) throw new Error(msg || 'assertion failed') }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

// ---- raw HTTP client --------------------------------------------------------------------------------
let PORT = 0
function request(reqPath, { method = 'GET', headers = {}, body, port = PORT, raw } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      const fin = () => {
        const b = Buffer.concat(chunks)
        let json = null
        try { json = b.length ? JSON.parse(b.toString('utf8')) : null } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: b, json })
      }
      res.on('end', fin)
      res.on('error', fin)
    })
    req.on('error', (e) => (req.res ? null : reject(e)))
    if (raw) return raw(req)
    req.end(body)
  })
}
const auth = (pass) => ({ Authorization: `Bearer ${pass.id}.${pass.secret}` })
const api = (pass, p, opts = {}) => request(p, { ...opts, headers: { ...(pass ? auth(pass) : {}), ...(opts.json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers ?? {}) }, body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body })
const putChunk = (pass, id, n, bytes, headers = {}) => request(`/api/staff/uploads/${id}/${n}`, { method: 'PUT', headers: { ...auth(pass), 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, ...headers }, body: bytes })
const chunksOf = (buf, size = CHUNK) => Array.from({ length: Math.ceil(buf.length / size) }, (_, i) => buf.subarray(i * size, (i + 1) * size))
const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1])

// ---- Hopper's engine with a stand-in job queue (as in pubshare.mjs) --------------------------------
function fakeJobs() {
  const jobs = new Map()
  let seq = 0
  return {
    create(kind, title, run) {
      const id = `j${++seq}`
      const info = { id, title }
      const ctl = { info, signal: new AbortController().signal, cancelled: false, async checkpoint() {}, add() {}, setCurrent() {}, setTotal() {}, fail() {} }
      const promise = run(ctl)
      promise.catch(() => {})
      jobs.set(id, promise)
      return id
    },
    wait: (id) => jobs.get(id)
  }
}
function engine({ user = 'staff1', displayName = 'Staff One', share = {}, admins = ['staff1'] } = {}) {
  const jobs = fakeJobs()
  const dataDir = path.join(WORK, 'userdata-' + user)
  fs.mkdirSync(dataDir, { recursive: true })
  const ctx = {
    office: { admins, publicShare: { enabled: true, store: STORE, pageUrl: 'https://vikramdex-ops.github.io/Hopper/share/', defaultDays: 7, minFreeGB: 0, ...share } },
    dataDir,
    settings: { officeConfigPath: path.join(WORK, 'office.json'), profile: { displayName }, archivePresets: [] },
    jobs,
    undo: { record() {} },
    emit() {}
  }
  const h = E.pubshareHandlers(ctx, { user: () => ({ user: user === 'staff1' ? 'Staff1' : user, host: 'PC-TEST-07' }), watch: false })
  return {
    h,
    async create(spec) {
      const r = await h['pubshare.create'](spec)
      await jobs.wait(r.jobId)
      return r
    },
    /** a pass through Hopper, with its secret taken from the link it shows */
    async pass() {
      const made = await h['pubshare.passCreate']()
      const ref = P.parseStaffRef(made.link.split('#')[1])
      return { ...made, secret: ref.secret }
    }
  }
}

const serverConfig = (extra = {}) => ({
  port: 0,
  store: STORE,
  allowedOrigins: [ORIGIN],
  stateDir: path.join(WORK, 'state'),
  logDir: path.join(WORK, 'logs'),
  clientIpHeader: 'x-test-ip',
  manifestCacheMs: 100,
  passCacheMs: 100,
  statsFlushMs: 200,
  revokeCheckMs: 250,
  apiPerMinutePerIp: 100000,
  filePerMinutePerIp: 100000,
  minFreeGB: 0,
  staff: { enabled: true, maxGB: 0.002, chunkBytes: CHUNK, defaultDays: 7, maxUnfinished: 2 },
  ...extra
})

/** A zip-shaped payload: the real zip signature, then random bytes. */
const zipLike = (n) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), crypto.randomBytes(n - 4)])

async function startUpload(pass, { name = 'Lot 07 isometrics.zip', size, days = 7, password, message, title } = {}) {
  const r = await api(pass, '/api/staff/uploads', { method: 'POST', json: { name, size, days, password, message, title } })
  return r
}
async function uploadAll(pass, buf, opts = {}) {
  const r = await startUpload(pass, { size: buf.length, ...opts })
  eq(r.status, 201, `create ${JSON.stringify(r.json)}`)
  const parts = chunksOf(buf, r.json.chunkBytes)
  for (const n of shuffle(parts.map((_, i) => i))) {
    const c = await putChunk(pass, r.json.id, n, parts[n])
    eq(c.status, 200, `chunk ${n} ${JSON.stringify(c.json)}`)
  }
  const f = await api(pass, `/api/staff/uploads/${r.json.id}/finish`, { method: 'POST', json: {} })
  return { id: r.json.id, finish: f, chunks: parts.length }
}

// ==================================================================================================
console.log(`Dexterity Share staff API — work folder ${WORK}`)
await fsp.rm(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
await fsp.mkdir(STORE, { recursive: true })
await fsp.mkdir(SRC, { recursive: true })

const app = S.createShareServer(serverConfig())
PORT = await app.listen()
const hopper = engine()
const other = engine({ user: 'staff2', displayName: 'Staff Two' })
let A // staff1's pass
let B // staff2's pass

await check('Hopper makes a pass: file in _staff with only a hash of the secret; the link carries it in the fragment', async () => {
  A = await hopper.pass()
  B = await other.pass()
  ok(P.SHARE_ID_RE.test(A.id), 'pass id shape')
  ok(A.link.startsWith(`https://vikramdex-ops.github.io/Hopper/share/create/#${A.id}.`), A.link)
  eq(A.secret.length, 43)
  const file = JSON.parse(await fsp.readFile(path.join(STORE, '_staff', `${A.id}.json`), 'utf8'))
  eq(Object.keys(file).sort().join(','), 'createdAt,host,id,name,user,v,verifier')
  eq(file.user, 'staff1', 'lower-case Windows account')
  eq(file.name, 'Staff One')
  eq(file.host, 'PC-TEST-07')
  eq(file.verifier, sha(Buffer.from(A.secret, 'base64url')))
  ok(!JSON.stringify(file).includes(A.secret), 'secret not stored')
  // with a pointer the link names it, exactly as client links do
  const pointed = engine({ share: { pointer: { gist: 'a'.repeat(32), key: 'b'.repeat(20) } } })
  const p2 = await pointed.h['pubshare.passCreate']()
  ok(new RegExp(`/create/#${p2.id}\\.[A-Za-z0-9_-]{43}\\.${'a'.repeat(32)}\\.${'b'.repeat(20)}$`).test(p2.link), p2.link)
  eq(JSON.stringify(P.parseStaffRef(p2.link.split('#')[1])), JSON.stringify({ id: p2.id, secret: P.parseStaffRef(p2.link.split('#')[1]).secret, gist: 'a'.repeat(32), key: 'b'.repeat(20) }))
  await pointed.h['pubshare.passRevoke'](p2.id)
  // switched off for the office: no new passes
  const off = engine({ share: { web: { enabled: false, maxGB: 5 } } })
  let refused = ''
  await off.h['pubshare.passCreate']().catch((e) => (refused = e.message))
  ok(/switched off/.test(refused), refused)
})

await check('signed out: missing, malformed, wrong secret, unknown and switched-off passes all get 401', async () => {
  eq((await api(null, '/api/staff/me')).status, 401)
  eq((await api(null, '/api/staff/me', { headers: { Authorization: 'Bearer nonsense' } })).json.error, 'signed_out')
  eq((await api(null, '/api/staff/me', { headers: { Authorization: `Basic ${A.id}.${A.secret}` } })).status, 401)
  eq((await api({ id: A.id, secret: B.secret }, '/api/staff/me')).status, 401, 'wrong secret')
  eq((await api({ id: P.encodeShareId(crypto.randomBytes(16)), secret: A.secret }, '/api/staff/me')).status, 401, 'unknown pass')
  eq((await api({ id: '../' + A.id.slice(3), secret: A.secret }, '/api/staff/me')).status, 401, 'path in pass id')
  const me = await api(A, '/api/staff/me')
  eq(me.status, 200)
  eq(me.json.name, 'Staff One')
  eq(me.json.limits.chunkBytes, CHUNK)
  eq(me.json.limits.maxBytes, Math.floor(0.002 * 2 ** 30))
  eq(me.json.limits.extensions.join(','), 'zip,rar,7z')
  eq(me.json.limits.days.join(','), '1,3,7,14,30,60,90')
  ok(!JSON.stringify(me.json).includes('verifier'), 'no verifier')
  // a third pass, switched off in Hopper, stops working within the cache time
  const C = await hopper.pass()
  eq((await api(C, '/api/staff/me')).status, 200)
  await hopper.h['pubshare.passRevoke'](C.id)
  await sleep(250)
  eq((await api(C, '/api/staff/me')).status, 401, 'switched-off pass refused')
  // a pass marked revoked in its file is refused too
  const D = await hopper.pass()
  const f = path.join(STORE, '_staff', `${D.id}.json`)
  await fsp.writeFile(f, JSON.stringify({ ...JSON.parse(await fsp.readFile(f, 'utf8')), revokedAt: Date.now() }))
  await sleep(250)
  eq((await api(D, '/api/staff/me')).status, 401, 'revokedAt refused')
  // a malformed pass file is refused
  await fsp.writeFile(f, '{"v":1,"id":"' + D.id + '","user":"staff1","verifier":"zz"}')
  await sleep(250)
  eq((await api(D, '/api/staff/me')).status, 401, 'malformed pass refused')
  // the pass folder is never a share
  eq((await request(`/api/s/${A.id}`)).status, 404)
  eq((await request('/api/s/_staff')).status, 404)
  eq((await request(`/d/${A.id}/0`)).status, 404)
})

await check('failed sign-ins are rate limited per client address; valid passes and other addresses are unaffected', async () => {
  const bad = { id: A.id, secret: B.secret }
  let last
  for (let i = 0; i < 10; i++) last = await api(bad, '/api/staff/me', { headers: { 'x-test-ip': '203.0.113.9' } })
  eq(last.status, 401)
  const locked = await api(bad, '/api/staff/me', { headers: { 'x-test-ip': '203.0.113.9' } })
  eq(locked.status, 429, 'further wrong attempts from that address are refused')
  ok(Number(locked.headers['retry-after']) > 0, 'Retry-After')
  // a whole office shares one public address: a valid pass must never be locked out by someone else
  eq((await api(A, '/api/staff/me', { headers: { 'x-test-ip': '203.0.113.9' } })).status, 200, 'the right pass still works from that address')
  eq((await api(A, '/api/staff/me', { headers: { 'x-test-ip': '203.0.113.10' } })).status, 200, 'other address')
})

await check('web switched off in the office settings: the whole staff API is refused, without a restart', async () => {
  app.setStaff({ enabled: false, maxGB: 0.002, chunkBytes: CHUNK }, 0)
  const r = await api(A, '/api/staff/me')
  eq(r.status, 403)
  eq(r.json.error, 'disabled')
  eq((await api(A, '/api/staff/uploads', { method: 'POST', json: { name: 'a.zip', size: 10 } })).status, 403)
  eq((await putChunk(A, P.encodeShareId(crypto.randomBytes(16)), 0, Buffer.alloc(10))).status, 403)
  app.setStaff({ enabled: true, maxGB: 0.002, chunkBytes: CHUNK, maxUnfinished: 2 }, 0)
  eq((await api(A, '/api/staff/me')).status, 200)
})

await check('create: wrong type, tricky names, oversize, bad password and missing fields are refused; nothing is written', async () => {
  const before = (await fsp.readdir(STORE)).sort().join(',')
  const tries = [
    [{ name: 'setup.exe', size: 100 }, 400, 'bad_type'],
    [{ name: 'drawing.pdf', size: 100 }, 400, 'bad_type'],
    [{ name: 'archive.zip.exe', size: 100 }, 400, 'bad_type'],
    [{ name: 'noext', size: 100 }, 400, 'bad_type'],
    [{ name: '../escape.zip', size: 100 }, 400, 'bad_name'],
    [{ name: '..\\..\\escape.zip', size: 100 }, 400, 'bad_name'],
    [{ name: 'sub/dir.zip', size: 100 }, 400, 'bad_name'],
    [{ name: 'C:\\Windows\\x.zip', size: 100 }, 400, 'bad_name'],
    [{ name: 'trailing.zip.', size: 100 }, 400, 'bad_name'],
    [{ name: 'ctrl\u0007.zip', size: 100 }, 400, 'bad_name'],
    [{ name: '.zip', size: 100 }, 400, 'bad_name'],
    [{ name: 'x'.repeat(200) + '.zip', size: 100 }, 400, 'bad_name'],
    [{ name: 'big.zip', size: Math.floor(0.002 * 2 ** 30) + 1 }, 413, 'too_big'],
    [{ name: 'zero.zip', size: 0 }, 400, 'bad_request'],
    [{ name: 'neg.zip', size: -5 }, 400, 'bad_request'],
    [{ name: 'frac.zip', size: 10.5 }, 400, 'bad_request'],
    [{ name: 'pw.zip', size: 100, password: 'short' }, 400, 'bad_password'],
    [{ size: 100 }, 400, 'bad_name']
  ]
  for (const [body, status, error] of tries) {
    const r = await api(A, '/api/staff/uploads', { method: 'POST', json: body })
    eq(r.status, status, JSON.stringify(body))
    eq(r.json.error, error, JSON.stringify(body))
  }
  const big = await api(A, '/api/staff/uploads', { method: 'POST', json: { name: 'big.zip', size: 10 ** 12 } })
  eq(big.json.maxBytes, Math.floor(0.002 * 2 ** 30), 'limit stated')
  eq((await api(A, '/api/staff/uploads', { method: 'POST', body: '{"name":"a.zip","size":1}' })).status, 415, 'needs JSON')
  eq((await api(A, '/api/staff/uploads', { method: 'POST', json: undefined, headers: { 'Content-Type': 'application/json' }, body: 'not json' })).status, 400)
  eq((await fsp.readdir(STORE)).sort().join(','), before, 'store unchanged')
})

let first
await check('upload: chunks in shuffled order, finish, manifest in Hopper\'s exact format, download through the client route with the same SHA-256', async () => {
  const buf = zipLike(5 * CHUNK + 1234)
  first = await uploadAll(A, buf, { name: 'Lot 07 isometrics (rev B).zip', message: 'Rev B as discussed.', days: 14 })
  eq(first.finish.status, 200, JSON.stringify(first.finish.json))
  eq(first.chunks, 6)
  const { id } = first
  ok(Math.abs(first.finish.json.expiresAt - Date.now() - 14 * P.DAY_MS) < 10_000, 'expires in 14 days')
  eq((await fsp.readdir(path.join(STORE, id))).sort().join(','), 'data,manifest.json', 'folder holds what Hopper\'s does')
  const m = JSON.parse(await fsp.readFile(path.join(STORE, id, 'manifest.json'), 'utf8'))
  ok(S.validateManifest(m, id), 'server accepts the manifest')
  // compare with a manifest Hopper writes
  const file = path.join(SRC, 'hopper.zip')
  await fsp.writeFile(file, zipLike(5000))
  const hop = await hopper.create({ paths: [file], title: 'Made in Hopper', days: 7 })
  const hm = JSON.parse(await fsp.readFile(path.join(STORE, hop.id, 'manifest.json'), 'utf8'))
  eq(Object.keys(m).join(','), Object.keys(hm).join(','), 'same keys in the same order')
  // (Hopper adds "mtime" only when it hard-links a file instead of copying it)
  eq(Object.keys(m.files[0]).join(','), Object.keys(hm.files[0]).filter((k) => k !== 'mtime').join(','), 'same file keys')
  eq(m.title, 'Lot 07 isometrics (rev B).zip', 'title defaults to the file name')
  eq(m.message, 'Rev B as discussed.')
  eq(m.sender, 'Staff One', 'sender = pass display name')
  eq(JSON.stringify(m.owner), JSON.stringify({ user: 'staff1', host: 'PC-TEST-07' }))
  eq(m.files[0].sha256, sha(buf))
  eq(m.password, null)
  const meta = await request(`/api/s/${id}`)
  eq(meta.status, 200)
  eq(meta.json.sender, 'Staff One')
  const dl = await request(`/d/${id}/0`)
  eq(dl.status, 200)
  eq(sha(dl.body), sha(buf), 'downloaded bytes')
  ok(/filename="Lot 07 isometrics \(rev B\)\.zip"/.test(dl.headers['content-disposition']), dl.headers['content-disposition'])
  // Hopper's own list shows it as mine
  const list = await hopper.h['pubshare.list']()
  ok(list.some((l) => l.id === id && l.sender === 'Staff One' && l.owner === 'staff1'), 'in Hopper\'s list')
  // finishing again just reports the link
  const again = await api(A, `/api/staff/uploads/${id}/finish`, { method: 'POST', json: {} })
  eq(again.status, 200)
  eq(again.json.expiresAt, first.finish.json.expiresAt)
  // and the upload is no longer listed as unfinished
  eq((await api(A, '/api/staff/uploads')).json.uploads.length, 0)
  return `${buf.length} bytes in ${first.chunks} chunks`
})

await check('resume: the server lists which chunks it has; a reload carries on where it stopped', async () => {
  const buf = zipLike(4 * CHUNK + 77)
  const r = await startUpload(A, { name: 'Resume me.zip', size: buf.length })
  eq(r.status, 201)
  const parts = chunksOf(buf)
  eq((await putChunk(A, r.json.id, 2, parts[2])).status, 200)
  eq((await putChunk(A, r.json.id, 0, parts[0])).status, 200)
  const st = await api(A, `/api/staff/uploads/${r.json.id}`)
  eq(st.status, 200)
  eq(st.json.have.join(','), '0,2')
  eq(st.json.chunks, 5)
  eq(st.json.received, 2 * CHUNK)
  eq(st.json.name, 'Resume me.zip')
  eq(st.json.state, 'uploading')
  const list = await api(A, '/api/staff/uploads')
  ok(list.json.uploads.some((u) => u.id === r.json.id && u.size === buf.length), 'listed as unfinished')
  const links = await api(A, '/api/staff/links')
  ok(links.json.uploads.some((u) => u.id === r.json.id), 'links answer carries unfinished uploads')
  // finishing too early is refused, and says how many are missing
  const early = await api(A, `/api/staff/uploads/${r.json.id}/finish`, { method: 'POST', json: {} })
  eq(early.status, 409)
  eq(early.json.missing, 3)
  for (const n of [4, 1, 3]) eq((await putChunk(A, r.json.id, n, parts[n])).status, 200)
  // re-sending a chunk that is already there is harmless
  eq((await putChunk(A, r.json.id, 1, parts[1])).status, 200)
  const f = await api(A, `/api/staff/uploads/${r.json.id}/finish`, { method: 'POST', json: {} })
  eq(f.status, 200, JSON.stringify(f.json))
  eq(sha((await request(`/d/${r.json.id}/0`)).body), sha(buf))
})

await check('chunk size is exact: wrong length, out-of-range index, a short body and an overlong body are refused and not counted', async () => {
  const buf = zipLike(2 * CHUNK + 10)
  const r = await startUpload(A, { name: 'Sizes.zip', size: buf.length })
  const { id } = r.json
  const parts = chunksOf(buf)
  const wrong = await putChunk(A, id, 0, parts[0].subarray(0, CHUNK - 1))
  eq(wrong.status, 400)
  eq(wrong.json.error, 'wrong_size')
  eq(wrong.json.expected, CHUNK)
  eq((await putChunk(A, id, 2, parts[1])).json.error, 'wrong_size', 'last chunk must be the remainder')
  eq((await putChunk(A, id, 3, parts[2])).json.error, 'bad_chunk')
  eq((await request(`/api/staff/uploads/${id}/0`, { method: 'PUT', headers: { ...auth(A), 'Transfer-Encoding': 'chunked' }, body: parts[0] })).json.error, 'wrong_size', 'needs Content-Length')
  // overlong: claims the right length but sends more on the same connection
  const over = await request(`/api/staff/uploads/${id}/1`, { method: 'PUT', headers: { ...auth(A), 'Content-Length': CHUNK }, raw: (req) => { req.write(Buffer.concat([parts[1], Buffer.alloc(5000)])); req.end() } })
  ok([200, 400].includes(over.status), `overlong answered ${over.status}`)
  // short: the connection drops halfway
  await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'PUT', path: `/api/staff/uploads/${id}/0`, headers: { ...auth(A), 'Content-Length': CHUNK }, agent: false })
    req.on('error', () => resolve())
    req.write(parts[0].subarray(0, 20000))
    setTimeout(() => { req.destroy(); resolve() }, 300)
  })
  await sleep(300)
  const st = await api(A, `/api/staff/uploads/${id}`)
  ok(!st.json.have.includes(0), `short chunk not counted: ${st.json.have}`)
  // what Node delivers for "overlong" is exactly the declared length; the extra bytes never reach the file
  eq((await putChunk(A, id, 0, parts[0])).status, 200)
  eq((await putChunk(A, id, 1, parts[1])).status, 200)
  eq((await putChunk(A, id, 2, parts[2])).status, 200)
  const f = await api(A, `/api/staff/uploads/${id}/finish`, { method: 'POST', json: {} })
  eq(f.status, 200, JSON.stringify(f.json))
  eq(sha((await request(`/d/${id}/0`)).body), sha(buf), 'file exactly as sent')
})

await check('content must match the name: a .rar holding a zip and a .7z holding text are refused at finish and removed; real rar and 7z signatures pass', async () => {
  const lie = await uploadAll(A, zipLike(1000), { name: 'Actually a zip.rar' })
  eq(lie.finish.status, 422)
  eq(lie.finish.json.error, 'wrong_content')
  eq(lie.finish.json.extension, 'rar')
  ok(!fs.existsSync(path.join(STORE, lie.id)), 'folder removed')
  const txt = await uploadAll(A, Buffer.from('just some text, not an archive at all'), { name: 'notes.7z' })
  eq(txt.finish.status, 422)
  const rar5 = await uploadAll(A, Buffer.concat([Buffer.from('Rar!\x1a\x07\x01\x00', 'latin1'), crypto.randomBytes(3000)]), { name: 'Model.rar' })
  eq(rar5.finish.status, 200, 'RAR 5')
  const rar4 = await uploadAll(A, Buffer.concat([Buffer.from('Rar!\x1a\x07\x00', 'latin1'), crypto.randomBytes(3000)]), { name: 'Old model.RAR' })
  eq(rar4.finish.status, 200, 'RAR 4, upper-case extension')
  const z7 = await uploadAll(A, Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]), crypto.randomBytes(3000)]), { name: 'Pack.7z' })
  eq(z7.finish.status, 200, '7z')
  eq(S.archiveKind(Buffer.from('PK\x05\x06', 'latin1')), 'zip', 'empty zip')
  eq(S.archiveKind(Buffer.from('MZ\x90\x00', 'latin1')), null)
})

await check('cancel removes the folder; an unfinished upload cannot be finished or written afterwards', async () => {
  const buf = zipLike(3 * CHUNK)
  const r = await startUpload(A, { name: 'Cancel me.zip', size: buf.length })
  const { id } = r.json
  eq((await putChunk(A, id, 1, chunksOf(buf)[1])).status, 200)
  ok(fs.existsSync(path.join(STORE, id, 'creating.json')))
  const d = await api(A, `/api/staff/uploads/${id}`, { method: 'DELETE' })
  eq(d.status, 200)
  ok(!fs.existsSync(path.join(STORE, id)), 'folder gone')
  eq((await putChunk(A, id, 0, chunksOf(buf)[0])).status, 404, 'no writing after cancel')
  ok(!fs.existsSync(path.join(STORE, id)), 'not recreated')
  eq((await api(A, `/api/staff/uploads/${id}/finish`, { method: 'POST', json: {} })).status, 404)
})

await check('at most two unfinished uploads per pass', async () => {
  for (const u of (await api(A, '/api/staff/uploads')).json.uploads) await api(A, `/api/staff/uploads/${u.id}`, { method: 'DELETE' })
  const a = await startUpload(A, { name: 'one.zip', size: 100 })
  const b = await startUpload(A, { name: 'two.zip', size: 100 })
  const c = await startUpload(A, { name: 'three.zip', size: 100 })
  eq(a.status, 201)
  eq(b.status, 201)
  eq(c.status, 409)
  eq(c.json.error, 'too_many_uploads')
  eq((await startUpload(B, { name: 'other.zip', size: 100 })).status, 201, 'another pass is not affected')
  await api(A, `/api/staff/uploads/${a.json.id}`, { method: 'DELETE' })
  eq((await startUpload(A, { name: 'three.zip', size: 100 })).status, 201, 'room again after a cancel')
  for (const u of (await api(A, '/api/staff/uploads')).json.uploads) await api(A, `/api/staff/uploads/${u.id}`, { method: 'DELETE' })
})

await check('pass A cannot see, write, finish, cancel, revoke or renew anything of pass B (all answer 404, as if missing)', async () => {
  const buf = zipLike(2 * CHUNK)
  for (const u of (await api(B, '/api/staff/uploads')).json.uploads) await api(B, `/api/staff/uploads/${u.id}`, { method: 'DELETE' })
  const up = await startUpload(B, { name: 'Other upload.zip', size: buf.length })
  const { id } = up.json
  eq((await api(A, `/api/staff/uploads/${id}`)).status, 404)
  eq((await putChunk(A, id, 0, chunksOf(buf)[0])).status, 404)
  eq((await api(A, `/api/staff/uploads/${id}/finish`, { method: 'POST', json: {} })).status, 404)
  eq((await api(A, `/api/staff/uploads/${id}`, { method: 'DELETE' })).status, 404)
  ok(fs.existsSync(path.join(STORE, id, 'creating.json')), 'B\'s upload untouched')
  ok(!(await api(A, '/api/staff/uploads')).json.uploads.some((u) => u.id === id), 'not in A\'s list')
  // B's finished link
  const done = await uploadAll(B, buf, { name: 'Other link.zip' })
  eq(done.finish.status, 200)
  const linksA = (await api(A, '/api/staff/links')).json.links
  ok(!linksA.some((l) => l.id === done.id), 'not in A\'s links')
  ok((await api(B, '/api/staff/links')).json.links.some((l) => l.id === done.id), 'in B\'s links')
  const rv = await api(A, `/api/staff/links/${done.id}/revoke`, { method: 'POST', json: {} })
  eq(rv.status, 404)
  eq(rv.json.error, 'not_found')
  eq((await api(A, `/api/staff/links/${done.id}/renew`, { method: 'POST', json: { days: 30 } })).status, 404)
  eq((await request(`/api/s/${done.id}?quiet`)).status, 200, 'B\'s link still works')
  const missing = await api(A, `/api/staff/links/${P.encodeShareId(crypto.randomBytes(16))}/revoke`, { method: 'POST', json: {} })
  eq(missing.body.toString(), rv.body.toString(), 'same answer as a link that does not exist')
})

await check('links: mine only (Hopper-made ones included) with downloads; revoke and renew do exactly what Hopper\'s revoke and extend do', async () => {
  const file = path.join(SRC, 'hopper-made.zip')
  await fsp.writeFile(file, zipLike(4000))
  const hop = await hopper.create({ paths: [file], title: 'Made in Hopper', days: 3 })
  await request(`/d/${first.id}/0`)
  await sleep(500)
  const r = await api(A, '/api/staff/links')
  eq(r.status, 200)
  const mine = r.json.links
  ok(mine.some((l) => l.id === hop.id && l.title === 'Made in Hopper'), 'Hopper-made link listed')
  const row = mine.find((l) => l.id === first.id)
  ok(row.downloads >= 2, `downloads ${row.downloads}`)
  eq(row.hasPassword, false)
  eq(row.files[0].name, 'Lot 07 isometrics (rev B).zip')
  ok(mine.every((l, i) => i === 0 || mine[i - 1].createdAt >= l.createdAt), 'newest first')
  ok(!JSON.stringify(r.json).includes('owner') && !JSON.stringify(r.json).includes('sha256'), 'no owner or checksum in the answer')
  // renew = extend: from the current expiry, or from now when expired; never more than a year ahead
  const before = JSON.parse(await fsp.readFile(path.join(STORE, hop.id, 'manifest.json'), 'utf8')).expiresAt
  const rn = await api(A, `/api/staff/links/${hop.id}/renew`, { method: 'POST', json: { days: 14 } })
  eq(rn.status, 200)
  eq(rn.json.expiresAt, before + 14 * P.DAY_MS)
  const viaHopper = await hopper.h['pubshare.extend'](hop.id, 14)
  eq(viaHopper, before + 28 * P.DAY_MS, 'Hopper continues from the same date')
  const capped = await api(A, `/api/staff/links/${hop.id}/renew`, { method: 'POST', json: { days: 5000 } })
  eq(capped.json.expiresAt, viaHopper + 90 * P.DAY_MS, 'at most 90 days at a time, like Hopper')
  // an expired link renews from today
  const exp = await uploadAll(A, zipLike(500), { name: 'Expired.zip' })
  const mf = path.join(STORE, exp.id, 'manifest.json')
  await fsp.writeFile(mf, JSON.stringify({ ...JSON.parse(await fsp.readFile(mf, 'utf8')), expiresAt: Date.now() - 1000 }))
  await sleep(200)
  ok((await api(A, '/api/staff/links')).json.links.find((l) => l.id === exp.id).expired, 'shown as expired')
  const revived = await api(A, `/api/staff/links/${exp.id}/renew`, { method: 'POST', json: { days: 3 } })
  ok(Math.abs(revived.json.expiresAt - (Date.now() + 3 * P.DAY_MS)) < 5000, 'from today')
  await sleep(200)
  eq((await request(`/api/s/${exp.id}?quiet`)).status, 200, 'works again')
  ok(S.validateManifest(JSON.parse(await fsp.readFile(mf, 'utf8')), exp.id), 'manifest still valid')
  eq((await api(A, `/api/staff/links/${exp.id}/renew`, { method: 'POST', body: 'x' })).status, 415, 'renew needs JSON')
  // revoke = Hopper's revoke: link gone at once, folder removed, Hopper's list no longer has it
  const rk = await api(A, `/api/staff/links/${hop.id}/revoke`, { method: 'POST', json: {} })
  eq(rk.status, 200)
  ok(!fs.existsSync(path.join(STORE, hop.id)), 'folder removed')
  await sleep(200)
  eq((await request(`/api/s/${hop.id}`)).status, 404)
  ok(!(await hopper.h['pubshare.list']()).some((l) => l.id === hop.id), 'gone from Hopper too')
  eq((await api(A, `/api/staff/links/${hop.id}/revoke`, { method: 'POST', json: {} })).status, 404, 'twice: already gone')
  // and a link this page made is revoked by Hopper the usual way
  await hopper.h['pubshare.revoke'](exp.id)
  ok(!(await api(A, '/api/staff/links')).json.links.some((l) => l.id === exp.id))
})

await check('password: stored only as the scrypt verifier; the client page route unlocks with it', async () => {
  const buf = zipLike(CHUNK + 500)
  const pw = 'k7Hd-Qm3x-9TpW'
  const up = await uploadAll(A, buf, { name: 'Tender package.zip', password: pw, title: 'Tender package - confidential' })
  eq(up.finish.status, 200)
  const m = JSON.parse(await fsp.readFile(path.join(STORE, up.id, 'manifest.json'), 'utf8'))
  ok(S.validVerifier(m.password), 'verifier')
  eq(m.title, 'Tender package - confidential')
  for (const f of fs.readdirSync(path.join(STORE, up.id))) if (!fs.statSync(path.join(STORE, up.id, f)).isDirectory()) ok(!fs.readFileSync(path.join(STORE, up.id, f), 'utf8').includes(pw), `password in ${f}`)
  const meta = await request(`/api/s/${up.id}`)
  eq(meta.json.needsPassword, true)
  eq(meta.json.files, null)
  eq((await request(`/d/${up.id}/0`)).status, 401)
  const bad = await request(`/api/s/${up.id}/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong-one' }) })
  eq(bad.status, 403)
  const good = await request(`/api/s/${up.id}/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) })
  eq(good.status, 200)
  const dl = await request(`/d/${up.id}/0?t=${encodeURIComponent(good.json.token)}`)
  eq(dl.status, 200)
  eq(sha(dl.body), sha(buf))
  ok((await api(A, '/api/staff/links')).json.links.find((l) => l.id === up.id).hasPassword)
})

await check('clean-up: an upload idle for over 24 hours is removed by the existing clean-up; a running one and the pass folder are not', async () => {
  for (const u of (await api(A, '/api/staff/uploads')).json.uploads) await api(A, `/api/staff/uploads/${u.id}`, { method: 'DELETE' })
  const old = await startUpload(A, { name: 'Abandoned.zip', size: 2 * CHUNK })
  const fresh = await startUpload(A, { name: 'Busy.zip', size: 2 * CHUNK })
  const t = new Date(Date.now() - 25 * 3_600_000)
  await fsp.utimes(path.join(STORE, old.json.id, 'creating.json'), t, t)
  await fsp.utimes(path.join(STORE, fresh.json.id, 'creating.json'), t, t)
  // a chunk arriving marks the upload as in use again
  eq((await putChunk(A, fresh.json.id, 0, zipLike(CHUNK))).status, 200)
  const removed = await app.cleanup()
  ok(removed.includes(old.json.id), 'abandoned upload removed')
  ok(!removed.includes(fresh.json.id) && fs.existsSync(path.join(STORE, fresh.json.id)), 'upload in use kept')
  ok(fs.existsSync(path.join(STORE, '_staff', `${A.id}.json`)), 'passes untouched')
  ok(!removed.some((x) => !P.SHARE_ID_RE.test(x)))
  await api(A, `/api/staff/uploads/${fresh.json.id}`, { method: 'DELETE' })
})

await check('CORS: the page origin may send Authorization, PUT and DELETE; other sites are refused', async () => {
  const pre = await request('/api/staff/uploads/' + P.encodeShareId(crypto.randomBytes(16)) + '/0', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type' } })
  eq(pre.status, 204)
  eq(pre.headers['access-control-allow-origin'], ORIGIN)
  ok(/PUT/.test(pre.headers['access-control-allow-methods']) && /DELETE/.test(pre.headers['access-control-allow-methods']), pre.headers['access-control-allow-methods'])
  ok(/Authorization/i.test(pre.headers['access-control-allow-headers']), pre.headers['access-control-allow-headers'])
  const me = await api(A, '/api/staff/me', { headers: { Origin: ORIGIN } })
  eq(me.status, 200)
  eq(me.headers['access-control-allow-origin'], ORIGIN)
  const evil = await api(A, '/api/staff/me', { headers: { Origin: 'https://evil.example' } })
  eq(evil.status, 403)
  eq(evil.headers['access-control-allow-origin'], undefined)
  eq((await request('/api/staff/me', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } })).status, 403)
})

await check('wrong methods and unknown staff paths: 405 with Allow, or 404', async () => {
  const r = await api(A, '/api/staff/me', { method: 'POST', json: {} })
  eq(r.status, 405)
  ok(/GET/.test(r.headers.allow))
  eq((await api(A, '/api/staff/links', { method: 'DELETE' })).status, 405)
  eq((await api(A, '/api/staff/nothing')).status, 404)
  eq((await api(A, '/api/staff/uploads/../../secret')).status, 404)
  eq((await api(A, `/api/staff/links/${first.id}/delete`, { method: 'POST', json: {} })).status, 404)
})

await check('last use is recorded in the server\'s state folder (never in the pass file); Hopper lists passes with it; switch off works for the owner and admins only', async () => {
  await api(A, '/api/staff/me')
  await sleep(500)
  const usedFile = JSON.parse(await fsp.readFile(path.join(WORK, 'state', 'staff-used.json'), 'utf8'))
  ok(usedFile[A.id] > Date.now() - 60_000, 'state file')
  const passFile = JSON.parse(await fsp.readFile(path.join(STORE, '_staff', `${A.id}.json`), 'utf8'))
  eq(Object.keys(passFile).sort().join(','), 'createdAt,host,id,name,user,v,verifier', 'pass file unchanged')
  ok(app.health().staffUsed[A.id] > 0, 'in the heartbeat numbers')
  // what the supervisor's heartbeat writes into the store
  await fsp.writeFile(path.join(STORE, '_server.json'), JSON.stringify({ v: 1, updated: Date.now(), ...app.health() }))
  const mine = await hopper.h['pubshare.passList']()
  const row = mine.find((p) => p.id === A.id)
  ok(row && row.lastUsedAt > Date.now() - 60_000, JSON.stringify(row))
  eq(row.host, 'PC-TEST-07')
  ok(!JSON.stringify(mine).includes('verifier'), 'no verifier to the UI')
  ok(mine.every((p) => p.user === 'staff1'), 'only mine')
  ok(!mine.some((p) => p.id === B.id))
  let err = ''
  await other.h['pubshare.passList']('all').catch((e) => (err = e.message))
  ok(/admin/.test(err), 'non-admins cannot list everyone: ' + err)
  const all = await hopper.h['pubshare.passList']('all')
  ok(all.some((p) => p.id === B.id && p.user === 'staff2') && all.some((p) => p.id === A.id), 'admin sees everyone')
  err = ''
  await other.h['pubshare.passRevoke'](A.id).catch((e) => (err = e.message))
  ok(/someone else/.test(err), err)
  ok(fs.existsSync(path.join(STORE, '_staff', `${A.id}.json`)))
  // an admin switches the other person's off; it stops working
  await hopper.h['pubshare.passRevoke'](B.id)
  await sleep(250)
  eq((await api(B, '/api/staff/me')).status, 401)
  ok(!(await hopper.h['pubshare.passList']('all')).some((p) => p.id === B.id))
})

await check('log: no secret, no Authorization header, no passwords', async () => {
  await app.flushStats()
  const text = fs.readdirSync(path.join(WORK, 'logs')).map((f) => fs.readFileSync(path.join(WORK, 'logs', f), 'utf8')).join('\n')
  ok(text.includes('staff-upload-started'), 'staff events logged')
  for (const leak of [A.secret, B.secret, 'Bearer', 'k7Hd-Qm3x-9TpW', A.id, 'authorization']) ok(!text.includes(leak), `log leaks ${leak.slice(0, 12)}`)
})

await check('slow clients: a stalled upload chunk is dropped and not counted; other requests must send their body in time', async () => {
  const slowStore = path.join(WORK, 'store-slow')
  await fsp.mkdir(path.join(slowStore, '_staff'), { recursive: true })
  await fsp.copyFile(path.join(STORE, '_staff', `${A.id}.json`), path.join(slowStore, '_staff', `${A.id}.json`))
  const srv = S.createShareServer(serverConfig({ store: slowStore, uploadIdleSeconds: 1, bodyTimeoutSeconds: 1, logDir: path.join(WORK, 'logs-slow'), stateDir: path.join(WORK, 'state-slow') }))
  const port = await srv.listen()
  try {
    const r = await request('/api/staff/uploads', { port, method: 'POST', headers: { ...auth(A), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'slow.zip', size: CHUNK }) })
    eq(r.status, 201)
    const t0 = Date.now()
    const closed = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: `/api/staff/uploads/${r.json.id}/0`, headers: { ...auth(A), 'Content-Length': CHUNK }, agent: false })
      req.on('error', () => resolve(Date.now() - t0))
      req.on('close', () => resolve(Date.now() - t0))
      req.write(Buffer.alloc(1000))
    })
    ok(closed >= 900 && closed < 5000, `stalled chunk dropped after ${closed} ms`)
    await sleep(200)
    eq((await request(`/api/staff/uploads/${r.json.id}`, { port, headers: auth(A) })).json.have.length, 0, 'not counted')
    const t1 = Date.now()
    const cut = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/staff/uploads', headers: { ...auth(A), 'Content-Type': 'application/json', 'Content-Length': 100 }, agent: false })
      req.on('error', () => resolve(Date.now() - t1))
      req.on('close', () => resolve(Date.now() - t1))
      req.write('{"pass')
    })
    ok(cut >= 900 && cut < 5000, `trickled body cut after ${cut} ms`)
  } finally {
    await srv.close(0)
  }
})

await app.close(0)
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
if (!process.argv.includes('--keep') && !failed.length) await fsp.rm(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {})
process.exit(failed.length ? 1 : 0)
