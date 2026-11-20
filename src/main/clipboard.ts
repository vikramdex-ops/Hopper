// Hopper Clipboard: a clipboard history that survives restarts and opens on Win+V.
// HopperShell --hooks (native/Hooks.cs) reports every clipboard change and the Win+V key; this
// module reads the content through Electron's clipboard, keeps the history in
// <userData>\clipboard\ (history.json + images\), and owns the panel window (the renderer's
// ClipPanel, loaded with #clipboard). Content a program marks as private (password managers set
// ExcludeClipboardContentFromMonitorProcessing / CanIncludeInClipboardHistory=0) is never recorded.
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, nativeImage, nativeTheme, screen } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, promises as fsp, readFileSync, statSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { MAX_HTML, MAX_TEXT, addEntry, cleanClipSettings, dedupeKey, textHint, tidy, type ClipEntry, type ClipSettings } from '@shared/cliphist'
import { ctx, paths, sendToWindow, showWindow } from './ctx'

const IMAGE_MAX_BYTES = 40 * 1024 ** 2
const IMAGES_BUDGET = 400 * 1024 ** 2
const THUMB = 240

interface HistoryFile {
  version: 1
  entries: ClipEntry[]
  /** where "Paste into…" sent files lately, newest first */
  dests: string[]
}

interface ClipEvent {
  seq: number
  private: boolean
  files: { path: string; dir: boolean }[]
  cut: boolean
  app: string
}

class ClipHistory {
  private cfg: ClipSettings = cleanClipSettings(undefined)
  private proc: ChildProcessWithoutNullStreams | null = null
  private restarts = 0
  private hist: HistoryFile = { version: 1, entries: [], dests: [] }
  private loaded = false
  private saveTimer?: NodeJS.Timeout
  private panel: BrowserWindow | null = null
  /** the window that was in front when Win+V was pressed: a pick is pasted there */
  private target = 0
  private lastSeq = -1
  /** a file dialog opened from the panel takes focus without meaning "close" */
  dialogOpen = false

  private get dir() {
    return join(app.getPath('userData'), 'clipboard')
  }
  private get imgDir() {
    return join(this.dir, 'images')
  }

  configure(raw: unknown) {
    this.cfg = cleanClipSettings(raw)
    if (process.platform !== 'win32') return
    if (this.cfg.enabled) this.start()
    else this.stop()
    this.proc?.stdin.write(`winv ${this.cfg.enabled && this.cfg.winV ? 1 : 0}\n`)
  }

  private start() {
    if (this.proc) return
    const exe = paths.helper()
    if (!existsSync(exe)) return
    this.load()
    const p = spawn(exe, ['--hooks'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = p
    p.stdin.on('error', () => {})
    p.stderr.on('data', () => {})
    p.stdin.write(`winv ${this.cfg.winV ? 1 : 0}\n`)
    createInterface({ input: p.stdout }).on('line', (line) => {
      let ev: any
      try {
        ev = JSON.parse(line)
      } catch {
        return
      }
      if (ev.ev === 'clip') void this.capture(ev).catch((err) => console.error('[clipboard]', err))
      else if (ev.ev === 'winv') this.showPanel(Number(ev.hwnd) || 0)
    })
    p.on('exit', () => {
      if (this.proc !== p) return
      this.proc = null
      // the helper died (not because we stopped it): start it again, a few times at most
      if (!ctx.quitting && this.cfg.enabled && this.restarts++ < 5) setTimeout(() => this.start(), 2000)
    })
  }

  stop() {
    const p = this.proc
    this.proc = null
    if (!p) return
    p.stdin.end()
    setTimeout(() => p.kill(), 1500)
  }

  // ---- history -------------------------------------------------------------

  private load() {
    if (this.loaded) return
    this.loaded = true
    try {
      mkdirSync(this.imgDir, { recursive: true })
      const j = JSON.parse(readFileSync(join(this.dir, 'history.json'), 'utf8'))
      if (j?.version === 1 && Array.isArray(j.entries)) this.hist = { version: 1, entries: j.entries, dests: Array.isArray(j.dests) ? j.dests : [] }
    } catch {
      /* first run */
    }
  }

  private saveSoon() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.save(), 800)
  }

  async save() {
    clearTimeout(this.saveTimer)
    if (!this.loaded) return
    try {
      await fsp.mkdir(this.dir, { recursive: true })
      const file = join(this.dir, 'history.json')
      await fsp.writeFile(file + '.tmp', JSON.stringify(this.hist), 'utf8')
      await fsp.rename(file + '.tmp', file)
    } catch (err) {
      console.error('[clipboard] save', err)
    }
  }

