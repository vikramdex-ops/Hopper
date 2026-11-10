// Reader for OLE compound files (the container of .sha, DGN V8, .doc, .xls): header, FAT,
// directory and streams, read on demand through a random-access source. Every offset is
// bounds-checked; a malformed file throws instead of looping or reading out of range.

export interface Source {
  size: number
  /** returns up to `length` bytes at `pos` (shorter at end of file) */
  read(pos: number, length: number): Buffer
}

export interface CfbEntry {
  name: string
  /** 1 storage, 2 stream, 5 root, 0 unused */
  type: number
  path: string
  start: number
  size: number
  clsid: string
  child: number
  left: number
  right: number
}

export const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const FREE = 0xffffffff
const END = 0xfffffffe

export const bufferSource = (buf: Buffer): Source => ({
  size: buf.length,
  read: (pos, length) => buf.subarray(Math.max(0, pos), Math.max(0, Math.min(buf.length, pos + length)))
})

export class Cfb {
  readonly entries: CfbEntry[] = []
  private sectorSize: number
  private miniSize: number
  private miniCutoff: number
  private fat: Uint32Array
  private miniFat: Uint32Array = new Uint32Array(0)
  private miniStream: number[] = []
  private src: Source

  constructor(src: Source) {
    this.src = src
    const h = src.read(0, 512)
    if (h.length < 512 || !h.subarray(0, 8).equals(CFB_MAGIC)) throw new Error('Not a compound file')
    const major = h.readUInt16LE(26)
    const shift = h.readUInt16LE(30)
    const miniShift = h.readUInt16LE(32)
    if ((major !== 3 && major !== 4) || (shift !== 9 && shift !== 12) || miniShift !== 6) throw new Error('Unsupported compound file header')
    this.sectorSize = 1 << shift
    this.miniSize = 1 << miniShift
    const fatSectors = h.readUInt32LE(44)
    const dirStart = h.readUInt32LE(48)
    this.miniCutoff = h.readUInt32LE(56)
    const miniFatStart = h.readUInt32LE(60)
    const miniFatSectors = h.readUInt32LE(64)
    let difatSector = h.readUInt32LE(68)
    const difatSectors = h.readUInt32LE(72)
    const maxSectors = Math.ceil(src.size / this.sectorSize)
    if (fatSectors > maxSectors || miniFatSectors > maxSectors || difatSectors > maxSectors) throw new Error('Corrupt compound file header')

    // FAT sector list: 109 entries in the header, the rest chained through DIFAT sectors.
    const fatList: number[] = []
    for (let i = 0; i < 109 && fatList.length < fatSectors; i++) {
      const s = h.readUInt32LE(76 + i * 4)
      if (s !== FREE && s !== END) fatList.push(s)
    }
    const perSector = this.sectorSize / 4
    for (let n = 0; difatSector !== END && difatSector !== FREE && fatList.length < fatSectors; n++) {
      if (n > difatSectors + 1) throw new Error('Corrupt DIFAT chain')
      const d = this.sector(difatSector)
      for (let i = 0; i < perSector - 1 && fatList.length < fatSectors; i++) {
        const s = d.readUInt32LE(i * 4)
        if (s !== FREE && s !== END) fatList.push(s)
      }
      difatSector = d.readUInt32LE((perSector - 1) * 4)
    }
    this.fat = new Uint32Array(fatList.length * perSector)
    fatList.forEach((s, k) => {
      const d = this.sector(s)
      for (let i = 0; i < perSector; i++) this.fat[k * perSector + i] = d.readUInt32LE(i * 4)
    })

    const dir = this.readChain(dirStart, Infinity)
    for (let o = 0; o + 128 <= dir.length; o += 128) {
      const nameLen = Math.min(64, dir.readUInt16LE(o + 64))
      const type = dir[o + 66]
      const name = nameLen >= 2 ? dir.subarray(o, o + nameLen - 2).toString('utf16le') : ''
      // v3 files keep only 32 bits of the size; the high half can hold garbage.
      const size = major === 3 ? dir.readUInt32LE(o + 120) : Number(dir.readBigUInt64LE(o + 120))
      this.entries.push({
        name,
        type,
        path: '',
        start: dir.readUInt32LE(o + 116),
        size,
        clsid: dir.subarray(o + 80, o + 96).toString('hex'),
        left: dir.readUInt32LE(o + 68),
        right: dir.readUInt32LE(o + 72),
        child: dir.readUInt32LE(o + 76)
      })
    }
    const root = this.entries[0]
    if (!root || root.type !== 5) throw new Error('Compound file has no root entry')

    // Paths, walking the sibling trees with a visited set against cycles.
    const seen = new Set<number>([0])
    const walk = (id: number, prefix: string, depth: number) => {
      const stack = [id]
      while (stack.length) {
        const i = stack.pop()!
        if (i === FREE || i >= this.entries.length || seen.has(i)) continue
        seen.add(i)
        const e = this.entries[i]
        e.path = prefix + e.name
        stack.push(e.left, e.right)
        if (e.type === 1 && depth < 32) walk(e.child, e.path + '/', depth + 1)
      }
    }
    walk(root.child, '', 0)
    for (let i = 1; i < this.entries.length; i++) if (!seen.has(i)) this.entries[i].type = 0

    if (miniFatSectors && miniFatStart !== END) {
      const mf = this.readChain(miniFatStart, miniFatSectors * this.sectorSize)
      this.miniFat = new Uint32Array(mf.length >> 2)
      for (let i = 0; i < this.miniFat.length; i++) this.miniFat[i] = mf.readUInt32LE(i * 4)
      this.miniStream = this.chain(root.start)
    }
  }

