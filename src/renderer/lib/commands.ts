// The single command registry: the palette, menus, command bar tooltips, the shortcut sheet
// and the keyboard handler all read from here, so a label and its key can never disagree.
import { app } from './app.svelte'
import { host, engine } from './api'
import { VIRTUAL, isArchivePath, isVirtual } from './pane.svelte'
import { kindOf } from './filetypes'
import { dirname } from './format'
import { copyPaths, PATH_MODES, type PathMode } from './pathcopy'
import { net } from './network.svelte'

export interface Command {
  id: string
  label: string
  group: string
  icon?: string
  keys?: string[]
  /** shown in the palette only when true */
  when?: () => boolean
  run: () => unknown
}

const T = () => app.active.targets()
const real = () => !isVirtual(app.active.path)
const writable = () => real() && !isArchivePath(app.active.path)
const hasTargets = () => T().length > 0
const isArchiveSel = () => T().some((e) => kindOf(e.ext) === 'archive')
const isPdfSel = () => T().length > 0 && T().every((e) => e.ext === 'pdf')

/** Dialog openers are registered by components at startup (avoids import cycles). */
export const dialogs: Record<string, (...args: any[]) => unknown> = {}
const open = (name: string, ...args: any[]) => () => dialogs[name]?.(...args)

export const commands: Command[] = [
  // navigation
  { id: 'nav.back', label: 'Back', group: 'Navigate', icon: 'back', keys: ['Alt+Left', 'Backspace', 'BrowserBack'], run: () => app.active.back() },
  { id: 'nav.forward', label: 'Forward', group: 'Navigate', icon: 'forward', keys: ['Alt+Right', 'BrowserForward'], run: () => app.active.forward() },
  { id: 'nav.up', label: 'Up one level', group: 'Navigate', icon: 'up', keys: ['Alt+Up'], run: () => app.active.up() },
  { id: 'nav.refresh', label: 'Refresh', group: 'Navigate', icon: 'refresh', keys: ['F5', 'Ctrl+R'], run: () => app.active.refresh() },
  { id: 'nav.address', label: 'Edit address', group: 'Navigate', icon: 'edit', keys: ['Ctrl+L', 'Alt+D', 'F4'], run: open('address') },
  { id: 'nav.go', label: 'Go to folder…', group: 'Navigate', icon: 'search', keys: ['Ctrl+G'], run: () => { app.paletteMode = 'go'; app.palette = true } },
  { id: 'nav.home', label: 'Home', group: 'Navigate', icon: 'home', keys: ['Alt+Home'], run: () => app.active.navigate(VIRTUAL.home) },
  { id: 'nav.inbox', label: 'Open Inbox', group: 'Navigate', icon: 'inbox', keys: ['Ctrl+Shift+I'], run: () => app.active.navigate(VIRTUAL.inbox) },
  { id: 'nav.activity', label: 'Open Activity', group: 'Navigate', icon: 'activity', run: () => app.active.navigate(VIRTUAL.activity) },
  { id: 'nav.recycle', label: 'Open Recycle Bin', group: 'Navigate', icon: 'trash', run: () => app.active.navigate(VIRTUAL.recycle) },
  { id: 'nav.network', label: 'Open Network', group: 'Navigate', icon: 'network', run: () => app.active.navigate(VIRTUAL.network) },
  { id: 'net.addPlace', label: 'Add a network place…', group: 'Navigate', icon: 'network', run: () => net.addPlace() },
  { id: 'nav.switchPane', label: 'Switch pane', group: 'Navigate', icon: 'dualPane', keys: ['Tab'], when: () => app.dual, run: () => app.setActive(app.activeIndex === 0 ? 1 : 0) },
  { id: 'nav.mirror', label: 'Open this folder in the other pane', group: 'Navigate', icon: 'dualPane', keys: ['Ctrl+Shift+M'], when: () => app.dual, run: () => app.other.navigate(app.active.path) },
  { id: 'nav.swap', label: 'Swap panes', group: 'Navigate', icon: 'compare', keys: ['Ctrl+U'], when: () => app.dual, run: () => { const a = app.panes[0].path; const b = app.panes[1].path; void app.panes[0].navigate(b); void app.panes[1].navigate(a) } },

  // tabs
  { id: 'tab.new', label: 'New tab', group: 'Tabs', icon: 'plus', keys: ['Ctrl+T'], run: () => { app.active.openTab(app.active.path); void app.active.load() } },
  { id: 'tab.close', label: 'Close tab', group: 'Tabs', icon: 'close', keys: ['Ctrl+W', 'Ctrl+F4'], run: () => app.active.closeTab() },
  { id: 'tab.reopen', label: 'Reopen closed tab', group: 'Tabs', icon: 'history', keys: ['Ctrl+Shift+T'], run: () => { const t = app.closedTabs.pop(); if (t) { app.active.openTab(t.path); void app.active.load() } } },
  { id: 'tab.next', label: 'Next tab', group: 'Tabs', keys: ['Ctrl+Tab'], run: () => app.active.switchTab((app.active.active + 1) % app.active.tabs.length) },
  { id: 'tab.prev', label: 'Previous tab', group: 'Tabs', keys: ['Ctrl+Shift+Tab'], run: () => app.active.switchTab((app.active.active - 1 + app.active.tabs.length) % app.active.tabs.length) },
  { id: 'tab.lock', label: 'Lock / unlock tab', group: 'Tabs', icon: 'lock', run: () => { app.active.tab.locked = !app.active.tab.locked; app.persistSoon() } },

  // clipboard & file ops
  { id: 'file.copy', label: 'Copy', group: 'Edit', icon: 'copy', keys: ['Ctrl+C'], when: hasTargets, run: () => app.copyToClipboard(false) },
  { id: 'file.cut', label: 'Cut', group: 'Edit', icon: 'cut', keys: ['Ctrl+X'], when: hasTargets, run: () => app.copyToClipboard(true) },
  { id: 'file.paste', label: 'Paste', group: 'Edit', icon: 'paste', keys: ['Ctrl+V'], when: real, run: () => app.paste() },
  { id: 'file.copyTo', label: 'Copy to…', group: 'Edit', icon: 'copy', keys: ['Ctrl+Alt+C'], when: hasTargets, run: open('copyTo', 'copy') },
  { id: 'file.moveTo', label: 'Move to…', group: 'Edit', icon: 'cut', keys: ['Ctrl+Alt+M', 'F6'], when: hasTargets, run: open('copyTo', 'move') },
  { id: 'file.copyOther', label: 'Copy to other pane', group: 'Edit', icon: 'copy', keys: ['Ctrl+F5'], when: () => app.dual && hasTargets(), run: () => app.transfer('copy', T().map((e) => e.path), app.other.path) },
  { id: 'file.moveOther', label: 'Move to other pane', group: 'Edit', icon: 'cut', keys: ['Ctrl+F6'], when: () => app.dual && hasTargets(), run: () => app.transfer('move', T().map((e) => e.path), app.other.path) },
  { id: 'file.duplicate', label: 'Duplicate', group: 'Edit', icon: 'duplicate', when: () => writable() && hasTargets(), run: () => engine.call('transfer.duplicate', T().map((e) => e.path)) },
  { id: 'file.rename', label: 'Rename', group: 'Edit', icon: 'rename', keys: ['F2'], when: hasTargets, run: () => { const t = T(); if (t.length > 1) dialogs.massRename?.(t); else if (t[0]) app.active.renaming = t[0].path.toLowerCase() } },
  { id: 'file.massRename', label: 'Rename many…', group: 'Edit', icon: 'rename', keys: ['Ctrl+Shift+R'], when: hasTargets, run: () => dialogs.massRename?.(T()) },
  { id: 'file.delete', label: 'Delete', group: 'Edit', icon: 'delete', keys: ['Delete', 'Ctrl+D'], when: hasTargets, run: () => app.deleteTargets(false) },
  { id: 'file.deletePerm', label: 'Delete permanently', group: 'Edit', icon: 'delete', keys: ['Shift+Delete'], when: hasTargets, run: () => app.deleteTargets(true) },
  { id: 'file.undo', label: 'Undo', group: 'Edit', icon: 'undo', keys: ['Ctrl+Z'], run: () => app.undo() },
  { id: 'file.history', label: 'Undo history…', group: 'Edit', icon: 'history', run: open('undoHistory') },
  { id: 'file.newFolder', label: 'New folder', group: 'New', icon: 'newFolder', keys: ['Ctrl+Shift+N'], when: writable, run: () => app.newFolder() },
  { id: 'file.newFile', label: 'New text file', group: 'New', icon: 'newFile', keys: ['Ctrl+Alt+N'], when: writable, run: () => app.newFile() },
  { id: 'file.template', label: 'New from folder template…', group: 'New', icon: 'template', when: writable, run: open('template') },
  { id: 'file.open', label: 'Open', group: 'File', icon: 'open', keys: ['Enter'], when: hasTargets, run: () => { for (const e of T().slice(0, 12)) void app.openEntry(e) } },
  { id: 'file.openNewTab', label: 'Open in new tab', group: 'File', icon: 'plus', keys: ['Ctrl+Enter'], when: () => T().some((e) => e.dir), run: () => { for (const e of T().filter((x) => x.dir)) app.active.openTab(e.path, false) } },
  { id: 'file.openWith', label: 'Open with…', group: 'File', icon: 'openWith', when: () => T().length === 1 && !T()[0].dir, run: () => dialogs.openWith?.(T()[0]) },
  { id: 'file.properties', label: 'Properties', group: 'File', icon: 'info', keys: ['Alt+Enter'], when: real, run: () => dialogs.properties?.(T().length ? T().map((e) => e.path) : [app.active.path]) },
  { id: 'file.terminal', label: 'Open terminal here', group: 'File', icon: 'terminal', keys: ['Ctrl+`'], when: writable, run: () => host.shell.terminal(app.active.path) },
  { id: 'file.copyPath', label: 'Copy path', group: 'Path Copy', icon: 'copyPath', keys: ['Ctrl+Shift+C'], run: () => copyPaths((app.settings?.pathCopy?.defaultMode as PathMode) || 'path') },
  ...PATH_MODES.map((m) => ({ id: `path.${m.id}`, label: `Copy ${m.label}`, group: 'Path Copy', icon: 'copyPath', run: () => copyPaths(m.id) })),
  { id: 'file.print', label: 'Print', group: 'File', icon: 'print', keys: ['Ctrl+P'], when: () => hasTargets() && T().every((e) => !e.dir), run: () => host.shell.print(T().map((e) => e.path)) },
  { id: 'file.checksum', label: 'Checksum (SHA-256)…', group: 'File', icon: 'checksum', when: () => T().length === 1 && !T()[0].dir, run: open('checksum') },
  { id: 'file.size', label: 'Calculate folder sizes', group: 'File', icon: 'size', keys: ['Ctrl+Shift+S'], when: real, run: open('folderSize') },

  // archives
  { id: 'zip.here', label: 'Zip here (one key)', group: 'Archive', icon: 'zip', keys: ['Ctrl+Alt+Z'], when: () => writable() && hasTargets(), run: () => app.zip(app.settings?.defaultPreset) },
  { id: 'zip.dialog', label: 'Compress with options…', group: 'Archive', icon: 'zip', keys: ['Ctrl+Shift+Z'], when: () => writable() && hasTargets(), run: open('zip') },
  { id: 'zip.extractSmart', label: 'Extract here (smart)', group: 'Archive', icon: 'extract', keys: ['Ctrl+Alt+X'], when: isArchiveSel, run: () => app.extract('smart') },
  { id: 'zip.extractEach', label: 'Extract each to its own folder', group: 'Archive', icon: 'extract', when: isArchiveSel, run: () => app.extract('each') },
  { id: 'zip.extractTo', label: 'Extract to…', group: 'Archive', icon: 'extract', when: isArchiveSel, run: async () => { const d = await host.dialog.folder('Extract to'); if (d) void app.extract('to', d) } },
  { id: 'zip.extractOther', label: 'Extract to other pane', group: 'Archive', icon: 'extract', when: () => app.dual && isArchiveSel(), run: () => app.extract('to', app.other.path) },

  // share
  { id: 'share.send', label: 'Share with people…', group: 'Share', icon: 'share', keys: ['Ctrl+Shift+Enter', 'Ctrl+Alt+S'], when: () => hasTargets() && real(), run: open('share') },
  { id: 'share.clientLink', label: 'Create client link… (Dexterity Share)', group: 'Share', icon: 'link', keys: ['Ctrl+Alt+L'], when: () => hasTargets() && real(), run: () => dialogs.publicLink?.() },
  { id: 'share.clientLinks', label: 'My client links', group: 'Share', icon: 'link', keys: ['Ctrl+Alt+K'], run: open('publicLinks') },
  { id: 'share.browser', label: 'Create client links in a browser…', group: 'Share', icon: 'cloud', run: open('publicLinks', true) },
  { id: 'share.setup', label: 'Set up Dexterity Share on this PC…', group: 'Share', icon: 'cloud', run: open('shareServer') },
  { id: 'share.announcements', label: 'Announcements', group: 'Share', icon: 'bell', run: open('announcements') },
  { id: 'share.announce', label: 'New announcement…', group: 'Share', icon: 'bell', when: () => !!app.lanStatus?.canAnnounce, run: () => dialogs.announce?.() },
  { id: 'share.people', label: 'People on the network', group: 'Share', icon: 'people', run: open('people') },

  // view
  { id: 'view.details', label: 'Details view', group: 'View', icon: 'details', keys: ['Ctrl+Shift+6'], run: () => { app.active.view = 'details'; app.persistSoon() } },
  { id: 'view.list', label: 'List view', group: 'View', icon: 'list', keys: ['Ctrl+Shift+5'], run: () => { app.active.view = 'list'; app.persistSoon() } },
  { id: 'view.grid', label: 'Thumbnails view', group: 'View', icon: 'grid', keys: ['Ctrl+Shift+2'], run: () => { app.active.view = 'grid'; app.persistSoon() } },
  { id: 'view.dual', label: 'Dual pane', group: 'View', icon: 'dualPane', keys: ['F10', 'Ctrl+Shift+D'], run: () => app.toggleDual() },
  { id: 'view.sidebar', label: 'Show / hide sidebar', group: 'View', icon: 'sidebar', keys: ['Ctrl+Shift+B'], run: () => app.updateSettings({ sidebarCollapsed: !app.settings?.sidebarCollapsed }) },
  { id: 'view.inspector', label: 'Preview & details pane', group: 'View', icon: 'inspector', keys: ['Alt+P'], run: () => app.updateSettings({ inspector: !app.settings?.inspector }) },
  { id: 'view.hidden', label: 'Show hidden items', group: 'View', icon: 'hidden', keys: ['Ctrl+H'], run: () => app.updateSettings({ showHidden: !app.settings?.showHidden }) },
  { id: 'view.revisions', label: 'Group drawing revisions', group: 'View', icon: 'layers', keys: ['Ctrl+Shift+V'], run: () => app.updateSettings({ groupRevisions: !app.settings?.groupRevisions }) },
  { id: 'view.filter', label: 'Filter this folder', group: 'View', icon: 'filter', keys: ['Ctrl+F', 'F3'], run: open('filter') },
  { id: 'view.quicklook', label: 'Quick Look', group: 'View', icon: 'eye', keys: ['Space'], when: () => !!app.active.focused, run: () => (app.quickLook = app.quickLook ? null : app.active.focused ?? null) },
  { id: 'view.theme', label: 'Toggle light / dark', group: 'View', icon: 'moon', keys: ['Ctrl+Shift+L'], run: () => app.updateSettings({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }) },
  { id: 'view.fullscreen', label: 'Full screen', group: 'View', icon: 'fullscreen', keys: ['F11'], run: () => host.win.fullscreen(!document.fullscreenElement && !(window.outerHeight === screen.height)) },
  { id: 'view.transfers', label: 'Transfers', group: 'View', icon: 'activity', keys: ['Ctrl+J'], run: () => (app.drawer = !app.drawer) },

  // select
  { id: 'sel.all', label: 'Select all', group: 'Select', icon: 'selectAll', keys: ['Ctrl+A'], run: () => app.active.selectAll() },
  { id: 'sel.none', label: 'Select none', group: 'Select', keys: ['Escape'], run: () => app.active.clearSelection() },
  { id: 'sel.invert', label: 'Invert selection', group: 'Select', keys: ['Ctrl+I'], run: () => app.active.invertSelection() },
  { id: 'sel.pattern', label: 'Select by pattern…', group: 'Select', icon: 'filter', keys: ['Ctrl+Shift+A'], run: open('selectPattern') },
  { id: 'sel.sameType', label: 'Select same type', group: 'Select', run: () => { const f = app.active.focused; if (f) app.active.selectWhere((r) => r.ext === f.ext && r.dir === f.dir) } },

  // search & tools
  { id: 'search.focus', label: 'Search', group: 'Tools', icon: 'search', keys: ['Ctrl+E', 'Ctrl+Shift+F'], run: open('search') },
  { id: 'tools.dupes', label: 'Find duplicates…', group: 'Tools', icon: 'duplicate', run: open('dupes') },
  { id: 'tools.compare', label: 'Compare panes', group: 'Tools', icon: 'compare', keys: ['F9'], when: () => app.dual, run: open('compare') },
  { id: 'tools.package', label: 'Package a lot / transmittal…', group: 'Office', icon: 'package', keys: ['Ctrl+Shift+P'], run: open('packager') },
  { id: 'tools.pdf', label: 'PDF tools…', group: 'Office', icon: 'pdf', when: isPdfSel, run: open('pdf') },
  { id: 'tools.pdfMerge', label: 'Merge PDFs', group: 'Office', icon: 'merge', when: () => isPdfSel() && T().length > 1, run: open('pdf', 'merge') },
  { id: 'tools.workspaceSave', label: 'Save workspace…', group: 'Workspaces', icon: 'workspace', run: async () => { const n = await app.prompt('Save workspace', '', 'Name'); if (n) app.saveWorkspace(n) } },
  { id: 'tools.workspaces', label: 'Switch workspace…', group: 'Workspaces', icon: 'workspace', keys: ['Ctrl+Shift+W'], run: open('workspaces') },
  { id: 'tools.pin', label: 'Pin folder to Quick access', group: 'Navigate', icon: 'pin', keys: ['Ctrl+B'], when: real, run: () => { const p = (T().find((e) => e.dir) ?? null)?.path ?? app.active.path; const pins = app.settings?.pinned ?? []; if (!pins.some((x) => x.toLowerCase() === p.toLowerCase())) app.updateSettings({ pinned: [...pins, p] }); app.toast('success', 'Pinned to Quick access') } },

  // app
  { id: 'app.palette', label: 'Command palette', group: 'App', icon: 'command', keys: ['Ctrl+K', 'Ctrl+Shift+K'], run: () => { app.paletteMode = 'commands'; app.palette = !app.palette } },
  { id: 'app.settings', label: 'Settings', group: 'App', icon: 'settings', keys: ['Ctrl+,'], run: open('settings') },
  { id: 'app.shortcuts', label: 'Keyboard shortcuts', group: 'App', icon: 'keyboard', keys: ['Ctrl+/', 'F1'], run: open('shortcuts') },
  { id: 'app.devtools', label: 'Developer tools', group: 'App', icon: 'code', keys: ['Ctrl+Shift+F12'], run: () => host.win.devtools() },
  { id: 'app.quit', label: 'Quit Hopper', group: 'App', keys: ['Ctrl+Q'], run: () => host.app.quit() }
]

