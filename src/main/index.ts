// Hopper main process: window, tray, protocols, IPC and the background processes.
// Nothing here reads file contents or blocks; heavy work lives in engine/lan utility processes.
import { app, BrowserWindow, Menu, nativeImage, nativeTheme, Notification, screen, shell, Tray, utilityProcess } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { sendToWindow } from './ctx'
import { applyTheme, connectPorts, ctx, overlayColors, paths, pushOfficeToUtilities, res, windowGone } from './ctx'
import { release } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { handleProtocol, registerSchemes } from './protocol'
import { healFolderAssoc, registerIpc } from './ipc'
import { clip, registerClipboardIpc } from './clipboard'
import { registerReachIpc } from './reach'
import { startOfficeSync } from './officeops'
import { OfficeStore, SettingsStore } from './store'
import { HopperShell } from '@shared/hshell'
import { initUpdater } from './updater'
import { initShareHost, shareHostActive, shareHostRunning, stopShareHost } from './sharehost'
import { trace } from '@shared/trace'
trace('main module loaded')

registerSchemes()
// Windows shows this name and icon on the taskbar, in toasts and in the volume/notification
// settings. Without it a PC whose Start-menu shortcut is missing shows "Electron" and Electron's icon.
// A dev run (electron.exe) gets its own id: when it shared the installed app's id, pinning or
// running it left an "Electron.lnk" carrying that id in the Start menu / taskbar pins, and
// Windows then showed the installed Hopper as "Electron" with no icon.
const APP_ID = app.isPackaged ? 'com.dexterity.hopper' : 'com.dexterity.hopper.dev'
app.setName('Hopper')
app.setAppUserModelId(APP_ID)
// Keep Chromium's own caches off the system drive when a portable/data dir is requested.
if (process.env.HOPPER_USER_DATA) app.setPath('userData', process.env.HOPPER_USER_DATA)

if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}

// ---- memory diet --------------------------------------------------------------------------
// Hopper sits in the tray all day next to CAD and Office, so every idle megabyte counts.
// - no spare renderer kept warm "in case" (Chromium does that by default), no back-forward cache
// - a small V8 young generation: scripts here are short-lived UI work, not throughput jobs
// - the GPU process may be switched off (Settings > Performance); Mica is drawn by Windows either way
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess,BackForwardCache,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication,OptimizationHints,Translate')
app.commandLine.appendSwitch('js-flags', '--max-semi-space-size=2')
app.commandLine.appendSwitch('disk-cache-size', String(8 * 1024 * 1024))
if (process.env.HOPPER_GPU === '0' || (process.env.HOPPER_GPU !== '1' && readGpuOff())) app.disableHardwareAcceleration()

/** Settings > Performance "Use the graphics card": read before the app is ready (settings load later). */
function readGpuOff() {
  try {
    const dir = process.env.HOPPER_USER_DATA || join(app.getPath('appData'), 'Hopper')
    const s = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    // off unless turned on: the GPU process costs ~100 MB and Hopper draws flat UI
    return s?.performance?.gpu !== true
  } catch {
    return true
  }
}



const isWin11 = () => Number(release().split('.')[2] ?? 0) >= 22000

function argPaths(argv: string[]) {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--open' && argv[i + 1]) out.push(argv[++i])
  return out
}

function startUtility(name: 'engine' | 'lan') {
  const child = utilityProcess.fork(join(__dirname, `${name}.js`), [], {
    serviceName: `Hopper ${name}`,
    stdio: 'inherit',
    // small young generation; the engine's big data (indexes) lives in Buffers outside the V8 heap
    // --expose-gc: the engine collects right after a big index leaves memory, so it is returned at once
    execArgv: ['--max-semi-space-size=2', '--expose-gc'],
    env: {
      ...process.env,
      HOPPER_7Z: paths.sevenZip(),
      HOPPER_HELPER: paths.helper(),
      HOPPER_DATA: app.getPath('userData'),
      HOPPER_VERSION: app.getVersion()
    }
  })
  const t0 = Date.now()
  trace(`fork ${name}`)
  child.on('spawn', () => trace(`${name} spawned in ${Date.now() - t0} ms`))
  child.on('exit', (code) => {
    if (ctx.quitting) return
    console.error(`[hopper] ${name} exited with ${code}; restarting`)
    setTimeout(() => {
      ctx[name] = startUtility(name)
      connectPorts()
    }, 500)
  })
  // Main-process services the utilities ask for (trash, thumbnails, notifications).
  child.on('message', (msg: any) => onUtilityMessage(name, msg))
  return child
}


