// Screenshot studio for the README and the landing page: boots the real app with a demo
// project and captures genuine UI states at 1600x960. Colleagues, jobs and shares in the shots are
// demo data injected into the UI state; everything else is the live app.
import { mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { launch, makeDemo, WORK } from './harness.mjs'

const out = join(WORK, 'shots-site')
mkdirSync(out, { recursive: true })
await makeDemo()
// Show the demo as its own drive (H:) so no real paths or office shares appear in public images.
const DRIVE = 'H:'
const demo = 'H:\\'
if (existsSync(demo)) throw new Error(`${DRIVE} is already in use; pick another letter in shots.mjs`)
execFileSync('subst', [DRIVE, join(WORK, 'demo')])
process.on('exit', () => {
  try {
    execFileSync('subst', [DRIVE, '/D'])
  } catch {}
})
const { app, win } = await launch({ env: { HOPPER_SHOTS: '1' } })
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.setContentSize(1600, 960)
  w.center()
})
const ev = (fn, arg) => win.evaluate(fn, arg)
const wait = (ms) => win.waitForTimeout(ms)
let demoPeople = null
const shot = async (name) => {
  // The LAN process keeps publishing the real (empty) people list; put the demo back.
  if (demoPeople) await ev((d) => { window.__hopper.peers = d.peers; window.__hopper.lanStatus = { ready: true, enabled: true } }, demoPeople)
  await wait(700)
  await win.screenshot({ path: join(out, `${name}.png`) })
  console.log('  shot', name)
}
const lot = join(demo, 'P12513 Refinery Revamp', '02_Working', 'Lot 07')

// Demo colleagues and activity (presentational only).
const P = String.raw`H:\P12513 Refinery Revamp`
await ev(({ P }) => {
  const now = Date.now()
  const h = window.__hopper
  h.peers = [
    { id: 'p1', user: 'arun', displayName: 'Arun Kumar', host: 'WS-012', address: '', port: 0, version: '2.0.0', status: 'online', lastSeen: now },
    { id: 'p2', user: 'priya', displayName: 'Priya Raman', host: 'WS-021', address: '', port: 0, version: '2.0.0', status: 'online', lastSeen: now },
    { id: 'p3', user: 'ravi', displayName: 'Ravi Shankar', host: 'WS-007', address: '', port: 0, version: '2.0.0', status: 'busy', lastSeen: now },
    { id: 'p4', user: 'meena', displayName: 'Meena Iyer', host: 'WS-030', address: '', port: 0, version: '2.0.0', status: 'away', lastSeen: now },
    { id: 'p5', user: 'suresh', displayName: 'Suresh Babu', host: 'WS-015', address: '', port: 0, version: '2.0.0', status: 'offline', lastSeen: now - 3600e3 }
  ]
  h.groups = [{ id: 'piping', name: 'Piping team', members: ['arun', 'priya', 'ravi'] }]
  // Demo drives only: never the real machine's shares.
  h.freezeDrives = true
  const bs = String.fromCharCode(92)
  h.drives = [
    { root: 'C:' + bs, label: 'Windows', kind: 'fixed', total: 512e9, free: 201e9, ready: true },
    { root: 'H:' + bs, label: 'Projects', kind: 'fixed', total: 2e12, free: 1.34e12, ready: true },
    { root: 'S:' + bs, label: 'Office server', kind: 'network', total: 8e12, free: 3.1e12, ready: true, remote: bs + bs + 'fileserver' + bs + 'projects' }
  ]
  h.info.home = P
  h.info.desktop = h.info.downloads = h.info.documents = h.info.pictures = ''
  h.lanStatus = { ready: true, enabled: true }
  h.updateSettings({ profile: { displayName: 'Asha', email: '', status: 'online' }, pinned: [P, 'H:' + bs + 'Site photos', 'H:' + bs + 'Transmittals'], quickDests: [], officeConfigPath: 'S:' + bs + '_Hopper' + bs + 'office.json' })
}, { P })
demoPeople = { peers: await ev(() => window.__hopper.peers) }

