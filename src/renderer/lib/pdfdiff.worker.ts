// Pixel diff off the UI thread: two RGBA pages in, the overlay image and change boxes out.
import { pixelDiff, type DiffOptions } from '@shared/pixeldiff'

interface Job {
  id: number
  a: ArrayBuffer
  aw: number
  ah: number
  b: ArrayBuffer
  bw: number
  bh: number
  opts?: DiffOptions
}

self.onmessage = (e: MessageEvent<Job>) => {
  const { id, a, aw, ah, b, bw, bh, opts } = e.data
  try {
    const r = pixelDiff(new Uint8ClampedArray(a), aw, ah, new Uint8ClampedArray(b), bw, bh, opts)
    ;(self as unknown as Worker).postMessage({ id, ok: true, r }, [r.out.buffer, r.cells.buffer])
  } catch (err: any) {
    ;(self as unknown as Worker).postMessage({ id, ok: false, error: String(err?.message ?? err) })
  }
}
