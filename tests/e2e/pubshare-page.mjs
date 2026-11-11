// Dexterity Share client page, driven in a real browser (system Edge through playwright-core)
// against the real share server on a scratch store. Takes desktop and phone screenshots of every
// state into <work>\page\shots. Nothing leaves this PC.
//   node --no-warnings tests/e2e/pubshare-page.mjs
import { TEST_WORK } from '../unit/pubshare-hooks.mjs'
import http from 'node:http'
import fs, { promises as fsp } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright-core'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORK = path.join(TEST_WORK, 'page')
process.env.TEMP = process.env.TMP = TEST_WORK
const STORE = path.join(WORK, 'store')
const SHOTS = path.join(WORK, 'shots')
const SITE = path.join(root, 'site')

const S = await import('../../server/dexterity-share/server.mjs')
const P = await import('../../src/shared/pubshare.ts')
const V = await import('../../server/dexterity-share/supervisor.mjs')

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
const newId = () => P.encodeShareId(crypto.randomBytes(16))

await fsp.rm(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
await fsp.mkdir(STORE, { recursive: true })
await fsp.mkdir(SHOTS, { recursive: true })

// ---- static server for site/ with a switchable config.json ----------------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' }
const site = { config: {}, extra: new Map() }
const siteServer = http.createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0])
  if (p === '/share/config.json') return site.config === null ? res.writeHead(404).end('not found') : res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(site.config))
  if (site.extra.has(p)) return res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }).end(JSON.stringify(site.extra.get(p)))
  const file = path.join(SITE, p.endsWith('/') ? p + 'index.html' : p)
  if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end('not found')
  let body = await fsp.readFile(file)
  // The shipped policy allows https only; the test servers are plain http on loopback, so that one source is added here.
  if (file.endsWith('index.html')) body = Buffer.from(body.toString('utf8').replace('connect-src https:', 'connect-src https: http://127.0.0.1:*'))
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body)
})
await new Promise((r) => siteServer.listen(0, '127.0.0.1', r))
const SITE_ORIGIN = `http://127.0.0.1:${siteServer.address().port}`
const PAGE = `${SITE_ORIGIN}/share/`

// ---- share server -----------------------------------------------------------------------------------
const shareCfg = (port) => ({ port, store: STORE, allowedOrigins: [SITE_ORIGIN], stateDir: path.join(WORK, 'state'), logDir: path.join(WORK, 'logs'), manifestCacheMs: 100, revokeCheckMs: 300, statsFlushMs: 300, apiPerMinutePerIp: 100000, filePerMinutePerIp: 100000, clientIpHeader: 'x-test-ip', shutdownGraceSeconds: 0 })
let app = S.createShareServer(shareCfg(0))
const PORT = await app.listen()
const BASE = `http://127.0.0.1:${PORT}`
site.config = { base: BASE, pointers: [], pointerKey: null, allowedHosts: ['*.trycloudflare.com'], company: 'Dexterity Design Services Private Limited' }

async function makeShare({ files, title, message = '', sender = 'Priya Sharma', days = 5, expiresAt, password, sparse }) {
  const id = newId()
  const dir = path.join(STORE, id)
  await fsp.mkdir(path.join(dir, 'data'), { recursive: true })
  const list = []
  for (let n = 0; n < files.length; n++) {
    const [name, content] = files[n]
    const file = path.join(dir, 'data', String(n))
    if (typeof content === 'number' && sparse) {
      const fh = await fsp.open(file, 'w')
      await fh.truncate(content)
      await fh.close()
      list.push({ name, size: content, sha256: 'd'.repeat(64) })
    } else {
      const buf = typeof content === 'number' ? crypto.randomBytes(content) : Buffer.from(content)
      await fsp.writeFile(file, buf)
      list.push({ name, size: buf.length, sha256: sha(buf) })
    }
  }
  const manifest = { v: 1, id, title, message, sender, createdAt: Date.now(), expiresAt: expiresAt ?? Date.now() + days * P.DAY_MS, files: list, password: password ? await S.hashPassword(password, { N: 1024 }) : null, maxDownloads: 0, owner: { user: 'asha', host: 'PC' } }
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  return { id, manifest, dir }
}

// ---- browser ----------------------------------------------------------------------------------------
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const consoleProblems = []
async function open(hash, { mobile = false, dark = false, init } = {}) {
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, deviceScaleFactor: mobile ? 2 : 1, colorScheme: dark ? 'dark' : 'light', acceptDownloads: true, isMobile: mobile, hasTouch: mobile })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_|ERR_CONNECTION/.test(m.text())) consoleProblems.push(m.text()) })
  page.on('pageerror', (e) => consoleProblems.push('pageerror: ' + e.message))
  page.on('dialog', (d) => { consoleProblems.push('dialog: ' + d.message()); void d.dismiss() })
  if (init) await page.addInitScript(init)
  await page.goto(PAGE + (hash ? '#' + hash : ''))
  return { page, ctx }
}
const settled = (page) => page.waitForSelector('#card[aria-busy="false"]', { timeout: 30000 })
async function shot(page, name) {
  await page.evaluate(() => document.fonts?.ready)
  await sleep(350) // let the entrance animation finish
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true })
}
/** No sideways scrolling, at this width or squeezed to 360 px. */
async function noOverflow(page, label) {
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])
  ok(w[0] <= w[1], `${label}: page scrolls sideways (${w[0]} > ${w[1]})`)
}
async function everywhere(name, hash, { wait = settled, darkToo = false, after } = {}) {
  for (const mode of darkToo ? ['desktop', 'mobile', 'desktop-dark', 'mobile-dark'] : ['desktop', 'mobile']) {
    const { page, ctx } = await open(hash, { mobile: mode.startsWith('mobile'), dark: mode.endsWith('dark') })
    await wait(page)
    if (after) await after(page)
    await noOverflow(page, `${name} ${mode}`)
    if (mode === 'mobile') {
      await page.setViewportSize({ width: 360, height: 740 })
      await noOverflow(page, `${name} at 360 px`)
      await shot(page, `${name}-360`)
      await page.setViewportSize({ width: 390, height: 844 })
    }
    await shot(page, `${name}-${mode}`)
    await ctx.close()
  }
}

