// LAN state beyond file sharing: announcements, join invites, office membership and the notes
// (messages, folder links, requests) exchanged with people. `app` owns peers/inbox/shares; this
// module owns the rest so the two can change independently.
import { app } from './app.svelte'
import { host, lan } from './api'
import { fmtSize, plural } from './format'
import type { AnnouncementView, DriveInfo, HistoryItem, InboxItem, OfficeInvite, OfficeMeta, ShareLink } from '@shared/types'

export interface NoteState {
  shareId: string
  to: string
  kind: string
  state: string
  via: 'direct' | 'server' | null
  error?: string
}

export interface InviteStatus {
  active: boolean
  until: number
  fingerprint: string
}

const LEVEL_RANK = { urgent: 0, important: 1, info: 2 } as const
export const LEVEL_LABEL = { info: 'Info', important: 'Important', urgent: 'Urgent' } as const

export const isLive = (a: AnnouncementView, now = Date.now()) => !a.withdrawn && !(a.expires && a.expires <= now)

/** Hex, at least 32 characters: the same rule as the LAN process. */
export const validKey = (k: string) => {
  const hex = k.trim()
  return hex.length >= 32 && hex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(hex)
}

/** First 8 hex of SHA-256 of the key bytes; '' when the key is not valid. */
export async function fingerprintOf(key: string) {
  const hex = key.trim()
  if (!validKey(hex)) return ''
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * A path as another PC can open it: a mapped network drive becomes its UNC. `shared` is false for
 * a path on a local disk, which the other PC cannot reach.
 */
export function toUnc(path: string, drives: DriveInfo[]): { path: string; shared: boolean } {
  const p = path.trim()
  if (p.startsWith('\\\\')) return { path: p, shared: true }
  const d = drives.find((x) => p.toLowerCase().startsWith(x.root.toLowerCase().replace(/\\$/, '')))
  if (d?.remote) return { path: d.remote.replace(/\\+$/, '') + p.slice(d.root.replace(/\\$/, '').length), shared: true }
  return { path: p, shared: false }
}

/** "Arun sent 3 files" / "Arun: message" etc. for toasts, notifications and the Inbox. */
export function receivedTitle(item: InboxItem) {
  switch (item.kind ?? 'files') {
    case 'message': return `Message from ${item.fromName}`
    case 'link': return `${item.fromName} sent you a folder link`
    case 'request': return `${item.fromName} is asking for files`
    default: return `${item.fromName} sent you ${plural(item.files, 'file')}`
  }
}

export function receivedBody(item: InboxItem) {
  const kind = item.kind ?? 'files'
  if (kind === 'link') return [item.link?.path, item.message].filter(Boolean).join(' — ')
  if (kind !== 'files') return item.message ?? ''
  return item.message || fmtSize(item.bytes)
}

class LanExtras {
  announcements = $state.raw<AnnouncementView[]>([])
  invites = $state.raw<OfficeInvite[]>([])
  inviteStatus = $state.raw<InviteStatus>({ active: false, until: 0, fingerprint: '' })
  meta = $state.raw<OfficeMeta>({ user: '', pc: '', admin: false, setup: null, setupPc: false, standing: false, keySource: 'none', fingerprint: '' })
  /** bumps when office.json changed on the server (a setup, a revoke, an admin's save) */
  officeTick = $state(0)
  /** where the office config was really loaded from */
  officePath = $state('')
  /** delivery state of notes sent from this PC, by `${shareId}|${to}` */
  notes = $state.raw<Record<string, NoteState>>({})
  /** bumps whenever something was sent or received, so open conversations reload */
  historyTick = $state(0)
  /** ticks every 30 s so expiries and countdowns move without events */
  now = $state(Date.now())

  /** live important/urgent announcements this user has not acknowledged, most pressing first */
  banner = $derived(
    this.announcements
      .filter((a) => a.level !== 'info' && !a.acked && isLive(a, this.now))
      .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.at - a.at)
  )
  unread = $derived(this.announcements.filter((a) => !a.read && isLive(a, this.now)).length)
  canAnnounce = $derived(!!app.lanStatus?.canAnnounce)
  /** invites this PC should ask about: it has no key yet */
  joinPrompts = $derived(this.invites.filter((i) => !i.haveKey))

  private started = false

  init() {
    if (this.started) return
    this.started = true
    setInterval(() => (this.now = Date.now()), 30_000)
    lan.on('announcements', (l: AnnouncementView[]) => (this.announcements = l))
    lan.on('announcement', (a: AnnouncementView & { live?: boolean }) => this.onAnnouncement(a))
    lan.on('invites', (l: OfficeInvite[]) => (this.invites = l))
    lan.on('invite', (i: OfficeInvite) => this.onInvite(i))
    lan.on('invite-status', (s: InviteStatus) => (this.inviteStatus = s))
    lan.on('note', (n: NoteState) => {
      this.notes = { ...this.notes, [`${n.shareId}|${n.to}`]: n }
      if (n.state === 'failed') app.toast('error', `Couldn't reach ${app.personName(n.to)}`, n.error)
    })
    lan.on('sent', (_i: HistoryItem) => this.historyTick++)
    lan.on('received', () => this.historyTick++)
    // the LAN process restarts on its own after a crash: ask again whenever its status arrives
    lan.on('lan-status', () => void this.refreshMeta())
    // another PC set the office up, revoked it or saved: follow it here (the Office page re-locks or opens)
    host.office.onChanged(async () => {
      await Promise.all([this.refreshMeta(), app.reloadOffice().catch(() => {})])
      this.officeTick++
      void this.reload()
    })
    void this.reload()
    void this.refreshMeta()
  }

  async reload() {
    await Promise.all([
      lan.call('announce.list').then((l) => (this.announcements = l)).catch(() => {}),
      lan.call('invite.list').then((l) => (this.invites = l)).catch(() => {}),
      lan.call('invite.status').then((s) => (this.inviteStatus = s)).catch(() => {})
    ])
  }

  async refreshMeta() {
    try {
      const r = (await host.office.get()) as any
      if (r.meta) this.meta = r.meta
      this.officePath = r.path ?? ''
    } catch {
      /* main busy */
    }
  }

  // ---- announcements ----------------------------------------------------------

  private onAnnouncement(a: AnnouncementView & { live?: boolean }) {
    if (a.level === 'info' && !a.live) return // old news picked up at start: the list has it
    const title = a.level === 'info' ? a.title : `${LEVEL_LABEL[a.level]}: ${a.title}`
    const actions = [
      ...(a.path ? [{ label: 'Open folder', run: () => void app.active.navigate(a.path!) }] : []),
      { label: a.level === 'info' ? 'View' : 'Got it', run: () => (a.level === 'info' ? void this.openList() : void this.ack(a.id)) }
    ]
    app.toast(a.level === 'urgent' ? 'error' : a.level === 'important' ? 'warning' : 'info', title, `${a.byName}: ${a.body || 'No details'}`.slice(0, 240), actions, a.level === 'urgent')
    if (a.level === 'urgent' || (a.level === 'important' && !document.hasFocus())) {
      try {
        new Notification(`${LEVEL_LABEL[a.level]} announcement: ${a.title}`, { body: `${a.byName}: ${a.body}`.slice(0, 200) })
      } catch {
        /* notifications unavailable */
      }
    }
  }

  async ack(id: string) {
    this.announcements = this.announcements.map((a) => (a.id === id ? { ...a, read: true, acked: true, ackedAt: Date.now() } : a))
    await lan.call('announce.ack', id).catch((e) => app.toast('error', "Couldn't record that", e.message))
  }

  markRead(id: string) {
    if (this.announcements.find((a) => a.id === id)?.read) return
    this.announcements = this.announcements.map((a) => (a.id === id ? { ...a, read: true } : a))
    void lan.call('announce.read', id).catch(() => {})
  }

  async openList() {
    const { dialogs } = await import('./commands')
    void dialogs.announcements?.()
  }

  async compose(path?: string) {
    const { dialogs } = await import('./commands')
    void dialogs.announce?.(path)
  }

  // ---- joining an office ----------------------------------------------------------

  private onInvite(i: OfficeInvite) {
    if (i.haveKey) {
      app.toast('info', `${i.adminName} is inviting PCs to ${i.officeName}`, `This PC already has a different office key, so nothing changes. Their key fingerprint is ${i.fingerprint}.`)
    } else if (!document.hasFocus()) {
      try {
        new Notification(`${i.adminName} invites this PC to join ${i.officeName}`, { body: 'Open Hopper to join.' })
      } catch {
        /* notifications unavailable */
      }
    }
  }

  /** Store a key on this PC (pasted, or from an invite the user accepted) and start using it. */
  async joinWithKey(key: string, info: { via: 'paste' | 'invite'; officeName?: string; by?: string; configPath?: string }) {
    const hex = key.trim().toLowerCase()
    const fingerprint = await fingerprintOf(hex)
    if (!fingerprint) throw new Error('That is not an office key: it must be hex, at least 32 characters')
    app.updateSettings({
      officeKeyOverride: hex,
      officeJoined: { officeName: info.officeName ?? app.office?.officeName ?? '', by: info.by ?? '', at: Date.now(), fingerprint, via: info.via }
    })
    const before = app.settings?.officeConfigPath ?? ''
    if (info.configPath && info.configPath.toLowerCase() !== (this.officePath || before).toLowerCase()) {
      // use the admin's config file when this PC can read it; otherwise stay on the pasted key alone
      const r = await host.office.load(info.configPath).catch(() => ({ error: 'unreachable' }))
      if (r.error && before) await host.office.load(before).catch(() => {})
      else if (app.settings) app.settings.officeConfigPath = info.configPath
    }
    await app.reloadOffice()
    await this.refreshMeta()
    return fingerprint
  }

  async acceptInvite(i: OfficeInvite) {
    try {
      const r = await lan.call<{ key: string; configPath: string; officeName: string; adminName: string }>('invite.accept', i.id)
      await this.joinWithKey(r.key, { via: 'invite', officeName: r.officeName, by: r.adminName, configPath: r.configPath })
      app.toast('success', `This PC joined ${r.officeName}`, 'Colleagues appear under People in a few seconds.')
    } catch (e: any) {
      app.toast('error', "Couldn't join", e.message)
    }
  }

  ignoreInvite(i: OfficeInvite) {
    this.invites = this.invites.filter((x) => x.id !== i.id)
    void lan.call('invite.ignore', i.id).catch(() => {})
  }

  /** Forget the locally stored key (the shared config's key, if any, still applies). */
  async leave() {
    app.updateSettings({ officeKeyOverride: '', officeJoined: undefined })
    await this.refreshMeta()
  }

  // ---- people ---------------------------------------------------------------------

  openLink(link: ShareLink) {
    return link.dir ? app.active.navigate(link.path) : app.reveal(link.path)
  }

  history(user: string) {
    return lan.call<HistoryItem[]>('history.with', user)
  }
}

export const lanx = new LanExtras()
// test hook, next to window.__hopper
;(window as any).__hopperLan = { lanx, call: (m: string, ...p: unknown[]) => lan.call(m, ...p) }
