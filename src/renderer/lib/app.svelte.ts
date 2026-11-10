// Application state and operations. Components read from `app` and call its methods;
// file work goes to the engine, sharing to the LAN process, OS integration to main.
import type { Component } from 'svelte'
import { engine, host, lan } from './api'
import { Pane, VIRTUAL, isArchivePath, isVirtual, splitArchive, titleFor } from './pane.svelte'
import { basename, dirname, fmtSize, join, plural } from './format'
import { kindOf } from './filetypes'
import { lanx, receivedBody, receivedTitle } from './lan2.svelte'
import type {
  Conflict, DriveInfo, Entry, InboxItem, JobInfo, OfficeConfig, Peer, PeerGroup, QuickDest, Settings, ShareSpec, TabState, UndoRecord, Workspace
} from '@shared/types'

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'warning' | 'error'
  title: string
  body?: string
  actions?: { label: string; run: () => void }[]
  sticky?: boolean
  progress?: number
}

export interface MenuItem {
  id?: string
  label?: string
  icon?: string
  keys?: string
  disabled?: boolean
  checked?: boolean
  danger?: boolean
  separator?: boolean
  submenu?: MenuItem[]
  run?: () => void
}

interface DialogEntry {
  id: number
  component: Component<any>
  props: Record<string, unknown>
  resolve: (v: unknown) => void
}

export interface ShareState {
  shareId: string
  to: string
  state: string
  done: number
  total: number
  rate: number
  via?: string
  error?: string
}

let toastSeq = 0
let dialogSeq = 0

export class App {
  ready = $state(false)
  info = $state<any>(null)
  settings = $state<Settings | null>(null)
  office = $state<OfficeConfig | null>(null)
  officeError = $state('')
  panes = $state<Pane[]>([])
  activeIndex = $state<0 | 1>(0)
  drives = $state.raw<DriveInfo[]>([])
  jobs = $state.raw<JobInfo[]>([])
  conflicts = $state.raw<Conflict[]>([])
  undoList = $state.raw<UndoRecord[]>([])
  peers = $state.raw<Peer[]>([])
  groups = $state.raw<PeerGroup[]>([])
  inbox = $state.raw<InboxItem[]>([])
  shares = $state.raw<Record<string, ShareState>>({})
  lanStatus = $state<any>(null)
  incoming = $state.raw<any[]>([])
  toasts = $state<Toast[]>([])
  clientDownloads = $state.raw<{ id: string; title: string; downloads: number; first: boolean; at: number }[]>([])
  // raw: dialog props must stay plain objects (they are sent over IPC, which cannot clone proxies)
  dialogs = $state.raw<DialogEntry[]>([])
  menu = $state<{ x: number; y: number; items: MenuItem[]; native?: string[] } | null>(null)
  palette = $state(false)
  paletteMode = $state<'commands' | 'go'>('commands')
  quickLook = $state<Entry | null>(null)
  viewer = $state<{ entries: Entry[]; index: number } | null>(null)
  drawer = $state(false)
  maximized = $state(false)
  indexStatus = $state<any>(null)
  dark = $state(false)
  closedTabs: TabState[] = []
  /** internal drag payload, so dropping between panes knows the source */
  dragPaths: string[] = []

  private persistTimer?: ReturnType<typeof setTimeout>

  get active(): Pane {
    return this.panes[this.activeIndex] ?? this.panes[0]
  }
  get other(): Pane {
    return this.panes[this.activeIndex === 0 ? 1 : 0]
  }
  get dual() {
    return this.settings?.dual ?? true
  }

  activeJobs = $derived(this.jobs.filter((j) => ['running', 'queued', 'paused', 'waiting'].includes(j.state)))
  unseenInbox = $derived(this.inbox.filter((i) => !i.seen).length)

  // ---- boot -----------------------------------------------------------------

