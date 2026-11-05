// Ad-hoc probe: boots the app, opens a folder, prints console errors with stacks.
import { join } from 'node:path'
import { launch, makeDemo } from './harness.mjs'

const demo = await makeDemo()
const tl = Date.now()
const { app, win } = await launch()
console.log('launch ms', Date.now() - tl)
app.process().stdout.on('data', (d) => process.stdout.write(`[main +${Date.now() - tl}] ${d}`))
app.process().stderr.on('data', (d) => process.stdout.write(`[main-err +${Date.now() - tl}] ${d}`))
win.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text(), JSON.stringify(m.location()))
})
win.on('pageerror', (e) => console.log('[pageerror]', e.stack))
const t0 = Date.now()
console.log('engine ping ms', await win.evaluate(async () => { const t = performance.now(); await window.__hopper.__engine('ping'); return Math.round(performance.now() - t) }), 'wall', Date.now() - t0)
const t = Date.now()
await win.evaluate((p) => window.__hopper.panes[0].navigate(p), demo)
console.log('first navigate ms', Date.now() - t)
const lot = join(demo, 'P12513 Refinery Revamp', '02_Working', 'Lot 07')
await win.evaluate(({ d, f }) => window.__hopper.panes[0].navigate(d, { select: f }), { d: lot, f: join(lot, 'ISO-1003_Rev2.pdf') })
await win.waitForTimeout(6000)
const m = await app.evaluate(({ app }) => app.getAppMetrics().map((p) => `${p.type}${p.serviceName ? `(${p.serviceName})` : ''}=${Math.round(p.memory.workingSetSize / 1024)}MB`))
console.log(m.join(' '))
await app.close()
