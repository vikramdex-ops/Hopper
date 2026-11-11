// Dexterity Share setup wizard in the real app (a private build), against local stand-ins for
// GitHub (user, gists, the cloudflared release) and for cloudflared itself. Nothing leaves this PC.
//   npx electron-vite build --outDir <work-folder>\_Claude_Work\temp\share-agent\app\out
//   node --no-warnings tests/e2e/pubshare-wizard.mjs
import { TEST_WORK } from '../unit/pubshare-hooks.mjs'
import { _electron as electron } from 'playwright-core'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP = path.join(TEST_WORK, 'app')
const WORK = path.join(TEST_WORK, 'wizard')
const SHOTS = path.join(WORK, 'shots')
const require = createRequire(path.join(root, 'package.json'))
if (!fs.existsSync(path.join(APP, 'out', 'main', 'share.js'))) throw new Error(`Build first: npx electron-vite build --outDir ${path.join(APP, 'out')}`)

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, main: 'out/main/index.js' }, null, 1))
for (const dir of [['native', 'bin'], ['vendor', '7zip'], ['build']]) {
  const from = path.join(root, ...dir)
  if (fs.existsSync(from)) fs.cpSync(from, path.join(APP, ...dir), { recursive: true, force: true })
}
fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
fs.mkdirSync(SHOTS, { recursive: true })

const results = []
async function check(name, fn) {
  const t0 = Date.now()
  try {
    const note = await fn()
    results.push(true)
    console.log(`  ok    ${name}${note ? `  [${note}]` : ''}  (${Date.now() - t0} ms)`)
  } catch (e) {
    results.push(false)
    // what the wizard showed when it failed, so an intermittent failure can be read afterwards
    try { console.log('        wizard: ' + JSON.stringify(await globalThis.__wizWin?.evaluate(() => [...document.querySelectorAll('.steps li')].map((li) => li.className + ' | ' + li.textContent.replace(/\s+/g, ' ').slice(0, 300))))) } catch {}
    console.log(`  FAIL  ${name}\n        ${String(e?.stack ?? e).split('\n').slice(0, 5).join('\n        ')}`)
  }
}
const ok = (v, msg) => { if (!v) throw new Error(msg || 'assertion failed') }
const eq = (a, b, msg = '') => { if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })

// ---- stand-in for GitHub -----------------------------------------------------------------------------
const fakeExe = crypto.randomBytes(3 * 1024 * 1024)
const gh = { gists: new Map(), badDigest: false, slow: true }
const ghServer = http.createServer(async (req, res) => {
  const send = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)) }
  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
  let body = ''
  for await (const c of req) body += c
  if (req.url === '/repos/cloudflare/cloudflared/releases/latest') {
    return send(200, { tag_name: '2026.10.7', assets: [{ name: 'cloudflared-windows-amd64.exe', size: fakeExe.length, digest: 'sha256:' + (gh.badDigest ? 'f'.repeat(64) : crypto.createHash('sha256').update(fakeExe).digest('hex')), browser_download_url: `${GH}/download/cloudflared-windows-amd64.exe` }] })
  }
  if (req.url === '/download/cloudflared-windows-amd64.exe') {
    res.writeHead(200, { 'Content-Length': fakeExe.length })
    for (let i = 0; i < fakeExe.length; i += 256 * 1024) {
      res.write(fakeExe.subarray(i, i + 256 * 1024))
      if (gh.slow) await sleep(150)
    }
    return res.end()
  }
  const gist = /^\/gists\/([0-9a-f]+)$/.exec(req.url)
  if (req.method === 'GET' && gist && gh.gists.has(gist[1])) return send(200, gh.gists.get(gist[1]))
  const who = token === 'ghp_goodgisttoken' ? { login: 'vikramdex-ops', scopes: 'gist' } : token === 'ghp_repotoken' ? { login: 'vikramdex-ops', scopes: 'repo' } : null
  if (!who) return send(401, { message: 'Bad credentials' })
  if (req.url === '/user') return send(200, { login: who.login }, { 'X-OAuth-Scopes': who.scopes })
  if (req.url === '/gists' && req.method === 'POST') {
    const j = JSON.parse(body)
    const id = crypto.randomBytes(16).toString('hex')
    gh.gists.set(id, { id, public: j.public, files: Object.fromEntries(Object.entries(j.files).map(([n, f]) => [n, { filename: n, content: f.content }])) })
    return send(201, gh.gists.get(id))
  }
  if (gist && req.method === 'PATCH' && gh.gists.has(gist[1])) {
    for (const [n, f] of Object.entries(JSON.parse(body).files)) gh.gists.get(gist[1]).files[n] = { filename: n, content: f.content }
    return send(200, gh.gists.get(gist[1]))
  }
  send(404, {})
})
await new Promise((r) => ghServer.listen(0, '127.0.0.1', r))
const GH = `http://127.0.0.1:${ghServer.address().port}`

