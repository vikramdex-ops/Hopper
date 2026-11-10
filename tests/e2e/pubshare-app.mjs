// Dexterity Share through the real app: Hopper creates a client link (zip + copy to the store),
// the share server runs locally on that store, and a "client" downloads and verifies the file.
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { launch, makeDemo, WORK } from './harness.mjs'

const base = join(WORK, 'pubshare-app')
rmSync(base, { recursive: true, force: true })
const store = join(base, 'PublicShares')
mkdirSync(store, { recursive: true })
const officeFile = join(base, 'office.json')
writeFileSync(officeFile, JSON.stringify({ officeName: 'Test office', officeKey: randomBytes(32).toString('hex'), admins: [(process.env.USERNAME || '').toLowerCase()], publicShare: { enabled: true, store, pageUrl: 'https://example.test/share/', defaultDays: 7 } }))
const userData = join(base, 'userdata')
mkdirSync(userData, { recursive: true })
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ officeConfigPath: officeFile, lan: { enabled: false, acceptFrom: 'all', blocked: [], askFor: [] } }))

const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const port = await freePort()
const cfg = join(base, 'server-config.json')
writeFileSync(cfg, JSON.stringify({ server: { port, store, allowedOrigins: ['https://example.test'] } }))
const server = spawn(process.execPath, ['--no-warnings', join(process.cwd(), 'server', 'dexterity-share', 'server.mjs')], { env: { ...process.env, DXSHARE_CONFIG: cfg }, stdio: 'ignore' })
process.on('exit', () => server.kill())

const demo = await makeDemo()
const { app, win } = await launch({ userData, fresh: false })
let ok = true
const check = async (name, fn) => {
  try {
    await fn()
    console.log('  ok ', name)
  } catch (e) {
    ok = false
    console.log('  FAIL', name, '-', e.message)
  }
}
const api = `http://127.0.0.1:${port}`
let created

await check('Hopper creates a link for a folder (zipped) with a password', async () => {
  created = await win.evaluate((p) => window.__hopper.__engine('pubshare.create', { paths: [p], title: 'Lot 07 isometrics', message: 'For review', days: 3, password: 'correct horse 42', zip: {} }), join(demo, 'P10001 Refinery Revamp', '02_Working', 'Lot 07'))
  await win.waitForFunction((id) => window.__hopper.jobs.some((j) => j.id === id && ['done', 'failed', 'cancelled'].includes(j.state)), created.jobId, { timeout: 180000 })
  const job = await win.evaluate((id) => window.__hopper.jobs.find((j) => j.id === id), created.jobId)
  if (job.state !== 'done') throw new Error(`job ${job.state}: ${job.error}`)
  if (!existsSync(join(store, created.id, 'manifest.json'))) throw new Error('no manifest in store')
  if (!created.url.startsWith('https://example.test/share/#' + created.id)) throw new Error('url ' + created.url)
  const days = Math.round((created.expiresAt - Date.now()) / 86400000)
  if (days !== 3) throw new Error('expiry days ' + days)
})

await check('client: metadata hides names until unlocked, wrong password refused', async () => {
  const meta = await (await fetch(`${api}/api/s/${created.id}`)).json()
  if (!meta.needsPassword) throw new Error('not protected: ' + JSON.stringify(meta))
  if (JSON.stringify(meta).includes('Lot 07.zip') || JSON.stringify(meta).toLowerCase().includes('asha\\')) throw new Error('metadata leaks')
  const bad = await fetch(`${api}/api/s/${created.id}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) })
  if (bad.ok) throw new Error('wrong password accepted')
})

await check('client: unlock, download and verify SHA-256 against the manifest', async () => {
  const un = await (await fetch(`${api}/api/s/${created.id}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse 42' }) })).json()
  const token = un.token
  if (!token) throw new Error('no token: ' + JSON.stringify(un))
  const meta = await (await fetch(`${api}/api/s/${created.id}?t=${encodeURIComponent(token)}`, { headers: { authorization: `Bearer ${token}` } })).json()
  const manifest = JSON.parse(readFileSync(join(store, created.id, 'manifest.json'), 'utf8'))
  const res = await fetch(`${api}/d/${created.id}/0?t=${encodeURIComponent(token)}`)
  if (!res.ok) throw new Error('download ' + res.status)
  const buf = Buffer.from(await res.arrayBuffer())
  const sha = createHash('sha256').update(buf).digest('hex')
  if (sha !== manifest.files[0].sha256) throw new Error('sha mismatch')
  if (buf.subarray(0, 2).toString() !== 'PK') throw new Error('not a zip')
  console.log(`       ${manifest.files[0].name} ${buf.length} bytes, sha256 ok; meta files: ${meta.files?.length ?? '?'}`)
})

await check('Hopper lists the link with a download count, then revokes it', async () => {
  await new Promise((r) => setTimeout(r, 6000))
  const list = await win.evaluate(() => window.__hopper.__engine('pubshare.list', 'mine'))
  const mine = list.find((l) => l.id === created.id)
  if (!mine) throw new Error('not listed')
  console.log('       listed:', JSON.stringify({ title: mine.title, downloads: mine.downloads ?? mine.stats?.downloads, expiresAt: mine.expiresAt }))
  await win.evaluate((id) => window.__hopper.__engine('pubshare.revoke', id), created.id)
  const gone = await fetch(`${api}/api/s/${created.id}`)
  if (gone.ok) throw new Error('still reachable after revoke')
})

await app.close()
server.kill()
console.log(ok ? '\nDexterity Share app test passed' : '\nDexterity Share app test FAILED')
process.exit(ok ? 0 : 1)
