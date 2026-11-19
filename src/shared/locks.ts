// Lock files that programs leave next to a document while it is open, and who they name:
//   - Microsoft Office: "~$name.ext" (Word drops the first one or two characters of long names);
//     the file holds the Office user name, once in ANSI and once in UTF-16;
//   - AutoCAD: "name.dwl" (text: user, computer, time) and "name.dwl2" (XML) for "name.dwg";
//   - LibreOffice: ".~lock.name#" (one CSV line: full name, login, computer, time, profile).
// Hopper only reads them and never changes or deletes them. Pure (no Node, no DOM) so the
// renderer, the engine and node:test share it.

export type LockKind = 'office' | 'autocad' | 'libreoffice'

export interface LockOwner {
  kind: LockKind
  /** the lock file's name */
  lock: string
  /** the person's name as the program stored it */
  name?: string
  /** Windows login, when the program stores it */
  user?: string
  /** computer name, when the program stores it */
  pc?: string
  /** when it was opened, as written by the program */
  since?: string
}

const OFFICE = /^~\$(.+\.[^.]+)$/
const DWL = /^(.+)\.dwl2?$/i
const LIBRE = /^\.~lock\.(.+)#$/

/** Is this the name of a lock file Hopper understands? */
export function isLockFile(name: string): boolean {
  return OFFICE.test(name) || DWL.test(name) || LIBRE.test(name)
}

export function lockKind(name: string): LockKind | null {
  if (OFFICE.test(name)) return 'office'
  if (LIBRE.test(name)) return 'libreoffice'
  if (DWL.test(name)) return 'autocad'
  return null
}

/**
 * Which file in the same folder a lock file belongs to, or null when that cannot be told for
 * sure (no such file, or more than one candidate: never guessed).
 */
export function lockTarget(lock: string, siblings: readonly string[]): string | null {
  const byLower = new Map<string, string>()
  for (const s of siblings) if (!isLockFile(s)) byLower.set(s.toLowerCase(), s)
  let m = OFFICE.exec(lock)
  if (m) {
    const rest = m[1].toLowerCase()
    const exact = byLower.get(rest)
    if (exact) return exact
    // Word keeps the name's length: "~$cument1.docx" is the lock of "Document1.docx"
    const hits = [...byLower.entries()].filter(([l]) => (l.length === rest.length + 1 || l.length === rest.length + 2) && l.endsWith(rest)).map(([, s]) => s)
    return hits.length === 1 ? hits[0] : null
  }
  m = LIBRE.exec(lock)
  if (m) return byLower.get(m[1].toLowerCase()) ?? null
  m = DWL.exec(lock)
  if (m) return byLower.get(`${m[1]}.dwg`.toLowerCase()) ?? null
  return null
}

/** Every lock file in a listing keyed by the lower-case name of the file it belongs to. */
export function matchLocks(names: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const locks = names.filter(isLockFile)
  if (!locks.length) return out
  for (const l of locks) {
    const t = lockTarget(l, names)
    if (!t) continue
    const k = t.toLowerCase()
    out.set(k, [...(out.get(k) ?? []), l])
  }
  return out
}

const printable = (s: string) => !!s && !/[\u0000-\u001f\u007f�]/.test(s)

function decode(bytes: Uint8Array, enc: string) {
  try {
    return new TextDecoder(enc, { fatal: false }).decode(bytes)
  } catch {
    return ''
  }
}

/** The user name inside an Office "~$" owner file, or null when it cannot be read. */
export function parseOfficeOwner(b: Uint8Array): string | null {
  if (!b || b.length < 2) return null
  // the UTF-16 copy: a 16-bit character count at offset 54 (Word) or 55 (Excel), then the name
  for (const off of [54, 55]) {
    if (b.length < off + 2) continue
    const n = b[off] | (b[off + 1] << 8)
    if (n < 1 || n > 52 || off + 2 + 2 * n > b.length) continue
    const s = decode(b.subarray(off + 2, off + 2 + 2 * n), 'utf-16le').trim()
    if (printable(s)) return s
  }
  // the ANSI copy: a length byte, then the name
  const n = b[0]
  if (n >= 1 && n <= 53 && 1 + n <= b.length) {
    const s = decode(b.subarray(1, 1 + n), 'windows-1252').trim()
    if (printable(s)) return s
  }
  return null
}

/** Text of a small lock file: UTF-8 (with or without BOM), else the Windows code page. */
export function lockText(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xfe) return decode(b.subarray(2), 'utf-16le')
  const u = decode(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b, 'utf-8')
  return u.includes('�') ? decode(b, 'windows-1252') : u
}

const clean = (s: string | undefined, max = 120) => (s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) || undefined

/** AutoCAD .dwl: user, computer and time on the first three lines. */
export function parseDwl(text: string): Pick<LockOwner, 'user' | 'pc' | 'since'> {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  return { user: clean(lines[0]), pc: clean(lines[1]), since: clean(lines[2]) }
}

/** AutoCAD .dwl2: XML with username / loginname / machinename elements (any case). */
export function parseDwl2(text: string): Pick<LockOwner, 'name' | 'user' | 'pc' | 'since'> {
  const tag = (...names: string[]) => {
    for (const n of names) {
      const m = new RegExp(`<${n}>([^<]*)</${n}>`, 'i').exec(text)
      if (m && m[1].trim()) return clean(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"))
    }
    return undefined
  }
  return { name: tag('fullname', 'username'), user: tag('loginname', 'login', 'username'), pc: tag('machinename', 'machine', 'computername'), since: tag('opentime', 'savetime', 'time') }
}

/** LibreOffice .~lock.name#: "Full Name,login,COMPUTER,dd.mm.yyyy hh:mm,profile;" (commas in a field are escaped). */
export function parseLibreLock(text: string): Pick<LockOwner, 'name' | 'user' | 'pc' | 'since'> {
  const line = text.split(/\r?\n/)[0] ?? ''
  const fields: string[] = []
  let cur = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '\\' && i + 1 < line.length) cur += line[++i]
    else if (c === ',') {
      fields.push(cur)
      cur = ''
    } else cur += c
  }
  fields.push(cur.replace(/;$/, ''))
  return { name: clean(fields[0]), user: clean(fields[1]), pc: clean(fields[2]), since: clean(fields[3]) }
}

/** Who a lock file names; only what the file itself says, nothing inferred. */
export function parseLock(lockName: string, bytes: Uint8Array): LockOwner | null {
  const kind = lockKind(lockName)
  if (!kind) return null
  const base: LockOwner = { kind, lock: lockName }
  if (kind === 'office') {
    const name = parseOfficeOwner(bytes)
    return name ? { ...base, name } : base
  }
  const text = lockText(bytes)
  if (kind === 'libreoffice') return { ...base, ...strip(parseLibreLock(text)) }
  return { ...base, ...strip(/\.dwl2$/i.test(lockName) ? parseDwl2(text) : parseDwl(text)) }
}

function strip<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as any)[k] = v
  return out
}

/** "Open by ‹name› on ‹PC›", "Open by ‹login›", "Open (lock file present, owner not recorded)". */
export function lockSummary(owners: readonly LockOwner[]): string {
  const parts: string[] = []
  for (const o of owners) {
    const who = o.name || o.user
    const s = who ? `${who}${o.pc ? ` on ${o.pc}` : ''}` : o.pc ? `someone on ${o.pc}` : ''
    if (s && !parts.includes(s)) parts.push(s)
  }
  return parts.length ? `Open by ${parts.join(', ')}` : 'Open (lock file present, owner not recorded)'
}