function onUtilityMessage(name: string, msg: any) {
  if (msg?.type === 'office-request') {
    pushOfficeToUtilities()
  } else if (msg?.type === 'attention') {
    if (ctx.win && !ctx.win.isDestroyed() && !ctx.win.isFocused()) ctx.win.flashFrame(true)
  } else if (msg?.type === 'received' && name === 'lan') {
    receivedNotify(msg.item)
  } else if (msg?.type === 'watch-notify' && name === 'engine') {
    watchNotify(msg)
  } else if (msg?.type === 'notify' && name === 'engine') {
    // Storage alerts and Smart File Notifications: same Windows notification as a watched folder;
    // storage alerts also go to the tracked folder's people on Dexterity Connect.
    const c = msg.connect
    if (c && typeof c.text === 'string') {
      const users = Array.isArray(c.users) ? c.users.filter((u: unknown): u is string => typeof u === 'string').slice(0, 30) : []
      ctx.lan?.postMessage({ type: 'notify-connect', users, text: c.text.slice(0, 1000), title: typeof c.title === 'string' ? c.title.slice(0, 80) : 'Hopper' })
    }
    watchNotify({ title: msg.title, body: msg.body, folder: msg.folder, select: msg.select })
  }
}

/**
 * A watched folder changed (engine/folderwatch.ts). The window shows its own toast when it has
 * focus; otherwise Windows shows a notification, and a click opens the folder in Hopper.
 * The Dexterity Connect copy goes through the LAN process, which knows whether Connect is set up.
 */
function watchNotify(msg: { title?: unknown; body?: unknown; folder?: unknown; select?: unknown; connect?: unknown }) {
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
  const folder = str(msg.folder, 4000)
  const connect = str(msg.connect, 500)
  if (connect) ctx.lan?.postMessage({ type: 'watch-connect', text: connect })
  const win = ctx.win
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) return
  if (!Notification.isSupported()) return
  const n = new Notification({ title: str(msg.title, 200) || 'Hopper', body: str(msg.body, 300), icon: iconPath() })
  n.on('click', () => {
    showMainWindow()
    sendToWindow('hopper:watch-open', { folder, select: str(msg.select, 4000) })
  })
  n.show()
}

/** Files or a message arrived over the LAN: the window says so itself when it is on screen. */
function receivedNotify(item: any) {
  const win = ctx.win
  if (win && !win.isDestroyed() && win.isVisible()) return
  if (!Notification.isSupported() || !item || typeof item !== 'object') return
  const from = String(item.fromName ?? item.from ?? 'Someone').slice(0, 80)
  const kind = item.kind ?? 'files'
  const title =
    kind === 'message' ? `Message from ${from}` : kind === 'link' ? `${from} sent you a folder link` : kind === 'request' ? `${from} is asking for files` : `${from} sent you ${item.files ?? ''} file${item.files === 1 ? '' : 's'}`
  const body = String(item.message ?? (kind === 'link' ? item.link?.path : '') ?? '').slice(0, 300) || 'Saved to your Hopper Inbox'
  const n = new Notification({ title, body, icon: iconPath() })
  n.on('click', () => {
    showMainWindow()
    sendToWindow('hopper:open', item.folder || ctx.settings.data.inboxDir)
  })
  n.show()
}




/** The app icon on disk; the installer ships it under resources\build. */
function iconPath() {
  const p = res('build', 'icon.ico')
  return existsSync(p) ? p : undefined
}

/**
 * Register the AppUserModelID's display name and icon for this user, so Windows notifications
 * say "Hopper" with the Hopper icon even when no Start-menu shortcut carries the ID.
 * Best effort and off the startup path.
 */
function registerAppIdentity() {
  if (process.platform !== 'win32') return
  const icon = iconPath()
  const key = 'HKCU\\Software\\Classes\\AppUserModelId\\' + APP_ID
  const add = (name: string, value: string) =>
    execFile('reg.exe', ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true, timeout: 10000 }, () => {})
  add('DisplayName', 'Hopper')
  if (icon) add('IconUri', icon)
  setTimeout(healStaleShortcuts, 5000)
}

