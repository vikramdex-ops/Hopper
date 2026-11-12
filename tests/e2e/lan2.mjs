// LAN features beyond file sharing, end to end in Electron: three Hopper instances on this PC
// (asha = office admin, bob = colleague, carol = a PC that has no office key yet).
// Covers admin-only office config, the Person panel, messages and folder links (direct and
// through the server inbox), announcements (online, picked up after being off, acknowledged),
// joining by pasted key and joining from an admin's LAN invite.
//
// It runs its own build so it never collides with other runs:
//   npx electron-vite build --outDir <work-folder>\_Claude_Work\temp\lan2-agent\app\out
//   node tests/e2e/lan2.mjs
// HOPPER_LAN2_WORK moves the work folder; nothing is written to C:.
import { _electron as electron } from 'playwright-core'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASE = process.env.HOPPER_LAN2_WORK || '<work-folder>\\_Claude_Work\\temp\\lan2-agent'
const APP = join(BASE, 'app')
const WORK = join(BASE, 'e2e')
const SHOTS = join(BASE, 'shots')
const require = createRequire(join(root, 'package.json'))

if (!existsSync(join(APP, 'out', 'main', 'index.js'))) throw new Error(`Build first: npx electron-vite build --outDir ${join(APP, 'out')}`)

// A minimal app folder around the private build: package.json, plus the helper, 7-Zip and icon
// that main looks for next to it. Modules resolve from the repo through NODE_PATH.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
writeFileSync(join(APP, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, main: 'out/main/index.js' }, null, 1))
for (const dir of [['native', 'bin'], ['vendor', '7zip'], ['build']]) {
  const from = join(root, ...dir)
  if (existsSync(from)) cpSync(from, join(APP, ...dir), { recursive: true, force: true })
}

rmSync(WORK, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })
const officeDir = join(WORK, 'office')
const office = join(officeDir, 'office.json')
const serverInbox = join(officeDir, 'Inbox')
const KEY = randomBytes(32).toString('hex')
const FP = createHash('sha256').update(Buffer.from(KEY, 'hex')).digest('hex').slice(0, 8)
mkdirSync(serverInbox, { recursive: true })
// set up on another PC: both test users run on this one, so bob is not the setup PC and asha is a standing admin
const SETUP = { user: 'asha', pc: 'OTHER-PC', at: 1 }
const officeCfg = { officeName: 'Test office', officeKey: KEY, serverInbox, cliq: { enabled: false, endpoint: '', zapikey: '' }, groups: [], admins: ['asha'], announcers: [], setup: SETUP }
writeFileSync(office, JSON.stringify(officeCfg))

// something to browse, select and link to
const project = join(WORK, 'files', 'P10001 Refinery Revamp')
mkdirSync(join(project, 'Lot 07'), { recursive: true })
for (const n of ['ISO-1001_RevA.txt', 'ISO-1002_RevB.txt', 'Comment register.csv']) writeFileSync(join(project, 'Lot 07', n), `${n}\n`.repeat(40))

const people = {}
async function start(user, name, configPath) {
  const userData = join(WORK, `data-${user}`)
  const fresh = !existsSync(userData)
  mkdirSync(userData, { recursive: true })
  const inboxDir = join(WORK, `inbox-${user}`)
  if (fresh) {
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({ officeConfigPath: configPath, inboxDir, theme: 'light', profile: { displayName: name, email: '', status: 'online' } }))
  }
  const temp = join(WORK, 'tmp')
  mkdirSync(temp, { recursive: true })
  const app = await electron.launch({
    // launching Electron off the U: share can take minutes when the share is slow
    timeout: 180000,
    executablePath: require('electron'),
    // Chromium's sandbox can't start child processes from an exe on a network share (U:).
    args: [APP, '--no-sandbox'],
    cwd: APP,
    env: { ...process.env, NODE_PATH: join(root, 'node_modules'), HOPPER_USER_DATA: userData, HOPPER_LAN_USER: user, TEMP: temp, TMP: temp }
  })
  const win = await app.firstWindow()
  await win.waitForFunction(() => window.__hopper?.ready === true && !!window.__hopperLan, null, { timeout: 90000 })
  await win.setViewportSize({ width: 1280, height: 800 }).catch(() => {})
  people[user] = { app, win, inboxDir, name }
  return people[user]
}