  private sector(n: number) {
    const pos = (n + 1) * this.sectorSize
    if (!(pos > 0) || pos >= this.src.size) throw new Error('Compound file sector out of range')
    const b = this.src.read(pos, this.sectorSize)
    if (b.length === this.sectorSize) return b
    const full = Buffer.alloc(this.sectorSize)
    b.copy(full)
    return full
  }

  private chain(start: number) {
    const out: number[] = []
    for (let s = start; s !== END && s !== FREE; s = this.fat[s]) {
      if (s >= this.fat.length || out.length >= this.fat.length) throw new Error('Corrupt compound file chain')
      out.push(s)
    }
    return out
  }

  private readChain(start: number, limit: number) {
    const sectors = this.chain(start)
    const want = Math.min(limit, sectors.length * this.sectorSize)
    const out = Buffer.alloc(want)
    for (let i = 0, o = 0; o < want; i++, o += this.sectorSize) this.sector(sectors[i]).copy(out, o, 0, Math.min(this.sectorSize, want - o))
    return out
  }

  /** Streams only; `path` is "Storage/Stream". */
  streams() {
    return this.entries.filter((e) => e.type === 2)
  }

  find(path: string) {
    const p = path.toLowerCase()
    return this.entries.find((e) => e.type === 2 && e.path.toLowerCase() === p)
  }

  /** First `limit` bytes of a stream. */
  read(e: CfbEntry, limit = Infinity): Buffer {
    const want = Math.min(e.size, limit)
    if (want <= 0) return Buffer.alloc(0)
    if (e.size >= this.miniCutoff) {
      if (e.size > this.src.size) throw new Error('Stream larger than the file')
      return this.readChain(e.start, want)
    }
    const out = Buffer.alloc(want)
    let s = e.start
    for (let o = 0, n = 0; o < want; o += this.miniSize, n++) {
      if (s >= this.miniFat.length || n > this.miniFat.length) throw new Error('Corrupt mini stream chain')
      const pos = s * this.miniSize
      const host = this.miniStream[Math.floor(pos / this.sectorSize)]
      if (host === undefined) throw new Error('Mini stream out of range')
      const at = pos % this.sectorSize
      this.sector(host).copy(out, o, at, at + Math.min(this.miniSize, want - o))
      s = this.miniFat[s]
    }
    return out
  }
}
