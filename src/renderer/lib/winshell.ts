// Windows shell commands: the real Windows context menu ("More options"), Create shortcut and
// Run as administrator. The native work is in the helper (native/ShellMenu.cs) and main (ipc.ts).
import { app } from './app.svelte'
import { host } from './api'
import { isArchivePath, isVirtual, type Pane } from './pane.svelte'
import { basename, plural } from './format'

const clean = (e: unknown) =>
  String((e as any)?.message ?? e)
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '')

const realPath = (p: string) => !isVirtual(p) && !isArchivePath(p)

/** Items (or the folder background when nothing is selected) that Windows can show its menu for. */
export const canWindowsMenu = (pane: Pane, paths: string[]) => (paths.length ? paths.every(realPath) : realPath(pane.path))

/** Shows the Windows context menu at the mouse pointer; refreshes the pane when a command ran. */
export async function windowsMenu(pane: Pane, paths: string[], extended = false) {
  if (!canWindowsMenu(pane, paths)) return
  try {
    const r = (await host.shell.menu(paths, paths.length ? '' : pane.path, extended)) as { invoked: boolean; verb?: string }
    if (!r?.invoked) return
    // a shell extension may have renamed, deleted, created or mapped something
    void pane.refresh()
    if (app.dual && app.other !== pane && app.other.path.toLowerCase() === pane.path.toLowerCase()) void app.other.refresh()
    void app.refreshDrives()
  } catch (e) {
    app.toast('error', "Couldn't show the Windows menu", clean(e))
  }
}

/** "<name> - Shortcut.lnk" next to each item. */
export async function createShortcuts(paths: string[]) {
  if (!paths.length || !paths.every(realPath)) return
  try {
    const r = (await host.shell.createShortcut(paths)) as { done: string[]; failed: { path: string; message: string }[] }
    if (r.failed.length) app.toast('error', `Couldn't create ${plural(r.failed.length, 'shortcut')}`, `${basename(r.failed[0].path)}: ${r.failed[0].message}`)
    if (r.done.length) app.toast('success', r.done.length === 1 ? `Created ${basename(r.done[0])}` : `Created ${plural(r.done.length, 'shortcut')}`)
    void app.active.refresh()
  } catch (e) {
    app.toast('error', "Couldn't create the shortcut", clean(e))
  }
}

/** Windows asks for permission (UAC); saying no there is not an error. */
export async function runAsAdmin(path: string) {
  try {
    const r = (await host.shell.runAsAdmin(path)) as { ok: boolean; cancelled?: boolean; error?: string }
    if (!r.ok && !r.cancelled) app.toast('error', `Couldn't run ${basename(path)} as administrator`, r.error)
  } catch (e) {
    app.toast('error', `Couldn't run ${basename(path)} as administrator`, clean(e))
  }
}

// test hook, next to window.__hopper
;(window as any).__hopperShell = { windowsMenu, createShortcuts, canWindowsMenu }
