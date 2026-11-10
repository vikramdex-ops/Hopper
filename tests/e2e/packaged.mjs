// Smoke test of the packaged build (release/win-unpacked): boots, lists a folder through the
// native helper, zips with the bundled 7-Zip and reads a PDF with the lazily loaded pdf-lib.
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeDemo, WORK } from './harness.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const exe = join(root, 'release', 'win-unpacked', 'Hopper.exe')
if (!existsSync(exe)) throw new Error('Run npm run pack first')
const demo = await makeDemo()
const userData = join(WORK, 'userdata-packaged')
rmSync(userData, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })
const t0 = Date.now()
const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox'], env: { ...process.env, HOPPER_USER_DATA: userData } })
const win = await app.firstWindow()
await win.waitForFunction(() => window.__hopper?.ready === true, null, { timeout: 120000 })
console.log('boot ms', Date.now() - t0)
await win.evaluate((p) => window.__hopper.panes[0].navigate(p), demo)
await win.waitForFunction(() => window.__hopper.panes[0].rows.length > 3, null, { timeout: 120000 })
console.log('listed', await win.evaluate(() => window.__hopper.panes[0].rows.length), 'items')
await win.evaluate((p) => window.__hopper.zip('fast', [p]), join(demo, 'Site photos'))
await win.waitForFunction(() => window.__hopper.jobs.some((j) => j.kind === 'zip' && j.state !== 'running' && j.state !== 'queued'), null, { timeout: 180000 })
const zip = await win.evaluate(() => window.__hopper.jobs.find((j) => j.kind === 'zip'))
console.log('zip', zip.state, zip.error ?? '', existsSync(join(demo, 'Site photos.zip')))
const info = await win.evaluate((p) => window.__hopper.__engine('pdf.info', p), join(demo, 'P12513 Refinery Revamp', '02_Working', 'Lot 07', 'ISO-1003_Rev2.pdf'))
console.log('pdf.info pages', info.pages)
// the viewers' parser worker and its libraries must load from inside the packaged archive
const book = await win.evaluate((p) => window.__hopper.__engine('preview.sheetBook', p), join(demo, 'P12513 Refinery Revamp', '02_Working', 'Lot 07', 'Comment register.csv'))
console.log('sheet preview sheets', book.sheets?.length ?? JSON.stringify(book).slice(0, 120))
const props = await win.evaluate((p) => window.hopper.shell.props([p]), join(demo, 'Site photos'))
console.log('props owner', props[0].owner ? 'ok' : JSON.stringify(props[0]).slice(0, 120))
// "Check now" must work in the installed app (2.0.0 shipped with the updater failing to load)
const upd = await win.evaluate(() => window.hopper.update.check())
console.log('update check', JSON.stringify(upd))
if (upd.status === 'error' && !/connection|published|busy/i.test(upd.error ?? '')) {
  console.log('UPDATE CHECK FAILED')
  process.exitCode = 1
}
const m = await app.evaluate(({ app }) => app.getAppMetrics().reduce((a, p) => a + p.memory.workingSetSize, 0))
console.log('total memory MB', Math.round(m / 1024))
await app.close()
