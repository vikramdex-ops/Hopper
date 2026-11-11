// Dexterity Share "Use in a browser" in the real app (a private build): My client links makes a
// personal browser pass, shows its sign-in link once, lists it, and switches it off; the real share
// server (run here, on the same scratch store) accepts the pass and then refuses it.
//   npx electron-vite build --outDir <TEST_WORK>\app\out
//   node --no-warnings tests/e2e/pubshare-staff-app.mjs
import { TEST_WORK } from '../unit/pubshare-hooks.mjs'
import { _electron as electron } from 'playwright-core'
import crypto from 'node:crypto'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP = path.join(TEST_WORK, 'app')
const WORK = path.join(TEST_WORK, 'staff-app')
const require = createRequire(path.join(root, 'package.json'))
if (!fs.existsSync(path.join(APP, 'out', 'main', 'index.js'))) throw new Error(`Build first: npx electron-vite build --outDir ${path.join(APP, 'out')}`)

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, main: 'out/main/index.js' }, null, 1))
for (const dir of [['native', 'bin'], ['vendor', '7zip'], ['build']]) {
  const from = path.join(root, ...dir)
  if (fs.existsSync(from)) fs.cpSync(from, path.join(APP, ...dir), { recursive: true, force: true })
}
fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
const STORE = path.join(WORK, 'office', 'PublicShares')
fs.mkdirSync(STORE, { recursive: true })

const S = await import('../../server/dexterity-share/server.mjs')
const results = []
async function check(name, fn) {
  const t0 = Date.now()
  try {
    const note = await fn()
    results.push(true)
    console.log(`  ok    ${name}${note ? `  [${note}]` : ''}  (${Date.now() - t0} ms)`)
  } catch (e) {
    results.push(false)
    console.log(`  FAIL  ${name}\n        ${String(e?.stack ?? e).split('\n').slice(0, 5).join('\n        ')}`)
  }
}
const ok = (v, msg) => { if (!v) throw new Error(msg || 'assertion failed') }
const eq = (a, b, msg = '') => { if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

const office = path.join(WORK, 'office', 'office.json')
fs.writeFileSync(office, JSON.stringify({ officeName: 'Test office', officeKey: crypto.randomBytes(32).toString('hex'), serverInbox: path.join(WORK, 'office', 'Inbox'), cliq: { enabled: false, endpoint: '', zapikey: '' }, groups: [], admins: ['staffdemo', os.userInfo().username.toLowerCase()], announcers: [], publicShare: { enabled: true, store: STORE, pageUrl: 'https://example.test/share/', defaultDays: 7, minFreeGB: 0, web: { enabled: true, maxGB: 5 } } }))
const userData = path.join(WORK, 'data')
fs.mkdirSync(userData, { recursive: true })
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ officeConfigPath: office, theme: 'light', inboxDir: path.join(WORK, 'inbox'), profile: { displayName: 'Demo Sender', email: '', status: 'online' }, lan: { enabled: false, acceptFrom: 'all', blocked: [], askFor: [] } }))
const temp = path.join(WORK, 'tmp')
fs.mkdirSync(temp, { recursive: true })

const server = S.createShareServer({ port: 0, store: STORE, allowedOrigins: ['https://example.test'], stateDir: path.join(WORK, 'state'), logDir: path.join(WORK, 'logs'), passCacheMs: 100, minFreeGB: 0, shutdownGraceSeconds: 0 })
const PORT = await server.listen()
const me = (pass, secret) => fetch(`http://127.0.0.1:${PORT}/api/staff/me`, { headers: { Authorization: `Bearer ${pass}.${secret}` } })

