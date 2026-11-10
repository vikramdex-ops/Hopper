// Hopper main process: window, tray, protocols, IPC and the background processes.
// Nothing here reads file contents or blocks; heavy work lives in engine/lan utility processes.
import { app, BrowserWindow, Menu, nativeTheme, screen, shell, Tray, utilityProcess } from 'electron'
import { sendToWindow } from './ctx'
import { applyTheme, connectPorts, ctx, overlayColors, paths, pushOfficeToUtilities, res } from './ctx'
import { release } from 'node:os'
import { join } from 'node:path'
import { handleProtocol, registerSchemes } from './protocol'
import { registerIpc } from './ipc'
import { OfficeStore, SettingsStore } from './store'
import { HopperShell } from '@shared/hshell'
import { initUpdater } from './updater'
import { initShareHost, shareHostActive, shareHostRunning, stopShareHost } from './sharehost'
import { trace } from '@shared/trace'
trace('main module loaded')

registerSchemes()
app.setAppUserModelId('com.dexterity.hopper')
// Keep Chromium's own caches off the system drive when a portable/data dir is requested.
if (process.env.HOPPER_USER_DATA) app.setPath('userData', process.env.HOPPER_USER_DATA)

if (!app.requestSingleInstanceLock()) {
  app.exit(0)
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
  }
}




function createWindow() {
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
    icon: res('build', 'icon.ico'),
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
  if (visible && b!.maximized) win.maximize()

  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show()
  })
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
    for (const p of ctx.pendingOpen.splice(0)) win.webContents.send('hopper:open', p)
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
    if (ctx.win === win) ctx.win = undefined
  })
  win.on('close', (e) => {
    // Stay in the tray so colleagues can still send files.
    // …and, on the PC that hosts Dexterity Share, so clients can keep downloading.
    if (!ctx.quitting && (ctx.settings.data.lan.enabled || shareHostActive()) && ctx.settings.data.keepInTray !== false) {
      e.preventDefault()
      win.hide()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

function createTray() {
  const tray = new Tray(res('build', 'icon.ico'))
  tray.setToolTip('Hopper')
  const show = () => {
    ctx.win?.show()
    ctx.win?.focus()
  }
  tray.on('click', show)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Hopper', click: show },
      { label: 'Open Inbox', click: () => { show(); sendToWindow('hopper:open', ctx.settings.data.inboxDir) } },
      { type: 'separator' },
      { label: 'Quit Hopper', click: () => { ctx.quitting = true; app.quit() } }
    ])
  )
  return tray
}

app.on('second-instance', (_e, argv) => {
  const ps = argPaths(argv)
  if (ctx.win) {
    if (ctx.win.isMinimized()) ctx.win.restore()
    ctx.win.show()
    ctx.win.focus()
    for (const p of ps) sendToWindow('hopper:open', p)
  }
})

app.whenReady().then(async () => {
  ctx.settings = new SettingsStore()
  ctx.office = new OfficeStore()
  ctx.shell = new HopperShell(paths.helper())
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
  ctx.engine = startUtility('engine')
  ctx.lan = startUtility('lan')
  pushOfficeToUtilities()
  initShareHost()
  createWindow()
  ctx.tray = createTray()
  if (ctx.settings.data.autoUpdate && app.isPackaged) void initUpdater()
})

app.on('before-quit', () => {
  ctx.quitting = true
  ctx.settings?.flushSync()
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