console.log(`Dexterity Share page test — screenshots in ${SHOTS}`)

const single = await makeShare({ title: 'P10001 Lot 07 — as-built isometrics, Rev B', message: 'Dear Mr Rao,\n\nPlease find the Lot 07 isometrics (rev B) with the comment register.\nKindly confirm receipt.', files: [['P10001_Lot-07_Isometrics_RevB.zip', 734 * 1048576 + 1234]], sparse: true })
const multi = await makeShare({ title: 'Stress report and marked-up drawings', message: 'Updated after Thursday’s review call.', days: 14, files: [['Stress report C-204 rev 2.pdf', 2_400_000], ['P&ID markups (client comments).pdf', 5_100_000], ['Pipe rack 3 — general arrangement.dwg', 1_800_000], ['Line list and comment register.xlsx', 240_000], ['Site photos.zip', 9_300_000]] })
const locked = await makeShare({ title: 'Tender package — confidential', files: [['Tender documents.zip', 3_000_000]], password: 'k7Hd-Qm3x-9TpW', days: 3 })
const small = await makeShare({ title: 'Small real file', files: [['Transmittal TR-0041.pdf', 1_500_000]], days: 30 })
const soon = await makeShare({ title: 'Expires this evening', files: [['notes.txt', 'hello']], expiresAt: Date.now() + 7 * 3600e3 })
const minutes = await makeShare({ title: 'Expires in minutes', files: [['notes.txt', 'hello']], expiresAt: Date.now() + 25 * 60e3 })
const expired = await makeShare({ title: 'Old', files: [['old.txt', 'x']], expiresAt: Date.now() - 3600e3 })
const hostile = await makeShare({ title: '<img src=x onerror=alert(1)><script>alert(2)</script>', message: '<b onmouseover=alert(3)>bold?</b>\n"><svg onload=alert(4)>', sender: '<i>Mallory</i>', files: [['<img src=x onerror=alert(5)>.pdf', 'x'], ['"><script>alert(6)</script>.zip', 'y']] })
const longNames = await makeShare({ title: 'A_very_long_title_without_any_spaces_to_break_on_P10001_REFINERY_REVAMP_PIPING_ASBUILT_ISOMETRICS_LOT_07_REVISION_B_FINAL_ISSUED_FOR_CONSTRUCTION', sender: 'Venkatasubramanian Balasubramaniam-Krishnamurthy', files: [['P10001-REFINERY-REVAMP-PIPING-ASBUILT-ISOMETRICS-LOT-07-REVISION-B-FINAL-ISSUED-FOR-CONSTRUCTION-WITH-COMMENT-REGISTER.zip', 1000], ['図面 – Übersicht ✓ नक्शा.pdf', 2000]] })

await check('loading skeleton', async () => {
  for (const mobile of [false, true]) {
    const { page, ctx } = await open('', { mobile })
    await page.route('**/api/s/**', async (route) => { await sleep(1500); await route.continue() })
    await page.goto(PAGE + '#' + single.id)
    await page.waitForSelector('.loading .sk')
    eq(await page.getAttribute('#card', 'aria-busy'), 'true')
    await shot(page, `01-loading-${mobile ? 'mobile' : 'desktop'}`)
    await settled(page)
    await ctx.close()
  }
})

await check('single file: title, sender, message, size, expiry, download button', async () => {
  await everywhere('02-single', single.id, { darkToo: true })
  const { page, ctx } = await open(single.id)
  await settled(page)
  eq(await page.textContent('h1'), 'P10001 Lot 07 — as-built isometrics, Rev B')
  ok((await page.textContent('.from')).includes('Priya Sharma sent you a file'))
  eq(await page.textContent('.avatar'), 'PS')
  ok((await page.textContent('.message')).includes('Kindly confirm receipt.'))
  ok(/Expires in 5 days · \w{3} \d{1,2} \w{3} 20\d\d$/.test((await page.textContent('.pills .pill:nth-child(2)')).trim()), await page.textContent('.pills'))
  ok((await page.textContent('.btn.primary.lg')).includes('Download · 734 MB'))
  ok((await page.textContent('.file .meta')).includes('ZIP archive · 734 MB'))
  ok(await page.isVisible('text=This is a large download'), 'large-file hint')
  eq(await page.locator('h1').count(), 1, 'one h1')
  eq(await page.evaluate(() => document.activeElement?.tagName), 'H1', 'focus moved to the heading')
  eq(await page.title(), 'Dexterity Share — files from Dexterity Design Services')
  ok((await page.getAttribute('meta[name=robots]', 'content')).includes('noindex'))
  // the link id is only ever in the fragment and in calls to the share server
  await ctx.close()
})

