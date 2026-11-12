// Join invites. An admin broadcasts the office key for two minutes so PCs that have no key can
// join with one click. The datagram is unsigned by necessity and carries the key in clear: see
// docs/OFFICE-SETUP.md for the trade-off. Nothing here applies a key; the renderer asks the user
// and stores the key through main (settings.officeKeyOverride).
import { randomBytes } from 'node:crypto'
import type { OfficeInvite } from '@shared/types'
import type { Discovery } from './discovery'
import { INVITE_EVERY_MS, INVITE_MS, keyFingerprint, openInvite, sealInvite, type Invite } from './protocol'
import type { LanCtx } from './types'
import { canConfigureOffice } from '@shared/office-access'

/** Invites from clocks this far off are dropped, like beacons. */
const MAX_SKEW_MS = 10 * 60 * 1000
/** At most one datagram per source address is looked at in this window. */
const PER_ADDRESS_MS = 2_000
const MAX_PENDING = 5
const PENDING_TTL_MS = 5 * 60_000

interface Pending {
  key: string
  view: OfficeInvite
  lastSeen: number
}

export interface InviteStatus {
  active: boolean
  until: number
  fingerprint: string
}

export class Invites {
  private pending = new Map<string, Pending>()
  /** fingerprints the user chose to ignore (until restart) */
  private ignored = new Set<string>()
  private lastFrom = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null
  private until = 0
  private current: Invite | null = null

  constructor(
    private ctx: LanCtx,
    private discovery: Discovery
  ) {
    discovery.onOther = (buf, address) => this.onDatagram(buf, address)
  }

  isAdmin() {
    return canConfigureOffice(this.ctx.office, this.ctx.me.user, this.ctx.me.host)
  }

  /** Start (or extend) the two-minute broadcast. Admins only. */
  start(): InviteStatus {
    if (!this.isAdmin()) throw new Error('Only an office admin can invite PCs')
    const key = this.ctx.key
    if (!key || !this.discovery.running) throw new Error('LAN sharing must be ready before inviting (office key saved, sharing on)')
    this.current = {
      v: 1,
      id: this.current?.id ?? randomBytes(8).toString('hex'),
      officeName: this.ctx.office?.officeName ?? '',
      adminUser: this.ctx.me.user,
      adminName: this.ctx.me.displayName || this.ctx.me.user,
      host: this.ctx.me.host,
      configPath: this.ctx.officePath,
      key: key.toString('hex'),
      t: Date.now()
    }
    this.until = Date.now() + INVITE_MS
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), INVITE_EVERY_MS)
      this.timer.unref()
    }
    this.tick()
    this.ctx.log('invite', `broadcasting for ${INVITE_MS / 1000} s`)
    this.emitStatus()
    return this.status()
  }

  stop() {
    if (!this.timer) return this.status()
    clearInterval(this.timer)
    this.timer = null
    this.current = null
    this.until = 0
    this.emitStatus()
    return this.status()
  }

  status(): InviteStatus {
    return { active: !!this.timer, until: this.until, fingerprint: keyFingerprint(this.ctx.key) }
  }

  /** Invites waiting for the user to decide, newest first. */
  list(): OfficeInvite[] {
    this.prune()
    return this.views()
  }

  /** The user clicked Join: hand the key over (once) so the renderer can store it through main. */
  accept(id: string) {
    const p = this.pending.get(id)
    if (!p) throw new Error('That invite has expired. Ask the admin to invite again.')
    this.pending.delete(id)
    this.emitList()
    const v = p.view
    return { key: p.key, configPath: v.configPath, officeName: v.officeName, adminName: v.adminName, adminUser: v.adminUser, fingerprint: v.fingerprint }
  }

  ignore(id: string) {
    const p = this.pending.get(id)
    if (!p) return false
    this.ignored.add(p.view.fingerprint)
    this.pending.delete(id)
    this.emitList()
    return true
  }

  /** The key changed (joined, or the config got one): drop invites that are now moot. */
  keyChanged() {
    const mine = keyFingerprint(this.ctx.key)
    let changed = false
    for (const [id, p] of this.pending) {
      if (p.view.fingerprint === mine) {
        this.pending.delete(id)
        changed = true
      } else if (p.view.haveKey !== !!this.ctx.key) {
        p.view = { ...p.view, haveKey: !!this.ctx.key }
        changed = true
      }
    }
    if (changed) this.emitList()
    if (this.timer && (!this.ctx.key || !this.isAdmin())) this.stop()
  }

  private tick() {
    if (!this.current || Date.now() >= this.until || !this.ctx.key) return void this.stop()
    this.current.t = Date.now()
    void this.discovery.broadcast(sealInvite(this.current)).catch(() => {})
  }

  private onDatagram(buf: Buffer, address: string) {
    const now = Date.now()
    if (now - (this.lastFrom.get(address) ?? 0) < PER_ADDRESS_MS) return
    this.lastFrom.set(address, now)
    if (this.lastFrom.size > 256) for (const [a, t] of this.lastFrom) if (now - t > PER_ADDRESS_MS) this.lastFrom.delete(a)
    const inv = openInvite(buf)
    if (!inv || inv.id === this.current?.id) return
    if (Math.abs(now - inv.t) > MAX_SKEW_MS) return
    const fingerprint = keyFingerprint(inv.key)
    // already in this office, or the user said no to this key
    if (!fingerprint || fingerprint === keyFingerprint(this.ctx.key) || this.ignored.has(fingerprint)) return
    this.prune()
    const known = this.pending.get(inv.id)
    if (known) {
      // the key of a pending invite never changes under the user
      if (known.key === inv.key) known.lastSeen = now
      return
    }
    if (this.pending.size >= MAX_PENDING) return
    const view: OfficeInvite = {
      id: inv.id,
      officeName: inv.officeName,
      adminUser: inv.adminUser,
      adminName: inv.adminName,
      host: inv.host,
      address,
      configPath: inv.configPath,
      fingerprint,
      at: now,
      haveKey: !!this.ctx.key
    }
    this.pending.set(inv.id, { key: inv.key, view, lastSeen: now })
    this.ctx.log('invite', `from ${inv.adminUser}@${address} for "${inv.officeName}" (key ${fingerprint})`)
    this.ctx.emit('invite', view)
    this.emitList()
    if (!view.haveKey) this.ctx.attention()
  }

  private prune() {
    const cutoff = Date.now() - PENDING_TTL_MS
    let changed = false
    for (const [id, p] of this.pending) {
      if (p.lastSeen < cutoff) {
        this.pending.delete(id)
        changed = true
      }
    }
    if (changed) this.emitList()
  }

  private views() {
    return [...this.pending.values()].map((p) => p.view).sort((a, b) => b.at - a.at)
  }

  private emitList() {
    this.ctx.emit('invites', this.views())
  }

  private emitStatus() {
    this.ctx.emit('invite-status', this.status())
  }
}
