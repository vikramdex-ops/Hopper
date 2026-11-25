// Dexterity Share through the real app: Hopper creates a client link (zip + copy to the store),
// the share server runs locally on that store, and a "client" downloads and verifies the file.
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { userInfo } from 'node:os'
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

// A local stand-in for the office mail server: plain SMTP on loopback, keeps every message.
const smtpMails = []
const smtp = createServer((sock) => {
  let buf = ''
  let data = null
  sock.write('220 fake ESMTP\r\n')
  sock.on('data', (c) => {
    buf += c.toString('utf8')
    let i
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 2)
      if (data != null) {
        if (line === '.') {
          smtpMails.push(data)
          data = null
          sock.write('250 queued\r\n')
        } else data += line + '\r\n'
      } else if (/^EHLO/.test(line)) sock.write('250-fake\r\n250 AUTH PLAIN\r\n')
      else if (/^AUTH PLAIN /.test(line)) sock.write(Buffer.from(line.slice(11), 'base64').toString() === '\0share@office.test\0smtp pw 1' ? '235 ok\r\n' : '535 bad\r\n')
      else if (/^(MAIL FROM|RCPT TO)/.test(line)) sock.write('250 ok\r\n')
      else if (line === 'DATA') {
        data = ''
        sock.write('354 go\r\n')
      } else if (line === 'QUIT') sock.end('221 bye\r\n')
      else sock.write('502 no\r\n')
    }
  })
  sock.on('error', () => {})
})
await new Promise((r) => smtp.listen(0, '127.0.0.1', r))
const mailBody = (raw) => Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8')
const mailTo = (raw) => /^To: <([^>]+)>/m.exec(raw)?.[1]

const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const port = await freePort()
const cfg = join(base, 'server-config.json')
writeFileSync(join(base, 'mail-pass.txt'), 'smtp pw 1\n')
writeFileSync(cfg, JSON.stringify({ server: { port, store, allowedOrigins: ['https://example.test'], manifestCacheMs: 200, statsFlushMs: 500 }, mail: { host: '127.0.0.1', port: smtp.address().port, secure: 'none', user: 'share@office.test', passFile: 'mail-pass.txt', from: 'share@office.test', fromName: 'Dexterity Share' } }))
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
  if (JSON.stringify(meta).includes('Lot 07.zip') || JSON.stringify(meta).toLowerCase().includes(userInfo().username.toLowerCase() + '\\')) throw new Error('metadata leaks')
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