await check('several files: list, types, per-file buttons, download all', async () => {
  await everywhere('03-multi', multi.id, { darkToo: true })
  const { page, ctx } = await open(multi.id)
  await settled(page)
  eq(await page.locator('.file').count(), 5)
  ok((await page.textContent('.from')).includes('sent you 5 files'))
  eq((await page.locator('.badge').allTextContents()).join(), 'PDF,PDF,DWG,XLS,ZIP')
  ok((await page.textContent('.btn.primary.lg')).includes('Download all · 18 MB'))
  ok((await page.textContent('.pills')).includes('Expires in 14 days'))
  eq(await page.locator('.file .btn[aria-label^="Download "]').count(), 5, 'each file has its own labelled button')
  await ctx.close()
})

await check('browser download: precheck, real file arrives, SHA-256 matches, "started" note', async () => {
  const { page, ctx } = await open(small.id)
  await settled(page)
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('.btn.primary.lg')])
  eq(download.suggestedFilename(), 'Transmittal TR-0041.pdf')
  const to = path.join(WORK, 'dl-single.bin')
  await download.saveAs(to)
  eq(sha(await fsp.readFile(to)), small.manifest.files[0].sha256, 'downloaded bytes')
  await page.waitForSelector('.note.good')
  ok((await page.textContent('.note.good')).includes('Your download has started'))
  ok(page.url().endsWith('#' + small.id), 'the page stayed where it was')
  await shot(page, '04-download-started-desktop')
  // unicode file name through a real browser
  const u = await open(longNames.id)
  await settled(u.page)
  const [d2] = await Promise.all([u.page.waitForEvent('download'), u.page.click('.file:nth-child(2) .btn[aria-label^="Download"]')])
  eq(d2.suggestedFilename(), '図面 – Übersicht ✓ नक्शा.pdf')
  await u.ctx.close()
  await ctx.close()
})

await check('checksum panel: full hash shown, copy button, how-to', async () => {
  const { page, ctx } = await open(small.id)
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: SITE_ORIGIN })
  await settled(page)
  await page.click('text=Checksum')
  eq(await page.textContent('.hash code'), small.manifest.files[0].sha256)
  eq(await page.getAttribute('.file .btn[aria-expanded]', 'aria-expanded'), 'true')
  await page.click('text=Copy checksum')
  await page.waitForSelector('.toast.on')
  eq(await page.evaluate(() => navigator.clipboard.readText()), small.manifest.files[0].sha256, 'clipboard')
  await shot(page, '05-checksum-desktop')
  await ctx.close()
  const m = await open(small.id, { mobile: true })
  await settled(m.page)
  await m.page.click('text=Checksum')
  await noOverflow(m.page, 'checksum mobile')
  await shot(m.page, '05-checksum-mobile')
  await m.ctx.close()
})

await check('download all without folder access (Firefox/Safari path): every file handed to the browser', async () => {
  const { page, ctx } = await open(multi.id, { init: () => { delete window.showDirectoryPicker; delete window.showSaveFilePicker; Object.defineProperty(window, 'showDirectoryPicker', { value: undefined }); Object.defineProperty(window, 'showSaveFilePicker', { value: undefined }) } })
  await settled(page)
  const got = []
  page.on('download', (d) => got.push(d))
  await page.click('.btn.primary.lg')
  await page.waitForSelector('text=All downloads have been handed to your browser', { timeout: 30000 })
  eq(got.length, 5)
  for (let i = 0; i < 5; i++) {
    const to = path.join(WORK, `dl-multi-${i}.bin`)
    await got[i].saveAs(to)
    const f = multi.manifest.files.find((x) => x.name === got[i].suggestedFilename())
    ok(f, `unexpected file ${got[i].suggestedFilename()}`)
    eq(sha(await fsp.readFile(to)), f.sha256, f.name)
  }
  await shot(page, '06-download-all-done-desktop')
  await ctx.close()
})

// OPFS gives real FileSystemFileHandles without a picker dialog, so the page's own streaming code runs unchanged.
const fakePickers = () => {
  window.showSaveFilePicker = async (o) => (await navigator.storage.getDirectory()).getFileHandle(o.suggestedName, { create: true })
  window.showDirectoryPicker = async () => navigator.storage.getDirectory()
  window.__sha = async (name) => {
    const f = await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile()
    const d = await crypto.subtle.digest('SHA-256', await f.arrayBuffer())
    return { size: f.size, sha: Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('') }
  }
}

