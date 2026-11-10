// Screenshot studio for the README and the landing page: boots the real app with a demo
// project and captures genuine UI states at 1600x960. Colleagues, jobs, client links, messages and
// announcements in the shots are demo data injected into the UI state (the LAN and engine replies
// for those few calls are stubbed inside the window); everything else is the live app.
//
//   node tests/e2e/shots.mjs            writes to <HOPPER_WORK>\shots-site
//   node tests/e2e/shots.mjs --publish  also copies the used images to site/assets/shots and docs/screenshots
//
// Only demo data may appear: the demo tree is shown as its own drive (H:), drives are frozen to a
// demo list, and no real PC, user, client or project names are used.
import { mkdirSync, existsSync, renameSync, writeFileSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { launch, makeDemo, WORK } from './harness.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = join(WORK, 'shots-site')
mkdirSync(out, { recursive: true })
await makeDemo()

// The shared demo tree uses a project folder name the e2e suite depends on; give the public
// images a neutral demo job instead, plus a spreadsheet for the viewer.
const DEMO_DIR = join(WORK, 'demo')
const PROJECT = 'J999 Demo Refinery'
renameSync(join(DEMO_DIR, 'P10001 Refinery Revamp'), join(DEMO_DIR, PROJECT))
writeFileSync(join(DEMO_DIR, PROJECT, 'README.txt'), 'Demo project J999: refinery revamp, piping as-builts.\r\n')
{
  const ExcelJS = createRequire(join(root, 'package.json'))('exceljs')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Line list')
  ws.columns = [
    { header: 'Line number', key: 'line', width: 26 },
    { header: 'Size', key: 'size', width: 8 },
    { header: 'Spec', key: 'spec', width: 9 },
    { header: 'From', key: 'from', width: 16 },
    { header: 'To', key: 'to', width: 16 },
    { header: 'Design °C', key: 't', width: 11 },
    { header: 'Design barg', key: 'p', width: 12 },
    { header: 'Iso', key: 'iso', width: 12 },
    { header: 'Rev', key: 'rev', width: 6 }
  ]
  const from = ['P-101A', 'E-201', 'V-301', 'T-401', 'C-501', 'P-102B']
  const to = ['E-201', 'V-301', 'T-401', 'C-501', 'Header 6"', 'Flare KO']
  for (let i = 0; i < 28; i++) {
    const size = [2, 3, 4, 6, 8, 10, 12][i % 7]
    ws.addRow({ line: `${size}"-PL-${1101 + i}-A1A-H`, size, spec: ['A1A', 'B2C', 'A1A', 'D3E'][i % 4], from: from[i % 6], to: to[i % 6], t: 60 + ((i * 17) % 220), p: 6 + ((i * 7) % 30), iso: `ISO-${1001 + (i % 5)}`, rev: ['0', 'B', '2', 'A', 'C'][i % 5] })
  }
  ws.getRow(1).font = { bold: true }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  const ws2 = wb.addWorksheet('Revisions')
  ws2.addRow(['Iso', 'Rev', 'Date', 'Reason'])
  ws2.addRow(['ISO-1001', '0', '2026-11-02', 'Issued for construction'])
  ws2.addRow(['ISO-1003', '2', '2026-11-04', 'Client comments'])
  await wb.xlsx.writeFile(join(DEMO_DIR, PROJECT, '05_References', 'Line list.xlsx'))
}

// Show the demo as its own drive (H:) so no real paths or office shares appear in public images.
const DRIVE = 'H:'
const demo = 'H:\\'
if (existsSync(demo)) throw new Error(`${DRIVE} is already in use; pick another letter in shots.mjs`)
execFileSync('subst', [DRIVE, DEMO_DIR])
const unsubst = () => {
  try {
    execFileSync('subst', [DRIVE, '/D'])
  } catch {}
}
process.on('exit', unsubst)

const { app, win } = await launch({ env: { HOPPER_SHOTS: '1' } })
try {
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setContentSize(1600, 960)
    w.center()
  })
  await studio()
} finally {
  // never leave a modal open or the app running, whatever happened above
  await win.evaluate(() => window.__hopper.dialogs.slice().forEach((d) => window.__hopper.closeDialog(d.id))).catch(() => {})
  await app.close().catch(() => {})
  unsubst()
}

