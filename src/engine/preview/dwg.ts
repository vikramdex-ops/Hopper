// Reads the preview picture AutoCAD / BricsCAD save inside a .dwg (R13 to 2018 formats).
// It is the picture taken when the drawing was last saved, not a rendering of the drawing.
// The preview block is found through the pointer at byte 13 of the file and checked by its
// 16-byte sentinel; every offset read from the file is validated before use.
import type { Source } from './cfb'

export const DWG_RELEASES: Record<string, string> = {
  'AC1.2': 'AutoCAD R1.2',
  'AC1.40': 'AutoCAD R1.4',
  'AC1.50': 'AutoCAD R2.0',
  'AC2.10': 'AutoCAD R2.10',
  AC1002: 'AutoCAD R2.5',
  AC1003: 'AutoCAD R2.6',
  AC1004: 'AutoCAD R9',
  AC1006: 'AutoCAD R10',
  AC1009: 'AutoCAD R11 / R12',
  AC1012: 'AutoCAD R13',
  AC1014: 'AutoCAD R14',
  AC1015: 'AutoCAD 2000',
  AC1018: 'AutoCAD 2004',
  AC1021: 'AutoCAD 2007',
  AC1024: 'AutoCAD 2010',
  AC1027: 'AutoCAD 2013',
  AC1032: 'AutoCAD 2018'
}

const SENTINEL = Buffer.from([0x1f, 0x25, 0x6d, 0x07, 0xd4, 0x36, 0x28, 0x28, 0x9d, 0x57, 0xca, 0x3f, 0x9d, 0x44, 0x10, 0x2b])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MAX_IMAGE = 32 * 1024 * 1024
const HAS_PREVIEW = new Set(['AC1012', 'AC1014', 'AC1015', 'AC1018', 'AC1021', 'AC1024', 'AC1027', 'AC1032'])

export interface DwgThumb {
  version: string
  release: string
  /** bmp: a complete .bmp file; png: a .png file; wmf: metafile bytes that still need converting */
  kind: 'bmp' | 'png' | 'wmf' | null
  data: Buffer | null
  /** the header points at a preview that lies beyond the end of the file */
  cutShort?: boolean
}

export function dwgVersion(head: Uint8Array) {
  const tag = Buffer.from(head.buffer, head.byteOffset, Math.min(6, head.length)).toString('latin1')
  return /^AC\d[\d.]{3}/.test(tag) ? tag.replace(/\0+$/, '') : ''
}

/** Size in bytes of the colour table that follows a BITMAPINFOHEADER, or -1 if the header is not sane. */
function dibPalette(d: Buffer) {
  if (d.length < 40) return -1
  const size = d.readUInt32LE(0)
  const w = d.readInt32LE(4)
  const h = Math.abs(d.readInt32LE(8))
  const planes = d.readUInt16LE(12)
  const bpp = d.readUInt16LE(14)
  const comp = d.readUInt32LE(16)
  const used = d.readUInt32LE(32)
  if (![40, 52, 56, 108, 124].includes(size) || planes !== 1 || ![1, 4, 8, 16, 24, 32].includes(bpp)) return -1
  if (w < 1 || w > 16384 || h < 1 || h > 16384 || (comp !== 0 && comp !== 3) || used > 256) return -1
  const colors = bpp <= 8 ? used || 1 << bpp : used
  return colors * 4 + (comp === 3 && size === 40 ? 12 : 0)
}

/** Wraps a device-independent bitmap in a BMP file header so Chromium can decode it. */
export function dibToBmp(dib: Buffer): Buffer | null {
  const pal = dibPalette(dib)
  if (pal < 0) return null
  const off = 14 + dib.readUInt32LE(0) + pal
  if (off > 14 + dib.length) return null
  const head = Buffer.alloc(14)
  head.write('BM', 0, 'latin1')
  head.writeUInt32LE(14 + dib.length, 2)
  head.writeUInt32LE(off, 10)
  return Buffer.concat([head, dib])
}

const looksWmf = (d: Buffer) => d.length >= 18 && (d.readUInt32LE(0) === 0x9ac6cdd7 || ((d.readUInt16LE(0) === 1 || d.readUInt16LE(0) === 2) && d.readUInt16LE(2) === 9))

export function readDwgThumbnail(src: Source): DwgThumb {
  const head = src.read(0, 32)
  const version = dwgVersion(head)
  if (!version) throw new Error('Not a DWG drawing')
  const res: DwgThumb = { version, release: DWG_RELEASES[version] ?? '', kind: null, data: null }
  if (!HAS_PREVIEW.has(version) || head.length < 17) return res

  let at = head.readUInt32LE(13)
  if (at >= src.size) return { ...res, cutShort: true }
  const sentinelAt = (pos: number) => pos > 0 && pos + 21 <= src.size && src.read(pos, 16).equals(SENTINEL)
  if (!sentinelAt(at)) {
    at = findSentinel(src)
    if (at < 0) return res
  }
  const dirHead = src.read(at + 16, 5)
  if (dirHead.length < 5) return res
  const overall = dirHead.readUInt32LE(0)
  const count = dirHead[4]
  if (count < 1 || count > 16) return res
  const dir = src.read(at + 21, count * 9)
  if (dir.length < count * 9) return res

  // Entries give an absolute file position; if that does not hold image data, try the position
  // the block layout implies (image data follows the directory in entry order).
  let sequential = at + 21 + count * 9
  let wmf: Buffer | null = null
  for (let i = 0; i < count; i++) {
    const code = dir[i * 9]
    const start = dir.readUInt32LE(i * 9 + 1)
    const size = dir.readUInt32LE(i * 9 + 5)
    const here = sequential
    sequential += size
    if (code === 1 || size < 16 || size > MAX_IMAGE || size > src.size) continue
    for (const pos of [start, here]) {
      if (pos < 16 || pos + size > src.size) continue
      if (overall && overall < MAX_IMAGE && (pos < at || pos + size > at + 20 + overall + 16) && pos === here) continue
      const data = src.read(pos, size)
      if (data.length < size) continue
      if (code === 2) {
        const bmp = dibToBmp(data)
        if (bmp) return { ...res, kind: 'bmp', data: bmp }
      } else if (code === 6) {
        if (data.subarray(0, 8).equals(PNG)) return { ...res, kind: 'png', data }
      } else if (code === 3 && !wmf && looksWmf(data)) wmf = data
    }
  }
  return wmf ? { ...res, kind: 'wmf', data: wmf } : res
}

/** Scans for the preview sentinel when the header pointer is unusable (first 64 MB only). */
function findSentinel(src: Source) {
  const CHUNK = 1 << 20
  const limit = Math.min(src.size, 64 * CHUNK)
  for (let pos = 0; pos < limit; pos += CHUNK) {
    const b = src.read(pos, CHUNK + 15)
    const i = b.indexOf(SENTINEL)
    if (i >= 0) return pos + i
  }
  return -1
}
