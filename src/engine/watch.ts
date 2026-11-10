// Live folders: the UI declares which folders are on screen; we watch exactly those
// (ReadDirectoryChangesW, works on SMB shares too) and send a debounced "dir-changed".
import { promises as fsp, watch, type FSWatcher } from 'node:fs'
import type { EngineCtx } from './index'

export function watchHandlers(ctx: EngineCtx) {
  const watchers = new Map<string, { w?: FSWatcher; timer?: NodeJS.Timeout; poll?: NodeJS.Timeout }>()

  /** Some NAS shares refuse change notifications: look at the folder's own timestamp every few seconds instead. */
  const poll = (dir: string, key: string) => {
    let last = -1
    const tick = async () => {
      const m = await fsp.stat(dir).then((s) => s.mtimeMs, () => -1)
      if (!watchers.has(key)) return
      if (last !== -1 && m !== last) ctx.emit('dir-changed', { path: dir })
      last = m
    }
    void tick()
    watchers.set(key, { poll: setInterval(() => void tick(), 4000) })
  }


  const add = (dir: string) => {
    const key = dir.toLowerCase()
    if (watchers.has(key)) return
    try {
      const w = watch(dir, { persistent: false }, () => {
        const rec = watchers.get(key)
        if (!rec) return
        clearTimeout(rec.timer)
        // Bursts (a copy of 1000 files) collapse into one refresh.
        rec.timer = setTimeout(() => ctx.emit('dir-changed', { path: dir }), 250)
      })
      w.on('error', () => {
        remove(key)
        poll(dir, key)
      })
      watchers.set(key, { w })
    } catch {
      poll(dir, key)
    }
  }
  const remove = (key: string) => {
    const rec = watchers.get(key)
    if (!rec) return
    clearTimeout(rec.timer)
    clearInterval(rec.poll)
    rec.w?.close()
    watchers.delete(key)
  }

  return {
    'watch.set': (dirs: string[]) => {
      const want = new Set(dirs.filter((d) => !d.includes('::')).map((d) => d.toLowerCase()))
      for (const key of [...watchers.keys()]) if (!want.has(key)) remove(key)
      for (const d of dirs) if (!d.includes('::')) add(d)
      return watchers.size
    }
  }
}
