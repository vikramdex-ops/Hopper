// LAN utility process: UDP discovery, TLS-PSK direct transfer, server-inbox fallback, Cliq notices.
// The renderer gets a MessagePort straight to this process (see main/ctx.ts connectPorts); main
// pushes {type:'office', office, settings} whenever either changes.
import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { serve, type Handlers } from '@shared/rpc'
import { HopperShell } from '@shared/hshell'
import type { InboxItem, ShareSpec } from '@shared/types'
import { Announcements, type AnnouncementDraft } from './announce'
import { postCliq } from './cliq'
import { LinkNotices } from './linknotices'
import { Discovery } from './discovery'
import { Sent } from './history'
import { Inbox } from './inbox'
import { Invites } from './invite'
import { keyFingerprint, officeKeyBytes } from './protocol'
import { ServerPickup } from './server-inbox'
import { Shares } from './shares'
import { TransferServer } from './transfer-server'
import type { LanCtx } from './types'
import { sleep } from './util'

interface Status {
  enabled: boolean
  ready: boolean
  reason?: string
}

const RETRY_MS = 30_000

const servers: ReturnType<typeof serve>[] = []
const emit = (event: string, data: unknown) => {
  for (const s of servers) s.emit(event, data)
}
const post = (msg: unknown) => {
  try {
    process.parentPort.postMessage(msg)
  } catch {
    /* main gone */
  }
}

const shell = new HopperShell(process.env.HOPPER_HELPER!)
const ctx: LanCtx = {
  emit,
  attention: () => post({ type: 'attention' }),
  log: (...a) => console.log('[lan]', ...a),
  dataDir: process.env.HOPPER_DATA!,
  sevenZip: process.env.HOPPER_7Z!,
  version: process.env.HOPPER_VERSION ?? '0.0.0',
  office: null,
  settings: null,
  key: null,
  officePath: '',
  me: { user: '', displayName: '', host: hostname(), domain: '', email: '', status: 'online' },
  inboxRoot: () => inbox.root()
}

const inbox = new Inbox(ctx)
const onReceived = (item: InboxItem) => inbox.add(item)
const admit = (r: Parameters<Inbox['admit']>[0]) => inbox.admit(r)
let peersTimer: NodeJS.Timeout | null = null
const discovery = new Discovery(ctx, () => {
  // coalesce bursts (several beacons arriving together) into one event
  if (peersTimer) return
  peersTimer = setTimeout(() => {
    peersTimer = null
    emit('peers', discovery.list())
  }, 100)
})
const announcements = new Announcements(ctx, discovery)
const invites = new Invites(ctx, discovery)
const sent = new Sent(ctx)
const transfer = new TransferServer(ctx, admit, onReceived, (identity, frame, fromName) => announcements.onFrame(identity, frame, fromName))
const pickup = new ServerPickup(ctx, admit, onReceived, (id) => inbox.has(id))
const shares = new Shares(ctx, discovery, sent)
const linkNotices = new LinkNotices(ctx, discovery)
linkNotices.start()

let status: Status = { enabled: false, ready: false, reason: 'starting' }
let helper: { user: string; displayName: string; host: string; domain: string } | null = null
let retryTimer: NodeJS.Timeout | null = null
let shuttingDown = false

function statusView() {
  return {
    ...status,
    self: discovery.self(),
    port: transfer.port,
    fingerprint: keyFingerprint(ctx.key),
    admin: invites.isAdmin(),
    canAnnounce: announcements.canPost()
  }
}

function setStatus(next: Status) {
  const same = next.enabled === status.enabled && next.ready === status.ready && next.reason === status.reason
  status = next
  if (!same) emit('lan-status', statusView())
}

async function resolveIdentity() {
  try {
    const r = await shell.call<{ user: string; displayName: string; host: string; domain: string }>('user', {}, 10_000)
    if (r?.user) helper = r
  } catch (e: any) {
    ctx.log('helper user lookup failed, using the OS account', e?.message ?? e)
  }
  if (!helper) {
    let user = process.env.USERNAME ?? ''
    try {
      user = userInfo().username
    } catch {
      /* keep env */
    }
    helper = { user, displayName: '', host: hostname(), domain: process.env.USERDOMAIN ?? '' }
  }
  // HOPPER_LAN_USER lets two instances on one PC act as two people (tests only).
  ctx.me.user = (process.env.HOPPER_LAN_USER || helper.user).toLowerCase()
  ctx.me.host = helper.host || hostname()
  ctx.me.domain = helper.domain
}

function applyProfile() {
  const p = ctx.settings?.profile
  ctx.me.displayName = p?.displayName?.trim() || helper?.displayName?.trim() || ctx.me.user
  ctx.me.email = p?.email?.trim() ?? ''
  ctx.me.status = p?.status ?? 'online'
}

async function loadId() {
  const file = join(ctx.dataDir, 'lan-id')
  try {
    const id = (await fsp.readFile(file, 'utf8')).trim()
    if (/^[0-9a-f]{16,64}$/.test(id)) return id
  } catch {
    /* first run */
  }
  const id = randomBytes(12).toString('hex')
  await fsp.mkdir(ctx.dataDir, { recursive: true })
  await fsp.writeFile(file, id, 'utf8')
  return id
}

async function stopNetwork(bye: boolean) {
  pickup.stop()
  shares.cancelAll()
  await discovery.stop(bye)
  await transfer.close()
}

function scheduleRetry() {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    reconcile()
  }, RETRY_MS)
  retryTimer.unref()
}