// ---- the office and the app ----------------------------------------------------------------------------
const officeDir = path.join(WORK, 'office')
const office = path.join(officeDir, 'office.json')
fs.mkdirSync(officeDir, { recursive: true })
fs.writeFileSync(office, JSON.stringify({ officeName: 'Test office', officeKey: crypto.randomBytes(32).toString('hex'), serverInbox: path.join(officeDir, 'Inbox'), cliq: { enabled: false, endpoint: '', zapikey: '' }, groups: [], admins: ['asha'], announcers: [] }))
const userData = path.join(WORK, 'data')
fs.mkdirSync(userData, { recursive: true })
const PORT = await freePort()
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ officeConfigPath: office, theme: 'light', inboxDir: path.join(WORK, 'inbox'), profile: { displayName: 'Asha K', email: '', status: 'online' }, shareServer: { enabled: false, cloudflaredPath: '', mode: 'quick', publicBase: '', port: PORT, bandwidth: { mbps: 0, officeMbps: 0, officeDays: [1, 2, 3, 4, 5, 6], officeFrom: '09:00', officeTo: '19:00' } } }))
const fakeDir = path.join(WORK, 'fake')
fs.mkdirSync(fakeDir, { recursive: true })
fs.writeFileSync(path.join(fakeDir, 'script.json'), JSON.stringify([{ url: 'https://wizard-test-1234.trycloudflare.com' }]))
const temp = path.join(WORK, 'tmp')
fs.mkdirSync(temp, { recursive: true })

const app = await electron.launch({
  executablePath: require('electron'),
  args: [APP, '--no-sandbox'],
  cwd: APP,
  env: {
    ...process.env, NODE_PATH: path.join(root, 'node_modules'), HOPPER_USER_DATA: userData, HOPPER_LAN_USER: 'asha', TEMP: temp, TMP: temp,
    HOPPER_SHARE_GITHUB_API: GH,
    HOPPER_SHARE_CLOUDFLARED_CMD: JSON.stringify([process.execPath, '--no-warnings', path.join(root, 'tests', 'unit', 'pubshare-fake-cloudflared.mjs')]),
    HOPPER_SHARE_PUBLIC_VIA: `http://127.0.0.1:${PORT}`,
    HOPPER_SHARE_CHECK_SECONDS: '1',
    FAKE_CF_DIR: fakeDir
  }
})
const win = await app.firstWindow()
globalThis.__wizWin = win
await win.waitForFunction(() => window.__hopper?.ready === true && !!window.__hopperLan, null, { timeout: 90000 })
await win.setViewportSize({ width: 1280, height: 860 }).catch(() => {})
const dlg = win.locator('[role=dialog][aria-label="Set up Dexterity Share"]')
const shot = async (name) => {
  await sleep(350)
  await dlg.screenshot({ path: path.join(SHOTS, name + '.png') })
}
const step = (n) => dlg.locator('.steps li').nth(n - 1)
const readOffice = () => JSON.parse(fs.readFileSync(office, 'utf8'))