const ev = (who, fn, arg) => people[who].win.evaluate(fn, arg)
const until = (who, fn, arg, ms = 60000) => people[who].win.waitForFunction(fn, arg, { timeout: ms })
const shot = (who, name) => people[who].win.screenshot({ path: join(SHOTS, `${name}.png`) })
const esc = async (who) => {
  const w = people[who].win
  for (let i = 0; i < 6 && (await w.locator('[role=dialog]').count()); i++) {
    // Esc only reaches a dialog that has the focus; its close button always works
    if (i % 2 === 0) await w.keyboard.press('Escape')
    else await w.locator('[role=dialog] header button[aria-label=Close]').last().click({ timeout: 2000 }).catch(() => {})
    await w.waitForTimeout(250)
  }
  if (await w.locator('[role=dialog]').count()) throw new Error(`${who}: a dialog would not close`)
}
const openOffice = async (who) => {
  const w = people[who].win
  await esc(who)
  await w.keyboard.press('Control+,')
  await w.locator('[role=dialog] nav button', { hasText: 'Office' }).click()
  await w.waitForTimeout(600)
}

const results = []
let ok = true
const check = async (name, fn) => {
  const t = Date.now()
  try {
    await fn()
    results.push(`  ok   ${name} (${Date.now() - t} ms)`)
  } catch (e) {
    ok = false
    results.push(`  FAIL ${name}: ${String(e.message).split('\n')[0]}`)
  }
  console.log(results[results.length - 1])
}

await start('asha', 'Asha', office)
await start('bob', 'Bob Test', office)

await check('the private build is the one running', async () => {
  const appPath = await people.asha.app.evaluate(({ app }) => app.getAppPath())
  if (appPath.toLowerCase() !== APP.toLowerCase()) throw new Error(`app path ${appPath}`)
})

await check('both report LAN ready and see each other', async () => {
  for (const who of ['asha', 'bob']) {
    await until(who, () => window.__hopper.lanStatus?.ready === true, null, 40000).catch(async () => {
      throw new Error(`${who} status ${await ev(who, () => JSON.stringify(window.__hopper.lanStatus))}`)
    })
  }
  await until('asha', () => window.__hopper.peers.some((p) => p.user === 'bob' && p.status !== 'offline'), null, 40000)
  await until('bob', () => window.__hopper.peers.some((p) => p.user === 'asha' && p.status !== 'offline'), null, 40000)
})

// ---- A. office key only by the admin ----------------------------------------------------

await check('asha is admin, bob is not; both joined with the same fingerprint', async () => {
  const v = await ev('asha', () => window.hopper.office.get().then((r) => r.meta))
  const b = await ev('bob', () => window.hopper.office.get().then((r) => r.meta))
  if (!v.admin || v.user !== 'asha') throw new Error(`asha meta ${JSON.stringify(v)}`)
  if (b.admin || b.user !== 'bob') throw new Error(`bob meta ${JSON.stringify(b)}`)
  if (v.fingerprint !== FP || b.fingerprint !== FP || b.keySource !== 'config') throw new Error(`fingerprints ${v.fingerprint} ${b.fingerprint} want ${FP}`)
})

await check('non-admin cannot save the office config (IPC refuses, file untouched)', async () => {
  const before = readFileSync(office, 'utf8')
  const err = await ev('bob', async () => {
    const r = await window.hopper.office.get()
    try {
      await window.hopper.office.save({ ...r.config, officeName: 'Hijacked', officeKey: 'ab'.repeat(32), admins: ['bob'] })
      return ''
    } catch (e) {
      return String(e.message)
    }
  })
  if (!/set up on|admin/i.test(err)) throw new Error(`save was not refused: "${err}"`)
  if (readFileSync(office, 'utf8') !== before) throw new Error('office.json changed')
  const moved = await ev('bob', async () => {
    const r = await window.hopper.office.get()
    return window.hopper.office.save(r.config, { moveTo: '<work-folder>\\_Claude_Work\\temp\\lan2-agent\\e2e\\elsewhere' }).then(() => 'moved', (e) => String(e.message))
  })
  if (!/set up on|admin/i.test(moved)) throw new Error(`move was not refused: "${moved}"`)
})