/**
 * A dev build used to share the installed app's id, so a developer PC can hold an "Electron.lnk"
 * (Start menu and/or taskbar pin) that carries Hopper's id but starts node_modules\electron.exe.
 * Windows names and draws the running Hopper from that shortcut: "Electron", no icon.
 * Start-menu copies are removed; a taskbar pin is pointed at Hopper and renamed, so the pin stays.
 */
function healStaleShortcuts() {
  if (!app.isPackaged) return
  const exe = app.getPath('exe')
  const icon = iconPath() ?? exe
  const appData = app.getPath('appData')
  const startMenu = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  const pins = join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar')
  for (const [dir, pinned] of [[startMenu, false], [pins, true]] as const) {
    let names: string[] = []
    try { names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.lnk')) } catch { continue }
    for (const name of names) {
      const lnk = join(dir, name)
      let d: Electron.ShortcutDetails
      try { d = shell.readShortcutLink(lnk) } catch { continue }
      if (d.appUserModelId !== APP_ID || basename(d.target).toLowerCase() !== 'electron.exe') continue
      try {
        if (!pinned) { unlinkSync(lnk); continue }
        shell.writeShortcutLink(lnk, 'replace', { target: exe, cwd: dirname(exe), icon, iconIndex: 0, appUserModelId: APP_ID, description: 'Hopper' })
        const named = join(dir, 'Hopper.lnk')
        if (!existsSync(named)) renameSync(lnk, named)
      } catch { /* best effort */ }
    }
  }
}

// Closed to the tray, the window keeps a renderer (~100 MB) alive for nothing. After a short
// while it is released; tray, notifications, LAN and clipboard keep working from this process,
// and opening Hopper again builds the window from the saved tabs (about a second).
const RELEASE_HIDDEN_MS = 90_000
let releaseTimer: NodeJS.Timeout | undefined

/** Show the main window, building it again when it was released. */
function showMainWindow() {
  let win = ctx.win
  if (!win || win.isDestroyed()) win = createWindow(true)
  else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
  clearTimeout(releaseTimer)
}

function createWindow(showWhenReady = true) {
  windowGone()
  const b = ctx.settings.data.windowBounds
  const visible = b && screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + 40 > a.y
  })
  const win = new BrowserWindow({
    width: visible ? b!.width : 1440,
    height: visible ? b!.height : 900,
    x: visible ? b!.x : undefined,
    y: visible ? b!.y : undefined,
    minWidth: 860,
    minHeight: 540,
    show: false,
    title: 'Hopper',
    icon: iconPath(),
    backgroundColor: isWin11() ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3',
    backgroundMaterial: isWin11() ? 'mica' : undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: overlayColors(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      webviewTag: false
    }
  })
  ctx.win = win
  // Taskbar button: name, icon and what a pinned button relaunches.
  const icon = iconPath()
  win.setAppDetails({
    appId: APP_ID,
    appIconPath: icon ?? app.getPath('exe'),
    appIconIndex: 0,
    relaunchCommand: app.isPackaged ? `"${app.getPath('exe')}"` : `"${process.execPath}" "${app.getAppPath()}"`,
    relaunchDisplayName: 'Hopper'
  })
  if (visible && b!.maximized) win.maximize()

  win.once('ready-to-show', () => {
    if (showWhenReady) {
      win.show()
      win.focus()
    }
  })
  win.on('show', () => clearTimeout(releaseTimer))
  // Never let remote content open windows or navigate the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })
  win.webContents.on('did-finish-load', () => {
    connectPorts()
    // queued until the page says it listens ('app:ready')
    for (const p of ctx.pendingOpen.splice(0)) sendToWindow('hopper:open', p)
  })

  const saveBounds = () => {
    if (win.isDestroyed() || win.isMinimized()) return
    const n = win.getNormalBounds()
    ctx.settings.set({ windowBounds: { ...n, maximized: win.isMaximized() } })
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)
  win.on('maximize', () => sendToWindow('hopper:win', { maximized: true }))
  win.on('unmaximize', () => sendToWindow('hopper:win', { maximized: false }))
  win.on('focus', () => win.flashFrame(false))
  win.on('closed', () => {
    if (ctx.win === win) {
      ctx.win = undefined
      windowGone()
    }
  })
  win.on('close', (e) => {
    // Stay in the tray so colleagues can still send files.
    // …and, on the PC that hosts Dexterity Share, so clients can keep downloading.
    if (!ctx.quitting && (ctx.settings.data.lan.enabled || shareHostActive()) && ctx.settings.data.keepInTray !== false) {
      e.preventDefault()
      win.hide()
      // release the renderer once it has had time to save its tabs (persistSoon is 600 ms)
      clearTimeout(releaseTimer)
      if (ctx.settings.data.performance?.releaseInTray !== false)
        releaseTimer = setTimeout(() => {
          if (!win.isDestroyed() && !win.isVisible() && ctx.win === win) win.destroy()
        }, RELEASE_HIDDEN_MS)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

function createTray() {
  const icon = iconPath()
  const tray = new Tray(icon ? nativeImage.createFromPath(icon) : nativeImage.createEmpty())
  if (!icon) void app.getFileIcon(app.getPath('exe'), { size: 'small' }).then((i) => tray.setImage(i)).catch(() => {})
  tray.setToolTip('Hopper')
  const show = () => showMainWindow()
  tray.on('click', show)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Hopper', click: show },
      { label: 'Open Inbox', click: () => { show(); sendToWindow('hopper:open', ctx.settings.data.inboxDir) } },
      { label: 'Clipboard history', click: () => clip.showPanel(0) },
      { type: 'separator' },
      { label: 'Quit Hopper', click: () => { ctx.quitting = true; app.quit() } }
    ])
  )
  return tray
}

