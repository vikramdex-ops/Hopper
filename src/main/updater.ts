// Silent updates from GitHub Releases: check in the background, download, apply on quit.
import type { AppUpdater } from 'electron-updater'
import { ctx } from './ctx'

let state: { status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error'; version?: string; percent?: number; error?: string } = {
  status: 'idle'
}

function send() {
  ctx.win?.webContents.send('hopper:update', state)
}

let started = false
let autoUpdater: AppUpdater
// electron-updater pulls in a lot of modules; load it only in installed builds that use it.
export async function initUpdater() {
  if (started) return
  started = true
  autoUpdater = (await import('electron-updater')).autoUpdater
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => ((state = { status: 'checking' }), send()))
  autoUpdater.on('update-available', (i) => ((state = { status: 'available', version: i.version }), send()))
  autoUpdater.on('update-not-available', () => ((state = { status: 'none' }), send()))
  autoUpdater.on('download-progress', (p) => ((state = { ...state, status: 'downloading', percent: Math.round(p.percent) }), send()))
  autoUpdater.on('update-downloaded', (i) => ((state = { status: 'ready', version: i.version }), send()))
  autoUpdater.on('error', (e) => ((state = { status: 'error', error: String(e?.message ?? e) }), send()))
  setTimeout(() => void autoUpdater.checkForUpdates().catch(() => {}), 15000)
  setInterval(() => void autoUpdater.checkForUpdates().catch(() => {}), 6 * 3600 * 1000).unref()
}

export async function checkForUpdates() {
  await initUpdater()
  try {
    await autoUpdater.checkForUpdates()
  } catch (e: any) {
    state = { status: 'error', error: String(e?.message ?? e) }
  }
  return state
}

export function installUpdate() {
  ctx.quitting = true
  autoUpdater.quitAndInstall(true, true)
}

export function updaterState() {
  return state
}