  async init() {
    const [info, settings, office] = await Promise.all([host.app.info(), host.settings.get(), host.office.get()])
    this.info = info
    this.settings = settings
    this.office = office.config
    this.officeError = office.error
    this.dark = info.dark
    this.applyTheme()
    document.documentElement.dataset.mica = info.win11 ? 'on' : 'off'
    if (settings.accent === 'system' && info.accent) this.setAccent(info.accent)
    else if (settings.accent !== 'system') this.setAccent(settings.accent)

    this.panes = [new Pane(this, 0, settings.panes[0]), new Pane(this, 1, settings.panes[1])]
    this.activeIndex = settings.activePane ?? 0
    this.wireEvents()
    lanx.init()
    this.ready = true
    await Promise.all(this.panes.map((p) => p.load()))
    void this.refreshDrives()
    setInterval(() => void this.refreshDrives(), 30000)
    window.addEventListener('focus', () => void this.refreshDrives())
    void engine.call('undo.list').then((l) => (this.undoList = l.slice(0, 30)))
    void engine.call('jobs.list').then((l) => (this.jobs = l))
    void lan.call('peers.list').then((p) => (this.peers = p)).catch(() => {})
    void lan.call('groups.list').then((g) => (this.groups = g)).catch(() => {})
    void lan.call('inbox.list').then((i) => (this.inbox = i)).catch(() => {})
    void lan.call('lan.status').then((s) => (this.lanStatus = s)).catch(() => {})
    this.configureIndex()
    host.win.isMaximized().then((m: boolean) => (this.maximized = m))
  }

