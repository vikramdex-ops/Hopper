// Compact in-memory name index for one indexed folder.
//
// The old index kept two JS strings per file (display + lower-case name), a boxed array per
// field and a Map of arrays per folder: about 200 bytes a file, so 8.6 million files on a PC
// that indexes several network drives cost the engine process ~2 GB. Here every file costs
// ~18 bytes of typed arrays plus its name once, as lower-case UTF-8 in one Buffer:
//
//   lower     "name\0name\0…"           lower-case UTF-8, NUL after each name
//   start[i]  byte offset of name i in `lower`
//   caseBits  1 bit per byte of `lower`: that ASCII letter is upper-case in the real name
//   odd       real names the bits cannot rebuild (non-ASCII case, lone surrogates)
//   dirOf, size, mtime (seconds), flags (1 = folder, 2 = deleted)
//
// Folders are stored as parent folder + the rest of the path ("D:\Projects" + "\Lot 3"), so a
// deep tree costs each folder its own name only; they are found again through a small
// open-addressing hash table over the full lower-case path (no Map of strings).
//
// A plain word is found with Buffer.indexOf over all names at once (memchr speed), and only
// the names that contain it are decoded and checked against the full query.
import { promises as fsp } from 'node:fs'
import { win32 } from 'node:path'

export interface IndexMatcher {
  test(nameLower: string): boolean
  /** A lower-case literal every matching name must contain; lets the search jump between hits. */
  anchor?: string
  /**
   * Set when the whole query is "every word is in the name, and the extension is one of exts"
   * (lower-case, exts without the dot). The index then matches on raw bytes and never decodes
   * a name that does not match; `test` is not called.
   */
  plain?: { words: string[]; exts: string[] }
}

export interface IndexHit {
  name: string
  dir: string
  isDir: boolean
  size: number
  mtime: number
}