await check('admin can save the office config', async () => {
  await ev('asha', async () => {
    const r = await window.hopper.office.get()
    await window.hopper.office.save({ ...r.config, officeName: 'Dexterity Design Services', announcers: [] })
  })
  const saved = JSON.parse(readFileSync(office, 'utf8'))
  if (saved.officeName !== 'Dexterity Design Services' || saved.officeKey !== KEY || saved.admins.join() !== 'asha') throw new Error(JSON.stringify(saved).slice(0, 200))
  await ev('bob', () => window.__hopper.reloadOffice(window.__hopper.settings.officeConfigPath))
})

await check('Office page: admin has Generate/Invite/Move; non-admin is read-only with Join', async () => {
  await openOffice('asha')
  const v = people.asha.win.locator('[role=dialog]')
  for (const text of ['Generate', 'Invite PCs', 'Move…', 'Save to server']) if (!(await v.getByRole('button', { name: text }).count())) throw new Error(`admin page lacks "${text}"`)
  await shot('asha', 'office-admin')
  await ev('asha', () => document.querySelector('[data-invite-toggle]')?.scrollIntoView({ block: 'start' }))
  await people.asha.win.waitForTimeout(300)
  await shot('asha', 'office-admin-2')
  await esc('asha')

  await openOffice('bob')
  const b = people.bob.win.locator('[role=dialog]')
  for (const text of ['Generate', 'Invite PCs', 'Move…', 'Save to server']) if (await b.getByRole('button', { name: text }).count()) throw new Error(`non-admin page shows "${text}"`)
  if ((await b.locator('[data-join-state]').getAttribute('data-join-state')) !== 'joined') throw new Error('bob not shown as joined')
  if (!(await b.locator('[data-join-key]').count())) throw new Error('no paste-key box')
  if (!(await b.locator('[data-office-locked]').count())) throw new Error('no "set up by its admin" note')
  await shot('bob', 'office-non-admin')
  await esc('bob')
})

await check('revoke opens the Office page for everyone; a setup on a PC locks it again', async () => {
  const meta = (u) => ev(u, async () => (await window.hopper.office.load(window.__hopper.settings.officeConfigPath)).meta)
  if ((await meta('bob')).admin) throw new Error('bob is admin before the revoke')
  const err = await ev('bob', () => window.hopper.office.revoke().then(() => '', (e) => String(e.message)))
  if (!err) throw new Error('bob could revoke')
  await ev('asha', () => window.hopper.office.revoke())
  if (JSON.parse(readFileSync(office, 'utf8')).setup) throw new Error('setup still in office.json')
  const open = await meta('bob')
  if (!open.admin || open.setup) throw new Error(`bob not admin after revoke: ${JSON.stringify(open)}`)
  await ev('bob', () => window.hopper.office.lock())
  const locked = JSON.parse(readFileSync(office, 'utf8')).setup
  if (!locked || locked.user !== 'bob') throw new Error(`lock not recorded: ${JSON.stringify(locked)}`)
  if (!(await meta('asha')).admin) throw new Error('standing admin lost access')
  // back to the starting state for the tests below
  writeFileSync(office, JSON.stringify({ ...JSON.parse(readFileSync(office, 'utf8')), setup: SETUP }))
  for (const u of ['asha', 'bob']) await meta(u)
  if ((await meta('bob')).admin) throw new Error('bob still admin after restoring the setup')
})

// ---- C. Person panel ---------------------------------------------------------------------

