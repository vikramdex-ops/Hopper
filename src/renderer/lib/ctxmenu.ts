// Right-click menus for files and folder backgrounds. Common actions first; the full
// Windows shell menu (7-Zip, WinRAR, Send to…) is one click away under "Show more options".
import { app, type MenuItem } from './app.svelte'
import { byId, run, dialogs } from './commands'
import { host, engine } from './api'
import { isArchivePath, isVirtual, VIRTUAL, type Pane, type Row } from './pane.svelte'
import { kindOf } from './filetypes'
import { basename } from './format'

const cmd = (id: string, extra: Partial<MenuItem> = {}): MenuItem => {
  const c = byId.get(id)!
  return { label: c.label, icon: c.icon, keys: c.keys?.[0], run: () => run(id), disabled: c.when ? !c.when() : false, ...extra }
}

function destMenu(op: 'copy' | 'move', paths: string[]): MenuItem[] {
  const dests = app.settings?.quickDests ?? []
  const items: MenuItem[] = []
  if (app.dual && !isVirtual(app.other.path)) items.push({ label: `Other pane — ${basename(app.other.path) || app.other.path}`, icon: 'dualPane', run: () => app.transfer(op, paths, app.other.path) })
  for (const d of dests.slice(0, 12)) items.push({ label: d.label || basename(d.path) || d.path, icon: d.pinned ? 'pin' : 'folder', run: () => app.transfer(op, paths, d.path) })
  if (items.length) items.push({ separator: true })
  items.push({ label: 'Choose folder…', icon: 'folderOpen', run: () => dialogs.copyTo?.(op) })
  return items
}

function shareMenu(paths: string[]): MenuItem[] {
  const recent = app.settings?.recentShares ?? []
  const online = app.peers.filter((p) => !p.self && p.status !== 'offline')
  const people = [...new Set([...recent, ...online.map((p) => p.user)])].slice(0, 10)
  const items: MenuItem[] = people.map((u) => {
    const peer = app.peers.find((p) => p.user === u)
    return { label: app.personName(u), icon: u.startsWith('group:') ? 'people' : 'person', checked: false, run: () => dialogs.share?.([u], paths) }
  })
  for (const g of app.groups.slice(0, 6)) if (!people.includes(`group:${g.id}`)) items.push({ label: g.name, icon: 'people', run: () => dialogs.share?.([`group:${g.id}`], paths) })
  if (items.length) items.push({ separator: true })
  items.push({ label: 'Share with…', icon: 'at', keys: 'Ctrl+Shift+Enter', run: () => dialogs.share?.([], paths) })
  return items
}

function zipMenu(paths: string[]): MenuItem[] {
  const presets = app.settings?.archivePresets ?? []
  return [
    ...presets.map((p) => ({ label: p.name, icon: 'zip', keys: p.id === app.settings?.defaultPreset ? 'Ctrl+Alt+Z' : undefined, run: () => app.zip(p.id, paths) })),
    { separator: true },
    cmd('zip.dialog')
  ]
}