const app = await electron.launch({
  executablePath: require('electron'),
  args: [APP, '--no-sandbox'],
  cwd: APP,
  env: { ...process.env, NODE_PATH: path.join(root, 'node_modules'), HOPPER_USER_DATA: userData, HOPPER_LAN_USER: 'staffdemo', TEMP: temp, TMP: temp }
})
console.log(`Dexterity Share "Use in a browser" app test — work folder ${WORK}`)
try {
  const win = await app.firstWindow()
  await win.waitForFunction(() => window.__hopper?.ready === true, null, { timeout: 90000 })
  await win.setViewportSize({ width: 1280, height: 860 }).catch(() => {})
  const dlg = win.locator('[role=dialog][aria-label="My client links"]')
  let link = ''
  let passId = ''

  await check('My client links → Use in a browser → Make a sign-in link: a valid pass file in the store and the link shown once', async () => {
    await win.keyboard.press('Control+K')
    await win.keyboard.type('My client links')
    await win.keyboard.press('Enter')
    await dlg.waitFor({ timeout: 20000 })
    await dlg.locator('button:has-text("Use in a browser")').click()
    await dlg.locator('text=No browser is signed in yet.').waitFor({ timeout: 20000 })
    await dlg.locator('button:has-text("Make a sign-in link")').click()
    const input = dlg.locator('input[aria-label="Sign-in link"]')
    await input.waitFor({ timeout: 20000 })
    link = await input.inputValue()
    const m = /^https:\/\/example\.test\/share\/create\/#([a-z2-7]{26})\.([A-Za-z0-9_-]{43})$/.exec(link)
    ok(m, link)
    passId = m[1]
    const file = JSON.parse(fs.readFileSync(path.join(STORE, '_staff', `${passId}.json`), 'utf8'))
    eq(file.v, 1)
    eq(file.id, passId)
    eq(file.name, 'Demo Sender')
    eq(file.user, file.user.toLowerCase(), 'lower-case account')
    eq(file.verifier, crypto.createHash('sha256').update(Buffer.from(m[2], 'base64url')).digest('hex'))
    ok(!JSON.stringify(file).includes(m[2]), 'secret not stored')
    for (const f of fs.readdirSync(userData)) {
      const p = path.join(userData, f)
      if (fs.statSync(p).isFile()) ok(!fs.readFileSync(p, 'utf8').includes(m[2]), `secret kept in ${f}`)
    }
    ok(await dlg.locator('button:has-text("Copy link")').isVisible() && await dlg.locator('button:has-text("Open in browser")').isVisible(), 'copy and open')
    ok((await dlg.textContent()).includes('bookmark the page'), 'explains what to do')
    await dlg.locator('button:has-text("Copy link")').click()
    eq(await app.evaluate(({ clipboard }) => clipboard.readText()), link, 'copied')
    // the server accepts it
    const r = await me(passId, m[2])
    eq(r.status, 200)
    eq((await r.json()).name, 'Demo Sender')
  })

  await check('the pass is listed with its PC; Switch off asks first, then the server refuses the pass', async () => {
    const row = dlg.locator('ul[aria-label="Browsers signed in"] li')
    await row.first().waitFor()
    eq(await row.count(), 1)
    ok((await row.first().textContent()).includes('not used yet'), await row.first().textContent())
    await row.first().locator('button:has-text("Switch off")').click()
    await row.first().locator('button:has-text("Yes, switch off")').click()
    await dlg.locator('text=No browser is signed in yet.').waitFor({ timeout: 20000 })
    ok(!fs.existsSync(path.join(STORE, '_staff', `${passId}.json`)), 'pass file removed')
    await sleep(300)
    eq((await me(passId, link.split('.').at(-1))).status, 401, 'server refuses it')
  })
  await check('Settings → Office (admin): the browser setting and everyone’s sign-ins, with Switch off', async () => {
    // somebody else's pass, as their Hopper would have written it
    const otherId = 'a'.repeat(26)
    fs.writeFileSync(path.join(STORE, '_staff', `${otherId}.json`), JSON.stringify({ v: 1, id: otherId, user: 'colleague', host: 'DEMO-PC-31', name: 'Demo Colleague', createdAt: Date.now() - 86400000, verifier: 'c'.repeat(64) }))
    await win.keyboard.press('Escape')
    await dlg.waitFor({ state: 'detached', timeout: 10000 })
    await win.keyboard.press('Control+K')
    await win.keyboard.type('Settings')
    await win.keyboard.press('Enter')
    const set = win.locator('[role=dialog][aria-label="Settings"]')
    await set.waitFor({ timeout: 20000 })
    await set.locator('button:has-text("Office")').first().click()
    const toggle = set.locator('label:has-text("Let staff create links from a browser") input[type=checkbox]')
    await toggle.waitFor({ timeout: 20000 })
    eq(await toggle.isChecked(), true)
    await set.locator('button:has-text("Show browser sign-ins")').click()
    const rows = set.locator('ul[aria-label="Browser sign-ins"] li')
    await rows.first().waitFor({ timeout: 20000 })
    eq(await rows.count(), 1)
    ok((await rows.first().textContent()).includes('Demo Colleague'), await rows.first().textContent())
    await rows.first().locator('button:has-text("Switch off")').click()
    await rows.first().locator('button:has-text("Yes, switch off")').click()
    await set.locator('text=Nobody has signed a browser in.').waitFor({ timeout: 20000 })
    ok(!fs.existsSync(path.join(STORE, '_staff', `${otherId}.json`)), 'removed')
    // switching the setting off and saving writes it into office.json
    await toggle.uncheck()
    await set.locator('button:has-text("Save to server")').click()
    await win.waitForFunction(() => true)
    for (let i = 0; i < 50 && JSON.parse(fs.readFileSync(office, 'utf8')).publicShare.web?.enabled !== false; i++) await sleep(200)
    eq(JSON.parse(fs.readFileSync(office, 'utf8')).publicShare.web.enabled, false, 'saved')
  })
} finally {
  await Promise.race([app.close().catch(() => {}), sleep(8000)])
  try { app.process().kill() } catch {}
  await server.close(0)
}
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