  private changed() {
    this.saveSoon()
    const msg = { at: Date.now() }
    if (this.panel && !this.panel.isDestroyed()) this.panel.webContents.send('hopper:cliphist', msg)
    sendToWindow('hopper:cliphist', msg)
  }

  private async capture(ev: ClipEvent) {
    if (ev.seq === this.lastSeq || ev.private) return
    this.lastSeq = ev.seq
    this.load()
    const now = Date.now()
    const source = typeof ev.app === 'string' && ev.app ? ev.app : undefined
    let e: ClipEntry | null = null
    if (ev.files?.length) {
      const files = ev.files.map((f) => ({ path: String(f.path), dir: !!f.dir }))
      e = { id: '', kind: 'files', hash: sha1(dedupeKey({ kind: 'files', files })), at: now, first: now, count: 1, pinned: false, source, files, cut: !!ev.cut, bytes: 0 }
    } else {
      // Electron 44's clipboard is the async, W3C-style one: items with typed Blobs
      const item = (await clipboard.read().catch(() => []))[0]
      if (!item) return
      const blobText = async (type: string) => (item.types.includes(type) ? await ((await item.getType(type)) as Blob).text().catch(() => '') : '')
      const text = await blobText('text/plain')
      if (text && text.trim()) {
        if (text.length > MAX_TEXT) return
        const html = await blobText('text/html')
        const rtf = await blobText('text/rtf')
        e = {
          id: '', kind: 'text', hash: sha1(dedupeKey({ kind: 'text', text })), at: now, first: now, count: 1, pinned: false, source,
          text, html: html && html.length <= MAX_HTML ? html : undefined, rtf: rtf && rtf.length <= MAX_HTML ? rtf : undefined,
          hint: textHint(text), bytes: Buffer.byteLength(text)
        }
      } else {
        const imgType = item.types.find((t) => t.startsWith('image/'))
        if (!imgType) return
        const raw = Buffer.from(await ((await item.getType(imgType)) as Blob).arrayBuffer())
        if (raw.length > IMAGE_MAX_BYTES) return
        const img = nativeImage.createFromBuffer(raw)
        if (img.isEmpty()) return
        const png = imgType === 'image/png' ? raw : img.toPNG()
        const hash = sha1(dedupeKey({ kind: 'image', imageHash: sha1(png) }))
        const name = `${hash.slice(0, 20)}.png`
        const file = join(this.imgDir, name)
        if (!existsSync(file)) {
          await fsp.mkdir(this.imgDir, { recursive: true })
          await fsp.writeFile(file, png)
        }
        const size = img.getSize()
        const thumb = size.width > THUMB || size.height > THUMB ? img.resize(size.width >= size.height ? { width: THUMB } : { height: THUMB }) : img
        e = { id: '', kind: 'image', hash, at: now, first: now, count: 1, pinned: false, source, image: name, width: size.width, height: size.height, thumb: thumb.toDataURL(), bytes: png.length }
      }
    }
    if (!e) return
    e.id = `c${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const r = addEntry(this.hist.entries, e, this.cfg.max)
    this.hist.entries = r.list
    for (const d of r.dropped) void this.dropImage(d)
    await this.enforceImageBudget()
    this.changed()
  }

  private async dropImage(e: ClipEntry) {
    if (e.kind !== 'image' || !e.image) return
    if (this.hist.entries.some((x) => x.image === e.image)) return
    await fsp.unlink(join(this.imgDir, e.image)).catch(() => {})
  }

  /** Images past the budget leave from the oldest unpinned up. */
  private async enforceImageBudget() {
    let total = 0
    const victims: ClipEntry[] = []
    for (const e of this.hist.entries) {
      if (e.kind !== 'image') continue
      total += e.bytes
      if (total > IMAGES_BUDGET && !e.pinned) victims.push(e)
    }
    if (!victims.length) return
    const ids = new Set(victims.map((v) => v.id))
    this.hist.entries = this.hist.entries.filter((e) => !ids.has(e.id))
    for (const v of victims) await this.dropImage(v)
  }

  list() {
    this.load()
    // files: mark the ones that are gone (local paths only, capped so a huge list never stalls)
    let checks = 0
    const entries = this.hist.entries.map((e) => {
      if (e.kind !== 'files' || !e.files) return e
      return { ...e, files: e.files.map((f) => (checks++ < 400 && !f.path.startsWith('\\\\') ? { ...f, missing: !existsSync(f.path) } : f)) }
    })
    return { entries, dests: this.hist.dests, settings: this.cfg }
  }

  private find(id: string) {
    this.load()
    return this.hist.entries.find((e) => e.id === id)
  }

  /** Put an entry back on the clipboard; with paste, also paste it into the window the user was in. */
  async use(id: string, paste: boolean, plain = false) {
    const e = this.find(id)
    if (!e) return false
    if (e.kind === 'text') {
      if (plain || (!e.html && !e.rtf)) await clipboard.writeText(e.text ?? '')
      else {
        const parts: Record<string, string> = { 'text/plain': e.text ?? '' }
        if (e.html) parts['text/html'] = e.html
        if (e.rtf) parts['text/rtf'] = e.rtf
        await clipboard.write([new ClipboardItem(parts)]).catch(() => clipboard.writeText(e.text ?? ''))
      }
    } else if (e.kind === 'image' && e.image) {
      let png: Buffer
      try {
        png = readFileSync(join(this.imgDir, e.image))
      } catch {
        throw new Error('The image is no longer in the clipboard history folder')
      }
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
    } else if (e.kind === 'files' && e.files) {
      const live = e.files.filter((f) => f.path.startsWith('\\\\') || existsSync(f.path)).map((f) => f.path)
      if (!live.length) throw new Error('None of these files exist any more')
      await ctx.shell.call('clipWrite', { paths: live, cut: false }, 10000)
    }
    if (paste) {
      const target = this.target
      this.hidePanel()
      if (target) setTimeout(() => this.proc?.stdin.write(`paste ${target}\n`), 120)
    }
    return true
  }

  pin(id: string, on: boolean) {
    const e = this.find(id)
    if (!e) return false
    e.pinned = on
    this.changed()
    return true
  }

  remove(ids: string[]) {
    this.load()
    const set = new Set(ids)
    const gone = this.hist.entries.filter((e) => set.has(e.id))
    this.hist.entries = this.hist.entries.filter((e) => !set.has(e.id))
    for (const g of gone) void this.dropImage(g)
    this.changed()
    return gone.length
  }

  clear(keepPinned: boolean) {
    this.load()
    const gone = this.hist.entries.filter((e) => !keepPinned || !e.pinned)
    this.hist.entries = keepPinned ? this.hist.entries.filter((e) => e.pinned) : []
    for (const g of gone) void this.dropImage(g)
    this.changed()
    return gone.length
  }

  /** Remove duplicates (whitespace variants), empty text and entries whose files are all gone. */
  tidy() {
    const r = tidy(this.list().entries)
    const ids = new Set(r.removed.map((e) => e.id))
    this.hist.entries = this.hist.entries.filter((e) => !ids.has(e.id))
    for (const g of r.removed) void this.dropImage(g)
    this.changed()
    return r.removed.length
  }

  imageData(id: string) {
    const e = this.find(id)
    if (!e?.image) return null
    try {
      return 'data:image/png;base64,' + readFileSync(join(this.imgDir, e.image)).toString('base64')
    } catch {
      return null
    }
  }

  private owner() {
    return this.panel && !this.panel.isDestroyed() && this.panel.isVisible() ? this.panel : ctx.win
  }

  async saveImage(id: string) {
    const e = this.find(id)
    if (!e?.image) return false
    const stamp = new Date(e.at).toISOString().slice(0, 19).replace(/[T:]/g, '-')
    const opts = { title: 'Save image', defaultPath: join(app.getPath('pictures'), `Clipboard ${stamp}.png`), filters: [{ name: 'PNG image', extensions: ['png'] }] }
    const owner = this.owner()
    const r = owner ? await dialog.showSaveDialog(owner, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return false
    await fsp.copyFile(join(this.imgDir, e.image), r.filePath)
    return r.filePath
  }

  /** Copy (or move) an entry's files into a folder: chosen now, a recent one, or Hopper's open folder. */
  async pasteFiles(id: string, op: 'copy' | 'move', dest: string) {
    const e = this.find(id)
    if (!e?.files?.length) return false
    let target: string | null = null
    if (dest === 'choose') {
      const n = e.files.length
      const opts = { title: `${op === 'move' ? 'Move' : 'Copy'} ${n} item${n === 1 ? '' : 's'} into…`, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
      const owner = this.owner()
      const r = owner ? await dialog.showOpenDialog(owner, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths[0]) return false
      target = r.filePaths[0]
    } else if (dest !== 'hopper') {
      if (!statSync(dest, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${dest} cannot be reached`)
      target = dest
    }
    if (target) this.hist.dests = [target, ...this.hist.dests.filter((d) => d.toLowerCase() !== target!.toLowerCase())].slice(0, 6)
    this.saveSoon()
    this.hidePanel()
    showMain()
    // the window runs the transfer, so it shows in the progress window and Transfers like any other
    sendToWindow('hopper:clip-transfer', { paths: e.files.map((f) => f.path), dest: target, op })
    return true
  }

  // ---- panel -----------------------------------------------------------------

  showPanel(target = 0) {
    if (process.platform !== 'win32') return
    this.target = target
    const win = this.ensurePanel()
    const pt = screen.getCursorScreenPoint()
    const wa = screen.getDisplayNearestPoint(pt).workArea
    const [w, h] = win.getSize()
    const x = Math.min(Math.max(wa.x + 8, pt.x - Math.round(w / 2)), wa.x + wa.width - w - 8)
    const y = Math.min(Math.max(wa.y + 8, pt.y - 40), wa.y + wa.height - h - 8)
    win.setPosition(x, y)
    win.webContents.send('hopper:cliphist', { at: Date.now(), opened: true })
    win.show()
    win.focus()
  }

  hidePanel() {
    if (this.panel && !this.panel.isDestroyed() && this.panel.isVisible()) this.panel.hide()
  }

  private ensurePanel() {
    if (this.panel && !this.panel.isDestroyed()) return this.panel
    const win11 = Number(release().split('.')[2] ?? 0) >= 22000
    const icon = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'build', 'icon.ico')
    const win = new BrowserWindow({
      width: 440,
      height: 600,
      minWidth: 340,
      minHeight: 360,
      show: false,
      frame: false,
      resizable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      title: 'Hopper Clipboard',
      icon: existsSync(icon) ? icon : undefined,
      backgroundColor: win11 ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3',
      backgroundMaterial: win11 ? 'acrylic' : undefined,
      webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
    })
    win.on('blur', () => {
      if (!this.dialogOpen) win.hide()
    })
    // memory diet: a panel nobody opened for two minutes gives its renderer back (~60 MB);
    // the next Win+V builds it again in a few hundred milliseconds
    let gone: NodeJS.Timeout | undefined
    win.on('hide', () => {
      clearTimeout(gone)
      gone = setTimeout(() => {
        if (!win.isDestroyed() && !win.isVisible()) win.destroy()
      }, 120_000)
    })
    win.on('show', () => clearTimeout(gone))
    win.on('closed', () => {
      clearTimeout(gone)
      if (this.panel === win) this.panel = null
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL + '#clipboard')
    else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'clipboard' })
    this.panel = win
    return win
  }
}