export function fileMenu(pane: Pane, targets: Row[]): MenuItem[] {
  if (!targets.length) return backgroundMenu(pane)
  const paths = targets.map((t) => t.path)
  const one = targets.length === 1 ? targets[0] : null
  const inArchive = targets.some((t) => isArchivePath(t.path))
  const virt = targets.some((t) => isVirtual(t.path))
  const archives = targets.filter((t) => kindOf(t.ext) === 'archive' && !isArchivePath(t.path))
  const pdfs = targets.filter((t) => t.ext === 'pdf')
  const allDirs = targets.every((t) => t.dir)
  const m: MenuItem[] = []

  m.push({ label: 'Open', icon: 'open', keys: 'Enter', run: () => targets.slice(0, 12).forEach((t) => void app.openEntry(t)) })
  if (allDirs) m.push({ label: 'Open in new tab', icon: 'plus', keys: 'Ctrl+Enter', run: () => targets.forEach((t) => pane.openTab(t.path, false)) })
  if (one?.dir && app.dual) m.push({ label: 'Open in other pane', icon: 'dualPane', run: () => app.other.navigate(one.path) })
  if (one && !one.dir && !inArchive) m.push(cmd('file.openWith'))
  if (archives.length) {
    m.push({ separator: true })
    m.push({ label: 'Extract here', icon: 'extract', keys: 'Ctrl+Alt+X', run: () => app.extract('smart', undefined, archives.map((a) => a.path)) })
    m.push({ label: 'Extract to…', icon: 'extract', submenu: [
      { label: 'Each to its own folder', run: () => app.extract('each', undefined, archives.map((a) => a.path)) },
      ...(app.dual ? [{ label: 'Other pane', icon: 'dualPane', run: () => app.extract('to', app.other.path, archives.map((a) => a.path)) }] : []),
      { label: 'Choose folder…', icon: 'folderOpen', run: async () => { const d = await host.dialog.folder('Extract to'); if (d) void app.extract('to', d, archives.map((a) => a.path)) } },
      { separator: true },
      { label: 'Extract here and delete archive', icon: 'delete', run: () => engine.call('archive.extract', archives.map((a) => a.path), { mode: 'smart', deleteAfter: true }) }
    ] })
    if (one) m.push({ label: 'Browse inside', icon: 'folderOpen', run: () => pane.navigate(`${one.path}::`) })
  }
  m.push({ separator: true })
  if (!virt) {
    m.push(cmd('file.cut'), cmd('file.copy'))
    if (one?.dir && !inArchive) m.push({ label: 'Paste into folder', icon: 'paste', run: () => app.paste(one.path) })
    m.push({ label: 'Copy to', icon: 'copy', submenu: destMenu('copy', paths) })
    if (!inArchive) m.push({ label: 'Move to', icon: 'cut', submenu: destMenu('move', paths) })
  }
  if (!virt && !inArchive) {
    m.push({ separator: true })
    m.push({ label: 'Share with', icon: 'share', submenu: shareMenu(paths) })
    m.push({ label: 'Compress to zip', icon: 'zip', submenu: zipMenu(paths) })
  }
  m.push({ separator: true })
  if (!virt) m.push(cmd('file.rename'))
  if (targets.length > 1 && !inArchive) m.push(cmd('file.massRename'))
  if (!virt && !inArchive) m.push(cmd('file.duplicate'))
  m.push(cmd('file.delete', { danger: true }))
  if (!virt && !inArchive && (pdfs.length || targets.length > 1)) {
    m.push({ separator: true })
    const office: MenuItem[] = []
    if (pdfs.length === targets.length) {
      office.push({ label: 'PDF tools…', icon: 'pdf', run: () => dialogs.pdf?.() })
      if (pdfs.length > 1) office.push({ label: 'Merge into one PDF', icon: 'merge', run: () => dialogs.pdf?.('merge') })
    }
    office.push({ label: 'Package as lot / transmittal…', icon: 'package', run: () => dialogs.packager?.(paths) })
    m.push({ label: 'Office tools', icon: 'package', submenu: office })
  }
  if (pane.path === VIRTUAL.recycle) {
    m.unshift({ label: 'Restore', icon: 'restore', run: async () => { const r = await host.shell.restore(paths); app.toast(r.failed.length ? 'warning' : 'success', `Restored ${r.restored.length} item(s)`, r.failed.length ? `${r.failed.length} could not be restored` : undefined); void pane.refresh() } }, { separator: true })
  }
  m.push({ separator: true })
  m.push(cmd('file.copyPath'))
  if (allDirs && one && !inArchive) m.push({ label: 'Pin to Quick access', icon: 'pin', run: () => app.updateSettings({ pinned: [...(app.settings?.pinned ?? []), one.path] }) })
  if (!virt && !inArchive) m.push(cmd('file.properties'))
  return m
}

export function backgroundMenu(pane: Pane): MenuItem[] {
  const virt = isVirtual(pane.path)
  const inArchive = isArchivePath(pane.path)
  const m: MenuItem[] = [
    { label: 'View', icon: 'view', submenu: [cmd('view.details', { checked: pane.view === 'details' }), cmd('view.list', { checked: pane.view === 'list' }), cmd('view.grid', { checked: pane.view === 'grid' }), { separator: true }, cmd('view.hidden', { checked: app.settings?.showHidden }), cmd('view.revisions', { checked: app.settings?.groupRevisions })] },
    { label: 'Sort by', icon: 'sort', submenu: (['name', 'mtime', 'type', 'size', 'ctime'] as const).map((k) => ({ label: { name: 'Name', mtime: 'Date modified', type: 'Type', size: 'Size', ctime: 'Date created' }[k], checked: pane.sort.key === k, run: () => pane.setSort(k) })) },
    cmd('nav.refresh'),
    { separator: true },
    cmd('file.paste', { disabled: virt })
  ]
  if (!virt && !inArchive) {
    m.push({ label: 'New', icon: 'plus', submenu: [cmd('file.newFolder'), cmd('file.newFile'), { separator: true }, cmd('file.template')] })
    m.push({ separator: true }, cmd('sel.all'), cmd('file.terminal'), cmd('file.size'), cmd('tools.pin'))
    m.push({ separator: true }, { label: 'Properties', icon: 'info', run: () => host.shell.properties([pane.path]) })
  }
  return m
}