await check('with nothing selected, clicking a person opens the Person panel, not Share', async () => {
  const w = people.asha.win
  // a focused row but no selection: exactly the stale state from the bug report
  await ev('asha', async (p) => {
    const a = window.__hopper.active
    await a.navigate(p)
    a.clearSelection()
    a.focus = 0
  }, join(project, 'Lot 07'))
  if ((await ev('asha', () => window.__hopper.active.selected.length)) !== 0) throw new Error('selection not empty')
  if ((await ev('asha', () => window.__hopper.active.targets().length)) !== 1) throw new Error('expected a focused row')
  await w.locator('.sidebar .row.person', { hasText: 'Bob Test' }).click()
  await w.locator('[role=dialog][aria-label="Bob Test"]').waitFor({ timeout: 15000 })
  if (await w.locator('[role=dialog][aria-label="Share"]').count()) throw new Error('Share dialog opened')
  await w.locator('[data-tab=files]').click()
  await w.getByText('Nothing is selected.').waitFor({ timeout: 5000 })
  if (await w.locator('[role=dialog] .file').count()) throw new Error('the focused row was offered for sending')
  await shot('asha', 'person-files-empty')
  await w.locator('[data-tab=message]').click()
})

await check('message asha -> bob, direct', async () => {
  const w = people.asha.win
  await w.locator('[role=dialog] textarea').first().fill('Lot 07 is ready for back-check.')
  await w.keyboard.press('Enter')
  await until('bob', () => window.__hopper.inbox.some((i) => i.kind === 'message'), null, 30000)
  const item = await ev('bob', () => window.__hopper.inbox.find((i) => i.kind === 'message'))
  if (item.via !== 'direct' || item.message !== 'Lot 07 is ready for back-check.' || item.from !== 'asha' || item.files !== 0 || item.folder) throw new Error(JSON.stringify(item))
  await w.locator('.line.out .bubble', { hasText: 'Lot 07 is ready for back-check.' }).waitFor({ timeout: 15000 })
})

await check('folder link asha -> bob opens the folder in Bob\'s Hopper', async () => {
  const w = people.asha.win
  await w.locator('[data-tab=link]').click()
  await w.locator('[role=dialog] input.input').first().fill(project)
  await w.locator('[role=dialog] textarea').first().fill('Stress reports are in here')
  await w.getByRole('button', { name: 'Send link' }).click()
  await until('bob', () => window.__hopper.inbox.some((i) => i.kind === 'link'), null, 30000)
  const item = await ev('bob', () => window.__hopper.inbox.find((i) => i.kind === 'link'))
  if (!item.link?.path || !item.link.dir || item.via !== 'direct') throw new Error(JSON.stringify(item))
  // U: is a mapped network drive, so the link must have been sent as a UNC path
  if (/^u:/i.test(project) && !item.link.path.startsWith('\\\\')) throw new Error(`not converted to UNC: ${item.link.path}`)
  console.log(`       link sent as ${item.link.path}`)
  // back on the Message tab the conversation shows both notes
  await w.locator('.line.out .bubble.link').waitFor({ timeout: 15000 })
  await w.waitForTimeout(400)
  await shot('asha', 'person-panel')
  await esc('asha')

  const b = people.bob.win
  await ev('bob', () => window.__hopper.active.navigate('hopper:inbox'))
  await b.locator('.inbox .item[data-kind=link]').waitFor({ timeout: 15000 })
  await shot('bob', 'inbox-notes')
  await b.locator('.inbox .item[data-kind=link]').getByRole('button', { name: 'Open folder' }).click()
  await until('bob', (want) => window.__hopper.active.path.toLowerCase() === want.toLowerCase(), item.link.path, 20000)
  const names = await ev('bob', () => window.__hopper.active.rows.map((r) => r.name))
  if (!names.includes('Lot 07')) throw new Error(`folder not listed: ${names.join(',')}`)
})

await check('request bob -> asha, answered with files that carry replyTo', async () => {
  await ev('bob', () => window.__hopperLan.call('share.send', { to: ['asha'], paths: [], kind: 'request', message: 'Please send the lot 07 register' }))
  await until('asha', () => window.__hopper.inbox.some((i) => i.kind === 'request'), null, 30000)
  const req = await ev('asha', () => window.__hopper.inbox.find((i) => i.kind === 'request'))
  await ev('asha', ([p, id]) => window.__hopper.share({ to: ['bob'], paths: [p], replyTo: id }), [join(project, 'Lot 07', 'Comment register.csv'), req.id])
  await until('bob', () => window.__hopper.inbox.some((i) => (i.kind ?? 'files') === 'files' && i.files === 1), null, 60000)
  const got = await ev('bob', () => window.__hopper.inbox.find((i) => (i.kind ?? 'files') === 'files'))
  if (got.replyTo !== req.id) throw new Error(`replyTo ${got.replyTo} != ${req.id}`)
  if (!existsSync(join(got.folder, 'Comment register.csv'))) throw new Error('file missing')
})