await check('verified download: streamed to disk with progress, survives the server going away mid-file, checksum verified', async () => {
  const bigReal = await makeShare({ title: 'Resume test', files: [['Model export.rvm', 24 * 1048576]] })
  for (const mobile of [false, true]) {
    const { page, ctx } = await open(bigReal.id, { mobile, init: fakePickers })
    await settled(page)
    // a slow line, so there is time to look at the progress and to pull the plug
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 3 * 1048576, uploadThroughput: 1048576 })
    await page.click('text=Checksum')
    await page.click('text=Download and verify automatically')
    await page.waitForFunction(() => /\d+%/.test(document.querySelector('.prog .line')?.textContent ?? '') && parseFloat(document.querySelector('.bar i').style.width) > 12, null, { timeout: 30000 })
    ok(/of 24 MB · \d+%/.test(await page.textContent('.prog .line')), await page.textContent('.prog .line'))
    ok(/MB\/s|KB\/s/.test(await page.textContent('.prog .line')), 'speed shown')
    await shot(page, `07-verified-progress-${mobile ? 'mobile' : 'desktop'}`)
    if (!mobile) {
      // the office server drops off the internet for a few seconds
      await app.close(0)
      await page.waitForSelector('text=/Connection interrupted — resuming in \\d+ s/', { timeout: 20000 })
      await shot(page, '07-verified-interrupted-desktop')
      app = S.createShareServer(shareCfg(PORT))
      await app.listen()
    }
    await page.waitForSelector('.prog.done', { timeout: 90000 })
    ok((await page.textContent('.prog.done')).includes('Saved and verified'))
    const saved = await page.evaluate(() => window.__sha('Model export.rvm'))
    eq(saved.size, 24 * 1048576, 'size on disk')
    eq(saved.sha, bigReal.manifest.files[0].sha256, 'bytes on disk')
    await noOverflow(page, 'verified')
    await shot(page, `07-verified-done-${mobile ? 'mobile' : 'desktop'}`)
    await ctx.close()
  }
})

