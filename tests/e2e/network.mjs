// Network node in the real app (a private build). Needs no office network:
//   - real: discovery sources answer through the app's IPC (counts only), \\localhost lists this PC's
//     own shares and one opens in the file list, \\192.0.2.1 (a reserved, unroutable address) shows
//     the offline state, the address bar, palette, dialogs, saved places and restart.
//   - STUBBED (inside the window, via window.__hopperNet.netApi): the computer list (NAS-DEMO,
//     FILES-DEMO, LOCKED-DEMO…), those computers' share lists, and every sign-in reply. No real
//     sign-in is attempted, so no connection or saved credential is created on this PC.
//   npx electron-vite build --outDir <HOPPER_WORK_ROOT>\net-agent\app\out
//   node --no-warnings tests/e2e/network.mjs
import { _electron as electron } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASE = process.env.HOPPER_NET_WORK || path.join(process.env.HOPPER_WORK_ROOT || tmpdir(), 'net-agent')
const APP = path.join(BASE, 'app')
const WORK = path.join(BASE, 'e2e')
const SHOTS = path.join(WORK, 'shots')
const require = createRequire(path.join(root, 'package.json'))
if (!fs.existsSync(path.join(APP, 'out', 'main', 'index.js'))) throw new Error(`Build first: npx electron-vite build --outDir ${path.join(APP, 'out')}`)

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
    console.log(`  FAIL  ${name}\n        ${String(e?.stack ?? e).split('\n').slice(0, 5).join('\n        ')}`)
  }
}
const ok = (v, msg) => { if (!v) throw new Error(msg || 'assertion failed') }
const eq = (a, b, msg = '') => { if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

// ---- isolated profile: LAN sharing off (no announcing on the office network), quit on close ----------
const userData = path.join(WORK, 'data')
const officeDir = path.join(WORK, 'office')
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(officeDir, { recursive: true })
fs.writeFileSync(path.join(officeDir, 'office.json'), JSON.stringify({ officeName: 'Test office', officeKey: '', serverInbox: '', cliq: { enabled: false, endpoint: '', zapikey: '' }, groups: [], admins: [], announcers: [] }))
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ officeConfigPath: path.join(officeDir, 'office.json'), theme: 'light', dual: false, keepInTray: false, inboxDir: path.join(WORK, 'inbox'), lan: { enabled: false, acceptFrom: 'all', blocked: [], askFor: [] } }))
const temp = path.join(WORK, 'tmp')
fs.mkdirSync(temp, { recursive: true })

let app
let win
async function launch() {
  app = await electron.launch({
    executablePath: require('electron'),
    args: [APP, '--no-sandbox'],
    cwd: APP,
    env: { ...process.env, NODE_PATH: path.join(root, 'node_modules'), HOPPER_USER_DATA: userData, TEMP: temp, TMP: temp }
  })
  win = await app.firstWindow()
  await win.waitForFunction(() => window.__hopper?.ready === true && !!window.__hopperNet, null, { timeout: 90000 })
  await win.setViewportSize({ width: 1280, height: 860 }).catch(() => {})
  await installStubs()
}
async function close() {
  if (!app) return
  const pid = app.process().pid
  await Promise.race([app.close().catch(() => {}), sleep(10000)])
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  app = undefined
}

/**
 * STUB: stands in for computers that don't exist. Calls for "localhost" and the reserved address
 * 192.0.2.1 still go to the real helper. stub.log records what the UI asked for (passwords redacted
 * to their length, so the test can prove the typed value reached the helper call unchanged).
 */
