// Settings and office config persistence. Writes are atomic (temp + rename) and debounced.
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultOffice, defaultSettings } from '@shared/defaults'
import type { OfficeConfig, Settings } from '@shared/types'

function readJson<T>(file: string): T | undefined {
  for (const f of [file, file + '.bak']) {
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as T
    } catch {
      /* try backup */
    }
  }
  return undefined
}

async function writeJsonAtomic(file: string, data: unknown) {
  await fsp.mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(data, null, 1), 'utf8')
  if (existsSync(file)) await fsp.copyFile(file, file + '.bak').catch(() => {})
  await fsp.rename(tmp, file)
}

function writeJsonAtomicSync(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8')
  renameSync(tmp, file)
}

/** Merge saved values over defaults so new keys appear after an update. */
function merge<T extends object>(defaults: T, saved: Partial<T> | undefined): T {
  if (!saved || typeof saved !== 'object') return defaults
  const out: any = { ...defaults }
  for (const [k, v] of Object.entries(saved)) {
    const d = (defaults as any)[k]
    out[k] = d && typeof d === 'object' && !Array.isArray(d) && v && typeof v === 'object' && !Array.isArray(v) ? merge(d, v) : v
  }
  return out
}

export class SettingsStore {
  readonly file: string
  data: Settings
  private timer?: NodeJS.Timeout

  constructor() {
    const portable = join(dirname(app.getPath('exe')), 'hopper-portable.flag')
    this.file = existsSync(portable)
      ? join(dirname(app.getPath('exe')), 'hopper-settings.json')
      : join(app.getPath('userData'), 'settings.json')
    const home = app.getPath('home')
    this.data = merge(defaultSettings(home, app.getPath('documents')), readJson<Settings>(this.file))
    if (!this.data.inboxDir) this.data.inboxDir = defaultInbox(home)
  }

  get portable() {
    return !this.file.startsWith(app.getPath('userData'))
  }

  set(patch: Partial<Settings>) {
    Object.assign(this.data, patch)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void writeJsonAtomic(this.file, this.data).catch(() => {}), 400)
  }

  flushSync() {
    clearTimeout(this.timer)
    try {
      writeJsonAtomicSync(this.file, this.data)
    } catch {
      /* best effort on quit */
    }
  }
}

/** The Inbox defaults to D: when it exists (the project drive), else the user's Downloads. */
function defaultInbox(home: string) {
  return existsSync('D:\\') ? 'D:\\Hopper Inbox' : join(home, 'Downloads', 'Hopper Inbox')
}

export class OfficeStore {
  data: OfficeConfig = defaultOffice()
  loadedFrom = ''
  error = ''

  async load(path: string, hop = 0): Promise<OfficeConfig> {
    this.loadedFrom = path
    try {
      const text = await fsp.readFile(path, 'utf8')
      this.data = merge(defaultOffice(), JSON.parse(text))
      this.error = ''
      // an admin moved the config: follow the pointer, but keep this copy if the new place is unreachable
      const next = this.data.movedTo
      if (typeof next === 'string' && next && hop < 3 && next.toLowerCase() !== path.toLowerCase()) {
        const here = this.data
        await this.load(next, hop + 1)
        if (this.error) Object.assign(this, { data: here, loadedFrom: path, error: '' })
      }
    } catch (e: any) {
      this.error = e?.code === 'ENOENT' ? 'not-found' : String(e?.message ?? e)
      this.data = defaultOffice()
    }
    return this.data
  }

  async save(path: string, cfg: OfficeConfig) {
    await writeJsonAtomic(path, cfg)
    this.data = cfg
    this.loadedFrom = path
    this.error = ''
  }
}