await check('verified download: a corrupted transfer is caught; cancel removes the progress; download-all into a folder verifies every file', async () => {
  const lie = await makeShare({ title: 'Corrupt', files: [['data.bin', 300_000]] })
  const m = JSON.parse(await fsp.readFile(path.join(lie.dir, 'manifest.json'), 'utf8'))
  m.files[0].sha256 = 'e'.repeat(64) // the server will send bytes that do not match the published fingerprint
  await fsp.writeFile(path.join(lie.dir, 'manifest.json'), JSON.stringify(m))
  const a = await open(lie.id, { init: fakePickers })
  await settled(a.page)
  await a.page.click('text=Checksum')
  await a.page.click('text=Download and verify automatically')
  await a.page.waitForSelector('.prog.bad')
  ok((await a.page.textContent('.prog.bad')).includes('did not arrive intact'))
  await shot(a.page, '08-verified-corrupt-desktop')
  await a.ctx.close()

  const slowShare = await makeShare({ title: 'Cancel', files: [['big.bin', 16 * 1048576]] })
  const c = await open(slowShare.id, { init: fakePickers })
  await settled(c.page)
  const cdp = await c.ctx.newCDPSession(c.page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 1048576, uploadThroughput: 1048576 })
  await c.page.click('text=Checksum')
  await c.page.click('text=Download and verify automatically')
  await c.page.waitForSelector('.prog .link')
  await c.page.click('.prog .link')
  await c.page.waitForSelector('.prog', { state: 'detached' })
  await c.ctx.close()

  const d = await open(multi.id, { init: fakePickers })
  await settled(d.page)
  ok((await d.page.textContent('.cta .sub')).includes('You choose a folder'))
  await d.page.click('.btn.primary.lg')
  await d.page.waitForSelector('text=All 5 files were saved and verified.', { timeout: 60000 })
  eq(await d.page.locator('.prog.done').count(), 5)
  for (const f of multi.manifest.files) eq((await d.page.evaluate((n) => window.__sha(n), f.name.replace(/[<>:"/\\|?*]/g, '_'))).sha, f.sha256, f.name)
  await shot(d.page, '08-folder-all-verified-desktop')
  await d.ctx.close()
})

await check('password: form, wrong password, attempts left, lockout message, unlock, remembered for the tab', async () => {
  await everywhere('09-locked', locked.id, { darkToo: true })
  const { page, ctx } = await open(locked.id)
  await page.setExtraHTTPHeaders({}) // (default client address)
  await settled(page)
  ok((await page.textContent('.pills')).includes('Password protected'))
  ok(!(await page.content()).includes('Tender documents.zip'), 'file names hidden until unlocked')
  eq(await page.evaluate(() => document.activeElement?.id), 'pw', 'password field focused')
  await page.click('button[type=submit]')
  ok((await page.textContent('#pw-err')).includes('Enter the password'))
  const attempt = async (pw) => {
    await page.fill('#pw', pw)
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => !document.querySelector('.lock button[type=submit]').disabled)
    return page.textContent('#pw-err')
  }
  ok((await attempt('wrong-password')).includes("isn't right"))
  eq(await page.getAttribute('#pw', 'aria-invalid'), 'true')
  await shot(page, '10-wrong-password-desktop')
  for (let i = 0; i < 5; i++) await attempt('wrong-' + i)
  ok(/2 attempts left/.test(await page.textContent('#pw-err')), await page.textContent('#pw-err'))
  ok(/1 attempt left/.test(await attempt('wrong-6')))
  ok(/No attempts left/.test(await attempt('wrong-7')))
  ok(/Too many wrong attempts/.test(await attempt('k7Hd-Qm3x-9TpW')), 'even the right password waits out the lockout')
  ok(/wait 10 minutes/.test(await page.textContent('#pw-err')), await page.textContent('#pw-err'))
  await shot(page, '10-locked-out-desktop')
  const mob = await open(locked.id, { mobile: true })
  await settled(mob.page)
  await mob.page.fill('#pw', 'x')
  await mob.page.keyboard.press('Enter')
  await mob.page.waitForFunction(() => document.querySelector('#pw-err').textContent.length > 5)
  await shot(mob.page, '10-locked-out-mobile')
  await mob.ctx.close()
  await ctx.close()

  // a different client address is not locked out: unlock for real
  const fresh = await makeShare({ title: 'Tender package — confidential', files: [['Tender documents.zip', 3_000_000]], password: 'k7Hd-Qm3x-9TpW', days: 3 })
  const u = await open(fresh.id)
  await settled(u.page)
  await u.page.check('.show input')
  eq(await u.page.getAttribute('#pw', 'type'), 'text', 'show password')
  await u.page.fill('#pw', 'k7Hd-Qm3x-9TpW')
  await u.page.click('button[type=submit]')
  await u.page.waitForSelector('.file')
  eq(await u.page.textContent('.file .name'), 'Tender documents.zip')
  await shot(u.page, '11-unlocked-desktop')
  const [download] = await Promise.all([u.page.waitForEvent('download'), u.page.click('.btn.primary.lg')])
  const to = path.join(WORK, 'dl-locked.bin')
  await download.saveAs(to)
  eq(sha(await fsp.readFile(to)), fresh.manifest.files[0].sha256, 'protected file downloads with the token')
  ok(!u.page.url().includes('k7Hd'), 'password never in the address')
  await u.page.reload()
  await settled(u.page)
  await u.page.waitForSelector('.file')
  ok(!(await u.page.isVisible('#pw')), 'still unlocked after a reload (token kept for this tab only)')
  eq(await u.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('dxs')).length), 0, 'nothing kept beyond the tab')
  // the server forgets the token (password changed / key rotated): the page asks again instead of failing
  await u.page.evaluate((id) => sessionStorage.setItem('dxs-t-' + id, 'zz.' + 'A'.repeat(43)), fresh.id)
  await u.page.reload()
  await settled(u.page)
  await u.page.waitForSelector('#pw')
  await u.ctx.close()
})

await check('expiry wording: days, hours, minutes; expired; not found; no link', async () => {
  const a = await open(soon.id)
  await settled(a.page)
  ok(/Expires in 7 hours · .*, \d\d:\d\d/.test(await a.page.textContent('.pill.soon')), await a.page.textContent('.pills'))
  await shot(a.page, '12-expires-soon-desktop')
  await a.ctx.close()
  const b = await open(minutes.id, { mobile: true })
  await settled(b.page)
  ok(/Expires in \d\d? minutes · /.test(await b.page.textContent('.pill.soon')), await b.page.textContent('.pills'))
  await shot(b.page, '12-expires-minutes-mobile')
  await b.ctx.close()
  await everywhere('13-expired', expired.id, { darkToo: true })
  await everywhere('14-not-found', newId())
  await everywhere('15-no-link', '')
  const e = await open(expired.id)
  await settled(e.page)
  eq(await e.page.textContent('h1'), 'This link has expired')
  await e.page.goto(PAGE + '#not-a-valid-id')
  await e.page.reload()
  await settled(e.page)
  eq(await e.page.textContent('h1'), 'This page needs your download link')
  // changing the fragment loads the other link without a reload
  await e.page.evaluate((id) => { location.hash = id }, small.id)
  await e.page.waitForSelector('.file')
  eq(await e.page.textContent('h1'), 'Small real file')
  await e.ctx.close()
})

await check('a link that expires while the page is open flips to "expired" by itself; a wrong PC clock does not mislead', async () => {
  const s = await makeShare({ title: 'About to expire', files: [['a.txt', 'x']], expiresAt: Date.now() + 40_000 })
  const { page, ctx } = await open('')
  await page.clock.install()
  await page.goto(PAGE + '#' + s.id)
  await settled(page)
  ok(/Expires in 1 minute/.test(await page.textContent('.pill.soon')), await page.textContent('.pills'))
  await page.clock.fastForward(61_000)
  await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'This link has expired')
  await ctx.close()
  // PC clock three days ahead: the countdown still follows the server's clock
  const w = await open('')
  await w.page.clock.install({ time: Date.now() + 3 * 86400e3 })
  await w.page.goto(PAGE + '#' + single.id)
  await settled(w.page)
  ok(/Expires in 5 days/.test(await w.page.textContent('.pills')), await w.page.textContent('.pills'))
  await w.ctx.close()
})

await check('hostile text from a manifest is shown as text: no markup, no script, no dialog', async () => {
  const { page, ctx } = await open(hostile.id)
  await settled(page)
  eq(await page.textContent('h1'), '<img src=x onerror=alert(1)><script>alert(2)</script>')
  eq(await page.locator('#card img, #card script, #card [onerror], #card [onload], #card [onmouseover], #card .from i, #card .message *, #card h1 *, #card .name *').count(), 0, 'no injected elements')
  ok((await page.textContent('.message')).includes('<b onmouseover=alert(3)>bold?</b>'))
  ok((await page.textContent('.from')).includes('<i>Mallory</i>'))
  eq(await page.textContent('.file .name'), '<img src=x onerror=alert(5)>.pdf')
  await shot(page, '16-hostile-text-desktop')
  await ctx.close()
  await everywhere('17-long-names', longNames.id)
})