async function installStubs() {
  await win.evaluate(() => {
    const { netApi, net } = window.__hopperNet
    const real = { ...netApi }
    const stub = (window.__netStub = { log: [], signedIn: false, connectReplies: [] })
    const realHost = (s) => /^(localhost|192\.0\.2\.1)$/i.test(s)
    const shares = {
      'NAS-DEMO': [{ name: 'Projects', type: 0, remark: 'Live jobs' }, { name: 'Scans', type: 0, remark: '' }, { name: 'IPC$', type: 0x80000003, remark: 'Remote IPC' }, { name: 'C$', type: 0x80000000, remark: 'Default share' }, { name: 'Plotter', type: 1, remark: '' }],
      'FILES-DEMO': [{ name: 'Archive', type: 0, remark: '' }]
    }
    netApi.computers = async (sources) => {
      stub.log.push(['computers', sources.join(',')])
      const all = {
        connected: { id: 'connected', ms: 5, items: [{ name: 'FILES-DEMO' }, { name: 'localhost' }] },
        wsd: { id: 'wsd', ms: 40, items: [{ name: 'NAS-DEMO', address: '192.0.2.10' }, { name: '192.0.2.10', address: '192.0.2.10', unnamed: true }, { name: '192.0.2.77', address: '192.0.2.77', unnamed: true }] },
        browse: { id: 'browse', ms: 60, items: [], error: 6118 },
        serverEnum: { id: 'serverEnum', ms: 60, items: [], error: 6118 }
      }
      await new Promise((r) => setTimeout(r, 150))
      return { ms: 150, sources: sources.map((s) => all[s]).filter(Boolean) }
    }
    netApi.shares = async (server) => {
      stub.log.push(['shares', server])
      if (realHost(server)) return real.shares(server)
      await new Promise((r) => setTimeout(r, 120))
      const key = server.toUpperCase()
      if (key === 'LOCKED-DEMO') return stub.signedIn ? { server, shares: [{ name: 'Private', type: 0, remark: '' }], connected: true, remembered: null } : { server, error: { stage: 'enum', code: 5 }, connected: false, remembered: null }
      if (key === 'GONE-DEMO') return { server, error: { stage: 'connect', code: 1231 } }
      if (key === 'OLDNAS-DEMO') return { server, error: { stage: 'enum', code: 50 }, connected: false }
      if (shares[key]) return { server, shares: shares[key], connected: false, remembered: null }
      return { server, error: { stage: 'resolve', code: 53 } }
    }
    netApi.connect = async (spec) => {
      stub.log.push(['connect', spec.remote, spec.user, `password:${spec.password.length}`, spec.remember])
      const r = stub.connectReplies.shift() ?? { ok: true, remote: spec.remote }
      if (r.ok) stub.signedIn = true
      return r
    }
    netApi.disconnect = async (server, forget) => {
      stub.log.push(['disconnect', server, forget])
      stub.signedIn = false
      return { closed: 1, failed: [], forgot: false }
    }
    // STUB: no Hopper peers. The LAN list includes this PC itself (its real name stays out of screenshots)
    // and the LAN process can resend it at any time, so the property is pinned to an empty list.
    Object.defineProperty(window.__hopper, 'peers', { configurable: true, get: () => [], set: () => {} })
    // forget anything the first (unstubbed) render may have fetched
    net.raw = {}
    net.scannedAt = 0
    net.listings = {}
  })
}

const P = () => win.evaluate(() => window.__hopper.active.path)
const waitPath = (pred, timeout = 15000) => win.waitForFunction(pred, null, { timeout })
const sidebar = () => win.locator('aside.sidebar')
const netRow = (text) => sidebar().locator('.netnode button.row.sub', { hasText: text })
const tile = (text) => win.locator('.net .tile', { hasText: text })
const shot = async (name, loc) => { await sleep(300); await (loc ?? win).screenshot({ path: path.join(SHOTS, name + '.png') }) }
const settingsFile = () => JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'))
async function typeAddress(text) {
  await win.evaluate(() => document.activeElement?.blur())
  await win.keyboard.press('Control+L')
  const input = win.locator('.crumbs input.edit').first()
  await input.waitFor({ timeout: 5000 })
  await input.fill(text)
  await input.press('Enter')
}
async function dismissToasts() {
  await win.evaluate(() => { window.__hopper.toasts = [] })
}

