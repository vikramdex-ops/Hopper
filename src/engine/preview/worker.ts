// Worker thread of the engine for preview parsing, so a 50 MB design file or a heavy workbook
// never delays a directory listing. One task at a time; parsers are imported on first use.
import { parentPort } from 'node:worker_threads'
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import type { Source } from './cfb'
import type { FileSniff } from './types'

const MAX_DGN = 300 * 1024 * 1024
const MAX_OFFICE = 150 * 1024 * 1024
const MAX_TEXT_SHEET = 8 * 1024 * 1024
const mb = (n: number) => `${Math.round(n / 1048576)} MB`

function withFile<T>(path: string, fn: (src: Source) => T): T {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    return fn({
      size,
      read(pos, length) {
        const n = Math.max(0, Math.min(length, size - pos))
        const b = Buffer.alloc(n)
        let got = 0
        while (got < n) {
          const r = readSync(fd, b, got, n - got, pos + got)
          if (r <= 0) break
          got += r
        }
        return got === n ? b : b.subarray(0, got)
      }
    })
  } finally {
    closeSync(fd)
  }
}

export function sniff(head: Uint8Array): FileSniff {
  if (head.length >= 4 && (head[0] & 0x3f) === 8 && head[1] === 0x09 && head[2] === 0xfe && head[3] === 0x02) return 'dgn7'
  if (head.length >= 8 && head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0 && head[4] === 0xa1 && head[5] === 0xb1 && head[6] === 0x1a && head[7] === 0xe1) return 'cfb'
  if (head.length >= 6 && head[0] === 0x41 && head[1] === 0x43 && head[2] >= 0x30 && head[2] <= 0x39) return 'dwg'
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4) return 'zip'
  if (head.length >= 4 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return 'pdf'
  return 'other'
}

// The last spreadsheet stays in memory while the worker lives, so switching sheets does not
// read the file again. The key includes size and modified time.
let book: { key: string; data: Buffer; truncated: boolean } | null = null
function sheetData(path: string) {
  const st = statSync(path)
  const key = `${path}|${st.size}|${st.mtimeMs}`
  if (book?.key === key) return book
  const ext = extname(path).slice(1).toLowerCase()
  const text = ext === 'csv' || ext === 'tsv'
  if (!text && st.size > MAX_OFFICE) throw new Error(`This workbook is ${mb(st.size)}; previews stop at ${mb(MAX_OFFICE)}.`)
  let data: Buffer
  let truncated = false
  if (text && st.size > MAX_TEXT_SHEET) {
    data = withFile(path, (src) => src.read(0, MAX_TEXT_SHEET))
    const cut = data.lastIndexOf(0x0a)
    if (cut > 0) data = data.subarray(0, cut)
    truncated = true
  } else data = readFileSync(path)
  book = { key, data, truncated }
  return book
}

type Out = { value: unknown; transfer?: ArrayBuffer[] }

async function run(task: string, args: any[]): Promise<Out> {
  const path: string = args[0]
  const ext = extname(path).slice(1).toLowerCase()
  switch (task) {
    case 'sniff':
      return { value: withFile(path, (src) => sniff(src.read(0, 16))) }
    case 'dwg': {
      const { readDwgThumbnail } = await import('./dwg')
      return { value: withFile(path, readDwgThumbnail) }
    }
    case 'ole': {
      const { readOlePreview } = await import('./olepreview')
      return { value: withFile(path, readOlePreview) }
    }
    case 'dgn': {
      const size = statSync(path).size
      if (size > MAX_DGN) throw new Error(`This design file is ${mb(size)}; previews stop at ${mb(MAX_DGN)}.`)
      const { parseDgn7 } = await import('./dgn7')
      const d = parseDgn7(readFileSync(path))
      return { value: d, transfer: [d.lines.buffer, d.arcs.buffer, d.lineStart.buffer, d.lineAttr.buffer, d.arcAttr.buffer, ...d.images.map((i) => i.rgba.buffer)] as ArrayBuffer[] }
    }
    case 'sheetBook': {
      const { sheetBook } = await import('./sheet')
      const b = sheetData(path)
      return { value: await sheetBook(b.data, ext, b.truncated) }
    }
    case 'sheetGrid': {
      const { sheetGrid } = await import('./sheet')
      return { value: await sheetGrid(sheetData(path).data, ext, Number(args[1]) || 0) }
    }
    case 'docx': {
      const size = statSync(path).size
      if (size > MAX_OFFICE) throw new Error(`This document is ${mb(size)}; previews stop at ${mb(MAX_OFFICE)}.`)
      const { docxToHtml } = await import('./word')
      return { value: await docxToHtml(readFileSync(path)) }
    }
    default:
      throw new Error(`unknown preview task ${task}`)
  }
}

parentPort?.on('message', async (msg: { id: number; task: string; args: any[] }) => {
  try {
    const { value, transfer } = await run(msg.task, msg.args)
    parentPort!.postMessage({ id: msg.id, ok: true, value }, transfer ?? [])
  } catch (err: any) {
    parentPort!.postMessage({ id: msg.id, ok: false, error: String(err?.message ?? err) })
  }
})
