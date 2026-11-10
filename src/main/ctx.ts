// Shared main-process state and helpers.
import { app, MessageChannelMain, nativeTheme, type BrowserWindow, type Tray, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { trace } from '@shared/trace'
import type { HopperShell } from '@shared/hshell'
import type { OfficeStore, SettingsStore } from './store'
import { effectiveOffice } from './officeops'

export const res = (...p: string[]) => (app.isPackaged ? join(process.resourcesPath, ...p) : join(app.getAppPath(), ...p))
export const paths = {
  sevenZip: () => (app.isPackaged ? res('7zip', '7z.exe') : res('vendor', '7zip', '7z.exe')),
  helper: () => (app.isPackaged ? res('native', 'HopperShell.exe') : res('native', 'bin', 'HopperShell.exe'))
}


export const ctx: {
  win?: BrowserWindow
  tray?: Tray
  settings: SettingsStore
  office: OfficeStore
  shell: HopperShell
  engine?: UtilityProcess
  lan?: UtilityProcess
  quitting: boolean
  pendingOpen: string[]
} = {} as any

/** Give the renderer a direct MessagePort to each utility process. */
export function connectPorts() {
  trace('connecting ports')
  const wc = ctx.win?.webContents
  if (!wc) return
  for (const name of ['engine', 'lan'] as const) {
    const child = ctx[name]
    if (!child) continue
    const { port1, port2 } = new MessageChannelMain()
    child.postMessage({ type: 'port' }, [port1])
    wc.postMessage('hopper:port', { name }, [port2])
  }
}


export function pushOfficeToUtilities() {
  for (const name of ['engine', 'lan'] as const) {
    // the key the LAN really uses (shared config, else the joined one) and where announcements live
    ctx[name]?.postMessage({ type: 'office', office: effectiveOffice(), settings: ctx.settings.data, officePath: ctx.office.loadedFrom })
  }
}


export function overlayColors() {
  const dark = ctx.settings.data.theme === 'dark' || (ctx.settings.data.theme === 'system' && nativeTheme.shouldUseDarkColors)
  return dark ? { color: '#00000000', symbolColor: '#e6e6e6', height: 40 } : { color: '#00000000', symbolColor: '#1b1b1b', height: 40 }
}


export function applyTheme() {
  const t = ctx.settings.data.theme
  nativeTheme.themeSource = t
  try {
    ctx.win?.setTitleBarOverlay(overlayColors())
  } catch {
    /* overlay unsupported */
  }
}