if (process.argv.includes('--publish')) {
  const site = join(root, 'site', 'assets', 'shots')
  const docs = join(root, 'docs', 'screenshots')
  const siteSet = ['01-workspace-light', '02-workspace-dark', 'f-share', 'f-clientlink', 'f-clientlinks', 'f-viewer', 'f-template', 'f-zip', 'f-transfers', 'f-packager', 'f-person', 'f-pathcopy', 'f-properties', 'f-home', 'f-rail']
  const docsSet = ['01-workspace-light', '02-workspace-dark', 'f-share', 'f-clientlink', 'f-clientlinks', 'f-viewer', 'f-template', 'f-transfers', 'f-packager', 'f-zip', 'f-person', 'f-pathcopy', 'f-home', 'f-palette']
  for (const n of siteSet) copyFileSync(join(out, `${n}.png`), join(site, `${n}.png`))
  for (const n of docsSet) copyFileSync(join(out, `${n}.png`), join(docs, `${n}.png`))
  console.log('published to', site, 'and', docs)
}
console.log('done:', out)

async function studio() {
  const ev = (fn, arg) => win.evaluate(fn, arg)
  const wait = (ms) => win.waitForTimeout(ms)
  let demoPeople = null
  const restorePeople = async () => {
    // The LAN process keeps publishing the real (empty) people list; put the demo back.
    if (demoPeople) await ev((d) => { window.__hopper.peers = d.peers; window.__hopper.groups = d.groups; window.__hopper.lanStatus = { ...window.__hopper.lanStatus, ready: true, enabled: true } }, demoPeople)
  }
  const shot = async (name) => {
    await restorePeople()
    await wait(700)
    await win.screenshot({ path: join(out, `${name}.png`) })
    console.log('  shot', name)
  }
  const box = async (selector) => {
    const all = await win.locator(selector).evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom] }).filter((r) => r[2] > r[0] && r[3] > r[1]))
    if (!all.length) throw new Error(`nothing matches ${selector}`)
    const [x0, y0, x1, y1] = all.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])])
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
  }
  // Focused crop of one UI element (dialog, drawer, menu) with a little breathing room.
  const crop = async (name, selector, { pad = 28, maxH = 0, extendLeft = 0, extendRight = 0 } = {}) => {
    await restorePeople()
    await wait(700)
    const b = await box(selector)
    const vw = await ev(() => [innerWidth, innerHeight])
    const x = Math.max(0, Math.floor(b.x - pad - extendLeft))
    const y = Math.max(0, Math.floor(b.y - pad))
    const w = Math.min(vw[0] - x, Math.ceil(b.width + pad * 2 + extendLeft + extendRight))
    const h = Math.min(vw[1] - y, Math.ceil((maxH || b.height) + pad * 2))
    await win.screenshot({ path: join(out, `${name}.png`), clip: { x, y, width: w, height: h } })
    console.log('  crop', name)
  }
  const clip = async (name, c) => {
    await restorePeople()
    await wait(700)
    await win.screenshot({ path: join(out, `${name}.png`), clip: c })
    console.log('  clip', name)
  }
  const closeAll = () => ev(() => window.__hopper.dialogs.slice().reverse().forEach((d) => window.__hopper.closeDialog(d.id)))
  const until = (fn, arg, timeout = 30000) => win.waitForFunction(fn, arg, { timeout })

  const P = demo + PROJECT
  const lot = join(P, '02_Working', 'Lot 07')

  // Stubbed replies for the few calls whose real answer needs the network (client links,
  // conversation history). Every other call goes to the real engine and LAN processes.
  await ev(() => {
    const stubs = (window.__stubs = {})
    window.__ports = new Set()
    const orig = MessagePort.prototype.postMessage
    MessagePort.prototype.postMessage = function (msg, ...rest) {
      if (msg && msg.t === 'req') {
        window.__ports.add(this)
        const f = stubs[msg.m]
        if (f) {
          const port = this
          Promise.resolve().then(() => f(...(msg.p ?? []))).then(
            (v) => port.onmessage?.({ data: { t: 'res', id: msg.id, ok: true, v } }),
            (e) => port.onmessage?.({ data: { t: 'res', id: msg.id, ok: false, e: String(e?.message ?? e) } })
          )
          return
        }
      }
      return orig.call(this, msg, ...rest)
    }
    // push an event to whichever port listens for it (the other ignores it)
    window.__emit = (n, d) => window.__ports.forEach((p) => p.onmessage?.({ data: { t: 'evt', n, d } }))
  })

  // Demo colleagues, drives and profile (presentational only).
  await ev(({ P }) => {
    const now = Date.now()
    const h = window.__hopper
    h.peers = [
      { id: 'p1', user: 'arun', displayName: 'Arun Kumar', host: 'WS-12', address: '', port: 0, version: '2.2.0', status: 'online', lastSeen: now },
      { id: 'p2', user: 'priya', displayName: 'Priya Raman', host: 'WS-21', address: '', port: 0, version: '2.2.0', status: 'online', lastSeen: now },
      { id: 'p3', user: 'ravi', displayName: 'Ravi Shankar', host: 'WS-07', address: '', port: 0, version: '2.2.0', status: 'busy', lastSeen: now },
      { id: 'p4', user: 'meena', displayName: 'Meena Iyer', host: 'WS-30', address: '', port: 0, version: '2.2.0', status: 'away', lastSeen: now },
      { id: 'p5', user: 'suresh', displayName: 'Suresh Babu', host: 'WS-15', address: '', port: 0, version: '2.2.0', status: 'offline', lastSeen: now - 3600e3 }
    ]
    h.groups = [{ id: 'piping', name: 'Piping team', members: ['arun', 'priya', 'ravi'] }]
    // Demo drives only: never the real machine's shares. C: is nearly full so Home shows its warning.
    h.freezeDrives = true
    const bs = String.fromCharCode(92)
    h.drives = [
      { root: 'C:' + bs, label: 'Windows', kind: 'fixed', total: 256e9, free: 14e9, ready: true },
      { root: 'H:' + bs, label: 'Projects', kind: 'fixed', total: 2e12, free: 1.34e12, ready: true },
      { root: 'S:' + bs, label: 'Office server', kind: 'network', total: 8e12, free: 3.1e12, ready: true, remote: bs + bs + 'fileserver' + bs + 'projects' }
    ]
    h.info.home = P
    h.info.desktop = h.info.downloads = h.info.documents = h.info.pictures = ''
    h.lanStatus = { ready: true, enabled: true }
    h.updateSettings({ profile: { displayName: 'Kiran Rao', email: '', status: 'online' }, pinned: [P, 'H:' + bs + 'Site photos', 'H:' + bs + 'Transmittals'], quickDests: [], officeConfigPath: 'S:' + bs + '_Hopper' + bs + 'office.json' })
    window.__demo = { peers: h.peers, groups: h.groups, drives: h.drives }
  }, { P })
  demoPeople = await ev(() => ({ peers: window.__hopper.peers, groups: window.__hopper.groups }))
  // The LAN process keeps publishing the real (empty) people list and a drive refresh may still be
  // in flight: keep putting the demo back while the studio runs.
  await ev(() => {
    const h = window.__hopper
    const keep = window.__demo
    setInterval(() => {
      if (h.peers !== keep.peers) h.peers = keep.peers
      if (h.groups !== keep.groups) h.groups = keep.groups
      if (h.drives !== keep.drives) h.drives = keep.drives
      if (!h.lanStatus?.ready) h.lanStatus = { ...h.lanStatus, ready: true, enabled: true }
    }, 100)
  })

  // ---- hero: two panes, a lot and a PDF preview -------------------------------------------------
  await ev(({ lot, P }) => {
    const h = window.__hopper
    h.updateSettings({ dual: true, inspector: true, theme: 'light', sidebarCollapsed: false, columns: h.settings.columns.map((c) => (c.id === 'rev' ? { ...c, visible: true } : c)) })
    void h.panes[0].navigate(lot, { select: lot + '\\ISO-1003_Rev2.pdf' })
    void h.panes[1].navigate(P)
    h.drawer = false
  }, { lot, P })
  await wait(2000)
  await until(() => !!document.querySelector('.insp canvas') && !document.querySelector('.insp .spin'), null, 300000)
  await wait(1500)
  await shot('01-workspace-light')

  await ev(() => window.__hopper.updateSettings({ theme: 'dark' }))
  await wait(1500)
  await shot('02-workspace-dark')
  await ev(() => window.__hopper.updateSettings({ theme: 'light' }))

  // ---- share with @mentions ---------------------------------------------------------------------
  await ev(() => {
    const p = window.__hopper.panes[0]
    p.selectWhere((r) => /ISO-100[1-3]/.test(r.name))
    window.__hopper.__dialogs.share(['arun', 'group:piping'])
  })
  await until(() => !!document.querySelector('.dlg'))
  await wait(900)
  await win.keyboard.type('@pri')
  await crop('f-share', '.dlg')
  await win.keyboard.press('Escape')
  await closeAll()

  // ---- Dexterity Share: create a client link, the link-ready view, My client links ---------------
  const now = Date.now()
  const DAY = 86400e3
  await ev(({ now, DAY }) => {
    const base = 'https://vikramdex-ops.github.io/Hopper/share/#'
    const files = [['ISO-1001_Rev0.pdf', 1072], ['ISO-1002_RevB.pdf', 1072], ['ISO-1003_Rev2.pdf', 1072], ['ISO-1004_RevA.pdf', 1072], ['ISO-1005_RevC.pdf', 1072]]
    const mk = (o) => ({ message: '', sender: 'Kiran Rao', owner: 'demo', expired: false, hasPassword: false, maxDownloads: 0, stats: null, ...o })
    window.__links = [
      mk({ id: 'Lq7mX2vR9kTa', url: base + 'Lq7mX2vR9kTa', title: 'Lot 07 isometrics, latest revisions', createdAt: now - 60e3, expiresAt: now + 14 * DAY, files: [{ name: 'Lot 07 isometrics, latest revisions.zip', size: 4.81e6 }], bytes: 4.81e6, hasPassword: true, maxDownloads: 3, stats: { views: 2, started: 1, downloads: 1, lastDownloadAt: now - 20e3, lastViewAt: now - 25e3 } }),
      mk({ id: 'Rt4pW8nZ1cHs', url: base + 'Rt4pW8nZ1cHs', title: 'Site photos, pipe rack 3', createdAt: now - 2 * DAY, expiresAt: now + 5 * DAY, files: [{ name: 'Site photos, pipe rack 3.zip', size: 218e6 }], bytes: 218e6, stats: { views: 3, started: 2, downloads: 2, lastDownloadAt: now - 1.5 * DAY } }),
      mk({ id: 'Bn6yK3dQ5uFe', url: base + 'Bn6yK3dQ5uFe', title: 'Transmittal TR-0041', createdAt: now - 6 * DAY, expiresAt: now + 1 * DAY - 3600e3, files: files.slice(0, 1).map(([name, size]) => ({ name: 'TR-0041.pdf', size: 312e3 })), bytes: 312e3, stats: { views: 0, started: 0, downloads: 0 } })
    ]
    const status = { enabled: true, store: '', storeOk: true, pageUrl: base.slice(0, -1), healthy: true, selfContained: true, freeBytes: 3.1e12, minFreeBytes: 5 * 2 ** 30, server: { activeDownloads: 1, bytesToday: 2.31e9, downloadsToday: 9 } }
    window.__stubs['pubshare.status'] = () => status
    window.__stubs['pubshare.list'] = () => window.__links
    window.__stubs['pubshare.create'] = (spec) => {
      const l = window.__links[0]
      Object.assign(l, { title: spec.title, message: spec.message ?? '', expiresAt: now + spec.days * DAY, hasPassword: !!spec.password, maxDownloads: spec.maxDownloads, stats: null })
      return { jobId: 'pub1', id: l.id, url: l.url, expiresAt: l.expiresAt }
    }
  }, { now, DAY })
  await ev(() => {
    const p = window.__hopper.panes[0]
    p.selectWhere((r) => /ISO-1001_Rev0|ISO-1002_RevB|ISO-1003_Rev2|ISO-1004_RevA|ISO-1005_RevC/.test(r.name))
    void window.__hopper.__dialogs.publicLink()
  })
  await until(() => !!document.querySelector('.dlg input.input'))
  await wait(800)
  await win.locator('.dlg input.input').first().fill('Lot 07 isometrics, latest revisions')
  await win.locator('.dlg textarea').first().fill('Please find the Lot 07 isometrics at their latest revisions, with the comment register to follow.')
  await win.locator('.dlg select').nth(0).selectOption('14')
  await win.locator('.dlg select').nth(1).selectOption('3')
  await win.locator('.dlg button[title="Make a strong password"]').click()
  await crop('f-clientlink-form', '.dlg')
  await win.locator('.dlg button[type="submit"]').click()
  await wait(300)
  await ev(() => {
    window.__hopper.jobs = [{ id: 'pub1', kind: 'copy', title: 'Publishing client link', state: 'done', done: 4.81e6, total: 4.81e6, files: 1, filesTotal: 1, rate: 0, startedAt: Date.now() - 4e3, endedAt: Date.now(), errors: [] }]
  })
  await until(() => /Client link ready/.test(document.querySelector('.dlg')?.innerText ?? ''), null, 15000)
  await ev(() => { window.__hopper.drawer = false })
  await crop('f-clientlink', '.dlg')
  await closeAll()
  await ev(() => { window.__hopper.jobs = []; window.__links[0].stats = { views: 2, started: 1, downloads: 1, lastDownloadAt: Date.now() - 20e3 } })
  await ev(() => { void window.__hopper.__dialogs.publicLinks() })
  await until(() => document.querySelectorAll('.dlg li').length >= 3, null, 15000)
  await crop('f-clientlinks', '.dlg')
  await closeAll()

  // ---- Person panel with a short conversation, and an announcement banner ------------------------
  await ev(({ now, P }) => {
    const bs = String.fromCharCode(92)
    const t0 = now - 50 * 60e3
    window.__stubs['history.with'] = () => [
      { id: 'h1', dir: 'in', user: 'arun', at: t0, kind: 'request', message: 'Can you send me the latest Lot 07 isos? Back-check starts this afternoon.', files: 0, bytes: 0, via: 'direct' },
      { id: 'h2', dir: 'out', user: 'arun', at: t0 + 6 * 60e3, kind: 'files', names: ['ISO-1001_Rev0.pdf', 'ISO-1002_RevB.pdf', 'ISO-1003_Rev2.pdf', 'ISO-1004_RevA.pdf', 'ISO-1005_RevC.pdf'], files: 5, bytes: 5.4e6, message: 'Latest revisions only.', via: 'direct', replyTo: 'h1' },
      { id: 'h3', dir: 'in', user: 'arun', at: t0 + 30 * 60e3, kind: 'link', link: { path: P + bs + '02_Working' + bs + 'Lot 07', dir: true }, message: 'Mark-ups are in the lot folder.', files: 0, bytes: 0, via: 'direct' },
      { id: 'h4', dir: 'out', user: 'arun', at: t0 + 34 * 60e3, kind: 'message', message: 'Thanks, will close them out by Friday.', files: 0, bytes: 0, via: 'direct' }
    ]
  }, { now, P })
  await ev(() => { void window.__hopper.__dialogs.person('arun') })
  await until(() => document.querySelectorAll('.dlg .bubble').length >= 4, null, 15000)
  await crop('f-person', '.dlg')
  await closeAll()

  await ev(({ now }) => {
    window.__emit('announcements', [
      { id: 'a1', title: 'Server maintenance on Saturday', body: 'The project server is offline from 9:00 to 13:00. Save your work to the server by Friday evening.', level: 'important', at: now - 12 * 60e3, by: 'admin', byName: 'Office admin', read: false, acked: false }
    ])
  }, { now })
  await until(() => !!document.querySelector('.bar.important'), null, 10000)
  await crop('f-announce', '.bar.important', { pad: 10 })
  await ev(() => window.__emit('announcements', []))

  // ---- Path Copy submenu and Properties ----------------------------------------------------------
  await ev((p) => window.__hopper.panes[0].navigate(p), lot)
  await wait(1500)
  await win.locator('.pane').first().locator('.list .row').nth(2).click({ button: 'right' })
  await until(() => !!document.querySelector('.menu'))
  await win.locator('.menu').first().getByText('Path Copy', { exact: true }).hover()
  await until(() => document.querySelectorAll('.menu').length >= 2, null, 5000)
  await crop('f-pathcopy', '.menu', { pad: 20 })
  await win.keyboard.press('Escape')
  await win.keyboard.press('Escape')
  await ev(() => { if (window.__hopper.menu) window.__hopper.menu = null })

  await ev((f) => { void window.__hopper.__dialogs.properties([f]) }, join(lot, 'ISO-1003_Rev2.pdf'))
  await until(() => /Size on disk/.test(document.querySelector('.dlg')?.innerText ?? ''), null, 20000)
  await wait(500)
  await crop('f-properties', '.dlg')
  await closeAll()

  // ---- transfer queue with live-looking jobs -----------------------------------------------------
  await ev(() => {
    const now = Date.now()
    const h = window.__hopper
    h.jobs = [
      { id: 'a', kind: 'copy', title: 'Copying Lot 07 to S:\\Lots\\07', state: 'running', done: 1.42e9, total: 2.31e9, files: 214, filesTotal: 340, rate: 96e6, startedAt: now - 15e3, errors: [], current: 'ISO-1044_Rev0.pdf' },
      { id: 'b', kind: 'zip', title: 'Zipping J999 Lot 07 2026-11-10.zip', state: 'running', done: 380e6, total: 610e6, files: 90, filesTotal: 141, rate: 210e6, startedAt: now - 2e3, errors: [] },
      { id: 'c', kind: 'move', title: 'Moving 12 items to 03_Outgoing', state: 'queued', done: 0, total: 0, files: 0, filesTotal: 0, rate: 0, startedAt: now, errors: [] },
      { id: 'd', kind: 'extract', title: 'Extracting Client markups.zip', state: 'done', done: 88e6, total: 88e6, files: 46, filesTotal: 46, rate: 0, startedAt: now - 60e3, endedAt: now - 52e3, errors: [] }
    ]
    h.shares = { 's|priya': { shareId: 's', to: 'priya', state: 'sending', done: 640e6, total: 1.1e9, rate: 104e6, via: 'direct' } }
    h.drawer = true
  })
  await wait(500)
  await ev(() => { document.querySelector('.drawer').style.maxWidth = '760px' })
  await crop('f-transfers', '.drawer', { pad: 12 })
  await ev(() => { document.querySelector('.drawer').style.maxWidth = '' })
  await ev(() => { window.__hopper.drawer = false; window.__hopper.jobs = []; window.__hopper.shares = {} })

  // ---- zip presets -------------------------------------------------------------------------------
  await ev(() => { window.__hopper.panes[0].selectWhere((r) => r.ext === 'pdf'); void window.__hopper.__dialogs.zip() })
  await until(() => !!document.querySelector('.dlg'))
  await crop('f-zip', '.dlg')
  await closeAll()

  // ---- lot packager ------------------------------------------------------------------------------
  await ev(() => { void window.__hopper.__dialogs.packager(window.__hopper.panes[0].rows.filter((r) => r.ext === 'pdf').map((r) => r.path)) })
  await until(() => document.querySelector('.dlg')?.innerText?.includes('ISO-1001_Rev0'), null, 600000)
  await wait(1000)
  await crop('f-packager', '.dlg', { maxH: 560 })
  await closeAll()

  // ---- command palette ---------------------------------------------------------------------------
  await win.locator('.list').first().focus()
  await win.keyboard.press('Control+K')
  await win.keyboard.type('client')
  await crop('f-palette', '.pal', { pad: 24 })
  await win.keyboard.press('Escape')

  // ---- project folder generator ------------------------------------------------------------------
  await ev((d) => {
    try {
      localStorage.setItem('hopper.template.last', JSON.stringify('dexterity-project'))
      localStorage.setItem('hopper.template.dexterity-project', JSON.stringify({ job: 'J999', name: 'DEMO', type: 'Detail design', platform: 'S3D' }))
    } catch {}
    return window.__hopper.panes[0].navigate(d)
  }, demo)
  await wait(800)
  await ev(() => { void window.__hopper.__dialogs.template() })
  await until(() => document.querySelectorAll('.dlg .tree .node').length > 20, null, 20000)
  await wait(800)
  await crop('f-template', '.dlg', { pad: 20 })
  await closeAll()

  // ---- document viewer: a workbook in the full-window viewer -------------------------------------
  await ev(({ d, f }) => window.__hopper.panes[0].navigate(d, { select: f }), { d: join(P, '05_References'), f: join(P, '05_References', 'Line list.xlsx') })
  await wait(1500)
  await win.locator('.insp .actions button[title="View in full window"]').click()
  await until(() => !!document.querySelector('.docv') && !document.querySelector('.docv .spin') && !!document.querySelector('.docv .sheet .canvas'), null, 60000)
  await wait(1500)
  await clip('f-viewer', { x: 0, y: 0, width: 880, height: 560 })
  await win.keyboard.press('Escape')
  await until(() => !document.querySelector('.docv'), null, 5000)

  // ---- Home page and the collapsed sidebar rail ----------------------------------------------------
  await ev(({ P, lot }) => {
    // where "you" have been: demo folders only (the first start visited the real profile folders)
    const bs = String.fromCharCode(92)
    window.__hopper.updateSettings({ dual: false, inspector: false, recentFolders: [lot, P + bs + '05_References', P, 'H:' + bs + 'Site photos', P + bs + '03_Outgoing', 'H:' + bs + 'Transmittals'] })
    window.__hopper.panes[0].navigate('hopper:home')
  }, { P, lot })
  await until(() => /Jump back in/.test(document.body.innerText), null, 15000)
  await wait(1200)
  await shot('09-home')
  await clip('f-home', { x: 0, y: 0, width: 900, height: 640 })
  await ev(() => window.__hopper.updateSettings({ sidebarCollapsed: true }))
  await until(() => !!document.querySelector('.rail'), null, 5000)
  await wait(800)
  await clip('f-rail', { x: 0, y: 0, width: 760, height: 520 })
  await ev(() => window.__hopper.updateSettings({ sidebarCollapsed: false, dual: true, inspector: true }))
}
