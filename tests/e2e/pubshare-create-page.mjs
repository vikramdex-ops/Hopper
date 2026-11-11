// Dexterity Share staff page (site/share/create/), driven in a real browser (system Edge through
// playwright-core) against the real share server on a scratch store, signed in with a pass made by
// Hopper's engine. Screenshots (demo data only) go to <work>\create-page\shots. Nothing leaves this PC.
//   node --no-warnings tests/e2e/pubshare-create-page.mjs
import { TEST_WORK } from '../unit/pubshare-hooks.mjs'
import http from 'node:http'
import fs, { promises as fsp } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright-core'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORK = path.join(TEST_WORK, 'create-page')
process.env.TEMP = process.env.TMP = TEST_WORK
const STORE = path.join(WORK, 'store')
const SHOTS = path.join(WORK, 'shots')
const FILES = path.join(WORK, 'files')
const SITE = path.join(root, 'site')
const CHUNK = 65536

const S = await import('../../server/dexterity-share/server.mjs')
const E = await import('../../src/engine/pubshare.ts')
const P = await import('../../src/shared/pubshare.ts')

const results = []
async function check(name, fn) {
  const t0 = Date.now()
  try {
    const note = await fn()
    results.push({ name, ok: true })
    console.log(`  ok    ${name}${note ? `  [${note}]` : ''}  (${Date.now() - t0} ms)`)
  } catch (e) {
    results.push({ name, ok: false })
    console.log(`  FAIL  ${name}\n        ${String(e?.stack ?? e).split('\n').slice(0, 5).join('\n        ')}`)
  }
}
const ok = (v, msg) => { if (!v) throw new Error(msg || 'assertion failed') }
const eq = (a, b, msg = '') => { if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

await fsp.rm(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
for (const d of [STORE, SHOTS, FILES]) await fsp.mkdir(d, { recursive: true })

// ---- a real zip (stored entries, CRC-32), so the result opens in any unzip tool --------------------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c })
const crc32 = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0 }
function makeZip(entries) {
  const locals = []
  const centrals = []
  let off = 0
  for (const [name, data] of entries) {
    const n = Buffer.from(name)
    const crc = crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42)
    locals.push(lh, n, data)
    centrals.push(ch, n)
    off += 30 + n.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16)
  return Buffer.concat([...locals, cd, end])
}
const register = Buffer.from('S.No,Drawing,Rev,Comment,Status\r\n1,ISO-1001,B,Add weld no.,Open\r\n2,ISO-1002,B,Check support SP-14,Closed\r\n')
const zipBytes = makeZip([['Lot 07/Comment register.csv', register], ['Lot 07/ISO-1001_RevB.pdf', crypto.randomBytes(150_000)], ['Lot 07/ISO-1002_RevB.pdf', crypto.randomBytes(90_000)]])
const ZIP = path.join(FILES, 'Lot 07 isometrics rev B.zip')
await fsp.writeFile(ZIP, zipBytes)
const RESUME_ZIP = path.join(FILES, 'Pipe rack 3 model.zip')
const resumeBytes = makeZip([['model/rack3.rvm', crypto.randomBytes(260_000)]])
await fsp.writeFile(RESUME_ZIP, resumeBytes)
const SLOW_ZIP = path.join(FILES, 'Stress report pack.zip')
const slowBytes = makeZip([['stress/report.pdf', zlib.deflateSync(crypto.randomBytes(1000)), ], ['stress/appendix.bin', crypto.randomBytes(330_000)]])
await fsp.writeFile(SLOW_ZIP, slowBytes)
const WRONG = path.join(FILES, 'Drawing list.pdf')
await fsp.writeFile(WRONG, '%PDF-1.7 demo')
const FAKE_ZIP = path.join(FILES, 'Not really.zip')
await fsp.writeFile(FAKE_ZIP, 'This is plain text with a .zip name.')
const BIG = path.join(FILES, 'Huge model.zip')
{
  const fh = await fsp.open(BIG, 'w')
  await fh.truncate(Math.floor(0.002 * 2 ** 30) + 10)
  await fh.close()
}

