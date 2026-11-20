// "Back online": a folder Hopper could not open (a network share down, a mapped drive
// disconnected, a USB disk pulled) is checked again automatically - every few seconds at first,
// then less often - for as long as a pane is waiting on it. When it can be read again every
// window that waited reloads, and Windows shows a reminder-style notification that stays on screen
// until dismissed, also while Hopper's window is closed to the tray.
import { Notification, ipcMain } from 'electron'
import { existsSync, promises as fsp } from 'node:fs'
import { ctx, res, sendToWindow, showWindow } from './ctx'

/** seconds between checks: quick at first (a blip), then settling at once a minute */
const BACKOFF = [3, 5, 8, 12, 20, 30, 45, 60]
const STAT_TIMEOUT_MS = 6000

interface Watch {
  path: string
  /** panes waiting on it (pane index + tab), so one closing does not stop the others */
  waiters: Set<string>
  since: number
  attempts: number
  timer?: NodeJS.Timeout
  checking: boolean
  /** the error that started the wait (shown in the notification) */
  error: string
}

const watches = new Map<string, Watch>()
const shown = new Set<Notification>()

/** Readable now? A directory listing (not just stat) proves the share answers. */
async function reachable(path: string) {
  const probe = fsp.readdir(path).then(
    () => true,
    () => false
  )
  return Promise.race([probe, new Promise<boolean>((r) => setTimeout(() => r(false), STAT_TIMEOUT_MS))])
}

function schedule(w: Watch) {
  clearTimeout(w.timer)
  const s = BACKOFF[Math.min(w.attempts, BACKOFF.length - 1)]
  const next = Date.now() + s * 1000
  sendToWindow('hopper:reach', { path: w.path, state: 'waiting', attempts: w.attempts, next, since: w.since })
  w.timer = setTimeout(() => void check(w), s * 1000)
}

async function check(w: Watch) {
  if (w.checking || watches.get(key(w.path)) !== w) return
  w.checking = true
  sendToWindow('hopper:reach', { path: w.path, state: 'checking', attempts: w.attempts, since: w.since })
  const ok = await reachable(w.path)
  w.checking = false
  if (watches.get(key(w.path)) !== w) return
  w.attempts++
  if (!ok) return schedule(w)
  watches.delete(key(w.path))
  sendToWindow('hopper:reach', { path: w.path, state: 'back', since: w.since })
  notifyBack(w)
}

const key = (p: string) => p.toLowerCase().replace(/\\+$/, '')
const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!)

function ago(ms: number) {
  const m = Math.round(ms / 60000)
  if (m < 1) return 'less than a minute'
  if (m < 90) return `${m} minute${m === 1 ? '' : 's'}`
  return `${Math.round(m / 60)} hours`
}

function notifyBack(w: Watch) {
  if (!Notification.isSupported()) return
  const name = w.path.replace(/\\+$/, '').split('\\').pop() || w.path
  const title = `${name} is back`
  const body = `Hopper can reach it again after ${ago(Date.now() - w.since)}. Your open view has refreshed.`
  const icon = res('build', 'icon.ico')
  // scenario="reminder": stays on screen until the user acts, unlike a normal toast that slides away
  const toastXml = `<toast scenario="reminder" activationType="foreground" launch="open">
  <visual><binding template="ToastGeneric">
    <text>${esc(title)}</text>
    <text>${esc(body)}</text>
    <text placement="attribution">${esc(w.path)}</text>
  </binding></visual>
  <actions>
    <action content="Open in Hopper" arguments="open" activationType="foreground"/>
    <action content="Dismiss" arguments="dismiss" activationType="system"/>
  </actions>
  <audio src="ms-winsoundevent:Notification.Reminder"/>
</toast>`
  const open = () => {
    showWindow()
    sendToWindow('hopper:watch-open', { folder: w.path })
  }
  let n: Notification
  try {
    n = new Notification({ toastXml })
  } catch {
    n = new Notification({ title, body: `${body}\n${w.path}`, icon: existsSync(icon) ? icon : undefined, urgency: 'critical' })
  }
  n.on('click', open)
  n.on('failed', () => {
    // toast XML refused (old Windows build, policy): a plain one instead
    const plain = new Notification({ title, body: `${body}\n${w.path}`, icon: existsSync(icon) ? icon : undefined, urgency: 'critical' })
    plain.on('click', open)
    shown.add(plain)
    plain.on('close', () => shown.delete(plain))
    plain.show()
  })
  // keep a reference: a collected Notification loses its click handler
  shown.add(n)
  n.on('close', () => shown.delete(n))
  n.show()
  if (ctx.win && !ctx.win.isDestroyed() && !ctx.win.isFocused()) ctx.win.flashFrame(true)
}

export function registerReachIpc() {
  /** A pane could not open `path`: wait for it (waiter = "pane:tab"). */
  ipcMain.handle('reach:watch', (_e, path: string, waiter: string, error: string) => {
    if (typeof path !== 'string' || !/^([a-zA-Z]:\\|\\\\)/.test(path)) return false
    const k = key(path)
    let w = watches.get(k)
    if (!w) {
      w = { path, waiters: new Set(), since: Date.now(), attempts: 0, checking: false, error: String(error ?? '').slice(0, 300) }
      watches.set(k, w)
      schedule(w)
    } else sendToWindow('hopper:reach', { path: w.path, state: 'waiting', attempts: w.attempts, next: Date.now() + 3000, since: w.since })
    w.waiters.add(String(waiter))
    return true
  })
  /** The pane moved on (or opened it): stop waiting when nobody else does. */
  ipcMain.handle('reach:unwatch', (_e, path: string, waiter: string) => {
    const w = watches.get(key(String(path)))
    if (!w) return false
    w.waiters.delete(String(waiter))
    if (!w.waiters.size) {
      clearTimeout(w.timer)
      watches.delete(key(w.path))
    }
    return true
  })
  /** "Check now": skip the wait. */
  ipcMain.handle('reach:now', (_e, path: string) => {
    const w = watches.get(key(String(path)))
    if (w) void check(w)
    return !!w
  })
}
