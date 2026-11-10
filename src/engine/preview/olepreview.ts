// Looks inside an OLE compound file (.sha, DGN V8, .doc, .xls…) for a preview picture the
// authoring program saved with it: the thumbnail property of the summary information, or a
// top-level stream named as a preview. Embedded pictures (logos, pasted images) are not previews
// and are deliberately ignored. Also returns the document properties stored in the file.
import { Cfb, type Source } from './cfb'
import { dibToBmp } from './dwg'

export interface OleFound {
  app: 'SmartSketch' | 'MicroStation V8' | 'Word' | 'Excel' | 'compound file'
  /** png / jpeg / bmp are ready to show; emf / wmf still need converting */
  kind: 'png' | 'jpeg' | 'bmp' | 'emf' | 'wmf' | null
  data: Buffer | null
  /** where the picture was found */
  stored: string | null
  props: [string, string][]
}

const MAX_PREVIEW = 48 * 1024 * 1024
const PROP_NAMES: Record<number, string> = { 2: 'Title', 3: 'Subject', 4: 'Author', 5: 'Keywords', 6: 'Comments', 8: 'Last saved by', 9: 'Revision number', 12: 'Created', 13: 'Last saved', 18: 'Application' }

/** Classifies raw picture bytes by their signature. */
export function sniffImage(d: Buffer): 'png' | 'jpeg' | 'bmp' | 'emf' | 'wmf' | 'dib' | null {
  if (d.length < 44) return null
  if (d.readUInt32BE(0) === 0x89504e47) return 'png'
  if (d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) return 'jpeg'
  if (d[0] === 0x42 && d[1] === 0x4d && d.readUInt32LE(6) === 0 && d.readUInt32LE(14) >= 12 && d.readUInt32LE(14) <= 124) return 'bmp'
  if (d.readUInt32LE(0) === 1 && d.readUInt32LE(40) === 0x464d4520) return 'emf'
  if (d.readUInt32LE(0) === 0x9ac6cdd7) return 'wmf'
  if ((d.readUInt16LE(0) === 1 || d.readUInt16LE(0) === 2) && d.readUInt16LE(2) === 9 && (d.readUInt16LE(4) === 0x0300 || d.readUInt16LE(4) === 0x0100)) return 'wmf'
  if (d.readUInt32LE(0) === 40 && d.readUInt16LE(12) === 1) return 'dib'
  return null
}

function asImage(d: Buffer): Pick<OleFound, 'kind' | 'data'> | null {
  const k = sniffImage(d)
  if (!k) return null
  if (k === 'dib') {
    const bmp = dibToBmp(d)
    return bmp ? { kind: 'bmp', data: bmp } : null
  }
  return { kind: k, data: d }
}