// ---- static server for site/ -------------------------------------------------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' }
const site = { config: {} }
const siteServer = http.createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0])
  if (p === '/share/config.json') return res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(site.config))
  const file = path.join(SITE, p.endsWith('/') ? p + 'index.html' : p)
  if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end('not found')
  let body = await fsp.readFile(file)
  // The shipped policy allows https only; the test servers are plain http on loopback, so that one source is added here.
  if (file.endsWith('index.html')) body = Buffer.from(body.toString('utf8').replace('connect-src https:', 'connect-src https: http://127.0.0.1:*'))
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body)
})
await new Promise((r) => siteServer.listen(0, '127.0.0.1', r))
const SITE_ORIGIN = `http://127.0.0.1:${siteServer.address().port}`
const PAGE = `${SITE_ORIGIN}/share/create/`

// ---- share server and Hopper's engine ------------------------------------------------------------------
const app = S.createShareServer({ port: 0, store: STORE, allowedOrigins: [SITE_ORIGIN], stateDir: path.join(WORK, 'state'), logDir: path.join(WORK, 'logs'), manifestCacheMs: 100, passCacheMs: 100, revokeCheckMs: 300, statsFlushMs: 300, apiPerMinutePerIp: 100000, filePerMinutePerIp: 100000, minFreeGB: 0, shutdownGraceSeconds: 0, staff: { enabled: true, maxGB: 0.002, chunkBytes: CHUNK, defaultDays: 7 } })
const PORT = await app.listen()
const BASE = `http://127.0.0.1:${PORT}`
site.config = { base: BASE, pointers: [], pointerKey: null, allowedHosts: ['*.trycloudflare.com'], company: 'Dexterity Design Services Private Limited' }

function engine(user, displayName) {
  const ctx = {
    office: { admins: [user], publicShare: { enabled: true, store: STORE, pageUrl: `${SITE_ORIGIN}/share/`, defaultDays: 7, minFreeGB: 0 } },
    dataDir: path.join(WORK, 'userdata-' + user),
    settings: { officeConfigPath: path.join(WORK, 'office.json'), profile: { displayName }, archivePresets: [] },
    jobs: { create() { throw new Error('not used') } },
    undo: { record() {} },
    emit() {}
  }
  fs.mkdirSync(ctx.dataDir, { recursive: true })
  return E.pubshareHandlers(ctx, { user: () => ({ user, host: 'DEMO-PC-12' }), watch: false })
}
const hopper = engine('demo.staff', 'Demo Sender')
const made = await hopper['pubshare.passCreate']()
const FRAG = made.link.split('#')[1]
const secret = P.parseStaffRef(FRAG).secret
const auth = { Authorization: `Bearer ${made.id}.${secret}` }

// ---- browser ----------------------------------------------------------------------------------------------
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const problems = []
async function open({ mobile = false, dark = false, hash = '', storage } = {}) {
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, deviceScaleFactor: mobile ? 2 : 1, colorScheme: dark ? 'dark' : 'light', isMobile: mobile, hasTouch: mobile })
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: SITE_ORIGIN })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_|ERR_CONNECTION/.test(m.text())) problems.push(m.text()) })
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message))
  page.on('dialog', (d) => { problems.push('dialog: ' + d.message()); void d.dismiss() })
  if (storage) await page.addInitScript((s) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('dxs-staff-pass', s) } }, storage)
  await page.goto(PAGE + (hash ? '#' + hash : ''))
  return { page, ctx }
}
const settled = (page) => page.waitForSelector('main[aria-busy="false"]', { timeout: 30000 })
async function shot(page, name) {
  await sleep(300)
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true })
}
async function noOverflow(page, label) {
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])
  ok(w[0] <= w[1], `${label}: page scrolls sideways (${w[0]} > ${w[1]})`)
}
const storedPass = JSON.stringify({ id: made.id, secret, gist: '', key: '' })

console.log(`Dexterity Share staff page test — screenshots in ${SHOTS}`)

