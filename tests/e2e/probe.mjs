// Ad-hoc probe: calls package.plan in the running app and prints the result and timing.
import { join } from 'node:path'
import { launch, makeDemo, WORK } from './harness.mjs'

const demo = await makeDemo()
const { app, win } = await launch({ userData: join(WORK, 'userdata-probe') })
win.on('pageerror', (e) => console.log('[pageerror]', e.message))
import { execFileSync } from 'node:child_process'
execFileSync('subst', ['H:', demo])
process.on('exit', () => { try { execFileSync('subst', ['H:', '/D']) } catch {} })
const lot = join('H:' + String.fromCharCode(92), 'P10001 Refinery Revamp', '02_Working', 'Lot 07')
const files = ['ISO-1001_Rev0.pdf', 'ISO-1001_RevA.pdf', 'ISO-1003_Rev2.pdf'].map((f) => join(lot, f))
win.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 300)))
await win.evaluate((files) => { void window.__hopper.__dialogs.packager(files) }, files)
for (const ms of [3000, 8000, 20000]) {
  await win.waitForTimeout(ms)
  console.log(ms, (await win.evaluate(() => document.querySelector('.dlg')?.innerText ?? 'no dialog')).replace(/\s+/g, ' ').slice(0, 400))
}
await app.close()
