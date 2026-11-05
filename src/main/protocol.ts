// hopper:// scheme
//   hopper://file/?p=<path>              streamed file with Range support (media, images, pdf.js)
//   hopper://thumb/?p=<path>&s=<px>&v=<mtime>   Windows shell thumbnail, cached in memory + on disk
//   hopper://icon/?p=<path>&e=<ext>      Windows file icon (cached per extension)
import { app, nativeImage, protocol } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream, promises as fsp } from 'node:fs'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'

export function registerSchemes() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'hopper', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
  ])
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2'
}

/** Small LRU over encoded thumbnail bytes, capped by total size. */
class ByteLru {
  private map = new Map<string, Buffer>()
  private bytes = 0
  constructor(private cap: number) {}
  get(k: string) {
    const v = this.map.get(k)
    if (v) {
      this.map.delete(k)
      this.map.set(k, v)
    }
    return v
  }
  set(k: string, v: Buffer) {
    const old = this.map.get(k)
    if (old) this.bytes -= old.length
    this.map.set(k, v)
    this.bytes += v.length
    while (this.bytes > this.cap) {
      const [ok, ov] = this.map.entries().next().value as [string, Buffer]
      this.map.delete(ok)
      this.bytes -= ov.length
    }
  }
  clear() {
    this.map.clear()
    this.bytes = 0
  }
}

const thumbMem = new ByteLru(48 * 1024 * 1024)
const iconMem = new Map<string, Buffer>()
let thumbDir = ''
// Shell thumbnail extraction is CPU and disk heavy; never run more than a few at once.
let active = 0
const waiters: (() => void)[] = []
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 3) await new Promise<void>((r) => waiters.push(r))
  active++
  try {
    return await fn()
  } finally {
    active--
    waiters.shift()?.()
  }
}

function notFound(status = 404) {
  return new Response(null, { status })
}

async function serveFile(req: Request, p: string) {
  let st
  try {
    st = await fsp.stat(p)
  } catch {
    return notFound()
  }
  if (!st.isFile()) return notFound()
  const type = MIME[extname(p).slice(1).toLowerCase()] ?? 'application/octet-stream'
  const range = req.headers.get('range')
  const size = st.size
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    let start = 0
    let end = size - 1
    if (m) {
      if (m[1] === '' && m[2] !== '') {
        start = Math.max(0, size - Number(m[2]))
      } else {
        start = Number(m[1] || 0)
        if (m[2]) end = Math.min(size - 1, Number(m[2]))
      }
    }
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    const body = Readable.toWeb(createReadStream(p, { start, end, highWaterMark: 256 * 1024 })) as ReadableStream
    return new Response(body, {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes'
      }
    })
  }
  const body = Readable.toWeb(createReadStream(p, { highWaterMark: 256 * 1024 })) as ReadableStream
  return new Response(body, {
    headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
  })
}

async function serveThumb(p: string, size: number, version: string) {
  const key = createHash('sha1').update(`${p}|${version}|${size}`).digest('hex')
  const hit = thumbMem.get(key)
  const headers = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' }
  if (hit) return new Response(new Uint8Array(hit), { headers })
  const diskFile = join(thumbDir, key.slice(0, 2), key + '.jpg')
  try {
    const buf = await fsp.readFile(diskFile)
    thumbMem.set(key, buf)
    return new Response(new Uint8Array(buf), { headers })
  } catch {
    /* not cached yet */
  }
  try {
    const buf = await slot(async () => {
      const img = await nativeImage.createThumbnailFromPath(p, { width: size, height: size })
      return img.toJPEG(82)
    })
    thumbMem.set(key, buf)
    void fsp
      .mkdir(join(thumbDir, key.slice(0, 2)), { recursive: true })
      .then(() => fsp.writeFile(diskFile, buf))
      .catch(() => {})
    return new Response(new Uint8Array(buf), { headers })
  } catch {
    return notFound()
  }
}

// Extensions whose icon is per file, not per type.
const PER_FILE_ICON = new Set(['exe', 'ico', 'lnk', 'url', 'appref-ms', 'msc', 'cpl', 'scr'])

async function serveIcon(p: string, ext: string, size: 'small' | 'normal' | 'large') {
  const key = PER_FILE_ICON.has(ext) || !ext ? `${p}|${size}` : `.${ext}|${size}`
  let buf = iconMem.get(key)
  if (!buf) {
    try {
      const img = await app.getFileIcon(p, { size })
      buf = img.toPNG()
      if (iconMem.size > 2000) iconMem.clear()
      iconMem.set(key, buf)
    } catch {
      return notFound()
    }
  }
  return new Response(new Uint8Array(buf), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } })
}

export function handleProtocol() {
  thumbDir = join(app.getPath('userData'), 'thumbs')
  protocol.handle('hopper', async (req) => {
    const url = new URL(req.url)
    const p = url.searchParams.get('p') ?? ''
    if (!p || !/^([a-zA-Z]:\\|\\\\)/.test(p)) return notFound(400)
    switch (url.hostname) {
      case 'file':
        return serveFile(req, p)
      case 'thumb':
        return serveThumb(p, Math.min(512, Math.max(16, Number(url.searchParams.get('s')) || 96)), url.searchParams.get('v') ?? '')
      case 'icon':
        return serveIcon(p, (url.searchParams.get('e') ?? '').toLowerCase(), (url.searchParams.get('z') as any) || 'small')
      default:
        return notFound()
    }
  })
}

export async function clearThumbCache() {
  thumbMem.clear()
  iconMem.clear()
  await fsp.rm(thumbDir, { recursive: true, force: true }).catch(() => {})
}