// ---- B. announcements ----------------------------------------------------------------------

let first
await check('everyone may post announcements (not only admins)', async () => {
  const can = await ev('bob', () => !!window.__hopper.lanStatus?.canAnnounce)
  if (!can) throw new Error('bob may not announce')
})

await check('announcement reaches an online PC at once: banner, then Got it is visible to the admin', async () => {
  const w = people.asha.win
  await ev('asha', () => window.__hopperLan.lanx.compose())
  const d = w.locator('[role=dialog][aria-label="New announcement"]')
  await d.waitFor({ timeout: 15000 })
  await d.locator('input.input').first().fill('P10001 project folder is almost full')
  await d.locator('textarea').fill('Please make a local backup of your working files and clear out old exports by 5 pm.')
  await d.locator('.lvl.urgent').click()
  await d.locator('input.input').nth(1).fill(project)
  await w.waitForTimeout(300)
  await shot('asha', 'announce-compose')
  await d.getByRole('button', { name: 'Announce' }).click()
  await until('bob', () => window.__hopperLan.lanx.banner.length === 1, null, 20000)
  first = await ev('bob', () => window.__hopperLan.lanx.banner[0])
  if (first.level !== 'urgent' || first.by !== 'asha' || !first.path) throw new Error(JSON.stringify(first))
  const stored = JSON.parse(readFileSync(join(officeDir, 'announcements.json'), 'utf8'))
  if (stored.length !== 1 || stored[0].id !== first.id) throw new Error('not in announcements.json')
  const b = people.bob.win
  await b.locator(`.bar[data-announcement="${first.id}"]`).waitFor({ timeout: 10000 })
  await b.waitForTimeout(500)
  await shot('bob', 'announcement-banner')
  await b.locator(`.bar[data-announcement="${first.id}"]`).getByRole('button', { name: 'Got it' }).click()
  await until('bob', () => window.__hopperLan.lanx.banner.length === 0, null, 10000)
  await until('asha', (id) => window.__hopperLan.lanx.announcements.find((a) => a.id === id)?.acks?.some((k) => k.user === 'bob'), first.id, 20000)
  // and it is filed in the office folder for when the author is off
  const t0 = Date.now()
  while (!existsSync(join(officeDir, 'announcement-acks', 'bob.json')) && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 300))
  const filed = JSON.parse(readFileSync(join(officeDir, 'announcement-acks', 'bob.json'), 'utf8'))
  if (!filed.acks[first.id]) throw new Error('ack not filed in the office folder')
})

await check('offline colleague: message goes to the server inbox as a manifest only', async () => {
  await esc('bob')
  await people.bob.app.close()
  await until('asha', () => window.__hopper.peers.some((p) => p.user === 'bob' && p.status === 'offline'), null, 60000)
  const id = await ev('asha', () => window.__hopperLan.call('share.send', { to: ['bob'], paths: [], kind: 'message', message: 'Read this when you are back' }))
  await until('asha', (k) => window.__hopperLan.lanx.notes[k]?.state === 'done', `${id}|bob`, 30000)
  const note = await ev('asha', (k) => window.__hopperLan.lanx.notes[k], `${id}|bob`)
  if (note.via !== 'server') throw new Error(`via ${note.via}`)
  const drops = readdirSync(join(serverInbox, 'bob'))
  if (drops.length !== 1) throw new Error(`drops: ${drops.join(',')}`)
  const inside = readdirSync(join(serverInbox, 'bob', drops[0]))
  if (inside.join() !== 'manifest.json') throw new Error(`drop holds ${inside.join(',')}`)
  const m = JSON.parse(readFileSync(join(serverInbox, 'bob', drops[0], 'manifest.json'), 'utf8'))
  if (m.kind !== 'message' || m.files.length !== 0 || m.message !== 'Read this when you are back') throw new Error(JSON.stringify(m))
})

