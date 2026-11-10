// UDP presence: signed beacons broadcast every 5 s on every IPv4 interface; peers expire after 20 s.
// Users seen before are remembered (lan-peers.json) so offline people stay pickable and their
// Zoho email is known for Cliq notices.
import { createSocket, type Socket } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { Peer } from '@shared/types'
import { beaconKey, DISCOVERY_PORT, openBeacon, sealBeacon, type Beacon } from './protocol'
import type { LanCtx } from './types'
import { readJson, saver, writeJsonAtomic } from './util'

const BEACON_MS = 5000
const OFFLINE_MS = 20000
const IFACE_MS = 30000
/** Beacons from clocks this far off are dropped (limits replay of captured beacons). */
const MAX_SKEW_MS = 10 * 60 * 1000
const KNOWN_TTL_MS = 120 * 24 * 3600 * 1000

interface Known {
  displayName: string
  email: string
  host: string
  lastSeen: number
}

export class Discovery {
  private sock: Socket | null = null
  private peers = new Map<string, Peer>()
  private known: Record<string, Known> = {}
  private targets: string[] = []
  private timers: NodeJS.Timeout[] = []
  private lastSent = ''
  private knownFile: string
  private knownSaver
  /** TCP port we advertise */
  port = 0
  /** persistent install id (lan-id), set before start() */
  id = ''
  /** datagrams that are not beacons (join invites); also heard while this PC has no key */
  onOther: ((buf: Buffer, address: string) => void) | null = null

  constructor(
    private ctx: LanCtx,
    private onChange: () => void
  ) {
    this.knownFile = join(ctx.dataDir, 'lan-peers.json')
    this.knownSaver = saver(5000, () => writeJsonAtomic(this.knownFile, this.known))
  }

  async load() {
    this.known = await readJson<Record<string, Known>>(this.knownFile, {})
    const cutoff = Date.now() - KNOWN_TTL_MS
    for (const [u, k] of Object.entries(this.known)) if (!k || k.lastSeen < cutoff) delete this.known[u]
  }

  get running() {
    return this.sock !== null
  }