await check('server unreachable: friendly state, countdown, automatic recovery when it returns', async () => {
  await app.close(0)
  await everywhere('18-unreachable', single.id, { darkToo: true })
  const { page, ctx } = await open(single.id)
  await settled(page)
  eq(await page.textContent('h1'), "We can't reach our file server right now")
  ok(/Trying again automatically in \d+ s/.test(await page.textContent('.state')))
  const first = Number(await page.textContent('.countdown'))
  await sleep(2100)
  ok(Number(await page.textContent('.countdown')) < first, 'countdown runs')
  app = S.createShareServer(shareCfg(PORT))
  await app.listen()
  await page.waitForSelector('.file', { timeout: 20000 }) // no click needed
  eq(await page.textContent('h1'), 'P10001 Lot 07 — as-built isometrics, Rev B')
  // offline browser
  const off = await open(single.id)
  await settled(off.page)
  await off.ctx.setOffline(true)
  await off.page.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')))
  await off.page.waitForFunction(() => document.querySelector('h1')?.textContent === 'You appear to be offline')
  await shot(off.page, '18-offline-desktop')
  await off.ctx.setOffline(false)
  await off.page.waitForSelector('.file', { timeout: 20000 })
  await off.ctx.close()
  await ctx.close()
})

await check('download problems are explained on the page: busy server, file withdrawn after the page was opened', async () => {
  const s = await makeShare({ title: 'Withdrawn later', files: [['a.pdf', 1000], ['b.pdf', 1000]] })
  const { page, ctx } = await open(s.id)
  await settled(page)
  await page.route('**/d/**', (route) => (route.request().method() === 'HEAD' ? route.fulfill({ status: 429, headers: { 'Retry-After': '30', 'Access-Control-Allow-Origin': SITE_ORIGIN, 'Access-Control-Expose-Headers': 'Retry-After' }, body: '' }) : route.continue()))
  await page.click('.file:nth-child(1) .btn[aria-label^="Download"]')
  await page.waitForSelector('.note.warn')
  ok((await page.textContent('.note.warn')).includes('many downloads right now'), await page.textContent('.note.warn'))
  await shot(page, '19-busy-note-desktop')
  await page.unroute('**/d/**')
  await fsp.rename(path.join(s.dir, 'manifest.json'), path.join(s.dir, 'revoked.json'))
  await sleep(250)
  await page.click('.file:nth-child(2) .btn[aria-label^="Download"]')
  await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'This link is no longer available')
  ok(page.url().includes('/share/#'), 'never navigated to a bare error page')
  await ctx.close()
})

await check('quick-tunnel pointer: stale address skipped, signed pointer accepted, forged pointer refused, wrong host refused', async () => {
  const { privateKey, publicJwk } = V.loadPointerKey(path.join(WORK, 'pointer-state'))
  const dead = 'http://127.0.0.1:9' // nothing listens here: yesterday's tunnel address
  const good = V.buildPointer(BASE, privateKey)
  site.extra.set('/p/stale.json', V.buildPointer(dead, privateKey, new Date(Date.now() - 3600e3).toISOString()))
  site.extra.set('/p/fresh.json', good)
  site.extra.set('/p/forged.json', { ...V.buildPointer(BASE, crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey) })
  site.extra.set('/p/moved.json', { ...good, base: 'http://127.0.0.1:9' }) // signature no longer matches
  site.extra.set('/p/evilhost.json', V.buildPointer('https://files.attacker.example', privateKey))
  site.extra.set('/p/github-api.json', { encoding: 'base64', content: Buffer.from(JSON.stringify(good)).toString('base64').replace(/(.{60})/g, '$1\n') })
  const withPointers = (pointers, key = publicJwk) => { site.config = { base: '', pointers: pointers.map((p) => SITE_ORIGIN + p), pointerKey: key, allowedHosts: ['*.trycloudflare.com'] } }
  const title = async () => {
    const { page, ctx } = await open(small.id)
    await settled(page)
    const t = await page.textContent('h1')
    await ctx.close()
    return t
  }
  try {
    withPointers(['/p/stale.json', '/p/fresh.json'])
    eq(await title(), 'Small real file', 'falls through from the stale address to the fresh one')
    withPointers(['/p/github-api.json'])
    eq(await title(), 'Small real file', 'GitHub API envelope')
    withPointers(['/p/forged.json'])
    eq(await title(), "We can't reach our file server right now", 'pointer signed by another key')
    withPointers(['/p/moved.json'])
    eq(await title(), "We can't reach our file server right now", 'pointer altered after signing')
    withPointers(['/p/missing.json'])
    eq(await title(), "We can't reach our file server right now", 'pointer missing')
    withPointers([])
    eq(await title(), 'This service is not set up yet', 'no base and no pointer')
    // host allow-list (a non-loopback https address): judged without contacting it
    const { page, ctx } = await open(small.id)
    await settled(page)
    const requests = []
    page.on('request', (r) => requests.push(r.url()))
    withPointers(['/p/evilhost.json'])
    await page.reload()
    await settled(page)
    eq(await page.textContent('h1'), "We can't reach our file server right now")
    ok(!requests.some((u) => u.includes('attacker.example')), 'an address outside the allow-list is never contacted')
    await ctx.close()
  } finally {
    site.config = { base: BASE, pointers: [], pointerKey: null, allowedHosts: ['*.trycloudflare.com'] }
  }
})