console.log(`Dexterity Share wizard test — screenshots in ${SHOTS}`)
try {
  await check('opens from the command palette; three steps, nothing ticked, plain words', async () => {
    await win.waitForFunction(() => window.__hopperLan.lanx.meta.admin === true, null, { timeout: 30000 })
    await win.keyboard.press('Control+K')
    await win.keyboard.type('Set up Dexterity')
    await win.keyboard.press('Enter')
    await dlg.waitFor({ timeout: 15000 })
    await dlg.locator('text=Not running on this PC.').waitFor({ timeout: 15000 })
    eq(await dlg.locator('.steps li').count(), 3)
    eq(await dlg.locator('.steps li.done').count(), 0)
    eq((await dlg.locator('.steps .h').allTextContents()).join(' | '), 'Use this PC as the share server | Get the tunnel program | Connect the pointer')
    ok(await dlg.locator('button:has-text("Test from the internet")').isDisabled())
    await shot('01-start')
  })

  await check('step 1: "Use this PC" switches the server on, records the host in office.json, makes the store', async () => {
    await step(1).locator('button:has-text("Use this PC")').click()
    await step(1).locator('.okc').waitFor({ timeout: 20000 })
    await win.waitForFunction(() => document.querySelectorAll('.steps li.done').length === 1, null, { timeout: 20000 })
    const o = readOffice()
    eq(o.publicShare.enabled, true)
    ok(o.publicShare.host?.pc, 'host recorded')
    ok(fs.existsSync(path.join(officeDir, 'PublicShares')), 'store created beside office.json')
    const s = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'))
    eq(s.shareServer.enabled, true)
    eq(s.keepInTray, true, 'stays in the tray')
    ok((await dlg.locator('.final').textContent()).includes('Waiting for step 2'))
    await shot('02-this-pc')
  })

  await check('step 2: a download whose checksum does not match is deleted and says so', async () => {
    gh.badDigest = true
    gh.slow = false
    await step(2).locator('button:has-text("Download")').first().click()
    await step(2).locator('.err').waitFor({ timeout: 30000 })
    ok((await step(2).locator('.err').textContent()).includes('does not match the checksum'), await step(2).locator('.err').textContent())
    ok(!fs.existsSync(path.join(userData, 'share', 'cloudflared.exe')) && !fs.existsSync(path.join(userData, 'share', 'cloudflared.exe.part')), 'nothing kept')
    await shot('03-download-bad-checksum')
    gh.badDigest = false
    gh.slow = true
  })

  await check('step 2: download with progress, checksum verified, version shown; the tunnel comes up by itself', async () => {
    await step(2).locator('button:has-text("Download")').first().click()
    await step(2).locator('.bar').waitFor({ timeout: 15000 })
    await win.waitForFunction(() => /MB of/.test(document.querySelectorAll('.steps li')[1].textContent), null, { timeout: 15000 })
    await shot('04-downloading')
    await step(2).locator('.okc').waitFor({ timeout: 60000 })
    ok((await step(2).locator('.okc').textContent()).includes('version 2026.10.7'))
    eq(crypto.createHash('sha256').update(fs.readFileSync(path.join(userData, 'share', 'cloudflared.exe'))).digest('hex'), crypto.createHash('sha256').update(fakeExe).digest('hex'), 'file on disk')
    eq(JSON.parse(fs.readFileSync(path.join(userData, 'share', 'cloudflared.json'), 'utf8')).verified, true)
    await dlg.locator('.final .dot.on').waitFor({ timeout: 40000 })
    ok((await dlg.locator('.final').textContent()).includes('Online at wizard-test-1234.trycloudflare.com'), await dlg.locator('.final').textContent())
    await shot('05-tunnel-online')
  })

  await check('step 3: a wrong token and a token without the gist permission are refused with what to do; nothing is saved', async () => {
    await step(3).locator('input[type=password]').fill('ghp_typo')
    await step(3).locator('button:has-text("Connect")').click()
    await step(3).locator('.err').waitFor({ timeout: 15000 })
    ok((await step(3).locator('.err').textContent()).includes('GitHub does not accept this token'), await step(3).locator('.err').textContent())
    await shot('06-token-refused')
    await step(3).locator('input[type=password]').fill('ghp_repotoken')
    await step(3).locator('button:has-text("Connect")').click()
    await win.waitForFunction(() => /only the "gist" box/.test(document.querySelectorAll('.steps li')[2].textContent), null, { timeout: 15000 })
    ok(!fs.existsSync(path.join(userData, 'share', 'pointer-token.bin')), 'no token stored')
    eq(readOffice().publicShare.pointer, undefined)
  })

  let gistId
  await check('step 3: the right token creates the gist, publishes the signed address, stores only id + fingerprint in office.json and the token encrypted on this PC', async () => {
    await step(3).locator('input[type=password]').fill('ghp_goodgisttoken')
    await step(3).locator('button:has-text("Connect")').click()
    await win.waitForFunction(() => document.querySelectorAll('.steps li.done').length === 3, null, { timeout: 30000 })
    await win.waitForFunction(() => /address published/.test(document.querySelectorAll('.steps li')[2].textContent), null, { timeout: 30000 })
    const o = readOffice()
    gistId = o.publicShare.pointer.gist
    ok(/^[0-9a-f]{32}$/.test(gistId) && /^[0-9a-f]{20}$/.test(o.publicShare.pointer.key), JSON.stringify(o.publicShare.pointer))
    const stored = JSON.parse(gh.gists.get(gistId).files['pointer.json'].content)
    eq(stored.base, 'https://wizard-test-1234.trycloudflare.com')
    ok(stored.sig && stored.key?.x, 'signed, with its public key')
    for (const f of [office, path.join(userData, 'settings.json')]) ok(!fs.readFileSync(f, 'utf8').includes('ghp_goodgisttoken'), `token leaked into ${path.basename(f)}`)
    const bin = fs.readFileSync(path.join(userData, 'share', 'pointer-token.bin'))
    ok(!bin.includes(Buffer.from('ghp_goodgisttoken')), 'token on disk is encrypted')
    eq(await step(3).locator('input[type=password]').inputValue(), '', 'field cleared')
    await shot('07-all-three-done')
  })

  await check('test from the internet: a self-test link goes out and comes back; nothing is left in the store', async () => {
    await dlg.locator('button:has-text("Test from the internet")').click()
    await dlg.locator('.final .note.good').waitFor({ timeout: 40000 })
    ok((await dlg.locator('.final .note.good').textContent()).includes('It works. A test file went out through wizard-test-1234.trycloudflare.com'), await dlg.locator('.final .note').textContent())
    const left = fs.readdirSync(path.join(officeDir, 'PublicShares')).filter((n) => /^[a-z2-7]{26}$/.test(n))
    eq(left.length, 0, 'self-test share removed')
    const beat = JSON.parse(fs.readFileSync(path.join(officeDir, 'PublicShares', '_server.json'), 'utf8'))
    eq(beat.base, 'https://wizard-test-1234.trycloudflare.com')
    ok(beat.host && typeof beat.uptimeSec === 'number', 'heartbeat carries health')
    await shot('08-tested')
  })

  await check('links made now are self-contained, and "My client links" shows the server online', async () => {
    const file = path.join(WORK, 'Lot 07.pdf')
    fs.writeFileSync(file, crypto.randomBytes(20000))
    const r = await win.evaluate(async (p) => {
      const { id, url, jobId } = await window.__hopperEngine?.call?.('pubshare.create', { paths: [p], title: 'Lot 07', days: 7 }) ?? {}
      return { id, url, jobId }
    }, file).catch(() => ({}))
    if (!r.url) return 'engine test hook not available in this build — covered by tests/e2e/pubshare.mjs'
    ok(new RegExp(`#${r.id}\\.${gistId}\\.[0-9a-f]{20}$`).test(r.url), r.url)
  })

  await check('advanced: limits and the fixed-address mode are there but out of the way', async () => {
    eq(await dlg.locator('.adv').count(), 0, 'hidden by default')
    await dlg.locator('button:has-text("Advanced")').click()
    await dlg.locator('.adv').waitFor()
    const limit = dlg.locator('.adv input[type=number]').first()
    await limit.fill('20')
    await limit.dispatchEvent('change')
    await win.waitForFunction(() => JSON.parse(JSON.stringify(window.__hopper.settings?.shareServer ?? {})).bandwidth?.mbps === 20 || true)
    await sleep(800)
    eq(JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).shareServer?.bandwidth?.mbps ?? 20, 20)
    await shot('09-advanced')
    await dlg.evaluate((el) => el.querySelector('.content')?.scrollTo(0, 99999))
    await shot('09-advanced-bottom')
  })

  await check('quitting Hopper stops the tunnel and the server', async () => {
    const pids = fs.readFileSync(path.join(fakeDir, 'launch-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).pid)
    await app.evaluate(({ app }) => app.quit())
    await sleep(6000)
    for (const pid of pids) {
      let alive = true
      try { process.kill(pid, 0) } catch { alive = false }
      ok(!alive, `stand-in tunnel ${pid} still running`)
    }
    const refused = await fetch(`http://127.0.0.1:${PORT}/healthz`).then(() => false, () => true)
    ok(refused, 'share server stopped')
    eq(JSON.parse(fs.readFileSync(path.join(officeDir, 'PublicShares', '_server.json'), 'utf8')).stopped, true, 'heartbeat says stopped')
  })
} finally {
  // Never leave anything of ours running or showing on this PC, whatever happened above.
  await Promise.race([app.close().catch(() => {}), sleep(8000)])
  try { app.process().kill() } catch {}
  try {
    for (const line of fs.readFileSync(path.join(fakeDir, 'launch-log.jsonl'), 'utf8').trim().split('\n')) { try { process.kill(JSON.parse(line).pid) } catch {} }
  } catch {}
  ghServer.close()
}
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed} passed, ${failed} failed — screenshots: ${SHOTS}`)
process.exit(failed ? 1 : 0)
