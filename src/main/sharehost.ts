// Dexterity Share on this PC: starts the share utility process when this PC is the office's share
// server (or while the setup wizard is open), keeps its configuration current, and stores the two
// secrets — the GitHub gist token and an optional Cloudflare tunnel token — encrypted with Windows
// data protection (Electron safeStorage) under userData. They never go into settings.json,
// office.json or the repository.
import { app, ipcMain, safeStorage, utilityProcess, type UtilityProcess } from 'electron'
import { existsSync, promises as fsp, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_PAGE_URL, DEFAULT_SHARE_SERVER, normalizeDays, type PublicShareConfig, type ShareServerSettings } from '@shared/pubshare'
import { ctx, officeListeners, sendToWindow } from './ctx'

let child: UtilityProcess | null = null
let seq = 0
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let stopped: (() => void) | null = null
let spawned = false
let queue: unknown[] = []

/** A utility process drops messages posted before it has started: hold them until it has. */
function send(msg: unknown) {
  const c = ensure()
  if (spawned) c.postMessage(msg)
  else queue.push(msg)
}

const dir = () => join(app.getPath('userData'), 'share')
const secretFile = (name: 'pointer' | 'tunnel') => join(dir(), `${name}-token.bin`)

function readSecret(name: 'pointer' | 'tunnel') {
  try {
    if (!safeStorage.isEncryptionAvailable()) return ''
    return safeStorage.decryptString(readFileSync(secretFile(name)))
  } catch {
    return ''
  }
}

async function writeSecret(name: 'pointer' | 'tunnel', value: string) {
  if (!value) {
    rmSync(secretFile(name), { force: true })
    return
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows cannot protect the token on this PC right now. Sign out and in again, then retry.')
  await fsp.mkdir(dir(), { recursive: true })
  await fsp.writeFile(secretFile(name), safeStorage.encryptString(value))
}

export const shareSettings = (): ShareServerSettings => ({ ...DEFAULT_SHARE_SERVER, ...((ctx.settings.data as any).shareServer ?? {}) })

function shareConfig(): PublicShareConfig {
  const c: Partial<PublicShareConfig> = (ctx.office.data as any)?.publicShare ?? {}
  const officeFile = ctx.office.loadedFrom || ctx.settings.data.officeConfigPath || ''
  return {
    enabled: !!c.enabled,
    store: c.store?.trim() || (officeFile ? join(dirname(officeFile), 'PublicShares') : ''),
    pageUrl: c.pageUrl?.trim() || DEFAULT_PAGE_URL,
    defaultDays: normalizeDays(c.defaultDays),
    pointer: c.pointer,
    minFreeGB: c.minFreeGB,
    host: c.host,
    web: c.web
  }
}

function ensure() {
  if (child) return child
  const c = utilityProcess.fork(join(__dirname, 'share.js'), [], {
    serviceName: 'Hopper share',
    stdio: 'inherit',
    env: { ...process.env, HOPPER_DATA: app.getPath('userData'), HOPPER_VERSION: app.getVersion() }
  })
  child = c
  spawned = false
  queue = []
  c.on('spawn', () => {
    spawned = true
    for (const m of queue.splice(0)) c.postMessage(m)
  })
  c.on('message', (msg: any) => {
    if (msg?.type === 'reply') {
      const w = waiting.get(msg.id)
      waiting.delete(msg.id)
      if (w) msg.ok ? w.resolve(msg.value) : w.reject(new Error(msg.error))
    } else if (msg?.type === 'share-changed' || msg?.type === 'share-progress') {
      sendToWindow('hopper:share', msg)
    } else if (msg?.type === 'stopped') stopped?.()
  })
  c.on('exit', (code) => {
    if (child === c) child = null
    for (const w of waiting.values()) w.reject(new Error('The share process stopped. Try again.'))
    waiting.clear()
    if (ctx.quitting) return
    console.error(`[hopper] share exited with ${code}`)
    if (shareSettings().enabled) setTimeout(() => pushShareConfig(), 2000)
  })
  return c
}

/** Send the current settings to the share process (starting it when this PC hosts the server). */
export function pushShareConfig(force = false) {
  const settings = shareSettings()
  if (!settings.enabled && !child && !force) return
  send({ type: 'config', config: { settings, share: shareConfig(), token: readSecret('pointer'), tunnelToken: readSecret('tunnel') } })
}

function call(method: string, ...args: unknown[]) {
  pushShareConfigOnce()
  return new Promise((resolve, reject) => {
    const id = ++seq
    waiting.set(id, { resolve, reject })
    send({ type: 'call', id, method, args })
  })
}

let pushed = false
function pushShareConfigOnce() {
  if (pushed && child) return
  pushed = true
  pushShareConfig(true)
}

export function initShareHost() {
  const h = (name: string, fn: (...args: any[]) => unknown) => ipcMain.handle(name, (_e, ...args) => fn(...args))
  h('share:state', async () => ({ ...((await call('state')) as object), settings: shareSettings(), tunnelTokenSaved: existsSync(secretFile('tunnel')), protected: safeStorage.isEncryptionAvailable() }))
  h('share:call', (method: 'checkToken' | 'probeCloudflared' | 'downloadCloudflared' | 'selfTest' | 'republish', ...args: unknown[]) => {
    if (!['checkToken', 'probeCloudflared', 'downloadCloudflared', 'selfTest', 'republish'].includes(method)) throw new Error('not allowed')
    return call(method, ...args)
  })
  /** Step 3: validates the token, creates or reuses the gist, and only then stores the token (encrypted). */
  h('share:connectPointer', async (token: string) => {
    const r = (await call('connectPointer', token)) as { gist: string; key: string; login: string; extraScopes: string[]; reused: boolean }
    await writeSecret('pointer', token.trim())
    return r
  })
  h('share:setTunnelToken', async (token: string) => {
    await writeSecret('tunnel', String(token ?? '').trim())
    pushShareConfig(true)
    return true
  })
  h('share:forgetToken', async () => {
    await writeSecret('pointer', '')
    pushShareConfig(true)
    return true
  })
  /** Save the per-PC settings. Switching the server on also makes Hopper start with Windows and stay in the tray. */
  h('share:configure', (patch: Partial<ShareServerSettings>) => {
    const next = { ...shareSettings(), ...patch }
    const turningOn = next.enabled && !shareSettings().enabled
    ctx.settings.set({ shareServer: next, ...(turningOn ? { keepInTray: true } : {}) } as any)
    // the share server must come back after a crash or power cut: write this now, not on the usual delay
    ctx.settings.flushSync()
    if (turningOn && app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] })
    pushShareConfig(true)
    return next
  })
  officeListeners.push(() => pushShareConfig())
  if (shareSettings().enabled) pushShareConfig()
}

/** Ask the share process to finish running downloads and stop the tunnel; resolves when it has (or after 4 s). */
export function stopShareHost() {
  const c = child
  if (!c) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      c.kill()
      resolve()
    }, 4000)
    stopped = () => {
      clearTimeout(t)
      resolve()
    }
    c.postMessage({ type: 'shutdown' })
  })
}

export const shareHostActive = () => shareSettings().enabled
export const shareHostRunning = () => !!child