const F_DIR = 1
const F_DEAD = 2
const NO_SIZE = 0xffffffff
const MAGIC = 'HPIX2\n'
/** A UTF-16 surrogate without its partner (NTFS allows them in names; UTF-8 cannot hold them). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function grow<T extends Uint8Array | Uint32Array | Int32Array>(a: T, need: number): T {
  if (need <= a.length) return a
  let cap = Math.max(1024, a.length)
  while (cap < need) cap = Math.ceil(cap * 1.125) // small steps: spare capacity is resident memory
  const b = new (a.constructor as any)(cap) as T
  b.set(a)
  return b
}

function growBuf(a: Buffer, need: number): Buffer {
  if (need <= a.length) return a
  let cap = Math.max(64 * 1024, a.length)
  while (cap < need) cap = Math.ceil(cap * 1.125) // small steps: spare capacity is resident memory
  const b = Buffer.alloc(cap)
  a.copy(b)
  return b
}

/** FNV-1a over UTF-16 code units. */
function hashStr(s: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** UTF-8 byte length of one UTF-16 code unit (a surrogate pair counts 4 on the high half). */
const unitBytes = (c: number) => (c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xdc00 ? 4 : c >= 0xdc00 && c < 0xe000 ? 0 : 3)

export class NameIndex {
  root: string
  ready = false
  scannedAt?: number
  /** entries including deleted ones */
  n = 0
  dead = 0

  private lower: Buffer = Buffer.alloc(0)
  private lowerLen = 0
  private start = new Uint32Array(0)
  private caseBits = new Uint8Array(0)
  private odd = new Map<number, string>()
  private dirOf = new Uint32Array(0)
  private size = new Uint32Array(0)
  private bigSize = new Map<number, number>()
  private mtime = new Uint32Array(0)
  private flags = new Uint8Array(0)

  private dirBuf: Buffer = Buffer.alloc(0)
  private dirLen = 0
  private dirStart = new Uint32Array(0)
  private dirParent = new Int32Array(0)
  private dirHashes = new Uint32Array(0)
  nDirs = 0
  private table = new Int32Array(0)
  private lastDirPath?: string
  private lastDirId = -1

  constructor(root: string) {
    this.root = root
  }

  get live() {
    return this.n - this.dead
  }

  /** Bytes held by the index (for status / diagnostics). */
  get bytes() {
    return this.lower.length + this.start.byteLength + this.caseBits.byteLength + this.dirOf.byteLength + this.size.byteLength + this.mtime.byteLength + this.flags.byteLength + this.dirBuf.length + this.dirStart.byteLength + this.dirParent.byteLength + this.dirHashes.byteLength + this.table.byteLength
  }

  // ---------------------------------------------------------------- folders

  private segment(id: number) {
    return this.dirBuf.toString('utf8', this.dirStart[id], id + 1 < this.nDirs ? this.dirStart[id + 1] : this.dirLen)
  }

  dirPath(id: number) {
    let p = this.segment(id)
    for (let up = this.dirParent[id]; up >= 0; up = this.dirParent[up]) p = this.segment(up) + p
    return p
  }

  private findDir(lowerPath: string, h: number) {
    const mask = this.table.length - 1
    if (mask < 0) return -1
    for (let s = h & mask; ; s = (s + 1) & mask) {
      const id = this.table[s]
      if (id < 0) return -1
      if (this.dirHashes[id] === h && this.dirPath(id).toLowerCase() === lowerPath) return id
    }
  }

  private place(id: number) {
    const mask = this.table.length - 1
    let s = this.dirHashes[id] & mask
    while (this.table[s] >= 0) s = (s + 1) & mask
    this.table[s] = id
  }

  /** The id of a folder already in the index, or -1. */
  lookupDir(path: string) {
    const k = path.toLowerCase()
    return this.findDir(k, hashStr(k))
  }

  dirId(path: string) {
    if (path === this.lastDirPath) return this.lastDirId
    const k = path.toLowerCase()
    const h = hashStr(k)
    let id = this.findDir(k, h)
    if (id < 0) {
      const up = win32.dirname(path)
      let parent = -1
      let seg = path
      if (up !== path && up.length < path.length && path.startsWith(up)) {
        parent = this.dirId(up)
        seg = path.slice(up.length)
      }
      id = this.nDirs++
      const bytes = Buffer.byteLength(seg, 'utf8')
      this.dirBuf = growBuf(this.dirBuf, this.dirLen + bytes)
      this.dirStart = grow(this.dirStart, this.nDirs)
      this.dirParent = grow(this.dirParent, this.nDirs)
      this.dirHashes = grow(this.dirHashes, this.nDirs)
      this.dirStart[id] = this.dirLen
      this.dirParent[id] = parent
      this.dirHashes[id] = h
      this.dirLen += this.dirBuf.write(seg, this.dirLen, 'utf8')
      if (this.nDirs * 2 > this.table.length) this.rehash()
      else this.place(id)
    }
    this.lastDirPath = path
    this.lastDirId = id
    return id
  }

  private rehash() {
    let cap = 1024
    while (cap < this.nDirs * 3) cap *= 2
    this.table = new Int32Array(cap).fill(-1)
    for (let id = 0; id < this.nDirs; id++) this.place(id)
  }

  // ---------------------------------------------------------------- entries

  add(name: string, dir: string, isDir: boolean, size: number, mtimeMs: number) {
    const d = this.dirId(dir)
    const i = this.n++
    const lower = name.toLowerCase()
    const bytes = Buffer.byteLength(lower, 'utf8')
    this.lower = growBuf(this.lower, this.lowerLen + bytes + 1)
    this.caseBits = grow(this.caseBits, ((this.lowerLen + bytes + 1) >> 3) + 1)
    this.start = grow(this.start, this.n)
    this.dirOf = grow(this.dirOf, this.n)
    this.size = grow(this.size, this.n)
    this.mtime = grow(this.mtime, this.n)
    this.flags = grow(this.flags, this.n)

    const at = this.lowerLen
    this.start[i] = at
    this.lowerLen += this.lower.write(lower, at, 'utf8')
    this.lower[this.lowerLen++] = 0
    if (lower !== name) this.recordCase(i, name, lower, at)

    this.dirOf[i] = d
    if (Number.isInteger(size) && size >= 0 && size < NO_SIZE) this.size[i] = size
    else {
      this.size[i] = NO_SIZE
      this.bigSize.set(i, size)
    }
    this.mtime[i] = Math.min(NO_SIZE, Math.max(0, Math.round((mtimeMs || 0) / 1000)))
    this.flags[i] = isDir ? F_DIR : 0
  }

  private recordCase(i: number, name: string, lower: string, at: number) {
    if (lower.length !== name.length || LONE_SURROGATE.test(name)) {
      this.odd.set(i, name)
      return
    }
    const bits: number[] = []
    let pos = at
    for (let j = 0; j < name.length; j++) {
      const c = name.charCodeAt(j)
      if (c !== lower.charCodeAt(j)) {
        if (c < 0x41 || c > 0x5a) {
          this.odd.set(i, name)
          return
        }
        bits.push(pos)
      }
      pos += unitBytes(lower.charCodeAt(j))
    }
    for (const p of bits) this.caseBits[p >> 3] |= 1 << (p & 7)
  }

  private end(i: number) {
    return (i + 1 < this.n ? this.start[i + 1] : this.lowerLen) - 1
  }

  nameLower(i: number) {
    return this.lower.toString('utf8', this.start[i], this.end(i))
  }

  displayName(i: number) {
    const o = this.odd.get(i)
    if (o !== undefined) return o
    const a = this.start[i]
    const b = this.end(i)
    let copy: Buffer | undefined
    for (let p = a; p < b; p++) {
      if (this.caseBits[p >> 3] & (1 << (p & 7))) {
        copy ??= Buffer.from(this.lower.subarray(a, b))
        copy[p - a] -= 32
      }
    }
    return (copy ?? this.lower).toString('utf8', copy ? 0 : a, copy ? b - a : b)
  }

  isDead(i: number) {
    return (this.flags[i] & F_DEAD) !== 0
  }

  /** Mark every live entry directly inside these folders as deleted (one pass). */
  removeIn(dirIds: Set<number>) {
    if (!dirIds.size) return
    for (let i = 0; i < this.n; i++) {
      if (!(this.flags[i] & F_DEAD) && dirIds.has(this.dirOf[i])) {
        this.flags[i] |= F_DEAD
        this.dead++
      }
    }
  }

  hit(i: number): IndexHit {
    const s = this.size[i]
    return {
      name: this.displayName(i),
      dir: this.dirPath(this.dirOf[i]),
      isDir: (this.flags[i] & F_DIR) !== 0,
      size: s === NO_SIZE ? this.bigSize.get(i) ?? 0 : s,
      mtime: this.mtime[i] * 1000
    }
  }

  /** Whether bytes [a, b) of `lower` contain w (plain JS: cheaper than a native call per name). */
  private has(a: number, b: number, w: Uint8Array) {
    const L = this.lower
    const n = w.length
    const w0 = w[0]
    for (let p = a, last = b - n; p <= last; p++) {
      if (L[p] !== w0) continue
      let k = 1
      while (k < n && L[p + k] === w[k]) k++
      if (k === n) return true
    }
    return false
  }

  /** extname() semantics: the name ends with ".ext" and the dot is not its first character. */
  private endsWith(a: number, b: number, e: Uint8Array) {
    if (b - a <= e.length) return false
    for (let k = 0, p = b - e.length; k < e.length; k++, p++) if (this.lower[p] !== e[k]) return false
    return true
  }

  /** Entry whose name contains byte position p. */
  private entryAt(p: number) {
    let lo = 0
    let hi = this.n - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1
      if (this.start[mid] <= p) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** Visit every entry holding `needle`, found with native Buffer.indexOf over all names at once. */
  private jump(needle: Buffer, each: (i: number) => boolean) {
    for (let pos = 0; pos < this.lowerLen; ) {
      const p = this.lower.indexOf(needle, pos)
      if (p < 0 || p >= this.lowerLen) return true
      const i = this.entryAt(p)
      pos = this.end(i) + 1
      if (!each(i)) return false
    }
    return true
  }

  /**
   * Visit live entries that pass `pre` (cheap checks such as "folders only", run first) and the
   * matcher; `visit` returns false to stop.
   *
   * The searching is native: an anchor word is found with Buffer.indexOf over all names at once,
   * and an extension as ".ext" followed by the NUL that ends a name. (A JS loop over the bytes
   * measured 4x slower than that in Electron.) Plain word queries are then checked on bytes, so
   * only wildcard and regex queries decode the names they test.
   */
  scan(m: IndexMatcher, visit: (i: number) => boolean | void, pre?: (i: number) => boolean) {
    const enc = (t: string) => Buffer.from(t, 'utf8')
    const plain = m.plain && { words: m.plain.words.filter(Boolean).map(enc), exts: m.plain.exts.map((e) => enc('.' + e)) }
    const each = (i: number) => {
      if (this.flags[i] & F_DEAD) return true
      if (pre && !pre(i)) return true
      if (plain) {
        const a = this.start[i]
        const b = this.end(i)
        if (plain.exts.length) {
          let any = false
          for (const e of plain.exts) if ((any = this.endsWith(a, b, e))) break
          if (!any) return true
        }
        for (const w of plain.words) if (!this.has(a, b, w)) return true
      } else if (!m.test(this.nameLower(i))) return true
      return visit(i) !== false
    }
    if (plain && !plain.words.length && plain.exts.length) {
      // one pass per extension; a name has only one, so nothing is visited twice
      for (const e of plain.exts) if (!this.jump(Buffer.concat([e, Buffer.from([0])]), each)) return
      return
    }
    const anchor = m.anchor && !m.anchor.includes('\0') ? enc(m.anchor) : undefined
    if (anchor && anchor.length) {
      this.jump(anchor, each)
      return
    }
    for (let i = 0; i < this.n; i++) if (!each(i)) return
  }

  isDirEntry(i: number) {
    return (this.flags[i] & F_DIR) !== 0
  }

  dirIdOf(i: number) {
    return this.dirOf[i]
  }

  /** A copy without deleted entries and with arrays trimmed to size. */
  compact(): NameIndex {
    const next = new NameIndex(this.root)
    next.ready = this.ready
    next.scannedAt = this.scannedAt
    for (let i = 0; i < this.n; i++) {
      if (this.flags[i] & F_DEAD) continue
      const h = this.hit(i)
      next.add(h.name, h.dir, h.isDir, h.size, h.mtime)
    }
    next.trim()
    return next
  }

  /** Drop spare capacity left by growth (call once a build is finished). */
  trim() {
    const cut = <T extends Uint8Array | Uint32Array | Int32Array>(a: T, n: number) => (a.length > n ? (a.slice(0, n) as T) : a)
    this.lower = this.lower.length > this.lowerLen ? Buffer.from(this.lower.subarray(0, this.lowerLen)) : this.lower
    this.caseBits = cut(this.caseBits, (this.lowerLen >> 3) + 1)
    this.start = cut(this.start, this.n)
    this.dirOf = cut(this.dirOf, this.n)
    this.size = cut(this.size, this.n)
    this.mtime = cut(this.mtime, this.n)
    this.flags = cut(this.flags, this.n)
    this.dirBuf = this.dirBuf.length > this.dirLen ? Buffer.from(this.dirBuf.subarray(0, this.dirLen)) : this.dirBuf
    this.dirStart = cut(this.dirStart, this.nDirs)
    this.dirParent = cut(this.dirParent, this.nDirs)
    this.dirHashes = cut(this.dirHashes, this.nDirs)
    this.lastDirPath = undefined
  }

  // ---------------------------------------------------------------- disk

  private sections(): [string, Uint8Array | Uint32Array | Int32Array][] {
    return [
      ['lower', this.lower.subarray(0, this.lowerLen)],
      ['caseBits', this.caseBits.subarray(0, (this.lowerLen >> 3) + 1)],
      ['start', this.start.subarray(0, this.n)],
      ['dirOf', this.dirOf.subarray(0, this.n)],
      ['size', this.size.subarray(0, this.n)],
      ['mtime', this.mtime.subarray(0, this.n)],
      ['flags', this.flags.subarray(0, this.n)],
      ['dirBuf', this.dirBuf.subarray(0, this.dirLen)],
      ['dirStart', this.dirStart.subarray(0, this.nDirs)],
      ['dirParent', this.dirParent.subarray(0, this.nDirs)],
      ['dirHashes', this.dirHashes.subarray(0, this.nDirs)]
    ]
  }

  /** Write the index section by section (no single big buffer is built). */
  async save(file: string) {
    const secs = this.sections()
    const header = Buffer.from(
      JSON.stringify({
        root: this.root,
        scannedAt: this.scannedAt,
        n: this.n,
        dead: this.dead,
        nDirs: this.nDirs,
        lowerLen: this.lowerLen,
        dirLen: this.dirLen,
        odd: [...this.odd],
        bigSize: [...this.bigSize],
        sections: secs.map(([k, a]) => [k, a.byteLength])
      }),
      'utf8'
    )
    const head = Buffer.alloc(MAGIC.length + 4)
    head.write(MAGIC, 0, 'latin1')
    head.writeUInt32LE(header.length, MAGIC.length)
    const fh = await fsp.open(file, 'w')
    try {
      let off = 0
      const put = async (b: Uint8Array) => {
        await fh.write(b, 0, b.byteLength, off)
        off += b.byteLength
      }
      await put(head)
      await put(header)
      for (const [, a] of secs) {
        const pad = (8 - (off % 8)) % 8
        if (pad) await put(Buffer.alloc(pad))
        await put(new Uint8Array(a.buffer, a.byteOffset, a.byteLength))
      }
    } finally {
      await fh.close()
    }
  }

  /** Read a file written by save(); null when the file is not in this format. */
  static async load(file: string): Promise<NameIndex | null> {
    const raw = await fsp.readFile(file)
    if (raw.length < MAGIC.length + 4 || raw.toString('latin1', 0, MAGIC.length) !== MAGIC) return null
    const hlen = raw.readUInt32LE(MAGIC.length)
    let off = MAGIC.length + 4
    const h = JSON.parse(raw.toString('utf8', off, off + hlen))
    off += hlen
    const ix = new NameIndex(h.root)
    const got: Record<string, Uint8Array> = {}
    for (const [k, len] of h.sections as [string, number][]) {
      off += (8 - (off % 8)) % 8
      if (off + len > raw.length) throw new Error('index file is truncated')
      got[k] = raw.subarray(off, off + len)
      off += len
    }
    // Copy each section out of the file buffer. Views would save the copy at load, but the
    // first change after loading grows (copies) the arrays anyway and the views would then
    // keep the whole file buffer alive next to them.
    const own = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
    const u32 = (b: Uint8Array) => new Uint32Array(own(b))
    ix.lower = Buffer.from(got.lower)
    ix.caseBits = new Uint8Array(got.caseBits)
    ix.start = u32(got.start)
    ix.dirOf = u32(got.dirOf)
    ix.size = u32(got.size)
    ix.mtime = u32(got.mtime)
    ix.flags = new Uint8Array(got.flags)
    ix.dirBuf = Buffer.from(got.dirBuf)
    ix.dirStart = u32(got.dirStart)
    ix.dirParent = new Int32Array(own(got.dirParent))
    ix.dirHashes = u32(got.dirHashes)
    ix.n = h.n
    // counted from the flags: a change during an async save can mark entries after the header was written
    ix.dead = 0
    for (let i = 0; i < h.n; i++) if (ix.flags[i] & F_DEAD) ix.dead++
    ix.nDirs = h.nDirs
    ix.lowerLen = h.lowerLen
    ix.dirLen = h.dirLen
    ix.odd = new Map(h.odd)
    ix.bigSize = new Map(h.bigSize)
    ix.scannedAt = h.scannedAt
    if (ix.start.length !== ix.n || ix.dirStart.length !== ix.nDirs || ix.dirParent.length !== ix.nDirs || ix.lower.length !== ix.lowerLen) throw new Error('index file is inconsistent')
    ix.rehash()
    ix.ready = true
    return ix
  }
}