await check('self-contained links (#id.gist.key): the page needs no office config; gist file and gist API both work; a swapped key, a wrong fingerprint and an unsigned pointer are refused', async () => {
  const { privateKey, publicJwk } = V.loadPointerKey(path.join(WORK, 'gist-state'))
  const kh = V.keyHash(publicJwk)
  const gist = crypto.randomBytes(16).toString('hex')
  const pointer = V.buildPointer(BASE, privateKey, undefined, publicJwk)
  const serveGist = (p, raw = true, api = true) => {
    if (raw) site.extra.set(`/gistraw/${gist}/pointer.json`, p)
    else site.extra.delete(`/gistraw/${gist}/pointer.json`)
    if (api) site.extra.set(`/gistapi/${gist}`, { id: gist, files: { 'pointer.json': { filename: 'pointer.json', content: JSON.stringify(p, null, 2) } } })
    else site.extra.delete(`/gistapi/${gist}`)
  }
  // the only thing config.json does here is point the test at local stand-ins for GitHub's two hosts
  const local = { base: '', pointers: [], pointerKey: null, allowedHosts: ['*.trycloudflare.com'], gistRaw: SITE_ORIGIN + '/gistraw/', gistApi: SITE_ORIGIN + '/gistapi/' }
  const title = async (frag) => {
    const { page, ctx } = await open(frag)
    await settled(page)
    const t = await page.textContent('h1')
    await ctx.close()
    return t
  }
  try {
    site.config = local
    serveGist(pointer)
    eq(await title(`${small.id}.${gist}.${kh}`), 'Small real file', 'gist file')
    serveGist(pointer, false, true)
    eq(await title(`${small.id}.${gist}.${kh}`), 'Small real file', 'gist API only')
    serveGist(V.buildPointer('http://127.0.0.1:9', privateKey, new Date(Date.now() - 600e3).toISOString(), publicJwk), true, false)
    site.extra.set(`/gistapi/${gist}`, { id: gist, files: { 'pointer.json': { content: JSON.stringify(pointer) } } })
    eq(await title(`${small.id}.${gist}.${kh}`), 'Small real file', 'stale gist file, current API')
    // someone who can edit the gist swaps in their own key and address
    const evil = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const { x, y } = evil.publicKey.export({ format: 'jwk' })
    serveGist(V.buildPointer(BASE, evil.privateKey, undefined, { kty: 'EC', crv: 'P-256', x, y }))
    eq(await title(`${small.id}.${gist}.${kh}`), "We can't reach our file server right now", 'pointer signed with a key the link does not name')
    serveGist({ v: 2, base: BASE, updated: new Date().toISOString(), key: publicJwk })
    eq(await title(`${small.id}.${gist}.${kh}`), "We can't reach our file server right now", 'unsigned pointer')
    serveGist({ ...pointer, base: 'http://127.0.0.1:9' })
    eq(await title(`${small.id}.${gist}.${kh}`), "We can't reach our file server right now", 'address changed after signing')
    serveGist(pointer)
    eq(await title(`${small.id}.${gist}.${'0'.repeat(20)}`), "We can't reach our file server right now", 'link with another fingerprint')
    eq(await title(`${small.id}.${gist}`), 'This page needs your download link', 'half a pointer reference is not a link')
    // old-format links keep working beside the new ones
    site.config = { ...local, base: BASE }
    eq(await title(small.id), 'Small real file', 'old link, fixed base')
    // the page stays on the right link while downloading and the password token is per link id
    const { page, ctx } = await open(`${small.id}.${gist}.${kh}`)
    await settled(page)
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('.btn.primary.lg')])
    const to = path.join(WORK, 'dl-selfcontained.bin')
    await download.saveAs(to)
    eq(sha(await fsp.readFile(to)), small.manifest.files[0].sha256)
    await shot(page, '20-self-contained-link-desktop')
    await ctx.close()
    // with no config.json at all on the page host
    site.config = null
    const requests = []
    const n = await open('')
    n.page.on('request', (r) => requests.push(r.url()))
    await n.page.goto(PAGE + '#' + `${small.id}.${gist}.${kh}`)
    await settled(n.page)
    ok(requests.some((u) => u === `https://gist.githubusercontent.com/raw/${gist}/pointer.json`), 'asks GitHub\'s gist file host first: ' + requests.filter((u) => !u.startsWith(SITE_ORIGIN)).join(' '))
    ok(requests.some((u) => u === `https://api.github.com/gists/${gist}`), 'then the gist API')
    ok(!requests.some((u) => u.startsWith(SITE_ORIGIN) && u.includes(gist)), 'the pointer reference is not sent to the page host')
    await n.ctx.close()
  } finally {
    site.config = { base: BASE, pointers: [], pointerKey: null, allowedHosts: ['*.trycloudflare.com'] }
  }
})