await check('signed out: explains how to get the sign-in link from Hopper; light, dark and phone', async () => {
  for (const mode of ['desktop', 'mobile', 'desktop-dark']) {
    const { page, ctx } = await open({ mobile: mode === 'mobile', dark: mode.endsWith('dark') })
    await settled(page)
    const text = await page.locator('main').innerText()
    ok(/Sign in from Hopper/.test(text) && /Use in a browser/.test(text) && /Bookmark this page/.test(text), text)
    eq(await page.locator('#signout').isVisible(), false)
    await noOverflow(page, mode)
    await shot(page, `01-signed-out-${mode}`)
    await ctx.close()
  }
})

let page
let ctx
await check('sign-in link: pass and secret are stored in this browser and the fragment is removed at once', async () => {
  ;({ page, ctx } = await open({ hash: FRAG }))
  await settled(page)
  eq(await page.evaluate(() => location.hash), '', 'fragment removed')
  ok(!(await page.evaluate(() => location.href)).includes(secret), 'secret not in the address')
  const kept = JSON.parse(await page.evaluate(() => localStorage.getItem('dxs-staff-pass')))
  eq(kept.id, made.id)
  eq(kept.secret, secret)
  ok((await page.locator('#who').innerText()).includes('Signed in as Demo Sender'))
  await page.locator('text=Your links').waitFor()
  // the bookmark (the page without a fragment) still signs in
  await page.goto(PAGE)
  await settled(page)
  ok((await page.locator('#who').innerText()).includes('Demo Sender'), 'signed in from storage')
  ok(!(await page.evaluate(() => JSON.stringify(history.state ?? '') + location.href)).includes(secret))
  await shot(page, '02-workbench-empty')
})

