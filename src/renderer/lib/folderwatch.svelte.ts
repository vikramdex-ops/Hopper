// Watch this folder: the window's side. The engine lists the folders and sends one notice per
// settled burst ('folder-watch'); here they become toasts, the sidebar's unread counts and
// Activity entries. Windows notifications and the Dexterity Connect copy are sent by the
// main and LAN processes, so they also arrive while the window is hidden in the tray.
import { app } from './app.svelte'
import { engine, host } from './api'
import { basename, dirname } from './format'
import { batchSize, cleanWatched, isWithin, newWatchedFolder, type FolderWatchEvent, type FolderWatchStatus, type WatchedFolder } from '@shared/folderwatch'

class WatchUi {
  /** newest first, this session only */
  events = $state.raw<FolderWatchEvent[]>([])
  /** watched folder id -> changed items not yet looked at */
  unread = $state<Record<string, number>>({})
  status = $state.raw<FolderWatchStatus[]>([])
  private started = false

  get folders(): WatchedFolder[] {
    return (app.settings?.watchedFolders ?? []).map(cleanWatched).filter((w): w is WatchedFolder => !!w)
  }

  init() {
    if (this.started) return
    this.started = true
    engine.on('folder-watch', (ev: FolderWatchEvent) => this.onEvent(ev))
    engine.on('folder-watch-status', (s: FolderWatchStatus[]) => (this.status = s))
    void engine.call<FolderWatchStatus[]>('folderWatch.status').then((s) => (this.status = s)).catch(() => {})
    host.onWatchOpen(({ folder, select }: { folder: string; select?: string }) => {
      const w = this.folders.find((x) => x.path.toLowerCase() === folder?.toLowerCase())
      if (select) void app.reveal(select)
      else if (folder) void app.active.navigate(folder)
      if (w) this.markRead(w.id)
    })
  }

  private onEvent(ev: FolderWatchEvent) {
    this.events = [ev, ...this.events].slice(0, 200)
    const n = ev.counts.added + ev.counts.changed + ev.counts.removed
    this.unread = { ...this.unread, [ev.watchId]: (this.unread[ev.watchId] ?? 0) + n }
    for (const p of app.panes) if (isWithin(p.path, ev.folder)) void p.refresh()
    if (ev.quiet) return
    app.toast('info', ev.title, ev.body, [
      { label: 'Open', run: () => void this.open(ev) },
      { label: 'Show in folder', run: () => void this.show(ev) }
    ])
  }

  /** The one file of a single-file notice; otherwise the folder. */
  open(ev: FolderWatchEvent) {
    const files = [...ev.added, ...ev.changed]
    this.markRead(ev.watchId)
    if (batchSize(ev) === 1 && files.length === 1) return app.openEntry({ name: basename(files[0]), path: files[0], dir: false, size: 0, mtime: 0, ctime: 0, atime: 0, attrs: 0, ext: basename(files[0]).split('.').pop()?.toLowerCase() ?? '' })
    return app.active.navigate(ev.folder)
  }

  /** The folder holding the (first) changed file, with that file selected. */
  show(ev: FolderWatchEvent) {
    this.markRead(ev.watchId)
    const first = ev.added[0] ?? ev.changed[0]
    if (first) return app.reveal(first)
    return app.active.navigate(ev.removed[0] ? dirname(ev.removed[0]) : ev.folder)
  }

  markRead(id: string) {
    if (this.unread[id]) this.unread = { ...this.unread, [id]: 0 }
  }

  /** A pane opened this folder (or one inside it): its news has been seen. */
  seen(path: string) {
    for (const w of this.folders) if (this.unread[w.id] && isWithin(path, w.path)) this.markRead(w.id)
  }

  watchedFolder(path: string) {
    return this.folders.find((w) => w.path.toLowerCase().replace(/\\+$/, '') === path.toLowerCase().replace(/\\+$/, ''))
  }

  statusOf(id: string) {
    return this.status.find((s) => s.id === id)
  }

  /** Watch this folder: opens the options (new or existing). */
  async watch(path: string) {
    const prev = this.watchedFolder(path)
    const { dialogs } = await import('./commands') // not at load time: commands imports this module
    const w = (await dialogs.watchFolder?.(prev ?? newWatchedFolder(path), !prev)) as WatchedFolder | undefined
    if (!w) return
    this.save(w)
    if (!prev) app.toast('success', `Watching ${basename(w.path) || w.path}`, 'New and changed files are announced here and in Windows notifications.')
  }

  save(w: WatchedFolder) {
    const list = this.folders
    const i = list.findIndex((x) => x.id === w.id)
    app.updateSettings({ watchedFolders: i >= 0 ? list.map((x) => (x.id === w.id ? w : x)) : [...list, w] })
  }

  stop(id: string) {
    app.updateSettings({ watchedFolders: this.folders.filter((x) => x.id !== id) })
    const { [id]: _, ...rest } = this.unread
    this.unread = rest
  }
}

export const watchUi = new WatchUi()