let second
await check('announcement posted while a PC is off is picked up at its next start, and acknowledged', async () => {
  second = await ev('asha', () => window.__hopperLan.call('announce.post', { title: 'Server maintenance tonight 8 pm', body: 'Save your work and close files on U: before you leave.', level: 'important' }))
  await start('bob', 'Bob Test', office)
  await until('bob', (id) => window.__hopperLan.lanx.announcements.some((a) => a.id === id), second.id, 60000)
  await until('bob', (id) => window.__hopperLan.lanx.banner[0]?.id === id, second.id, 10000)
  // the one acknowledged before the restart stays acknowledged
  const firstNow = await ev('bob', (id) => window.__hopperLan.lanx.announcements.find((a) => a.id === id), first.id)
  if (!firstNow?.acked) throw new Error('earlier acknowledgement was lost')
  await until('bob', () => window.__hopper.lanStatus?.ready === true, null, 40000)
  await until('bob', () => window.__hopper.peers.some((p) => p.user === 'asha' && p.status !== 'offline'), null, 40000)
  await ev('bob', (id) => window.__hopperLan.lanx.ack(id), second.id)
  await until('asha', (id) => window.__hopperLan.lanx.announcements.find((a) => a.id === id)?.acks?.some((k) => k.user === 'bob'), second.id, 90000)
})

await check('bob picks the message up from the server inbox on start', async () => {
  await until('bob', () => window.__hopper.inbox.some((i) => i.kind === 'message' && i.via === 'server'), null, 90000)
  const item = await ev('bob', () => window.__hopper.inbox.find((i) => i.kind === 'message' && i.via === 'server'))
  if (item.message !== 'Read this when you are back') throw new Error(JSON.stringify(item))
  if (readdirSync(join(serverInbox, 'bob')).length) throw new Error('server drop not removed')
})

await check('Announcements view lists history and shows the admin who acknowledged', async () => {
  const w = people.asha.win
  await esc('asha')
  await ev('asha', () => window.__hopperLan.lanx.openList())
  const d = w.locator('[role=dialog][aria-label="Announcements"]')
  await d.waitFor({ timeout: 15000 })
  if ((await d.locator('.card').count()) !== 2) throw new Error(`cards: ${await d.locator('.card').count()}`)
  await d.locator(`.card[data-announcement="${first.id}"]`).getByText(/1 person acknowledged/).click()
  await d.locator('.acks', { hasText: 'Bob Test' }).waitFor({ timeout: 5000 })
  await shot('asha', 'announcements-view')
  await esc('asha')
})

// ---- A. joining: pasted key, then LAN invite ---------------------------------------------------

const nowhere = join(WORK, 'nowhere', 'office.json')
await start('carol', 'Carol New', nowhere)

await check('a PC without the office config is "Not joined" and silent', async () => {
  await until('carol', () => window.__hopper.lanStatus && window.__hopper.lanStatus.ready === false && window.__hopper.lanStatus.reason === 'no-office-key', null, 30000)
  const meta = await ev('carol', () => window.hopper.office.get().then((r) => r.meta))
  if (meta.keySource !== 'none' || meta.admin) throw new Error(JSON.stringify(meta))
  await openOffice('carol')
  const d = people.carol.win.locator('[role=dialog]')
  if ((await d.locator('[data-join-state]').getAttribute('data-join-state')) !== 'none') throw new Error('not shown as Not joined')
  if (await d.getByRole('button', { name: 'Generate' }).count()) throw new Error('a keyless non-admin can generate a key')
  await shot('carol', 'office-not-joined')
})