let createdId
let resumeId
await check('create a link from a real zip: chunks, 14 days, generated password, note; the link opens through the client API', async () => {
  await page.setInputFiles('#file', ZIP)
  await page.locator('.drop.has').waitFor()
  await page.locator('.chips button', { hasText: /^14$/ }).click()
  eq(await page.locator('.chips button[aria-pressed="true"]').innerText(), '14')
  await page.locator('button', { hasText: 'Generate' }).click()
  const pw = await page.locator('#pw').inputValue()
  ok(/^[A-HJ-NP-Za-km-np-z2-9]{4}-[A-HJ-NP-Za-km-np-z2-9]{4}-[A-HJ-NP-Za-km-np-z2-9]{4}$/.test(pw), `password ${pw}`)
  await page.locator('#note').fill('Lot 07 isometrics, revision B, with the comment register.')
  await shot(page, '03-form-filled')
  await page.locator('#create').click()
  await page.locator('#result-link').waitFor({ timeout: 60000 })
  const url = await page.locator('#result-link').inputValue()
  ok(url.startsWith(`${SITE_ORIGIN}/share/#`), url)
  createdId = P.parseShareRef(url.split('#')[1]).id
  eq(await page.locator('#result-pw').innerText(), pw, 'password shown once')
  await shot(page, '04-link-ready')
  // what the client gets
  const meta = await (await fetch(`${BASE}/api/s/${createdId}`)).json()
  eq(meta.needsPassword, true)
  eq(meta.sender, 'Demo Sender')
  eq(meta.message, 'Lot 07 isometrics, revision B, with the comment register.')
  ok(meta.expiresAt - Date.now() > 13.9 * P.DAY_MS && meta.expiresAt - Date.now() < 14.1 * P.DAY_MS, '14 days')
  const un = await (await fetch(`${BASE}/api/s/${createdId}/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) })).json()
  ok(un.token, 'unlocked with the shown password')
  eq(un.files[0].name, 'Lot 07 isometrics rev B.zip')
  const body = Buffer.from(await (await fetch(`${BASE}/d/${createdId}/0?t=${encodeURIComponent(un.token)}`)).arrayBuffer())
  eq(sha(body), sha(zipBytes), 'downloaded zip is identical')
  eq(un.files[0].sha256, sha(zipBytes))
  // copy buttons
  await page.locator('#copy-link').click()
  eq(await page.evaluate(() => navigator.clipboard.readText()), url)
  await page.locator('#copy-email').click()
  const mail = await page.evaluate(() => navigator.clipboard.readText())
  ok(mail.includes(url) && mail.includes('Subject: Lot 07 isometrics rev B.zip - files from Dexterity Design Services Private Limited'), mail.slice(0, 200))
  ok(mail.includes('We will send you the password separately.') && !mail.includes(pw), 'e-mail never holds the password')
  const expected = P.buildEmail({ url, title: 'Lot 07 isometrics rev B.zip', message: 'Lot 07 isometrics, revision B, with the comment register.', sender: 'Demo Sender', files: [{ name: 'Lot 07 isometrics rev B.zip', size: zipBytes.length }], expiresAt: meta.expiresAt, hasPassword: true })
  eq(mail, `Subject: ${expected.subject}\r\n\r\n${expected.body}`, 'same wording as Hopper')
  await page.locator('#copy-pw').click()
  eq(await page.evaluate(() => navigator.clipboard.readText()), pw)
  return `${zipBytes.length} bytes in ${Math.ceil(zipBytes.length / CHUNK)} chunks`
})

await check('your links: the new link is listed with its download, status and the counts line', async () => {
  await page.locator('#links button', { hasText: 'Refresh' }).click()
  const row = page.locator(`tr[data-id="${createdId}"]`)
  await row.waitFor()
  await page.waitForFunction((id) => document.querySelector(`tr[data-id="${id}"] td[data-label="Downloads"]`)?.textContent === '1', createdId, { timeout: 10000 })
  eq(await row.locator('.pill').innerText(), 'Active')
  ok((await row.innerText()).includes('Lot 07 isometrics rev B.zip'))
  ok((await row.innerText()).includes('made today'))
  ok((await page.locator('#counts').innerText()).startsWith('1 active'), await page.locator('#counts').innerText())
  await page.locator('#another').click()
  await page.locator('#create').waitFor()
  await shot(page, '05-links-listed')
})

await check('plain-language errors: wrong type, too big (with the limit), and a file that is not really a zip', async () => {
  await page.setInputFiles('#file', WRONG)
  ok((await page.locator('#form-err').innerText()).includes('Only .zip, .rar and .7z'), await page.locator('#form-err').innerText())
  await page.setInputFiles('#file', BIG)
  const big = await page.locator('#form-err').innerText()
  ok(/limit for links made in a browser is 2\.0 MB/.test(big), big)
  await shot(page, '06-too-big')
  await page.setInputFiles('#file', FAKE_ZIP)
  await page.locator('#create').click()
  await page.locator('#up-msg.err').waitFor({ timeout: 30000 })
  ok((await page.locator('#up-msg').innerText()).includes('is not really a .zip file'), await page.locator('#up-msg').innerText())
  await shot(page, '07-not-a-zip')
  await page.locator('button', { hasText: 'Start again' }).click()
  await page.locator('#create').waitFor()
})

await check('resume: an upload started earlier carries on when the same file is chosen again', async () => {
  // what a reload in the middle of an upload leaves behind: the server holds some of the pieces
  const r = await (await fetch(`${BASE}/api/staff/uploads`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Pipe rack 3 model.zip', size: resumeBytes.length, days: 3, message: 'Model for review.' }) })).json()
  for (const n of [0, 2]) await fetch(`${BASE}/api/staff/uploads/${r.id}/${n}`, { method: 'PUT', headers: auth, body: resumeBytes.subarray(n * CHUNK, (n + 1) * CHUNK) })
  await page.reload()
  await settled(page)
  await page.locator('.unfinished', { hasText: 'Pipe rack 3 model.zip' }).waitFor()
  await shot(page, '08-unfinished-listed')
  await page.setInputFiles('#file', RESUME_ZIP)
  eq(await page.locator('#create').innerText(), 'Continue upload')
  ok((await page.locator('.note-box').innerText()).includes('unfinished upload'))
  await page.locator('#create').click()
  await page.locator('#result-link').waitFor({ timeout: 60000 })
  const url = await page.locator('#result-link').inputValue()
  eq(P.parseShareRef(url.split('#')[1]).id, r.id, 'the same upload finished')
  resumeId = r.id
  const body = Buffer.from(await (await fetch(`${BASE}/d/${r.id}/0`)).arrayBuffer())
  eq(sha(body), sha(resumeBytes), 'resumed file is identical')
  const meta = await (await fetch(`${BASE}/api/s/${r.id}?quiet`)).json()
  eq(meta.message, 'Model for review.', 'settings chosen at the start kept')
  await page.locator('#another').click()
})

await check('progress, pause and resume, and automatic retry of a failed piece', async () => {
  let failOnce = true
  let hold = true
  await page.route('**/api/staff/uploads/*/*', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    if (failOnce) {
      failOnce = false
      return route.abort('connectionreset')
    }
    while (hold) await sleep(100)
    return route.continue().catch(() => {})
  })
  await page.setInputFiles('#file', SLOW_ZIP)
  await page.locator('#create').click()
  await page.locator('#pause').waitFor()
  await page.waitForFunction(() => /Trying again/.test(document.getElementById('up-msg')?.textContent ?? ''), null, { timeout: 15000 })
  await shot(page, '09-uploading-retry')
  await page.locator('#pause').click()
  await page.waitForFunction(() => document.getElementById('pause')?.textContent === 'Resume')
  ok((await page.locator('#up-msg').innerText()).includes('Paused'), await page.locator('#up-msg').innerText())
  await shot(page, '10-paused')
  hold = false
  await page.locator('#pause').click()
  await page.locator('#result-link').waitFor({ timeout: 60000 })
  const id = P.parseShareRef((await page.locator('#result-link').inputValue()).split('#')[1]).id
  eq(sha(Buffer.from(await (await fetch(`${BASE}/d/${id}/0`)).arrayBuffer())), sha(slowBytes), 'file intact after a failure and a pause')
  await page.unroute('**/api/staff/uploads/*/*')
  await page.locator('#another').click()
})

await check('cancel asks in the page, then removes the upload from the server', async () => {
  let hold = true
  await page.route('**/api/staff/uploads/*/*', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    while (hold) await sleep(100)
    return route.continue().catch(() => {})
  })
  await page.setInputFiles('#file', SLOW_ZIP)
  await page.locator('#create').click()
  await page.locator('#cancel').click()
  await page.locator('#cancel-yes').waitFor()
  await shot(page, '11-cancel-confirm')
  const before = (await fsp.readdir(STORE)).filter((n) => P.SHARE_ID_RE.test(n) && fs.existsSync(path.join(STORE, n, 'creating.json')))
  ok(before.length === 1, `one upload in progress: ${before}`)
  await page.locator('#cancel-yes').click()
  await page.locator('#create').waitFor()
  hold = false
  ok(!fs.existsSync(path.join(STORE, before[0])), 'folder removed')
  await page.unroute('**/api/staff/uploads/*/*')
})

await check('switch off from the list: confirm in the page, the link stops working, the row says so', async () => {
  const row = page.locator(`tr[data-id="${createdId}"]`)
  await row.locator('button', { hasText: 'Switch off' }).click()
  await row.locator('button', { hasText: 'Yes, switch off' }).waitFor()
  await shot(page, '12-switch-off-confirm')
  await row.locator('button', { hasText: 'Yes, switch off' }).click()
  await page.waitForFunction((id) => document.querySelector(`tr[data-id="${id}"] .pill`)?.textContent === 'Switched off', createdId, { timeout: 10000 })
  eq((await fetch(`${BASE}/api/s/${createdId}`)).status, 404)
  ok(!fs.existsSync(path.join(STORE, createdId)))
  // renew another one
  const other = page.locator(`tr[data-id="${resumeId}"]`)
  const mf = path.join(STORE, resumeId, 'manifest.json')
  const before = JSON.parse(await fsp.readFile(mf, 'utf8')).expiresAt
  await other.locator('button', { hasText: 'Renew' }).click()
  await other.locator('select').selectOption('30')
  await other.locator('button', { hasText: /^Renew$/ }).click()
  await page.waitForFunction(() => /Now expires on/.test(document.getElementById('toast')?.textContent ?? ''), null, { timeout: 10000 })
  eq(JSON.parse(await fsp.readFile(mf, 'utf8')).expiresAt, before + 30 * P.DAY_MS, 'renewed by 30 days, as Hopper extends')
  await shot(page, '13-after-switch-off-and-renew')
})

await check('phone width: the cards stack, nothing scrolls sideways, at 390 and 360 px; dark theme too', async () => {
  for (const dark of [false, true]) {
    const m = await open({ mobile: true, dark, storage: storedPass })
    await settled(m.page)
    await m.page.locator('text=Your links').waitFor()
    await m.page.locator('#links tr[data-id]').first().waitFor()
    const boxes = await m.page.evaluate(() => [document.getElementById('new').getBoundingClientRect().toJSON(), document.getElementById('links').getBoundingClientRect().toJSON()])
    ok(boxes[1].top >= boxes[0].bottom - 1, 'stacked')
    await noOverflow(m.page, `390 ${dark ? 'dark' : 'light'}`)
    await shot(m.page, `14-phone-${dark ? 'dark' : 'light'}`)
    await m.page.setViewportSize({ width: 360, height: 740 })
    await noOverflow(m.page, '360')
    await m.ctx.close()
  }
  const d = await open({ dark: true, storage: storedPass })
  await settled(d.page)
  await d.page.locator('#links tr[data-id]').first().waitFor()
  const bg = await d.page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  ok(bg !== 'rgb(244, 246, 250)', `dark background ${bg}`)
  await shot(d.page, '15-desktop-dark')
  await d.ctx.close()
})

await check('keyboard: the file chooser, chips and buttons can be reached and show focus', async () => {
  await page.keyboard.press('Tab')
  let found = false
  for (let i = 0; i < 12 && !found; i++) {
    found = await page.evaluate(() => document.activeElement?.id === 'file')
    if (!found) await page.keyboard.press('Tab')
  }
  ok(found, 'file input reachable by Tab')
  ok(await page.locator('.drop.focus').count(), 'drop zone shows focus')
  await page.keyboard.press('Tab')
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle)
  eq(outline, 'solid', 'focus ring on the next control')
})

await check('web switched off by an admin: the page says so instead of the workbench', async () => {
  app.setStaff({ enabled: false, maxGB: 0.002, chunkBytes: CHUNK }, 0)
  await page.reload()
  await settled(page)
  ok((await page.locator('main').innerText()).includes('switched off'), await page.locator('main').innerText())
  await shot(page, '16-web-disabled')
  app.setStaff({ enabled: true, maxGB: 0.002, chunkBytes: CHUNK }, 0)
})

await check('sign out on this browser: asks in the page, then forgets the pass', async () => {
  await page.reload()
  await settled(page)
  await page.locator('#signout').click()
  await page.locator('button', { hasText: 'Yes, sign out' }).waitFor()
  await page.locator('button', { hasText: 'Yes, sign out' }).click()
  await page.locator('text=Sign in from Hopper').waitFor()
  eq(await page.evaluate(() => localStorage.getItem('dxs-staff-pass')), null)
  await page.reload()
  await settled(page)
  ok((await page.locator('main').innerText()).includes('Sign in from Hopper'))
})

await check('a pass switched off in Hopper signs the browser out with an explanation', async () => {
  const p2 = await hopper['pubshare.passCreate']()
  const b = await open({ hash: p2.link.split('#')[1] })
  await settled(b.page)
  await b.page.locator('text=Your links').waitFor()
  await hopper['pubshare.passRevoke'](p2.id)
  await sleep(300)
  await b.page.reload()
  await settled(b.page)
  ok((await b.page.locator('main').innerText()).includes('switched off in Hopper'), await b.page.locator('main').innerText())
  eq(await b.page.evaluate(() => localStorage.getItem('dxs-staff-pass')), null, 'forgotten')
  await shot(b.page, '17-signed-out-revoked')
  await b.ctx.close()
})

await check('no console errors, no browser dialogs, nothing blocked by the content security policy', async () => {
  eq(problems.length, 0, problems.join(' | '))
})

await ctx?.close()
await browser.close()
await app.close(0)
siteServer.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed — screenshots: ${SHOTS}`)
process.exit(failed.length ? 1 : 0)