function fileTime(d: Buffer, o: number) {
  const t = Number(d.readBigUInt64LE(o))
  if (!t) return ''
  const ms = t / 10000 - 11644473600000
  // Values under a day are durations (editing time), not dates.
  if (!(ms > 0) || ms > 8.64e15) return ''
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

interface PropSet {
  props: [string, string][]
  thumb: Pick<OleFound, 'kind' | 'data'> | null
}

/** Parses a \005SummaryInformation property set stream. */
export function readSummary(d: Buffer): PropSet {
  const out: PropSet = { props: [], thumb: null }
  if (d.length < 48 || d.readUInt16LE(0) !== 0xfffe || d.readUInt32LE(24) < 1) return out
  const base = d.readUInt32LE(44)
  if (base + 8 > d.length) return out
  const count = Math.min(d.readUInt32LE(base + 4), 256)
  let codepage = 1252
  const entries: [number, number][] = []
  for (let i = 0; i < count && base + 16 + i * 8 <= d.length; i++) entries.push([d.readUInt32LE(base + 8 + i * 8), base + d.readUInt32LE(base + 12 + i * 8)])
  for (const [id, o] of entries) if (id === 1 && o + 6 <= d.length && d.readUInt16LE(o) === 2) codepage = d.readUInt16LE(o + 4)
  const decode = (b: Buffer) => {
    try {
      return new TextDecoder(codepage === 65001 ? 'utf-8' : codepage === 1200 ? 'utf-16le' : `windows-${codepage}`).decode(b)
    } catch {
      return b.toString('latin1')
    }
  }
  for (const [id, o] of entries) {
    if (o + 8 > d.length) continue
    const type = d.readUInt32LE(o) & 0xffff
    if (id === 17 && type === 71) {
      const cb = d.readUInt32LE(o + 4)
      if (cb < 8 || cb > MAX_PREVIEW || o + 8 + cb > d.length) continue
      const tag = d.readInt32LE(o + 8)
      let body = d.subarray(o + 12, o + 8 + cb)
      if (tag === -1 || tag === -2) body = body.subarray(4)
      // A metafile picture has an 8-byte mapping header before the metafile itself.
      out.thumb = asImage(body) ?? asImage(body.subarray(8))
      continue
    }
    const name = PROP_NAMES[id]
    if (!name) continue
    let value = ''
    if (type === 30 || type === 31) {
      const n = d.readUInt32LE(o + 4)
      const bytes = type === 31 ? n * 2 : n
      if (n > 4096 || o + 8 + bytes > d.length) continue
      value = (type === 31 ? d.subarray(o + 8, o + 8 + bytes).toString('utf16le') : decode(d.subarray(o + 8, o + 8 + bytes))).replace(/\0+$/, '').trim()
    } else if (type === 64 && o + 12 <= d.length) value = fileTime(d, o + 4)
    if (value) out.props.push([name, value])
  }
  return out
}

const words = (tag: string) => tag.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim()
const unescape = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim()

/** Title block and revision fields that SmartSketch-based drawings keep as small XML streams. */
function taggedText(cfb: Cfb): [string, string][] {
  const out: [string, string][] = []
  const leaf = /<([A-Za-z_][\w.-]*)>([^<]+)<\/\1>/g
  for (const name of ['TitleArea', 'SignatureArea', 'Revision']) {
    const e = cfb.find(`TaggedTxtData/${name}`)
    if (!e || e.size > 256 * 1024) continue
    const xml = cfb.read(e).toString('utf8')
    if (name === 'Revision') {
      for (const rec of xml.split('<RevisionRecord>').slice(1, 13)) {
        const parts = [...rec.matchAll(leaf)].map((m) => [words(m[1]), unescape(m[2])]).filter((p) => p[1])
        if (parts.length) out.push(['Revision record', parts.map((p) => `${p[0].replace(/ For Revise$/, '')}: ${p[1]}`).join(' · ')])
      }
    } else {
      for (const m of xml.matchAll(leaf)) if (unescape(m[2]) && out.length < 40) out.push([words(m[1]), unescape(m[2])])
    }
  }
  return out
}

export function readOlePreview(src: Source): OleFound {
  const cfb = new Cfb(src)
  const names = new Set(cfb.streams().map((e) => e.path.toLowerCase()))
  const app: OleFound['app'] =
    names.has('dgn~h') || names.has('dgn~s') || [...names].some((n) => n.startsWith('dgn-md') || n.startsWith('dgn~mf'))
      ? 'MicroStation V8'
      : names.has('psmroots') || names.has('jsiteslist') || names.has('docversion3')
        ? 'SmartSketch'
        : names.has('worddocument')
          ? 'Word'
          : names.has('workbook') || names.has('book')
            ? 'Excel'
            : 'compound file'
  const found: OleFound = { app, kind: null, data: null, stored: null, props: [] }

  const summary = cfb.find('\u0005SummaryInformation')
  if (summary && summary.size <= MAX_PREVIEW) {
    const s = readSummary(cfb.read(summary))
    found.props = s.props
    if (s.thumb) return { ...found, ...s.thumb, stored: 'thumbnail property' }
  }
  // Title block fields first: they say which drawing this is.
  if (app === 'SmartSketch') found.props = [...taggedText(cfb), ...found.props]
  for (const e of cfb.streams()) {
    if (e.path.includes('/') || !/preview|thumbnail/i.test(e.name) || e.size < 64 || e.size > MAX_PREVIEW) continue
    const img = asImage(cfb.read(e))
    if (img) return { ...found, ...img, stored: `stream "${e.name}"` }
  }
  return found
}