await check('join by pasted key: bad keys refused, good key joins and discovers peers', async () => {
  const w = people.carol.win
  const d = w.locator('[role=dialog]')
  await d.locator('[data-join-key]').fill('not-a-key')
  if (!(await d.locator('[data-join-go]').isDisabled())) throw new Error('Join enabled for a bad key')
  await d.locator('[data-join-key]').fill(KEY)
  await d.getByText(FP).first().waitFor({ timeout: 5000 }) // fingerprint shown before joining
  await d.locator('[data-join-go]').click()
  await until('carol', () => window.__hopper.lanStatus?.ready === true, null, 40000)
  await until('carol', () => window.__hopper.peers.some((p) => p.user === 'asha' && p.status !== 'offline'), null, 40000)
  const meta = await ev('carol', () => window.hopper.office.get().then((r) => r.meta))
  if (meta.keySource !== 'override' || meta.fingerprint !== FP) throw new Error(JSON.stringify(meta))
  await until('carol', () => document.querySelector('[data-join-state]')?.getAttribute('data-join-state') === 'joined', null, 10000)
  await shot('carol', 'office-joined-by-key')
  await esc('carol')
})

await check('invite: a PC without a key gets the prompt, joins on click, then discovers peers', async () => {
  // back to having no key
  await ev('carol', () => window.__hopperLan.lanx.leave())
  await until('carol', () => window.__hopper.lanStatus?.reason === 'no-office-key', null, 30000)
  await until('asha', () => !window.__hopper.peers.some((p) => p.user === 'carol' && p.status !== 'offline'), null, 60000)
  // only an admin may invite
  const refused = await ev('bob', () => window.__hopperLan.call('invite.start').then(() => '', (e) => String(e.message)))
  if (!/admin/i.test(refused)) throw new Error(`bob could invite: "${refused}"`)
  const st = await ev('asha', () => window.__hopperLan.call('invite.start'))
  if (!st.active || st.fingerprint !== FP) throw new Error(JSON.stringify(st))
  await until('carol', () => window.__hopperLan.lanx.joinPrompts.length === 1, null, 30000)
  const inv = await ev('carol', () => window.__hopperLan.lanx.joinPrompts[0])
  if (inv.adminUser !== 'asha' || inv.fingerprint !== FP || inv.officeName !== 'Dexterity Design Services' || 'key' in inv) throw new Error(JSON.stringify(inv))
  // nothing is applied without a click
  await people.carol.win.waitForTimeout(6000)
  if ((await ev('carol', () => window.__hopper.lanStatus?.ready)) !== false) throw new Error('joined without a click')
  // PCs already on this key are not asked
  if (await ev('bob', () => window.__hopperLan.lanx.invites.length)) throw new Error('bob (same key) was shown the invite')
  const w = people.carol.win
  await w.locator('.bar.invite').waitFor({ timeout: 10000 })
  await shot('carol', 'invite-prompt')
  await w.locator('.bar.invite').getByRole('button', { name: 'Join' }).click()
  await until('carol', () => window.__hopper.lanStatus?.ready === true, null, 40000)
  await until('carol', () => window.__hopper.peers.filter((p) => !p.self && p.status !== 'offline').length >= 2, null, 40000)
  await until('asha', () => window.__hopper.peers.some((p) => p.user === 'carol' && p.status !== 'offline'), null, 40000)
  // the invite also told carol where the office config is
  const r = await ev('carol', () => window.hopper.office.get())
  if (r.path.toLowerCase() !== office.toLowerCase() || r.meta.fingerprint !== FP) throw new Error(`${r.path} ${JSON.stringify(r.meta)}`)
  if (await w.locator('.bar.invite').count()) throw new Error('invite bar still showing')
  await ev('asha', () => window.__hopperLan.call('invite.stop'))
})

await check('the newly joined PC sees the standing announcement and can message the admin', async () => {
  await until('carol', (id) => window.__hopperLan.lanx.announcements.some((a) => a.id === id), second.id, 90000)
  await ev('carol', () => window.__hopperLan.call('share.send', { to: ['asha'], paths: [], kind: 'message', message: 'Carol is in' }))
  await until('asha', () => window.__hopper.inbox.some((i) => i.kind === 'message' && i.from === 'carol'), null, 30000)
})

for (const who of Object.keys(people)) await people[who].app.close().catch(() => {})
console.log(`\n${results.join('\n')}\n\nScreenshots: ${SHOTS}`)
console.log(ok ? '\nLAN2 e2e passed' : '\nLAN2 e2e FAILED')
process.exit(ok ? 0 : 1)