await check('a file changed after sharing, and a used-up download limit, are explained on the page', async () => {
  const s = await makeShare({ title: 'Changed later', files: [['Report.pdf', 5000]] })
  const m = JSON.parse(await fsp.readFile(path.join(s.dir, 'manifest.json'), 'utf8'))
  m.files[0].mtime = Date.now() - 86400e3
  await fsp.writeFile(path.join(s.dir, 'manifest.json'), JSON.stringify(m))
  const { page, ctx } = await open(s.id)
  await settled(page)
  await page.click('.btn.primary.lg')
  await page.waitForSelector('.note.warn')
  ok((await page.textContent('.note.warn')).includes('changed on our side after the link was made'), await page.textContent('.note.warn'))
  await shot(page, '21-changed-after-sharing-desktop')
  await ctx.close()
  const once = await makeShare({ title: 'Once only', files: [['Once.pdf', 5000]] })
  const mm = JSON.parse(await fsp.readFile(path.join(once.dir, 'manifest.json'), 'utf8'))
  mm.maxDownloads = 1
  await fsp.writeFile(path.join(once.dir, 'manifest.json'), JSON.stringify(mm))
  const o = await open(once.id)
  await settled(o.page)
  await Promise.all([o.page.waitForEvent('download'), o.page.click('.btn.primary.lg')])
  await sleep(600)
  await o.page.click('.btn.primary.lg')
  await o.page.waitForSelector('.note.warn')
  ok((await o.page.textContent('.note.warn')).includes('number of downloads the sender allowed'), await o.page.textContent('.note.warn'))
  eq(await o.page.textContent('h1'), 'Once only', 'the page stays put')
  await o.ctx.close()
})

await check('keyboard and assistive basics: skip link, labelled controls, live regions, theme switch, reduced motion', async () => {
  const { page, ctx } = await open(multi.id)
  await settled(page)
  const unnamed = await page.evaluate(() => Array.from(document.querySelectorAll('button, a[href], input')).filter((el) => !(el.getAttribute('aria-label') || el.textContent.trim() || el.labels?.length)).length)
  eq(unnamed, 0, 'controls without an accessible name')
  eq(await page.locator('[aria-live], [role=status], [role=alert]').count() > 0, true)
  eq(await page.getAttribute('html', 'lang'), 'en')
  await page.keyboard.press('Tab')
  // focus sits on the heading after loading, so the first Tab lands on the main action
  ok((await page.evaluate(() => document.activeElement.textContent)).includes('Download all'), 'first Tab reaches the main download button')
  eq(await page.evaluate(() => getComputedStyle(document.querySelector('h1')).outlineStyle), 'none', 'no focus ring on the heading')
  await page.evaluate(() => document.querySelector('.skip').focus())
  ok(await page.evaluate(() => document.querySelector('.skip').getBoundingClientRect().top >= 0), 'skip link appears on focus')
  const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  await page.click('#theme')
  ok((await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) !== before, 'theme switches')
  eq(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
  // contrast of body text against the card, both themes (WCAG AA needs 4.5)
  const ratio = () => page.evaluate(() => {
    const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
    const probe = (sel) => { const el = document.querySelector(sel); const fg = lum(getComputedStyle(el).color); const bg = lum(getComputedStyle(document.querySelector('.file')).backgroundColor); return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) }
    return Math.min(probe('.file .name'), probe('.file .meta'), probe('.fine'))
  })
  const dark = await ratio()
  await page.click('#theme')
  const light = await ratio()
  ok(dark >= 4.5 && light >= 4.5, `contrast light ${light.toFixed(2)}, dark ${dark.toFixed(2)}`)
  await ctx.close()
  return `min text contrast: light ${light.toFixed(1)}:1, dark ${dark.toFixed(1)}:1`
})

await check('page hygiene: strict CSP holds (no violations), no third-party requests, id never sent to the page host', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()
  const requests = []
  page.on('request', (r) => requests.push(r.url()))
  await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)) })
  await page.goto(PAGE + '#' + multi.id)
  await settled(page)
  await page.click('text=Checksum')
  eq((await page.evaluate(() => window.__csp)).join(), '', 'CSP violations')
  const csp = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content')
  ok(csp.includes("default-src 'none'") && csp.includes("script-src 'self'") && csp.includes("style-src 'self'") && !csp.includes('unsafe'), csp)
  eq(await page.locator('script:not([src]), style, [style]:not(.bar i)').count(), 0, 'no inline script or style in the page')
  const hosts = [...new Set(requests.map((u) => new URL(u).origin))].sort()
  eq(hosts.join(), [SITE_ORIGIN, BASE].sort().join(), 'only the page host and the share server are contacted')
  ok(!requests.some((u) => u.startsWith(SITE_ORIGIN) && u.includes(multi.id)), 'link id never sent to the page host')
  // an inline script injected into the page would be blocked by the policy
  await page.evaluate(() => { const s = document.createElement('script'); s.textContent = 'window.__pwned = 1'; document.head.appendChild(s) })
  eq(await page.evaluate(() => window.__pwned), undefined, 'inline script blocked')
  await ctx.close()
  const shipped = fs.readFileSync(path.join(SITE, 'share', 'index.html'), 'utf8')
  ok(shipped.includes('connect-src https:;') && !/http:\/\//.test(shipped.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')), 'the shipped page allows https connections only')
  ok(!/<script(?![^>]*\ssrc=)/.test(shipped) && !/\son\w+=/.test(shipped) && !/style=/.test(shipped), 'no inline code in the shipped page')
})

await check('no unexpected console errors or dialogs in any scenario', async () => {
  eq(consoleProblems.join(' | '), '')
})

await browser.close()
await app.close(0)
siteServer.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed — screenshots: ${SHOTS}`)
process.exit(failed.length ? 1 : 0)