// ---- links for named e-mail addresses ------------------------------------------------------------
const lot = join(demo, 'P10001 Refinery Revamp', '02_Working', 'Lot 07')
let named
const post = (p, body) => fetch(`${api}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }))

await check('e-mail codes: refused while the share server has not said it can send e-mail; bad input refused', async () => {
  const tryCreate = (spec) => win.evaluate((sp) => window.__hopper.__engine('pubshare.create', sp).then(() => 'created', (e) => String(e?.message ?? e)), spec)
  const base0 = { paths: [lot], title: 'Lot 07 named', days: 3, zip: {} }
  const r1 = await tryCreate({ ...base0, recipients: ['client.pm@client-co.test'] })
  if (!/not set up on the share server/.test(r1)) throw new Error('no heartbeat: ' + r1)
  writeFileSync(join(store, '_server.json'), JSON.stringify({ v: 1, base: null, mode: 'quick', healthy: true, updated: Date.now(), mail: true }))
  const r2 = await tryCreate({ ...base0, recipients: ['client.pm@client-co.test'], password: 'secret 123' })
  if (!/either a password or e-mail codes/.test(r2)) throw new Error('password + addresses: ' + r2)
  const r3 = await tryCreate({ ...base0, recipients: ['client.pm@client-co.test', 'not-an-address'] })
  if (!/not-an-address/.test(r3)) throw new Error('bad address: ' + r3)
  const r4 = await tryCreate({ ...base0, recipients: Array.from({ length: 11 }, (_, i) => `u${i}@client-co.test`) })
  if (!/at most 10/.test(r4)) throw new Error('eleven: ' + r4)
})

await check('create-link dialog: e-mail option, address checking, link made for the listed addresses only', async () => {
  await win.evaluate((p) => void window.__hopper.__dialogs.publicLink([p]), lot)
  await win.waitForSelector('.dlg input[type=radio][value=email]:not([disabled])', { timeout: 20000 })
  await win.check('.dlg input[type=radio][value=email]')
  await win.fill('.dlg textarea[placeholder="name@client.com"]', 'Client PM <Client.PM@client-co.test>, bad@')
  await win.waitForSelector('.dlg .hint.bad')
  const bad = await win.textContent('.dlg .hint.bad')
  if (!bad.includes('bad@')) throw new Error('bad address not named: ' + bad)
  if (!(await win.isDisabled('.dlg button[type=submit]'))) throw new Error('create enabled with a bad address')
  await win.fill('.dlg textarea[placeholder="name@client.com"]', 'Client PM <Client.PM@client-co.test>\nsite.engineer@client-co.test, client.pm+lot7@client-co.test')
  await win.waitForFunction(() => /2 addresses/.test(document.querySelector('.dlg')?.innerText ?? ''))
  await win.screenshot({ path: join(base, 'dialog-email-code.png') })
  await win.click('.dlg button[type=submit]')
  await win.waitForFunction(() => /Only for:/.test(document.querySelector('.dlg')?.innerText ?? ''), null, { timeout: 180000 })
  await win.waitForFunction(() => !window.__hopper.jobs.some((j) => !['done', 'failed', 'cancelled'].includes(j.state)), null, { timeout: 180000 })
  await win.screenshot({ path: join(base, 'dialog-email-ready.png') })
  const links = (await win.evaluate(() => window.__hopper.__engine('pubshare.list', 'mine'))).filter((l) => l.recipients)
  if (links.length !== 1) throw new Error('links with recipients: ' + links.length)
  named = links[0]
  const m = JSON.parse(readFileSync(join(store, named.id, 'manifest.json'), 'utf8'))
  if (JSON.stringify(m.recipients) !== JSON.stringify(['client.pm@client-co.test', 'site.engineer@client-co.test'])) throw new Error('recipients ' + JSON.stringify(m.recipients))
  if (m.password !== null) throw new Error('password set too')
  await win.keyboard.press('Escape')
})

await check('client: someone else is refused; the listed address gets a code by real SMTP, confirms and downloads', async () => {
  const meta = await (await fetch(`${api}/api/s/${named.id}`)).json()
  if (!meta.needsEmail || meta.mailReady !== true || meta.files !== null || JSON.stringify(meta).includes('client-co')) throw new Error('meta ' + JSON.stringify(meta))
  const other = await post(`/api/s/${named.id}/code`, { email: 'colleague@client-co.test' })
  if (other.status !== 403 || other.json.error !== 'not_recipient') throw new Error('other ' + JSON.stringify(other))
  if (smtpMails.length) throw new Error('mail sent for a stranger')
  const ask = await post(`/api/s/${named.id}/code`, { email: 'CLIENT.PM@client-co.test' })
  if (ask.status !== 200) throw new Error('code ' + JSON.stringify(ask))
  if (smtpMails.length !== 1 || mailTo(smtpMails[0]) !== 'client.pm@client-co.test') throw new Error('mail ' + smtpMails.length + ' ' + mailTo(smtpMails[0] ?? ''))
  const code = /(\d{3}) (\d{3})/.exec(mailBody(smtpMails[0])).slice(1).join('')
  const v = await post(`/api/s/${named.id}/verify`, { email: 'client.pm@client-co.test', code })
  if (!v.json.token) throw new Error('verify ' + JSON.stringify(v))
  const res = await fetch(`${api}/d/${named.id}/0?t=${encodeURIComponent(v.json.token)}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const m = JSON.parse(readFileSync(join(store, named.id, 'manifest.json'), 'utf8'))
  if (!res.ok || createHash('sha256').update(buf).digest('hex') !== m.files[0].sha256) throw new Error('download ' + res.status)
  if ((await fetch(`${api}/d/${named.id}/0`)).status !== 401) throw new Error('download without a token')
})

await check('Hopper lists who confirmed and downloaded, and the refused attempt', async () => {
  await new Promise((r) => setTimeout(r, 2500))
  const l = (await win.evaluate(() => window.__hopper.__engine('pubshare.list', 'mine'))).find((x) => x.id === named.id)
  const rs = l.stats?.recipients
  if (!rs || rs[0].downloads !== 1 || !rs[0].verifiedAt || rs[1].codesSent !== 0 || l.stats.refused !== 1) throw new Error('stats ' + JSON.stringify(l.stats))
  await win.evaluate(() => void window.__hopper.__dialogs.publicLinks())
  await win.waitForFunction(() => /attempts? by other address/.test(document.querySelector('.dlg')?.innerText ?? ''), null, { timeout: 20000 })
  await win.screenshot({ path: join(base, 'dialog-links-email.png') })
})

await app.close()
smtp.close()
server.kill()
console.log(ok ? '\nDexterity Share app test passed' : '\nDexterity Share app test FAILED')
process.exit(ok ? 0 : 1)
