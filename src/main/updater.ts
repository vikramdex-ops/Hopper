// Silent updates from GitHub Releases: check in the background, download, apply on quit.
import type { AppUpdater } from 'electron-updater'
import { app } from 'electron'
import { ctx, sendToWindow } from './ctx'

let state: { status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error' | 'unavailable'; version?: string; percent?: number; error?: string } = {
  status: 'idle'
}

function send() {
  sendToWindow('hopper:update', state)
}

/** Plain words for the failures people actually meet; the raw text is kept for anything else. */
function friendly(e: unknown) {
  const m = String((e as Error)?.message ?? e)
  if (/ENOTFOUND|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ENETUNREACH|ETIMEDOUT|ERR_CONNECTION|ECONNRESET|ERR_NETWORK/i.test(m)) return 'No connection to the update server. Hopper will try again later.'
  if (/latest\.yml|404|Cannot find.*release|No published versions/i.test(m)) return 'No update information is published yet. Hopper will try again later.'
  if (/app-update\.yml/i.test(m)) return 'This copy of Hopper was not installed with the installer, so it cannot update itself. Install Hopper from the download page to get updates.'
  if (/403|rate limit/i.test(m)) return 'The update server is busy. Hopper will try again later.'
  return m.split('\n')[0].slice(0, 200)
}

let loading: Promise<AppUpdater | null> | undefined
let autoUpdater: AppUpdater | null = null

// electron-updater pulls in a lot of modules; load it only in installed builds that use it.
async function load(): Promise<AppUpdater | null> {
  if (!app.isPackaged) return null
  try {
    // The package is CommonJS: depending on how it is loaded, its exports sit on the module
    // itself or under `default`. Accept both; 2.0.0 read only the first and got undefined.
    const mod: any = await import('electron-updater')
    const u: AppUpdater | undefined = mod.autoUpdater ?? mod.default?.autoUpdater
    if (!u) throw new Error('The update component could not be loaded')
    u.autoDownload = true
    u.autoInstallOnAppQuit = true
    u.on('checking-for-update', () => ((state = { status: 'checking' }), send()))
    u.on('update-available', (i) => ((state = { status: 'available', version: i.version }), send()))
    u.on('update-not-available', () => ((state = { status: 'none' }), send()))
    u.on('download-progress', (p) => ((state = { ...state, status: 'downloading', percent: Math.round(p.percent) }), send()))
    u.on('update-downloaded', (i) => ((state = { status: 'ready', version: i.version }), send()))
    u.on('error', (e) => ((state = { status: 'error', error: friendly(e) }), send()))
    autoUpdater = u
    return u
  } catch (e) {
    state = { status: 'error', error: friendly(e) }
    send()
    loading = undefined // allow another attempt later
    return null
  }
}

const updater = () => (loading ??= load())

let scheduled = false
export async function initUpdater() {
  if (scheduled) return
  scheduled = true
  const tick = async () => {
    const u = await updater()
    await u?.checkForUpdates().catch(() => {})
  }
  setTimeout(() => void tick(), 15000)
  setInterval(() => void tick(), 6 * 3600 * 1000).unref()
}

export async function checkForUpdates() {
  if (!app.isPackaged) return (state = { status: 'unavailable' })
  const u = await updater()
  if (!u) return state
  try {
    await u.checkForUpdates()
  } catch (e) {
    state = { status: 'error', error: friendly(e) }
  }
  return state
}

export function installUpdate() {
  if (!autoUpdater) return
  ctx.quitting = true
  autoUpdater.quitAndInstall(true, true)
}

export function updaterState() {
  return state
}
