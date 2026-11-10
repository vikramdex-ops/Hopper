// pdf.js, loaded only when a PDF is previewed. The worker is a module worker from our bundle.
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
// Decoders for scanned pages (JBIG2, JPEG 2000) and colour profiles are WebAssembly files that
// pdf.js asks for by name; without them scanned drawings lose most of their content.
import jbig2Url from 'pdfjs-dist/wasm/jbig2.wasm?url'
import openjpegUrl from 'pdfjs-dist/wasm/openjpeg.wasm?url'
import qcmsUrl from 'pdfjs-dist/wasm/qcms_bg.wasm?url'

const WASM: Record<string, string> = { 'jbig2.wasm': jbig2Url, 'openjpeg.wasm': openjpegUrl, 'qcms_bg.wasm': qcmsUrl }

function load(url: string) {
  // XMLHttpRequest, because fetch() refuses file: URLs in the packaged app.
  return new Promise<Uint8Array>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', url)
    xhr.responseType = 'arraybuffer'
    xhr.onload = () => (xhr.response && (xhr.status === 200 || xhr.status === 0) ? resolve(new Uint8Array(xhr.response)) : reject(new Error(`Unable to load ${url}`)))
    xhr.onerror = () => reject(new Error(`Unable to load ${url}`))
    xhr.send()
  })
}

/** Serves pdf.js's by-name requests for binary data from the files bundled with the app. */
class BundledData {
  constructor(_options: unknown) {}
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const url = kind === 'wasmUrl' ? WASM[filename] : undefined
    if (!url) throw new Error(`No bundled ${kind} data named ${filename}`)
    return load(url)
  }
}

let ready = false

/** Files up to this size are read whole (fast paging); larger ones are read in ranges as needed. */
const WHOLE_FILE_MAX = 96 * 1024 * 1024

export async function open(url: string, size = 0) {
  if (!ready) {
    GlobalWorkerOptions.workerSrc = workerUrl
    ready = true
  }
  // A scanned page pulls dozens of objects from all over the file, and each range request is a
  // round trip through the main process, so ordinary files are simply streamed in once. Big
  // drawing sets stay on range requests (nothing is downloaded that is not looked at), in
  // chunks large enough that a page costs a few requests instead of dozens.
  const whole = size > 0 && size <= WHOLE_FILE_MAX
  const task = getDocument({
    url,
    disableAutoFetch: !whole,
    disableStream: !whole,
    rangeChunkSize: whole ? 256 * 1024 : 1024 * 1024,
    enableXfa: false,
    // Measured on scanned A1 sheets: letting the worker pre-draw images on an OffscreenCanvas
    // made those pages two to three times slower than drawing them on the page canvas.
    isOffscreenCanvasSupported: false,
    BinaryDataFactory: BundledData,
    useWorkerFetch: false
  })
  const doc = await task.promise
  return { doc, close: () => void task.destroy() }
}