app.on('second-instance', (_e, argv) => {
  const ps = argPaths(argv)
  if (!ctx.settings) return
  showMainWindow()
  for (const p of ps) sendToWindow('hopper:open', p)
})

app.whenReady().then(async () => {
  ctx.settings = new SettingsStore()
  ctx.office = new OfficeStore()
  // exits after two quiet minutes (~25 MB each helper); starts again on the next call
  ctx.shell = new HopperShell(paths.helper(), 120_000)
  ctx.quitting = false
  ctx.pendingOpen = argPaths(process.argv)
  await ctx.office.load(ctx.settings.data.officeConfigPath)
  nativeTheme.themeSource = ctx.settings.data.theme
  nativeTheme.on('updated', () => {
    applyTheme()
    sendToWindow('hopper:theme', { dark: nativeTheme.shouldUseDarkColors })
  })
  Menu.setApplicationMenu(null)
  handleProtocol()
  registerIpc()
  registerClipboardIpc()
  registerReachIpc()
  ctx.engine = startUtility('engine')
  ctx.lan = startUtility('lan')
  pushOfficeToUtilities()
  initShareHost()
  startOfficeSync(() => {
    pushOfficeToUtilities()
    sendToWindow('hopper:office', {})
  })
  registerAppIdentity()
  healFolderAssoc()
  ctx.showWindow = showMainWindow
  // started at sign-in (--hidden): no window at all until it is opened
  if (!process.argv.includes('--hidden')) createWindow(true)
  ctx.tray = createTray()
  clip.configure(ctx.settings.data.clipboard)
  if (ctx.settings.data.autoUpdate && app.isPackaged) void initUpdater()
})

app.on('before-quit', () => {
  ctx.quitting = true
  ctx.settings?.flushSync()
  void clip.save()
  clip.stop()
})

let shareStopping = false
app.on('will-quit', (e) => {
  // The share server first: it stops the tunnel and lets a running client download finish its chunk.
  if (shareHostRunning() && !shareStopping) {
    e.preventDefault()
    shareStopping = true
    void stopShareHost().then(() => app.quit())
    return
  }
  ctx.shell?.dispose()
  ctx.engine?.kill()
  // Let the LAN process say "bye" so colleagues see us go offline at once.
  if (ctx.lan) {
    e.preventDefault()
    const lan = ctx.lan
    ctx.lan = undefined
    lan.postMessage({ type: 'shutdown' })
    setTimeout(() => {
      lan.kill()
      app.quit()
    }, 600)
  }
})

app.on('window-all-closed', () => {
  if (ctx.quitting) app.quit()
})