  /** Bind the UDP port. Rejects with the socket error (EADDRINUSE etc.). Without a key it only listens. */
  start(port: number) {
    this.port = port
    if (this.sock) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const sock = createSocket({ type: 'udp4', reuseAddr: true })
      sock.once('error', (e) => {
        sock.close()
        reject(e)
      })
      sock.on('message', (buf, rinfo) => this.onBeacon(buf, rinfo.address))
      sock.bind({ port: DISCOVERY_PORT, exclusive: false }, () => {
        sock.removeAllListeners('error')
        sock.on('error', (e) => this.ctx.log('udp error', e.message))
        sock.setBroadcast(true)
        this.sock = sock
        this.targets = broadcastTargets()
        const tick = setInterval(() => this.tick(), BEACON_MS)
        const iface = setInterval(() => {
          const t = broadcastTargets()
          if (t.join() !== this.targets.join()) {
            this.targets = t
            this.announce(true)
          }
        }, IFACE_MS)
        tick.unref()
        iface.unref()
        this.timers.push(tick, iface)
        this.announce(true)
        resolve()
      })
    })
  }

  /** Close the socket; with bye, tell peers first (best effort, one datagram per target). */
  async stop(bye: boolean) {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    const sock = this.sock
    this.sock = null
    if (!sock) return
    if (bye && this.ctx.key) await this.send(sock, this.beacon(true)).catch(() => {})
    sock.close()
    let changed = false
    for (const p of this.peers.values()) if (p.status !== 'offline') ((p.status = 'offline'), (changed = true))
    if (changed) this.onChange()
    await this.knownSaver.flush()
  }

  /** Send a beacon now; unless forced, only when its content changed since the last one. */
  announce(force = false) {
    if (!this.sock || !this.ctx.key) return
    const b = this.beacon(false)
    const sig = JSON.stringify({ ...b, t: 0 })
    if (!force && sig === this.lastSent) return
    this.lastSent = sig
    this.send(this.sock, b).catch(() => {})
  }

  /** Send a raw datagram to every broadcast target (join invites). */
  async broadcast(buf: Buffer) {
    const sock = this.sock
    if (!sock) return false
    await Promise.all(this.targets.map((addr) => new Promise<void>((resolve) => sock.send(buf, DISCOVERY_PORT, addr, () => resolve()))))
    return true
  }

  /** Online PCs other than this one. */
  online(): Peer[] {
    return [...this.peers.values()].filter((p) => p.status !== 'offline')
  }

  /** The key went away or changed: everyone we knew is unverified now. */
  forget() {
    if (!this.peers.size) return
    this.peers.clear()
    this.lastSent = ''
    this.onChange()
  }

  self(): Peer {
    const me = this.ctx.me
    return {
      id: this.id,
      user: me.user,
      displayName: me.displayName,
      host: me.host,
      email: me.email || undefined,
      address: this.targets.length ? localAddress() : '127.0.0.1',
      port: this.port,
      version: this.ctx.version,
      status: me.status,
      lastSeen: Date.now(),
      self: true
    }
  }

  /** Self first, then online peers, then remembered users who are offline. */
  list(): Peer[] {
    const online = [...this.peers.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
    const users = new Set(online.filter((p) => p.status !== 'offline').map((p) => p.user))
    users.add(this.ctx.me.user)
    const shown = new Set<string>()
    const out: Peer[] = [this.self()]
    for (const p of online) {
      if (p.status === 'offline' && (users.has(p.user) || shown.has(p.user))) continue
      shown.add(p.user)
      out.push({ ...p })
    }
    for (const [user, k] of Object.entries(this.known)) {
      if (users.has(user) || shown.has(user)) continue
      out.push({ id: `known:${user}`, user, displayName: k.displayName, host: k.host, email: k.email || undefined, address: '', port: 0, version: '', status: 'offline', lastSeen: k.lastSeen })
    }
    return out
  }

  /** The most recently seen online PC of a user, other than this one. */
  find(user: string): Peer | undefined {
    let best: Peer | undefined
    for (const p of this.peers.values()) {
      if (p.user !== user || p.status === 'offline') continue
      if (!best || p.lastSeen > best.lastSeen) best = p
    }
    return best
  }

  emailFor(user: string) {
    return this.find(user)?.email || this.known[user]?.email || ''
  }

  nameFor(user: string) {
    return this.find(user)?.displayName || this.known[user]?.displayName || user
  }

  private beacon(bye: boolean): Beacon {
    const me = this.ctx.me
    return {
      v: 1,
      id: this.id,
      user: me.user,
      displayName: me.displayName,
      host: me.host,
      email: me.email,
      port: this.port,
      version: this.ctx.version,
      status: bye ? 'offline' : me.status,
      t: Date.now(),
      ...(bye ? { bye: true } : {})
    }
  }

  private async send(sock: Socket, b: Beacon) {
    const buf = sealBeacon(b, beaconKey(this.ctx.key!))
    await Promise.all(
      this.targets.map(
        (addr) => new Promise<void>((resolve) => sock.send(buf, DISCOVERY_PORT, addr, () => resolve()))
      )
    )
  }

  private tick() {
    this.announce(true)
    const now = Date.now()
    let changed = false
    for (const [id, p] of this.peers) {
      if (p.status !== 'offline' && now - p.lastSeen > OFFLINE_MS) {
        p.status = 'offline'
        changed = true
      } else if (p.status === 'offline' && now - p.lastSeen > 10 * 60 * 1000) {
        this.peers.delete(id)
        changed = true
      }
    }
    if (changed) this.onChange()
  }

  private onBeacon(buf: Buffer, address: string) {
    if (buf.subarray(0, 18).toString('latin1') === '{"hopper":"invite"') return this.onOther?.(buf, address)
    if (!this.ctx.key) return
    const b = openBeacon(buf, beaconKey(this.ctx.key))

    if (!b || b.id === this.id) return
    if (Math.abs(Date.now() - b.t) > MAX_SKEW_MS) return
    const prev = this.peers.get(b.id)
    const peer: Peer = {
      id: b.id,
      user: b.user,
      displayName: b.displayName || b.user,
      host: b.host,
      email: b.email || undefined,
      address,
      port: b.port,
      version: b.version,
      status: b.bye ? 'offline' : b.status,
      lastSeen: Date.now()
    }
    this.peers.set(b.id, peer)
    const k = this.known[b.user]
    if (!k || k.displayName !== peer.displayName || k.email !== b.email || k.host !== b.host || Date.now() - k.lastSeen > 3600_000) {
      this.known[b.user] = { displayName: peer.displayName, email: b.email, host: b.host, lastSeen: peer.lastSeen }
      this.knownSaver.schedule()
    }
    const same =
      prev &&
      prev.status === peer.status &&
      prev.displayName === peer.displayName &&
      prev.email === peer.email &&
      prev.address === peer.address &&
      prev.port === peer.port &&
      prev.version === peer.version
    if (!same) {
      this.onChange()
      // a newcomer learns about us at once instead of waiting up to 5 s
      if (!prev || prev.status === 'offline') this.announce(true)
    }
  }
}

/** 255.255.255.255 plus each IPv4 interface's directed broadcast (Windows only sends the limited one out of one NIC). */
function broadcastTargets() {
  const out = new Set<string>(['255.255.255.255'])
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const ip = ipToInt(a.address)
      const mask = ipToInt(a.netmask)
      if (ip === null || mask === null) continue
      out.add(intToIp((ip | ~mask) >>> 0))
    }
  }
  return [...out].sort()
}

function localAddress() {
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  return '127.0.0.1'
}

function ipToInt(s: string) {
  const p = s.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !(n >= 0 && n <= 255))) return null
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
}

const intToIp = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