export const byId = new Map(commands.map((c) => [c.id, c]))
export const keyLabel = (id: string) => byId.get(id)?.keys?.[0]?.replace('Delete', 'Del') ?? ''
export const run = (id: string) => byId.get(id)?.run()

/** Normalise a KeyboardEvent to "Ctrl+Shift+K" form. */
export function eventKey(e: KeyboardEvent) {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  let k = e.key
  if (k === ' ') k = 'Space'
  else if (k.startsWith('Arrow')) k = k.slice(5)
  else if (k.length === 1) k = k.toUpperCase()
  if (e.code === 'Backquote') k = '`'
  if (e.code.startsWith('Digit') && e.shiftKey) k = e.code.slice(5)
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return ''
  parts.push(k)
  return parts.join('+')
}

const keymap = new Map<string, Command>()
for (const c of commands) for (const k of c.keys ?? []) if (!keymap.has(k)) keymap.set(k, c)

/** Keys the file list handles itself when it has focus. */
const LIST_KEYS = new Set(['Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Shift+Up', 'Shift+Down', 'Shift+Home', 'Shift+End', 'Ctrl+Up', 'Ctrl+Down', 'Ctrl+Space', 'Shift+PageUp', 'Shift+PageDown'])

export function handleGlobalKey(e: KeyboardEvent) {
  const k = eventKey(e)
  if (!k) return false
  const t = e.target as HTMLElement
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
  // While a dialog, menu or overlay is open, only Ctrl+K style app keys go through.
  const overlay = app.dialogs.length > 0 || app.menu || app.palette || app.viewer
  if (typing && !/^(Ctrl\+K|Ctrl\+,|F1)$/.test(k)) return false
  if (overlay && !/^(Ctrl\+K|Ctrl\+Q)$/.test(k)) return false
  if (app.quickLook && k !== 'Space' && k !== 'Escape' && !LIST_KEYS.has(k)) return false
  if (LIST_KEYS.has(k)) return false
  const cmd = keymap.get(k)
  if (!cmd) return false
  if (cmd.when && !cmd.when()) return false
  e.preventDefault()
  void cmd.run()
  return true
}

export function canUseOther() {
  return app.dual && !isVirtual(app.other.path)
}

export const parentOf = dirname
