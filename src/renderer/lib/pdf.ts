// pdf.js, loaded only when a PDF is previewed. The worker is a module worker from our bundle.
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

let ready = false

export async function open(url: string) {
  if (!ready) {
    GlobalWorkerOptions.workerSrc = workerUrl
    ready = true
  }
  // Range requests through hopper://file keep big drawings from loading whole.
  const task = getDocument({ url, disableAutoFetch: true, disableStream: false, enableXfa: false })
  const doc = await task.promise
  return { doc, close: () => void task.destroy() }
}
