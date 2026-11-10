// RPC surface of the built-in previews (preview.*): spreadsheets, Word, DWG saved previews,
// MicroStation V7 drawings and previews stored in OLE compound files (.sha, DGN V8).
// Parsing runs in a worker thread (preview/worker.ts). Requests carry a "slot" (who is asking:
// inspector, quick look, viewer); a newer request in the same slot supersedes an older one.
import type { Worker } from 'node:worker_threads'
import createWorker from './preview/worker?nodeWorker'
import type { EngineCtx } from './index'
import type { DwgThumb } from './preview/dwg'
import type { OleFound } from './preview/olepreview'
import type { DgnDrawing, DocxPreview, DwgPreview, FileSniff, OlePreview, PreviewImage, SheetBook, SheetGrid } from './preview/types'

const IDLE_MS = 90_000
const TASK_MS = 120_000
export const SUPERSEDED = 'superseded'

interface Task {
  id: number
  task: string
  args: unknown[]
  slot: string
  resolve: (v: any) => void
  reject: (e: Error) => void
}

class PreviewWorker {
  private worker: Worker | null = null
  private queue: Task[] = []
  private running: Task | null = null
  private seq = 0
  private idle?: NodeJS.Timeout
  private watchdog?: NodeJS.Timeout

  run<T>(task: string, slot: string, ...args: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Only the newest request of a slot matters: the user has moved on to another file.
      this.queue = this.queue.filter((t) => {
        if (t.slot !== slot) return true
        t.reject(new Error(SUPERSEDED))
        return false
      })
      this.queue.push({ id: ++this.seq, task, args, slot, resolve, reject })
      if (this.running && this.running.slot === slot && this.running.task !== 'sniff') this.stop(SUPERSEDED)
      this.pump()
    })
  }

  private stop(reason: string) {
    const t = this.running
    this.running = null
    clearTimeout(this.watchdog)
    const w = this.worker
    this.worker = null
    w?.removeAllListeners()
    void w?.terminate()
    t?.reject(new Error(reason))
  }

  private pump() {
    if (this.running) return
    const next = this.queue.shift()
    if (!next) {
      clearTimeout(this.idle)
      this.idle = setTimeout(() => !this.running && this.stop('idle'), IDLE_MS)
      return
    }
    clearTimeout(this.idle)
    if (!this.worker) {
      const w = createWorker({})
      w.on('message', (m: { id: number; ok: boolean; value?: unknown; error?: string }) => {
        const t = this.running
        if (!t || t.id !== m.id) return
        this.running = null
        clearTimeout(this.watchdog)
        m.ok ? t.resolve(m.value) : t.reject(new Error(m.error))
        this.pump()
      })
      const fail = (err: unknown) => {
        if (this.worker !== w) return
        this.stop(`Preview failed: ${String((err as any)?.message ?? err)}`)
        this.pump()
      }
      w.on('error', fail)
      w.on('exit', (code) => fail(`worker exited (${code})`))
      this.worker = w
    }
    this.running = next
    this.watchdog = setTimeout(() => {
      this.stop('This file takes too long to preview.')
      this.pump()
    }, TASK_MS)
    this.worker.postMessage({ id: next.id, task: next.task, args: next.args })
  }
}

const image = (mime: string, data: Uint8Array): PreviewImage => ({ mime, data })

/** Reader errors are technical; say what they mean and keep the detail in brackets. */
async function readable<T>(what: string, work: Promise<T>): Promise<T> {
  try {
    return await work
  } catch (err: any) {
    const m = String(err?.message ?? err)
    if (m === SUPERSEDED || /^This |^Preview failed|password/i.test(m)) throw err
    throw new Error(`This ${what} could not be read; it may be damaged or incomplete. (${m})`)
  }
}

export function previewHandlers(ctx: EngineCtx) {
  const worker = new PreviewWorker()

  /** EMF / WMF cannot be drawn by Chromium; HopperShell renders them to PNG with GDI+. */
  const metafile = async (kind: 'emf' | 'wmf', data: Uint8Array): Promise<PreviewImage> => {
    const r = await ctx.shell.call<{ png: string }>('metafileToPng', { kind, data: Buffer.from(data).toString('base64'), max: 2400 }, 30000)
    return image('image/png', Buffer.from(r.png, 'base64'))
  }

  return {
    /** What the file is by its first bytes, whatever its extension says. */
    'preview.sniff': (path: string, slot = 'default'): Promise<FileSniff> => worker.run('sniff', slot, path),

    'preview.sheetBook': (path: string, slot = 'default'): Promise<SheetBook> => readable('workbook', worker.run('sheetBook', slot, path)),
    'preview.sheet': (path: string, index: number, slot = 'default'): Promise<SheetGrid> => readable('sheet', worker.run('sheetGrid', slot, path, index)),

    'preview.docx': (path: string, slot = 'default'): Promise<DocxPreview> => readable('document', worker.run('docx', slot, path)),

    'preview.dgn': (path: string, slot = 'default'): Promise<DgnDrawing> => readable('design file', worker.run('dgn', slot, path)),

    'preview.dwg': async (path: string, slot = 'default'): Promise<DwgPreview> => {
      const t = await readable('drawing', worker.run<DwgThumb>('dwg', slot, path))
      const base = { version: t.version, release: t.release }
      if (t.cutShort) return { ...base, image: null, stored: null, note: 'The drawing is incomplete: its saved preview lies beyond the end of the file.' }
      if (!t.data || !t.kind) return { ...base, image: null, stored: null, note: 'No preview picture is saved in this drawing.' }
      if (t.kind === 'wmf') {
        try {
          return { ...base, image: await metafile('wmf', t.data), stored: 'wmf', note: '' }
        } catch {
          return { ...base, image: null, stored: 'wmf', note: 'The saved preview is a Windows metafile that could not be converted.' }
        }
      }
      return { ...base, image: image(t.kind === 'png' ? 'image/png' : 'image/bmp', t.data), stored: t.kind, note: '' }
    },

    'preview.ole': async (path: string, slot = 'default'): Promise<OlePreview> => {
      const f = await readable('file', worker.run<OleFound>('ole', slot, path))
      const base = { app: f.app, props: f.props, stored: f.stored }
      if (!f.data || !f.kind) return { ...base, image: null, note: 'No preview is stored in this file.' }
      if (f.kind === 'emf' || f.kind === 'wmf') {
        try {
          return { ...base, image: await metafile(f.kind, f.data), note: '' }
        } catch {
          return { ...base, image: null, note: 'The stored preview is a Windows metafile that could not be converted.' }
        }
      }
      return { ...base, image: image(`image/${f.kind}`, f.data), note: '' }
    }
  }
}