function sha1(s: string | Buffer) {
  return createHash('sha1').update(s).digest('hex')
}

function showMain() {
  showWindow()
}

export const clip = new ClipHistory()

export function registerClipboardIpc() {
  const h = (name: string, fn: (...args: any[]) => unknown) => ipcMain.handle(name, (_e, ...a) => fn(...a))
  h('cliphist:list', () => clip.list())
  h('cliphist:use', (id: string, paste: boolean, plain: boolean) => clip.use(String(id), !!paste, !!plain))
  h('cliphist:pin', (id: string, on: boolean) => clip.pin(String(id), !!on))
  h('cliphist:remove', (ids: string[]) => clip.remove(Array.isArray(ids) ? ids.map(String) : []))
  h('cliphist:clear', (keepPinned: boolean) => clip.clear(keepPinned !== false))
  h('cliphist:tidy', () => clip.tidy())
  h('cliphist:image', (id: string) => clip.imageData(String(id)))
  h('cliphist:saveImage', async (id: string) => {
    clip.dialogOpen = true
    try {
      return await clip.saveImage(String(id))
    } finally {
      clip.dialogOpen = false
    }
  })
  h('cliphist:pasteFiles', async (id: string, op: string, dest: string) => {
    clip.dialogOpen = dest === 'choose'
    try {
      return await clip.pasteFiles(String(id), op === 'move' ? 'move' : 'copy', String(dest))
    } finally {
      clip.dialogOpen = false
    }
  })
  h('cliphist:show', () => clip.showPanel(0))
  h('cliphist:hide', () => clip.hidePanel())
  /** open a path from the panel in Hopper: a folder opens, a file is selected in its folder */
  h('cliphist:reveal', (path: string) => {
    clip.hidePanel()
    showMain()
    sendToWindow('hopper:clip-reveal', String(path))
  })
}
