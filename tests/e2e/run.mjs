// End-to-end smoke suite: drives the real app and checks the core flows actually work.
// Usage: npm run build && npm run e2e
import { existsSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { launch, makeDemo, WORK } from './harness.mjs'

const shots = join(WORK, 'shots')
mkdirSync(shots, { recursive: true })
const results = []
const errors = []

const demo = await makeDemo()
const { app, win } = await launch()
let current = 'boot'
win.on('console', (m) => m.type() === 'error' && errors.push(`[${current}] ${m.text()} @ ${m.location().url?.split('/').pop()}:${m.location().lineNumber}`))
win.on('pageerror', (e) => errors.push(`[${current}] ${String(e.stack ?? e).split(/\r?\n/).slice(0, 6).join(' <- ')}`))

const step = async (name, fn) => {
  current = name
  const t = Date.now()
  try {
    await fn()
    results.push({ name, ok: true, ms: Date.now() - t })
    console.log(`  ok  ${name} (${Date.now() - t} ms)`)
  } catch (e) {
    results.push({ name, ok: false, error: String(e?.message ?? e) })
    console.log(`  FAIL ${name}: ${e?.message ?? e}`)
    await win.screenshot({ path: join(shots, `fail-${name.replace(/\W+/g, '-')}.png`) }).catch(() => {})
  }
}
const ev = (fn, arg) => win.evaluate(fn, arg)
const until = async (fn, arg, ms = 30000) => win.waitForFunction(fn, arg, { timeout: ms })
const engine = (method, ...args) => ev(({ method, args }) => window.__hopper.__engine(method, ...args), { method, args })

await step('boot shows two panes', async () => {
  await until(() => document.querySelectorAll('.pane').length === 2)
})

await step('navigate to demo folder', async () => {
  await ev((p) => window.__hopper.panes[0].navigate(p), demo)
  await until(() => window.__hopper.panes[0].rows.length >= 4)
})

await step('listing has attributes and sizes', async () => {
  const rows = await ev(() => window.__hopper.panes[0].rows.map((r) => ({ n: r.name, d: r.dir })))
  if (!rows.some((r) => r.n === 'Site photos' && r.d)) throw new Error('missing Site photos folder')
})

await step('open nested folder and back', async () => {
  await ev((p) => window.__hopper.panes[0].navigate(p + '\\P12513 Refinery Revamp\\02_Working\\Lot 07'), demo)
  await until(() => window.__hopper.panes[0].rows.some((r) => r.name.startsWith('ISO-1001')))
  await win.screenshot({ path: join(shots, '01-lot.png') })
  await ev(() => window.__hopper.panes[0].back())
  await until(() => window.__hopper.panes[0].path.endsWith('demo'))
})

await step('revision grouping hides older revisions', async () => {
  await ev((p) => window.__hopper.panes[0].navigate(p + '\\P12513 Refinery Revamp\\02_Working\\Lot 07'), demo)
  await ev(() => window.__hopper.updateSettings({ groupRevisions: true }))
  const names = await ev(() => window.__hopper.panes[0].rows.map((r) => r.name))
  await ev(() => window.__hopper.updateSettings({ groupRevisions: false }))
  if (names.includes('ISO-1003_Rev0.pdf')) throw new Error('older numeric revision still shown: ' + names.join(','))
  if (!names.includes('ISO-1003_Rev2.pdf')) throw new Error('latest revision missing')
  if (!names.includes('ISO-1001_RevA.pdf') && !names.includes('ISO-1001_Rev0.pdf')) throw new Error('mixed-order group lost files')
})

await step('copy folder to other pane (real folder copy)', async () => {
  const dest = join(WORK, 'copy-dest')
  mkdirSync(dest, { recursive: true })
  await ev((p) => window.__hopper.panes[1].navigate(p), dest)
  await ev(({ src, dest }) => window.__hopper.transfer('copy', [src], dest, { policy: 'overwrite' }), { src: join(demo, 'Site photos'), dest })
  await until(() => window.__hopper.jobs.some((j) => j.kind === 'copy' && j.state === 'done'), null, 60000)
  if (!existsSync(join(dest, 'Site photos', 'IMG_2040.png'))) throw new Error('folder contents not copied')
})

await step('zip here with fast preset', async () => {
  await ev((p) => window.__hopper.panes[0].navigate(p), demo)
  await ev((p) => window.__hopper.zip('fast', [p]), join(demo, 'Site photos'))
  await until(() => window.__hopper.jobs.some((j) => j.kind === 'zip' && j.state === 'done'), null, 60000)
  if (!existsSync(join(demo, 'Site photos.zip'))) throw new Error('zip not created')
})

await step('browse inside zip', async () => {
  await ev((p) => window.__hopper.panes[0].navigate(p + '::'), join(demo, 'Site photos.zip'))
  await until(() => window.__hopper.panes[0].rows.length > 0)
  await win.screenshot({ path: join(shots, '02-zip-browse.png') })
})

await step('smart extract', async () => {
  await ev((p) => window.__hopper.panes[0].navigate(p), demo)
  const out = join(WORK, 'extract-dest')
  mkdirSync(out, { recursive: true })
  await ev(({ f, out }) => window.__hopper.extract('smart', out, [f]), { f: join(demo, 'Site photos.zip'), out })
  await until(() => window.__hopper.jobs.some((j) => j.kind === 'extract' && j.state === 'done'), null, 60000)
  // one top-level folder -> no "Site photos/Site photos" nesting
  if (!existsSync(join(out, 'Site photos', 'IMG_2041.png'))) throw new Error('unexpected layout: ' + readdirSync(out).join(','))
})

await step('rename + undo', async () => {
  const p = join(demo, 'Transmittals', 'TR-0041.json')
  await ev((d) => window.__hopper.panes[0].navigate(d), join(demo, 'Transmittals'))
  await ev(async (path) => {
    const e = window.__hopper.panes[0].rows.find((r) => r.path === path)
    await window.__hopper.rename(e, 'TR-0041-renamed.json')
  }, p)
  if (!existsSync(join(demo, 'Transmittals', 'TR-0041-renamed.json'))) throw new Error('rename failed')
  await ev(() => window.__hopper.undo())
  await until((path) => window.__hopper.panes[0].rows.some((r) => r.path === path), p)
})

await step('new folder does not clobber', async () => {
  await ev(() => window.__hopper.newFolder())
  await ev(() => window.__hopper.newFolder())
  await until(() => window.__hopper.panes[0].rows.filter((r) => r.name.startsWith('New folder')).length === 2)
  await win.keyboard.press('Escape')
})

await step('preview pane renders a PDF', async () => {
  await ev((d) => window.__hopper.panes[0].navigate(d, { select: d + '\\ISO-1003_Rev2.pdf' }), join(demo, 'P12513 Refinery Revamp', '02_Working', 'Lot 07'))
  await until(() => !!document.querySelector('.insp canvas, .insp .pdf'), null, 30000)
  await win.waitForTimeout(800)
  await win.screenshot({ path: join(shots, '03-preview-pdf.png') })
})

await step('grid view thumbnails', async () => {
  await ev((d) => window.__hopper.panes[0].navigate(d), join(demo, 'Site photos'))
  await ev(() => (window.__hopper.panes[0].view = 'grid'))
  await win.waitForTimeout(1500)
  await win.screenshot({ path: join(shots, '04-grid.png') })
  await ev(() => (window.__hopper.panes[0].view = 'details'))
})

await step('command palette opens', async () => {
  await win.locator('.list').first().focus()
  await win.keyboard.press('Control+K')
  await until(() => !!document.querySelector('.pal'))
  await win.keyboard.type('zip')
  await win.screenshot({ path: join(shots, '05-palette.png') })
  await win.keyboard.press('Escape')
})

await step('context menu on a file', async () => {
  const row = win.locator('.list .row').first()
  await row.click({ button: 'right' })
  await until(() => !!document.querySelector('.menu'))
  await win.screenshot({ path: join(shots, '06-context.png') })
  await win.keyboard.press('Escape')
})

for (const [name, arg] of [['settings'], ['settings', 'sharing'], ['settings', 'office'], ['shortcuts'], ['share'], ['copyTo'], ['zip'], ['massRename'], ['folderSize'], ['checksum'], ['selectPattern'], ['template'], ['packager'], ['pdf'], ['dupes'], ['compare'], ['workspaces'], ['undoHistory'], ['people'], ['publicLink'], ['publicLinks'], ['announcements']]) {
  await step(`dialog ${name}${arg ? ` (${arg})` : ''} opens`, async () => {
    const lot = join(demo, 'P12513 Refinery Revamp', '02_Working', 'Lot 07')
    await ev(({ d }) => window.__hopper.panes[0].navigate(d), { d: lot })
    await ev(() => { const p = window.__hopper.panes[0]; p.selectWhere((r) => r.ext === 'pdf') ; p.focus = p.rows.findIndex((r) => r.ext === 'pdf') })
    await ev(({ name, arg }) => { void window.__hopper.__dialogs[name](...(arg ? [arg] : [])) }, { name, arg })
    await until(() => !!document.querySelector('.dlg'), null, 20000)
    await win.waitForTimeout(700)
    await win.screenshot({ path: join(shots, `dlg-${name}${arg ? '-' + arg : ''}.png`) })
    await win.keyboard.press('Escape')
    await until(() => !document.querySelector('.dlg'), null, 5000).catch(async () => {
      // dialogs with unsaved-change prompts: close everything
      await ev(() => window.__hopper.dialogs.slice().reverse().forEach((d) => window.__hopper.closeDialog(d.id)))
    })
  })
}

await step('properties is Hopper\'s own window with size on disk', async () => {
  const f = join(demo, 'P12513 Refinery Revamp', '02_Working', 'Lot 07', 'ISO-1003_Rev2.pdf')
  await ev((f) => { void window.__hopper.__dialogs.properties([f]) }, f)
  await until(() => /Size on disk\s+4\.0 KB/.test(document.querySelector('.dlg')?.innerText ?? ''), null, 20000)
  await win.screenshot({ path: join(shots, 'dlg-properties.png') })
  await win.keyboard.press('Escape')
  // a folder: totals are counted by the engine
  await ev((d) => { void window.__hopper.__dialogs.properties([d]) }, join(demo, 'Site photos'))
  await until(() => /Contains\s*\n?\s*[1-9]\d* files/.test(document.querySelector('.dlg')?.innerText ?? ''), null, 30000)
  await win.screenshot({ path: join(shots, 'dlg-properties-folder.png') })
  await win.keyboard.press('Escape')
  await until(() => !document.querySelector('.dlg'), null, 5000)
})

await step('open with lists apps without Explorer', async () => {
  const f = join(demo, 'P12513 Refinery Revamp', 'README.txt')
  await ev((f) => { void window.__hopper.__dialogs.openWith({ name: 'README.txt', path: f, ext: 'txt', dir: false }) }, f)
  await until(() => document.querySelectorAll('.dlg .app').length > 0, null, 20000)
  await win.screenshot({ path: join(shots, 'dlg-openwith.png') })
  await win.keyboard.press('Escape')
  await until(() => !document.querySelector('.dlg'), null, 5000)
})

await step('folder picker is Hopper\'s own', async () => {
  await ev((d) => { void window.__hopper.__dialogs.pickFolder({ title: 'Choose a folder', mode: 'folder', start: d }) }, demo)
  await until(() => document.querySelectorAll('.dlg .item').length > 2, null, 20000)
  await win.screenshot({ path: join(shots, 'dlg-picker.png') })
  await win.keyboard.press('Escape')
  await until(() => !document.querySelector('.dlg'), null, 5000)
})

await step('path copy forms', async () => {
  const f = join(demo, 'Site photos', 'IMG_2040.png')
  const r = await ev(async (f) => {
    const o = {}
    for (const m of ['name', 'path', 'parent', 'unc', 'uncParent', 'internet', 'samba']) o[m] = await window.__hopper.__formatPath(f, m)
    return o
  }, f)
  console.log('     ', JSON.stringify(r))
  if (r.name !== 'IMG_2040.png') throw new Error('name ' + r.name)
  if (r.path !== f) throw new Error('path ' + r.path)
  if (!r.unc.startsWith('\\\\') || !r.unc.endsWith('\\Site photos\\IMG_2040.png')) throw new Error('unc ' + r.unc)
  if (!r.uncParent.endsWith('\\Site photos')) throw new Error('uncParent ' + r.uncParent)
  if (!/^file:\/\/[^/]/.test(r.internet) || !r.internet.endsWith('/Site%20photos/IMG_2040.png')) throw new Error('internet ' + r.internet)
  if (!r.samba.startsWith('smb://') || r.samba.includes('\\')) throw new Error('samba ' + r.samba)
})

await step('context menu has Path Copy and no Explorer hand-off', async () => {
  await ev((d) => window.__hopper.panes[0].navigate(d), join(demo, 'Site photos'))
  await win.locator('.pane').first().locator('.list .row').first().click({ button: 'right' })
  await until(() => !!document.querySelector('.menu'))
  const text = await ev(() => document.querySelector('.menu').innerText)
  await win.keyboard.press('Escape')
  if (!/Path Copy/.test(text)) throw new Error('no Path Copy: ' + text)
  if (/Show more options|Explorer/.test(text)) throw new Error('Explorer item still present')
})

await step('last tab cannot be closed; home is a start page', async () => {
  const n = await ev(() => { const p = window.__hopper.panes[0]; while (p.tabs.length > 1) p.closeTab(); p.closeTab(); return p.tabs.length })
  if (n !== 1) throw new Error('tabs ' + n)
  const path = await ev(() => window.__hopper.panes[0].path)
  if (path.startsWith('hopper:home')) throw new Error('closing the last tab jumped to Home')
  await ev(() => window.__hopper.panes[1].navigate('hopper:home'))
  await until(() => /Jump back in/.test(document.body.innerText))
  await win.screenshot({ path: join(shots, '07-home.png') })
})

await step('memory stays reasonable', async () => {
  const m = await app.evaluate(async ({ app }) => app.getAppMetrics().map((p) => ({ type: p.type, name: p.name ?? p.serviceName ?? '', kb: p.memory.workingSetSize })))
  const total = m.reduce((a, p) => a + p.kb, 0)
  console.log('     memory by process:', m.map((p) => `${p.type}${p.name ? `(${p.name})` : ''}=${Math.round(p.kb / 1024)}MB`).join(' '), `total=${Math.round(total / 1024)}MB`)
})

await step('no console errors', async () => {
  const real = errors.filter((e) => !/favicon|Autofill|DevTools/.test(e))
  if (real.length) throw new Error(real.slice(0, 5).join(' | '))
})

await app.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${shots}`)
process.exit(failed.length ? 1 : 0)
