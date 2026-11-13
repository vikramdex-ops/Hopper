// LAN end-to-end test inside Electron: two Hopper instances on this PC (different user data and
// LAN identities) discover each other, send a folder directly, then fall back to the server inbox.
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { launch, makeDemo, WORK } from './harness.mjs'

const office = join(WORK, 'office', 'office.json')
const serverInbox = join(WORK, 'office', 'Inbox')
rmSync(join(WORK, 'office'), { recursive: true, force: true })
mkdirSync(serverInbox, { recursive: true })
writeFileSync(office, JSON.stringify({ officeName: 'Test office', officeKey: randomBytes(32).toString('hex'), serverInbox, cliq: { enabled: false, endpoint: '', zapikey: '' }, groups: [{ id: 'piping', name: 'Piping team', members: ['bob'] }] }))

const demo = await makeDemo()
const people = {}
for (const [user, name] of [['alice', 'Alice Test'], ['bob', 'Bob Test']]) {
  const userData = join(WORK, `lan-${user}`)
  rmSync(userData, { recursive: true, force: true })
  mkdirSync(userData, { recursive: true })
  const inboxDir = join(WORK, `inbox-${user}`)
  rmSync(inboxDir, { recursive: true, force: true })
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ officeConfigPath: office, inboxDir, profile: { displayName: name, email: `${user}@example.com`, status: 'online' } }))
  people[user] = { ...(await launch({ userData, fresh: false, env: { HOPPER_LAN_USER: user } })), inboxDir }
}

const ev = (who, fn, arg) => people[who].win.evaluate(fn, arg)
const until = (who, fn, arg, ms = 60000) => people[who].win.waitForFunction(fn, arg, { timeout: ms })
let ok = true
const check = async (name, fn) => {
  const t = Date.now()
  try {
    await fn()
    console.log(`  ok  ${name} (${Date.now() - t} ms)`)
  } catch (e) {
    ok = false
    console.log(`  FAIL ${name}: ${e.message}`)
  }
}

await check('both report LAN ready', async () => {
  for (const who of ['alice', 'bob']) await until(who, () => window.__hopper.lanStatus?.ready === true, null, 30000).catch(async () => {
    const s = await ev(who, async () => JSON.stringify(window.__hopper.lanStatus))
    throw new Error(`${who} status ${s}`)
  })
})

await check('alice discovers bob', async () => {
  await until('alice', () => window.__hopper.peers.some((p) => p.user === 'bob' && p.status !== 'offline'), null, 30000)
})

await check('direct share alice -> bob (folder, TLS-PSK)', async () => {
  await ev('alice', (p) => window.__hopper.share({ to: ['bob'], paths: [p], message: 'Lot 07 for back-check' }), join(demo, 'P10001 Refinery Revamp', '02_Working', 'Lot 07'))
  await until('bob', () => window.__hopper.inbox.length > 0, null, 120000)
  const item = await ev('bob', () => window.__hopper.inbox[0])
  if (item.via !== 'direct') throw new Error(`via ${item.via}`)
  const files = readdirSync(join(item.folder, 'Lot 07'))
  if (!files.includes('ISO-1003_Rev2.pdf')) throw new Error('missing file: ' + files.join(','))
  console.log(`     received ${item.files} files in ${item.folder}`)
})

await check('a file share with a message, from reactive dialog state (proxied lists), is sent', async () => {
  // the Share dialog's recipient list is Svelte state; a proxy cannot be structured-cloned to the LAN port
  const before = await ev('bob', () => window.__hopper.inbox.length)
  const err = await ev('alice', async (p) => {
    try {
      await window.__hopper.share({ to: new Proxy(['bob'], {}), paths: new Proxy([p], {}), message: 'Rev B attached, with a note' })
      return ''
    } catch (e) {
      return String(e?.message ?? e)
    }
  }, join(demo, 'Transmittals'))
  if (err) throw new Error(err)
  await until('bob', (n) => window.__hopper.inbox.length > n, before, 120000)
  const msg = await ev('bob', () => window.__hopper.inbox[0].message)
  if (msg !== 'Rev B attached, with a note') throw new Error('message ' + msg)
})

await check('offline recipient goes via server inbox', async () => {
  await people.bob.app.close()
  // wait until alice sees bob offline (20 s beacon timeout)
  await until('alice', () => window.__hopper.peers.some((p) => p.user === 'bob' && p.status === 'offline'), null, 60000)
  await ev('alice', (p) => window.__hopper.share({ to: ['bob'], paths: [p] }), join(demo, 'Transmittals'))
  await until('alice', () => Object.values(window.__hopper.shares).some((s) => s.via === 'server' && s.state === 'done'), null, 120000)
  const drops = readdirSync(join(serverInbox, 'bob'))
  if (!drops.length) throw new Error('nothing in server inbox')
  console.log(`     server drop: ${drops[0]}`)
})

await check('bob picks up the server drop on start', async () => {
  const userData = join(WORK, 'lan-bob')
  people.bob = { ...(await launch({ userData, fresh: false, env: { HOPPER_LAN_USER: 'bob' } })), inboxDir: people.bob.inboxDir }
  await until('bob', () => window.__hopper.inbox.some((i) => i.via === 'server'), null, 120000)
})

for (const who of ['alice', 'bob']) await people[who].app.close().catch(() => {})
console.log(ok ? '\nLAN e2e passed' : '\nLAN e2e FAILED')
process.exit(ok ? 0 : 1)