await ev(({ lot, demo }) => {
  const h = window.__hopper
  h.updateSettings({ dual: true, inspector: true, theme: 'light', columns: h.settings.columns.map((c) => (c.id === 'rev' ? { ...c, visible: true } : c)) })
  void h.panes[0].navigate(lot, { select: lot + '\\ISO-1003_Rev2.pdf' })
  void h.panes[1].navigate(demo + 'P12513 Refinery Revamp')
  h.drawer = false
}, { lot, demo })
await wait(2000)
await win.waitForFunction(() => !!document.querySelector('.insp canvas') && !document.querySelector('.insp .spin'), null, { timeout: 300000 })
await wait(1500)
await shot('01-workspace-light')

await ev(() => window.__hopper.updateSettings({ theme: 'dark' }))
await wait(1500)
await shot('02-workspace-dark')
await ev(() => window.__hopper.updateSettings({ theme: 'light' }))

// Share with @mentions
await ev(() => {
  const p = window.__hopper.panes[0]
  p.selectWhere((r) => /ISO-100[1-3]/.test(r.name))
  window.__hopper.__dialogs.share(['arun', 'group:piping'])
})
await wait(900)
await win.keyboard.type('@pri')
await shot('03-share-mention')
await win.keyboard.press('Escape')

// Transfer queue with live-looking jobs
await ev(() => {
  const now = Date.now()
  const h = window.__hopper
  h.jobs = [
    { id: 'a', kind: 'copy', title: 'Copying Lot 07 to U:\\Lots\\07', state: 'running', done: 1.42e9, total: 2.31e9, files: 214, filesTotal: 340, rate: 96e6, startedAt: now - 15e3, errors: [], current: 'ISO-1044_Rev0.pdf' },
    { id: 'b', kind: 'zip', title: 'Zipping P12513 Lot 07 2026-11-05.zip', state: 'running', done: 380e6, total: 610e6, files: 90, filesTotal: 141, rate: 210e6, startedAt: now - 2e3, errors: [] },
    { id: 'c', kind: 'move', title: 'Moving 12 items to 03_Outgoing', state: 'queued', done: 0, total: 0, files: 0, filesTotal: 0, rate: 0, startedAt: now, errors: [] },
    { id: 'd', kind: 'extract', title: 'Extracting Client markups.zip', state: 'done', done: 88e6, total: 88e6, files: 46, filesTotal: 46, rate: 0, startedAt: now - 60e3, endedAt: now - 52e3, errors: [] }
  ]
  h.shares = { 's|priya': { shareId: 's', to: 'priya', state: 'sending', done: 640e6, total: 1.1e9, rate: 104e6, via: 'direct' } }
  h.drawer = true
})
await shot('04-transfers')
await ev(() => { window.__hopper.drawer = false; window.__hopper.jobs = []; window.__hopper.shares = {} })

// Zip presets
await ev(() => { void window.__hopper.__dialogs.zip() })
await shot('05-zip')
await win.keyboard.press('Escape')

// Lot packager
await ev(() => { void window.__hopper.__dialogs.packager(window.__hopper.panes[0].rows.filter((r) => r.ext === 'pdf').map((r) => r.path)) })
await win.waitForFunction(() => document.querySelector('.dlg')?.innerText?.includes('ISO-1001_Rev0'), null, { timeout: 600000 })
await wait(1000)
await shot('06-packager')
await ev(() => window.__hopper.dialogs.slice().forEach((d) => window.__hopper.closeDialog(d.id)))

// Revisions grouped
await ev(() => window.__hopper.updateSettings({ groupRevisions: true }))
await shot('07-revisions')
await ev(() => window.__hopper.updateSettings({ groupRevisions: false }))

// Command palette
await win.locator('.list').first().focus()
await win.keyboard.press('Control+K')
await win.keyboard.type('zip')
await shot('08-palette')
await win.keyboard.press('Escape')

// Home
await ev(() => { window.__hopper.panes[0].navigate('hopper:home'); window.__hopper.updateSettings({ dual: false }) })
await shot('09-home')

// Thumbnails
await ev((d) => { window.__hopper.panes[0].navigate(d); window.__hopper.panes[0].view = 'grid' }, join(demo, 'Site photos'))
await wait(2500)
await shot('10-thumbnails')
await ev(() => { window.__hopper.panes[0].view = 'details'; window.__hopper.updateSettings({ dual: true }) })

// Settings > Office
await ev(() => { void window.__hopper.__dialogs.settings('office') })
await shot('11-settings-office')
await ev(() => window.__hopper.dialogs.slice().forEach((d) => window.__hopper.closeDialog(d.id)))

await app.close()
console.log('done:', out)