/** Bring the network side in line with the current settings and office config. */
async function doReconcile() {
  if (shuttingDown) return
  if (!ctx.settings || !ctx.office) return setStatus({ enabled: false, ready: false, reason: 'waiting-for-settings' })
  const enabled = ctx.settings.lan?.enabled !== false
  // the shared config's key, else the one this PC joined with (pasted or accepted from an invite)
  const before = keyFingerprint(ctx.key)
  ctx.key = officeKeyBytes(ctx.office.officeKey) ?? officeKeyBytes(ctx.settings.officeKeyOverride)
  const keyChanged = keyFingerprint(ctx.key) !== before
  if (keyChanged) discovery.forget()
  invites.keyChanged()
  applyProfile()
  // announcements are read from the office folder, so they work whatever the LAN state is
  announcements.start()
  if (!enabled) {
    await stopNetwork(true)
    setStatus({ enabled, ready: false, reason: 'disabled' })
    return emit('lan-status', statusView())
  }
  if (!ctx.key) {
    // no key yet: stay silent, but keep listening so an admin's invite can reach this PC
    pickup.stop()
    shares.cancelAll()
    await transfer.close()
    if (!discovery.running) await discovery.start(0).catch((e) => ctx.log('invite listener', e?.message ?? e))
    const reason = ctx.office.officeKey?.trim() || ctx.settings.officeKeyOverride?.trim() ? 'bad-office-key' : 'no-office-key'
    setStatus({ enabled, ready: false, reason })
    return emit('lan-status', statusView())
  }
  if (!transfer.listening && (await transfer.listen()) === null) {
    scheduleRetry()
    return setStatus({ enabled, ready: false, reason: 'port-in-use' })
  }
  if (!discovery.running) {
    try {
      await discovery.start(transfer.port)
    } catch (e: any) {
      scheduleRetry()
      return setStatus({ enabled, ready: false, reason: e?.code === 'EADDRINUSE' ? 'port-in-use' : `discovery: ${e?.message ?? e}` })
    }
  }
  discovery.port = transfer.port
  discovery.announce()
  pickup.start()
  setStatus({ enabled, ready: true })
  // always: the fingerprint or the admin flag may have changed while the state stayed 'ready'
  emit('lan-status', statusView())
  emit('peers', discovery.list()) // self may have a new name/status
  if (keyChanged) void announcements.sync()
}

let chain: Promise<void>
function reconcile() {
  chain = chain.then(doReconcile).catch((e) => ctx.log('reconcile', e?.message ?? e))
}

chain = (async () => {
  discovery.id = await loadId()
  await resolveIdentity()
  await Promise.all([inbox.load(), discovery.load(), transfer.load(), announcements.load(), sent.load()])
})().catch((e) => ctx.log('startup', e?.message ?? e))

const needReady = () => {
  if (!ctx.key) throw new Error('LAN sharing needs the office key (Settings > Office)')
}

const handlers: Handlers = {
  ping: () => 'pong',
  'lan.status': () => statusView(),
  'peers.list': () => discovery.list(),
  'groups.list': () => ctx.office?.groups ?? [],
  'share.send': (spec: ShareSpec) => {
    needReady()
    return shares.send(spec)
  },
  'share.cancel': (shareId: string) => shares.cancel(shareId),
  'shares.list': () => shares.list(),
  'inbox.list': () => inbox.list(),
  'inbox.markSeen': (id: string) => inbox.markSeen(id),
  'inbox.answer': (requestId: string, accept: boolean) => inbox.answer(requestId, accept),
  'inbox.pending': () => inbox.pendingList(),
  'history.with': (user: string) => sent.with(user, inbox.list()),
  'announce.list': () => announcements.list(),
  'announce.canPost': () => announcements.canPost(),
  'announce.post': (draft: AnnouncementDraft) => announcements.post(draft),
  'announce.withdraw': (id: string) => announcements.withdraw(String(id)),
  'announce.read': (id: string) => announcements.markRead(String(id)),
  'announce.ack': (id: string) => announcements.ack(String(id)),
  'announce.sync': async () => {
    await announcements.sync()
    return announcements.list()
  },
  'invite.start': () => invites.start(),
  'invite.stop': () => invites.stop(),
  'invite.status': () => invites.status(),
  'invite.list': () => invites.list(),
  'invite.accept': (id: string) => invites.accept(String(id)),
  'invite.ignore': (id: string) => invites.ignore(String(id)),
  'cliq.test': (email: string) =>
    postCliq(
      ctx.office?.cliq,
      [String(email ?? '')],
      `Test message from Hopper on ${ctx.me.host} (${ctx.me.displayName || ctx.me.user}): Cliq notifications are working.`
    )
}

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  inbox.declineAll()
  invites.stop()
  announcements.stop()
  // bye beacon, close sockets, flush history; never hang the exit for more than 1.5 s
  await Promise.race([Promise.all([stopNetwork(true), inbox.flush(), sent.flush(), announcements.flush()]).catch(() => {}), sleep(1500)])
  shell.dispose()
  process.exit(0)
}

process.parentPort.on('message', (e) => {
  const data = e.data as any
  if (data?.type === 'port' && e.ports[0]) {
    const port = e.ports[0]
    const server = serve(port, handlers)
    servers.push(server)
    port.on('message', (m) => void server.onMessage(m.data))
    port.on('close', () => {
      const i = servers.indexOf(server)
      if (i >= 0) servers.splice(i, 1)
    })
    port.start()
  } else if (data?.type === 'office') {
    ctx.office = data.office
    ctx.settings = data.settings
    // main's reply to 'office-request' carries no path: keep the last one, else the configured path
    ctx.officePath = String(data.officePath || ctx.officePath || data.settings?.officeConfigPath || '')
    reconcile()
  } else if (data?.type === 'shutdown') {
    void shutdown()
  }
})

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
process.on('uncaughtException', (err) => console.error('[lan]', err))
process.on('unhandledRejection', (err) => console.error('[lan]', err))

post({ type: 'office-request' })