  private wireEvents() {
    engine.on('job', (list: JobInfo[]) => {
      const map = new Map(this.jobs.map((j) => [j.id, j]))
      for (const j of list) map.set(j.id, j)
      this.jobs = [...map.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 200)
    })
    engine.on('jobs', (list: JobInfo[]) => (this.jobs = list))
    engine.on('job-finished', (j: JobInfo) => this.onJobFinished(j))
    // Dexterity Share: a client finished downloading one of my links
    engine.on('pubshare-download', (d: { id: string; title: string; downloads: number; first: boolean; at: number }) => {
      this.clientDownloads = [d, ...this.clientDownloads].slice(0, 100)
      const when = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(d.at))
      this.toast('success', `Your client downloaded ${d.title}`, `${when}${d.downloads > 1 ? ` · ${d.downloads} downloads so far` : ''}`, [{ label: 'My client links', run: () => void import('./commands').then((m) => m.dialogs.publicLinks?.()) }], true)
    })
    engine.on('conflict', (c: Conflict) => (this.conflicts = [...this.conflicts, c]))
    engine.on('undo', (l: UndoRecord[]) => (this.undoList = l))
    engine.on('dir-changed', ({ path }: { path: string }) => {
      for (const p of this.panes) if (p.path.toLowerCase() === path.toLowerCase()) void p.refresh()
    })
    engine.on('index', (s) => (this.indexStatus = s))
    lan.on('peers', (p: Peer[]) => (this.peers = p))
    lan.on('lan-status', (s) => (this.lanStatus = s))
    lan.on('share', (s: ShareState) => {
      this.shares = { ...this.shares, [`${s.shareId}|${s.to}`]: s }
      if (s.state === 'failed') this.toast('error', `Couldn't send to ${this.personName(s.to)}`, s.error)
    })
    lan.on('incoming', (r) => (this.incoming = [...this.incoming, r]))
    lan.on('received', (item: InboxItem) => {
      this.inbox = [item, ...this.inbox.filter((i) => i.id !== item.id)]
      // files land in a folder; messages, folder links and requests have none
      this.toast('success', receivedTitle(item), receivedBody(item), [
        ...(item.folder ? [{ label: 'Open', run: () => void this.active.navigate(item.folder) }] : []),
        ...(item.link ? [{ label: 'Open folder', run: () => void lanx.openLink(item.link!) }] : []),
        { label: 'Inbox', run: () => this.active.navigate(VIRTUAL.inbox) }
      ])
      if (!document.hasFocus()) new Notification(receivedTitle(item), { body: receivedBody(item) || 'Saved to your Hopper Inbox' })
      for (const p of this.panes) if (p.path === VIRTUAL.inbox || (item.folder && p.path.toLowerCase() === item.folder.toLowerCase())) void p.refresh()
    })
    host.onOpen((p: string) => void this.active.navigate(p, { newTab: true }))
    host.onTheme(({ dark }: { dark: boolean }) => {
      this.dark = dark
      this.applyTheme()
    })
    host.win.onState(({ maximized }: { maximized: boolean }) => (this.maximized = maximized))
    host.update.on((s: any) => {
      if (s.status === 'ready') this.toast('info', `Hopper ${s.version} is ready`, 'It installs when you quit, or restart now.', [{ label: 'Restart now', run: () => host.update.install() }], true)
    })
  }

  // ---- settings & theme -------------------------------------------------------

  applyTheme() {
    const t = this.settings?.theme ?? 'system'
    const dark = t === 'dark' || (t === 'system' && this.dark)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }

  setAccent(hex: string) {
    const root = document.documentElement.style
    // Fluent uses a darker accent on light, lighter on dark.
    root.setProperty('--accent-base', hex)
    const dark = document.documentElement.dataset.theme === 'dark'
    root.setProperty('--accent', dark ? `color-mix(in srgb, ${hex} 55%, white)` : `color-mix(in srgb, ${hex} 88%, black)`)
    root.setProperty('--accent-hover', dark ? `color-mix(in srgb, ${hex} 45%, white)` : hex)
  }

  updateSettings(patch: Partial<Settings>) {
    if (!this.settings) return
    Object.assign(this.settings, patch)
    void host.settings.set($state.snapshot(patch))
    if ('theme' in patch) {
      this.applyTheme()
      if (this.info?.accent && this.settings.accent === 'system') this.setAccent(this.info.accent)
    }
    if ('indexRoots' in patch || 'indexEnabled' in patch) this.configureIndex()
  }

  persistSoon() {
    clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      if (!this.settings || this.panes.length < 2) return
      const panes = [this.panes[0].state(), this.panes[1].state()] as Settings['panes']
      this.settings.panes = panes
      void host.settings.set({ panes, activePane: this.activeIndex })
    }, 600)
  }

  configureIndex() {
    const s = this.settings
    if (!s) return
    const roots = s.indexEnabled ? (s.indexRoots.length ? s.indexRoots : this.defaultIndexRoots()) : []
    void engine.call('index.configure', roots)
  }

  defaultIndexRoots() {
    const roots = [this.info?.home].filter(Boolean)
    if (this.drives.some((d) => d.root === 'D:\\' && d.kind === 'fixed')) roots.push('D:\\')
    return roots
  }

  searchRoots() {
    const p = this.active.path
    if (!isVirtual(p) && !isArchivePath(p)) return [p]
    return this.settings?.indexRoots.length ? this.settings.indexRoots : this.defaultIndexRoots()
  }

  /** set by the screenshot studio so demo drives are not replaced by the real ones */
  freezeDrives = false

  async refreshDrives() {
    if (this.freezeDrives) return
    try {
      this.drives = await host.shell.drives()
    } catch {
      /* helper busy */
    }
  }

  async reloadOffice(path?: string) {
    const r = path ? await host.office.load(path) : await host.office.get()
    this.office = r.config
    this.officeError = r.error
    void lan.call('groups.list').then((g) => (this.groups = g)).catch(() => {})
  }

  // ---- panes ----------------------------------------------------------------

  setActive(i: 0 | 1) {
    if (this.activeIndex === i) return
    this.activeIndex = i
    this.persistSoon()
  }

  onPaneNavigated(_p: Pane) {
    const dirs = this.panes.filter((p, i) => i === 0 || this.dual).map((p) => p.path).filter((p) => !isVirtual(p) && !isArchivePath(p))
    void engine.call('watch.set', dirs)
    this.persistSoon()
    const p = _p.path
    if (this.settings && !isVirtual(p) && !isArchivePath(p) && this.settings.recentFolders?.[0]?.toLowerCase() !== p.toLowerCase()) {
      this.updateSettings({ recentFolders: [p, ...(this.settings.recentFolders ?? []).filter((x) => x.toLowerCase() !== p.toLowerCase())].slice(0, 15) })
    }
  }

  toggleDual() {
    this.updateSettings({ dual: !this.dual })
    if (!this.dual) this.activeIndex = 0
    this.onPaneNavigated(this.active)
  }

  async openEntry(e: Entry, opts: { newTab?: boolean; otherPane?: boolean } = {}) {
    const pane = opts.otherPane && this.dual ? this.other : this.active
    if (e.dir) return pane.navigate(e.path, { newTab: opts.newTab })
    if (isArchivePath(e.path)) {
      const { file, inner } = splitArchive(e.path)
      try {
        const local = await engine.call<string>('archive.openEntry', file, inner)
        await host.shell.open(local)
      } catch (err: any) {
        this.toast('error', `Couldn't open ${e.name}`, err.message)
      }
      return
    }
    if (kindOf(e.ext) === 'archive' && !e.ext.match(/^(exe|msi)$/)) return pane.navigate(`${e.path}::`, { newTab: opts.newTab })
    try {
      await host.shell.open(e.path)
    } catch (err: any) {
      this.toast('error', `Couldn't open ${e.name}`, err.message)
    }
  }

  saveWorkspace(name: string) {
    const ws: Workspace = { id: `w${Date.now().toString(36)}`, name, panes: [this.panes[0].state(), this.panes[1].state()], dual: this.dual }
    this.updateSettings({ workspaces: [...(this.settings?.workspaces ?? []), ws] })
    this.toast('success', `Saved workspace "${name}"`)
  }

  async openWorkspace(ws: Workspace) {
    this.updateSettings({ dual: ws.dual })
    const panes = [new Pane(this, 0, ws.panes[0]), new Pane(this, 1, ws.panes[1])]
    this.panes = panes
    this.activeIndex = 0
    await Promise.all(panes.map((p) => p.load()))
    this.persistSoon()
  }

  // ---- toasts / dialogs / menus ---------------------------------------------

  toast(kind: Toast['kind'], title: string, body?: string, actions?: Toast['actions'], sticky = false) {
    const t: Toast = { id: ++toastSeq, kind, title, body, actions, sticky }
    this.toasts = [...this.toasts.slice(-4), t]
    if (!sticky) setTimeout(() => this.dismissToast(t.id), kind === 'error' ? 9000 : 5000)
    return t.id
  }

  dismissToast(id: number) {
    this.toasts = this.toasts.filter((t) => t.id !== id)
  }

  dialog<T = unknown>(component: Component<any>, props: Record<string, unknown> = {}) {
    return new Promise<T>((resolve) => {
      const id = ++dialogSeq
      this.dialogs = [...this.dialogs, { id, component, props, resolve: resolve as (v: unknown) => void }]
    })
  }

  closeDialog(id: number, value?: unknown) {
    const d = this.dialogs.find((x) => x.id === id)
    this.dialogs = this.dialogs.filter((x) => x.id !== id)
    d?.resolve(value)
  }

  openMenu(x: number, y: number, items: MenuItem[], native?: string[]) {
    this.menu = { x, y, items, native }
  }

  // ---- file operations ----------------------------------------------------------

  async copyToClipboard(cut = false) {
    const t = this.active.targets().filter((e) => !isVirtual(e.path) && !isArchivePath(e.path))
    if (!t.length) return
    await host.clip.writeFiles(t.map((e) => e.path), cut)
    this.cutPaths = cut ? new Set(t.map((e) => e.path.toLowerCase())) : new Set()
    this.toast('info', `${cut ? 'Cut' : 'Copied'} ${plural(t.length, 'item')}`, 'Paste here, in the other pane, or in Explorer')
  }
  cutPaths = $state.raw<Set<string>>(new Set())

  async paste(dest = this.active.path) {
    if (isVirtual(dest)) return this.toast('warning', "Can't paste here")
    const clip = await host.clip.read()
    if (!clip.paths?.length) {
      if (clip.text) return this.toast('info', 'The clipboard holds text, not files')
      return
    }
    if (isArchivePath(dest)) {
      const { file } = splitArchive(dest)
      await engine.call('archive.add', file, clip.paths)
      return
    }
    const sameFolder = clip.paths.every((p: string) => dirname(p).toLowerCase() === dest.toLowerCase())
    if (sameFolder && !clip.cut) {
      await engine.call('transfer.duplicate', clip.paths)
    } else {
      await this.transfer(clip.cut ? 'move' : 'copy', clip.paths, dest)
    }
    if (clip.cut) {
      await host.clip.writeText('')
      this.cutPaths = new Set()
    }
  }

  async transfer(op: 'copy' | 'move', sources: string[], dest: string, opts: { policy?: 'ask' | 'overwrite' | 'skip' | 'rename' | 'newer'; verify?: boolean; filter?: string } = {}) {
    if (!sources.length) return
    if (isArchivePath(dest)) {
      const { file } = splitArchive(dest)
      return engine.call('archive.add', file, sources)
    }
    const archived = sources.filter(isArchivePath)
    if (archived.length) {
      const { file } = splitArchive(archived[0])
      return engine.call('archive.extractEntries', file, archived.map((s) => splitArchive(s).inner), dest)
    }
    this.rememberDest(dest)
    this.drawer = true
    return engine.call('transfer.start', { op, sources, dest, policy: opts.policy ?? 'ask', verify: opts.verify ?? this.settings?.verifyCopies, filter: opts.filter })
  }

  rememberDest(path: string) {
    if (!this.settings || isVirtual(path)) return
    const list: QuickDest[] = this.settings.quickDests.filter((d) => d.path.toLowerCase() !== path.toLowerCase())
    const prev = this.settings.quickDests.find((d) => d.path.toLowerCase() === path.toLowerCase())
    list.unshift({ path, pinned: prev?.pinned ?? false, label: prev?.label, usedAt: Date.now() })
    const pinned = list.filter((d) => d.pinned)
    const recent = list.filter((d) => !d.pinned).slice(0, 10)
    this.updateSettings({ quickDests: [...pinned, ...recent] })
  }

  async deleteTargets(permanent = false) {
    const pane = this.active
    const t = pane.targets().filter((e) => !isVirtual(e.path))
    if (!t.length) return
    if (isArchivePath(t[0].path)) {
      const { file } = splitArchive(t[0].path)
      if (!(await this.confirm(`Delete ${plural(t.length, 'item')} from ${basename(file)}?`, 'This changes the archive and cannot be undone.', 'Delete'))) return
      await engine.call('archive.delete', file, t.map((e) => splitArchive(e.path).inner))
      return pane.refresh()
    }
    const needConfirm = permanent ? this.settings?.confirmPermanentDelete !== false : this.settings?.confirmDelete
    if (needConfirm) {
      const what = t.length === 1 ? `"${t[0].name}"` : plural(t.length, 'item')
      const ok = await this.confirm(permanent ? `Permanently delete ${what}?` : `Move ${what} to the Recycle Bin?`, permanent ? 'This cannot be undone.' : undefined, permanent ? 'Delete permanently' : 'Delete')
      if (!ok) return
    }
    const next = Math.min(pane.focus, pane.rows.length - t.length - 1)
    if (permanent) {
      const r = await engine.call('fs.deletePermanent', t.map((e) => e.path))
      if (r.failed.length) this.toast('error', `${plural(r.failed.length, 'item')} could not be deleted`, r.failed[0].message)
    } else {
      const r = await host.shell.trash(t.map((e) => e.path))
      if (r.done.length) {
        void engine.call('fs.recordRecycle', r.done)
        this.toast('info', `Deleted ${plural(r.done.length, 'item')}`, undefined, [{ label: 'Undo', run: () => void this.undo() }])
      }
      if (r.failed.length) this.toast('error', `${plural(r.failed.length, 'item')} could not be deleted`, r.failed[0].message)
    }
    await pane.refresh()
    pane.clearSelection()
    if (next >= 0) pane.selectIndex(Math.max(0, next))
  }

  async undo() {
    try {
      const r = await engine.call<{ label: string; ok: number; failed: string[] }>('undo.undo')
      this.toast(r.failed.length ? 'warning' : 'success', `Undid: ${r.label}`, r.failed.length ? `${plural(r.failed.length, 'item')} could not be restored` : undefined)
      for (const p of this.panes) void p.refresh()
    } catch (e: any) {
      this.toast('info', e.message.replace(/^Error:\s*/, ''))
    }
  }

  async newFolder() {
    const pane = this.active
    if (isVirtual(pane.path) || isArchivePath(pane.path)) return
    const p = await engine.call<string>('fs.mkdir', pane.path, 'New folder')
    await pane.load({ select: p })
    pane.renaming = p.toLowerCase()
  }

  async newFile(name = 'New Text Document.txt') {
    const pane = this.active
    if (isVirtual(pane.path) || isArchivePath(pane.path)) return
    const p = await engine.call<string>('fs.newFile', pane.path, name)
    await pane.load({ select: p })
    pane.renaming = p.toLowerCase()
  }

  async rename(e: Entry, newName: string) {
    newName = newName.trim()
    if (!newName || newName === e.name) return
    if (/[<>:"/\\|?*]/.test(newName)) return this.toast('error', 'A file name can’t contain any of these characters: \\ / : * ? " < > |')
    try {
      const to = await engine.call<string>('fs.rename', e.path, join(dirname(e.path), newName))
      await this.active.load({ select: to })
    } catch (err: any) {
      this.toast('error', 'Rename failed', err.message.replace(/^Error:\s*/, ''))
    }
  }

  async zip(presetId?: string, sources = this.active.targets().map((e) => e.path)) {
    if (!sources.length || sources.some((s) => isVirtual(s) || isArchivePath(s))) return
    this.drawer = true
    await engine.call('archive.create', sources, { presetId })
  }

  async extract(mode: 'smart' | 'here' | 'each' | 'to', dest?: string, files = this.active.targets().filter((e) => kindOf(e.ext) === 'archive').map((e) => e.path)) {
    if (!files.length) return
    this.drawer = true
    await engine.call('archive.extract', files, { mode, dest })
  }

  async share(spec: ShareSpec) {
    try {
      await lan.call('share.send', spec)
      this.drawer = true
      if (this.settings) this.updateSettings({ recentShares: [...new Set([...spec.to, ...this.settings.recentShares])].slice(0, 12) })
    } catch (e: any) {
      this.toast('error', 'Sharing failed', e.message)
    }
  }

  personName(user: string) {
    if (user.startsWith('group:')) return this.groups.find((g) => `group:${g.id}` === user)?.name ?? user
    return this.peers.find((p) => p.user === user)?.displayName ?? user
  }

  // ---- jobs -----------------------------------------------------------------

  private onJobFinished(j: JobInfo) {
    const where = j.output ?? j.dest
    for (const p of this.panes) {
      const pp = p.path.toLowerCase()
      if (where && (pp === where.toLowerCase() || pp === dirname(where).toLowerCase())) void p.refresh()
      else if (j.kind === 'move') void p.refresh()
    }
    if (j.state === 'done') {
      const actions = where ? [{ label: 'Show', run: () => void this.reveal(where) }] : undefined
      if (j.errors.length) this.toast('warning', `${j.title.replace(/^(\w+)ing/, (m) => m)} finished with ${plural(j.errors.length, 'problem')}`, j.errors[0]?.message, actions)
      else if (j.kind !== 'hash' && j.kind !== 'size') this.toast('success', doneTitle(j), undefined, actions)
    } else if (j.state === 'failed') {
      this.toast('error', `${j.title} failed`, j.error ?? j.errors[0]?.message)
    }
  }

  async reveal(path: string) {
    const parent = dirname(path)
    await this.active.navigate(parent, { select: path })
  }

  resolveConflict(c: Conflict, answer: string, all: boolean) {
    this.conflicts = this.conflicts.filter((x) => x.conflictId !== c.conflictId && !(all && x.jobId === c.jobId))
    void engine.call('jobs.resolve', c.jobId, c.conflictId, answer, all)
  }

  // ---- helpers -----------------------------------------------------------------

  confirmImpl?: (title: string, body?: string, ok?: string) => Promise<boolean>
  promptImpl?: (title: string, value?: string, label?: string) => Promise<string | null>
  confirm(title: string, body?: string, ok = 'OK') {
    return this.confirmImpl ? this.confirmImpl(title, body, ok) : Promise.resolve(window.confirm(title))
  }
  prompt(title: string, value = '', label?: string) {
    return this.promptImpl ? this.promptImpl(title, value, label) : Promise.resolve(window.prompt(title, value))
  }

  tabTitle(t: TabState) {
    return t.title || titleFor(t.path)
  }
}

function doneTitle(j: JobInfo) {
  switch (j.kind) {
    case 'copy': return `Copied ${plural(j.files, 'file')}`
    case 'move': return `Moved ${plural(Math.max(j.files, 1), 'item')}`
    case 'zip': return `Created ${basename(j.output ?? '')}`
    case 'extract': return `Extracted to ${basename(j.output ?? '')}`
    case 'package': return 'Lot package ready'
    case 'pdf': return 'PDF ready'
    default: return `${j.title} — done`
  }
}

export const app = new App()