console.log(`Network node test — screenshots (stubbed data only) in ${SHOTS}`)
try {
  await launch()

  await check('real discovery sources answer through the app (counts only)', async () => {
    const t0 = Date.now()
    const r = await win.evaluate(() => window.hopper.net.computers(['connected', 'wsd']))
    ok(Array.isArray(r.sources) && r.sources.length === 2, 'two sources')
    for (const s of r.sources) ok(Array.isArray(s.items) && typeof s.ms === 'number', `source ${s.id} shape`)
    return r.sources.map((s) => `${s.id}: ${s.items.length} in ${s.ms} ms${s.error ? ` error ${s.error}` : ''}`).join(', ') + `; ${Date.now() - t0} ms round trip`
  })

  await check('Network node expands to discovered computers and is remembered', async () => {
    await win.evaluate(() => window.__hopper.updateSettings({ sidebarCollapsed: false }))
    const twist = sidebar().locator('.netnode .twist')
    eq(await twist.getAttribute('aria-expanded'), 'false', 'starts collapsed')
    await twist.click()
    eq(await twist.getAttribute('aria-expanded'), 'true', 'expanded')
    await netRow('NAS-DEMO').waitFor({ timeout: 10000 })
    await netRow('FILES-DEMO').waitFor()
    await netRow('192.0.2.77').waitFor()
    // address-only reply for NAS-DEMO's address is merged away; localhost is not listed
    eq(await netRow('192.0.2.10').count(), 0, 'duplicate address row')
    eq(await sidebar().locator('.netnode button.row.sub').count(), 3, 'computer rows')
    const asked = await win.evaluate(() => window.__netStub.log.filter((l) => l[0] === 'computers').map((l) => l[1]).sort())
    eq(JSON.stringify(asked), JSON.stringify(['browse,serverEnum', 'connected', 'wsd']), 'sources asked')
    await sleep(700)
    eq(settingsFile().network?.expanded, true, 'expanded state saved')
    // only the Network node: the rest of the sidebar shows this PC's real drives
    await shot('01-sidebar-network', sidebar().locator('.netnode'))
  })

  await check("a computer's shares list (folders only, hidden on request)", async () => {
    await netRow('NAS-DEMO').click()
    await waitPath(() => window.__hopper.active.path === 'hopper:network?host=NAS-DEMO')
    await tile('Projects').waitFor({ timeout: 10000 })
    eq(await win.locator('.net .tile').count(), 2, 'Projects and Scans only')
    ok(await win.locator('.net .foot', { hasText: '1 hidden share not shown' }).isVisible(), 'hidden count')
    eq(await win.locator('.crumbs .seg').allTextContents().then((t) => t.map((x) => x.trim()).join(' > ')), 'Network > NAS-DEMO', 'breadcrumb')
    await shot('02-shares', win.locator('.pane').first())
    await win.locator('.net .actions .check input').check()
    await tile('C$').waitFor()
    eq(await win.locator('.net .tile').count(), 3, 'with hidden share')
    await win.locator('.net .actions .check input').uncheck()
    await win.waitForFunction(() => document.querySelectorAll('.net .tile').length === 2)
    // the pane filter narrows the share list
    await win.evaluate(() => { window.__hopper.active.filter = 'sca' })
    await win.waitForFunction(() => document.querySelectorAll('.net .tile').length === 1)
    await win.evaluate(() => { window.__hopper.active.filter = '' })
  })

  await check('typing \\\\localhost opens its share list; a share opens in the file list (real helper)', async () => {
    await typeAddress('\\\\localhost')
    await waitPath(() => window.__hopper.active.path === 'hopper:network?host=localhost')
    await win.waitForFunction(() => { const l = window.__hopperNet.net.listing('localhost'); return l && l.status !== 'loading' }, null, { timeout: 30000 })
    const st = await win.evaluate(() => { const l = window.__hopperNet.net.listing('localhost'); return { status: l.status, n: l.shares.length, err: l.error?.code } })
    if (st.status !== 'ok') throw new Error(`listing localhost: ${st.err}`)
    const tiles = await win.locator('.net .tile').count()
    if (!tiles) return `this PC shares no folders (${st.n} raw entries) — opening a share was not exercised`
    await win.locator('.net .tile').first().click()
    await waitPath(() => /^\\\\localhost\\[^\\]+$/i.test(window.__hopper.active.path) && !window.__hopper.active.loading, 30000)
    const r = await win.evaluate(() => ({ error: window.__hopper.active.error, n: window.__hopper.active.entries.length }))
    eq(r.error, '', 'listing error')
    ok(await win.locator('.pane').first().locator('.list').count(), 'file list shown')
    eq((await win.locator('.crumbs .seg').first().textContent()).trim(), 'Network', 'UNC breadcrumb starts at Network')
    // Up from a share root goes back to the computer, then to Network; Back/Forward walk the same way
    await win.evaluate(() => window.__hopper.active.up())
    await waitPath(() => window.__hopper.active.path === 'hopper:network?host=localhost')
    await win.evaluate(() => window.__hopper.active.up())
    await waitPath(() => window.__hopper.active.path === 'hopper:network')
    await win.evaluate(() => window.__hopper.active.back())
    await waitPath(() => window.__hopper.active.path === 'hopper:network?host=localhost')
    await win.evaluate(() => window.__hopper.active.back())
    await waitPath(() => /^\\\\localhost\\/i.test(window.__hopper.active.path))
    return `${tiles} shares listed, opened one with ${r.n} entries`
  })

  await check('an unreachable computer shows the offline state within seconds (real helper)', async () => {
    const t0 = Date.now()
    await win.evaluate(() => window.__hopper.active.navigate('\\\\192.0.2.1'))
    await win.locator('.net .state.err').waitFor({ timeout: 30000 })
    const ms = Date.now() - t0
    eq(await win.locator('.net .state.err').getAttribute('data-code'), 'offline')
    ok((await win.locator('.net .state.err .msg').textContent()).includes("isn't answering"), 'offline wording')
    eq(await win.locator('.net .state.err button', { hasText: 'Sign in' }).count(), 0, 'no sign-in offered for offline')
    return `offline after ${ms} ms`
  })

  await check('stubbed failures: not found, offline, cannot list', async () => {
    await win.evaluate(() => window.__hopper.active.navigate('\\\\GONE-DEMO'))
    await win.locator('.net .state.err[data-code=offline]').waitFor({ timeout: 10000 })
    await win.evaluate(() => window.__hopper.active.navigate('\\\\NOWHERE-DEMO'))
    await win.locator('.net .state.err[data-code=notfound]').waitFor({ timeout: 10000 })
    ok((await win.locator('.net .state.err .msg').textContent()).includes("can't find a computer called NOWHERE-DEMO"), 'not found wording')
    await win.evaluate(() => window.__hopper.active.navigate('\\\\OLDNAS-DEMO'))
    await win.locator('.net .state.err[data-code=unsupported]').waitFor({ timeout: 10000 })
    ok(await win.locator('.net .state.err button', { hasText: 'Add a share by name' }).isVisible(), 'offers adding a share by name')
  })

  await check('access denied shows Hopper’s sign-in dialog; wrong then right password (stubbed replies)', async () => {
    await win.evaluate(() => { window.__netStub.connectReplies = [{ error: { stage: 'signin', code: 1326 } }, { error: { stage: 'signin', code: 1219 } }] })
    await win.evaluate(() => window.__hopper.active.navigate('hopper:network?host=LOCKED-DEMO'))
    const err = win.locator('.net .state.err[data-code=denied]')
    await err.waitFor({ timeout: 10000 })
    ok((await err.locator('.msg').textContent()).includes('needs you to sign in'), 'denied wording')
    await err.locator('button', { hasText: 'Sign in' }).click()
    const dlg = win.locator('[role=dialog][aria-label="Sign in to LOCKED-DEMO"]')
    await dlg.waitFor({ timeout: 5000 })
    await dlg.locator('input[aria-label="User name"]').fill('LOCKED-DEMO\\tester')
    await dlg.locator('input[aria-label="Password"]').fill('dummy-pass-1')
    await dlg.locator('button[type=submit]').click()
    await dlg.locator('[role=alert]', { hasText: 'The user name or password is incorrect.' }).waitFor({ timeout: 5000 })
    await shot('03-signin-wrong-password', dlg)
    // Windows already connected with another account: the dialog offers to sign out and retry
    await dlg.locator('button[type=submit]').click()
    await dlg.locator('[role=alert]', { hasText: 'different account' }).waitFor({ timeout: 5000 })
    await dlg.locator('input[type=checkbox]').check()
    await dlg.locator('button', { hasText: 'Sign out of LOCKED-DEMO and try again' }).click()
    await dlg.waitFor({ state: 'detached', timeout: 5000 })
    await tile('Private').waitFor({ timeout: 10000 })
    const log = await win.evaluate(() => window.__netStub.log.filter((l) => l[0] === 'connect' || l[0] === 'disconnect'))
    eq(JSON.stringify(log), JSON.stringify([
      ['connect', '\\\\LOCKED-DEMO', 'LOCKED-DEMO\\tester', 'password:12', false],
      ['connect', '\\\\LOCKED-DEMO', 'LOCKED-DEMO\\tester', 'password:12', false],
      ['disconnect', 'LOCKED-DEMO', false],
      ['connect', '\\\\LOCKED-DEMO', 'LOCKED-DEMO\\tester', 'password:12', true]
    ]), 'calls')
    await sleep(700)
    const raw = fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')
    ok(!raw.includes('dummy-pass-1'), 'password not in settings')
    const stored = await win.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))
    ok(!stored.includes('dummy-pass-1'), 'password not in web storage')
  })

  await check('opening a share that refuses access asks to sign in (stubbed listing error)', async () => {
    // a share whose listing fails with "Access denied" brings up the dialog; cancelling leaves the error in the list
    await win.evaluate(async () => {
      const pane = window.__hopper.active
      const orig = pane.load.bind(pane)
      pane.load = async (o) => { await orig(o); if (/^\\\\DENIED-DEMO\\/i.test(pane.path)) pane.error = 'Access denied: ' + pane.path }
      window.__restoreLoad = () => { delete pane.load }
      void window.__hopperNet.net.open(pane, '\\\\DENIED-DEMO\\Secret')
    })
    const dlg = win.locator('[role=dialog][aria-label="Sign in to DENIED-DEMO"]')
    await dlg.waitFor({ timeout: 15000 })
    ok((await dlg.locator('.lead').textContent()).includes('\\\\DENIED-DEMO\\Secret'), 'names the share')
    await dlg.locator('button', { hasText: 'Cancel' }).click()
    await dlg.waitFor({ state: 'detached' })
    await win.evaluate(() => window.__restoreLoad())
  })

  await check('Add a network place from the palette; FTP and bad addresses are refused', async () => {
    await dismissToasts()
    await win.locator('.list, .net').first().click({ position: { x: 5, y: 5 } }).catch(() => {})
    await win.keyboard.press('Control+K')
    const pal = win.locator('[role=dialog][aria-label="Command palette"] input')
    await pal.waitFor({ timeout: 5000 })
    await pal.fill('add a network place')
    await win.locator('.pal .it', { hasText: 'Add a network place…' }).first().click()
    const dlg = win.locator('[role=dialog][aria-label="Add a network place"]')
    await dlg.waitFor({ timeout: 5000 })
    const addr = dlg.locator('input[aria-label="Network address"]')
    await addr.fill('ftp://files.example.com/pub')
    await dlg.locator('button[type=submit]').click()
    await dlg.locator('[role=alert]', { hasText: "FTP isn't supported in Hopper yet" }).waitFor({ timeout: 3000 })
    await shot('04-ftp-refused', dlg)
    await addr.fill('\\\\bad name\\x')
    await dlg.locator('button[type=submit]').click()
    await dlg.locator('[role=alert]', { hasText: "isn't a valid computer name" }).waitFor({ timeout: 3000 })
    await addr.fill('C:\\Projects')
    await dlg.locator('button[type=submit]').click()
    await dlg.locator('[role=alert]', { hasText: 'folder on this PC' }).waitFor({ timeout: 3000 })
    await addr.fill('smb://nas-demo/Projects/2026')
    await dlg.locator('.hint', { hasText: '\\\\nas-demo\\Projects\\2026' }).waitFor({ timeout: 3000 })
    await dlg.locator('input[aria-label="Name"]').fill('Demo projects')
    await dlg.locator('button[type=submit]').click()
    await dlg.waitFor({ state: 'detached' })
    await netRow('Demo projects').waitFor({ timeout: 5000 })
    // the address bar refuses ftp:// too, in a toast
    await typeAddress('ftp://files.example.com')
    await win.locator('.toast', { hasText: "FTP isn't supported in Hopper yet" }).waitFor({ timeout: 5000 })
  })

  await check('add from the Network page, rename and remove; saved places survive a restart', async () => {
    await dismissToasts()
    await win.evaluate(() => window.__hopper.active.navigate('hopper:network'))
    await win.locator('.net header button', { hasText: 'Add a network place' }).click()
    const dlg = win.locator('[role=dialog][aria-label="Add a network place"]')
    await dlg.locator('input[aria-label="Network address"]').fill('//files-demo')
    await dlg.locator('button[type=submit]').click()
    await dlg.waitFor({ state: 'detached' })
    await netRow('\\\\files-demo').waitFor({ timeout: 5000 })
    // a duplicate is not added twice
    await win.evaluate(() => window.__hopperNet.net.addPlaceRaw('\\\\FILES-DEMO\\'))
    eq(await win.evaluate(() => window.__hopperNet.net.places.length), 2, 'no duplicate')
    // rename through the sidebar context menu
    await netRow('\\\\files-demo').click({ button: 'right' })
    await win.locator('.menu button, [role=menu] button, .ctx button', { hasText: 'Rename…' }).first().click()
    const prompt = win.locator('[role=dialog][aria-label="Rename network place"]')
    await prompt.waitFor({ timeout: 5000 })
    await prompt.locator('input').fill('Files server')
    await prompt.locator('button[type=submit]').click()
    await netRow('Files server').waitFor({ timeout: 5000 })
    await win.locator('.net .tile', { hasText: 'Files server' }).waitFor()
    // remove "Demo projects" from the Network page's context menu
    await win.locator('.net .tile', { hasText: 'Demo projects' }).click({ button: 'right' })
    await win.locator('.menu button, [role=menu] button, .ctx button', { hasText: 'Remove' }).first().click()
    await netRow('Demo projects').waitFor({ state: 'detached', timeout: 5000 })
    await shot('05-network-page', win.locator('.pane').first())
    // opening a saved computer goes to its share list
    await netRow('Files server').click()
    await waitPath(() => window.__hopper.active.path === 'hopper:network?host=files-demo')
    await tile('Archive').waitFor({ timeout: 10000 })
    await sleep(800)
    const saved = settingsFile().network
    eq(JSON.stringify(saved.places.map((p) => [p.path, p.name ?? ''])), JSON.stringify([['\\\\files-demo', 'Files server']]), 'saved before restart')

    await close()
    await launch()
    await netRow('Files server').waitFor({ timeout: 15000 })
    eq(await netRow('Demo projects').count(), 0, 'removed place stays removed')
    eq(await win.evaluate(() => window.__hopperNet.net.places.map((p) => p.path).join('|')), '\\\\files-demo', 'after restart')
    eq(await sidebar().locator('.netnode .twist').getAttribute('aria-expanded'), 'true', 'still expanded')
  })

  await check('collapsed sidebar rail: Network button opens the Network page', async () => {
    await win.evaluate(() => window.__hopper.active.navigate('hopper:home'))
    await win.evaluate(() => window.__hopper.updateSettings({ sidebarCollapsed: true }))
    const rail = win.locator('aside.rail')
    await rail.waitFor({ timeout: 5000 })
    await rail.locator('button[aria-label=Network]').click()
    await waitPath(() => window.__hopper.active.path === 'hopper:network')
    ok(await rail.locator('button[aria-label=Network].on').count(), 'rail button highlighted')
    await rail.locator('button[aria-label=Home]').click()
    await waitPath(() => window.__hopper.active.path === 'hopper:home')
    await rail.locator('button[aria-label="Show sidebar"]').click()
    await sidebar().waitFor({ timeout: 5000 })
  })

  await check('Network command in the palette and tabs', async () => {
    await win.evaluate(() => { window.__hopper.active.openTab('\\\\NAS-DEMO'); return window.__hopper.active.load() })
    eq(await P(), 'hopper:network?host=NAS-DEMO', 'new tab for \\\\server lands on the share list')
    eq((await win.locator('.tab.active').first().textContent()).trim().includes('NAS-DEMO'), true, 'tab title')
    await win.evaluate(() => window.__hopper.active.closeTab())
    // middle-click on a saved place opens exactly one new tab; right-click only opens the menu
    const before = await win.evaluate(() => window.__hopper.active.tabs.length)
    const at = await P()
    await netRow('Files server').click({ button: 'right' })
    await win.locator('[role=menu]').first().waitFor({ timeout: 3000 })
    await win.evaluate(() => { window.__hopper.menu = null })
    eq(await P(), at, 'right-click does not navigate')
    // (the sidebar is scrollable here, so this also checks a middle-click doesn't start autoscroll instead)
    await netRow('Files server').click({ button: 'middle' })
    await waitPath(() => window.__hopper.active.path === 'hopper:network?host=files-demo')
    eq(await win.evaluate(() => window.__hopper.active.tabs.length), before + 1, 'one new tab')
    await win.evaluate(() => window.__hopper.active.closeTab())
    await win.keyboard.press('Control+K')
    const pal = win.locator('[role=dialog][aria-label="Command palette"] input')
    await pal.fill('open network')
    await win.locator('.pal .it', { hasText: 'Open Network' }).first().click()
    await waitPath(() => window.__hopper.active.path === 'hopper:network')
  })
} finally {
  // Never leave anything of ours running or showing on this PC, whatever happened above.
  await close().catch(() => {})
}
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed} passed, ${failed} failed — screenshots: ${SHOTS}`)
process.exit(failed ? 1 : 0)
