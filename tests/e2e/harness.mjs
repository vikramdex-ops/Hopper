// Launches the built app (out/) with Playwright, isolated user data, and a generated demo tree.
// Everything is written under HOPPER_WORK (default <work-folder>\_Claude_Work\temp\hopper-e2e), never C:.
import { _electron as electron } from 'playwright-core'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { deflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const WORK = process.env.HOPPER_WORK || '<work-folder>\\_Claude_Work\\temp\\hopper-e2e'
export const DEMO = join(WORK, 'demo')

function crcTable() {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
}
const CRC = crcTable()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Generated gradient PNG (no dependencies) so thumbnails have something to show. */
export function png(w, h, hueA, hueB) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  const hsl = (hh, s, l) => {
    const a = s * Math.min(l, 1 - l)
    const f = (n) => {
      const k = (n + hh / 30) % 12
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
    }
    return [f(0), f(8), f(4)]
  }
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2
      const [r, g, b] = hsl(hueA + (hueB - hueA) * t, 0.65, 0.35 + 0.3 * Math.sin((x * y) / (w * h) * Math.PI))
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** A realistic piping-office demo tree: project folders, iso PDFs with revisions, lots, images. */
export async function makeDemo() {
  rmSync(DEMO, { recursive: true, force: true })
  const mk = (p) => mkdirSync(join(DEMO, p), { recursive: true })
  const put = (p, data) => {
    mkdirSync(dirname(join(DEMO, p)), { recursive: true })
    writeFileSync(join(DEMO, p), data)
  }
  const require = createRequire(join(root, 'package.json'))
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib')
  const pdf = async (title, pages = 1) => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (let i = 0; i < pages; i++) {
      const pg = doc.addPage([842, 595])
      pg.drawRectangle({ x: 20, y: 20, width: 802, height: 555, borderColor: rgb(0.1, 0.1, 0.1), borderWidth: 1.5 })
      pg.drawLine({ start: { x: 120, y: 180 }, end: { x: 520, y: 420 }, thickness: 3, color: rgb(0.1, 0.3, 0.7) })
      pg.drawLine({ start: { x: 520, y: 420 }, end: { x: 700, y: 420 }, thickness: 3, color: rgb(0.1, 0.3, 0.7) })
      pg.drawCircle({ x: 520, y: 420, size: 8, borderColor: rgb(0.8, 0.2, 0.1), borderWidth: 2 })
      pg.drawText(title, { x: 600, y: 60, size: 14, font })
      pg.drawText(`Sheet ${i + 1} of ${pages}`, { x: 600, y: 40, size: 10, font })
    }
    return Buffer.from(await doc.save())
  }
  mk('P12513 Refinery Revamp/01_Incoming')
  mk('P12513 Refinery Revamp/03_Outgoing')
  mk('P12513 Refinery Revamp/05_References')
  for (const [n, revs] of [['ISO-1001', ['A', 'B', '0']], ['ISO-1002', ['A', 'B']], ['ISO-1003', ['0', '1', '2']], ['ISO-1004', ['A']], ['ISO-1005', ['B', 'C']]]) {
    for (const r of revs) put(`P12513 Refinery Revamp/02_Working/Lot 07/${n}_Rev${r}.pdf`, await pdf(`${n} Rev ${r}`, 1 + (n.charCodeAt(7) % 3)))
  }
  put('P12513 Refinery Revamp/02_Working/Lot 07/Comment register.csv', 'S.No,Drawing,Rev,Comment,Status\n1,ISO-1001,B,Add weld no.,Open\n2,ISO-1002,B,Check support SP-14,Closed\n3,ISO-1003,2,Flange rating,Open\n')
  put('P12513 Refinery Revamp/02_Working/Lot 07/notes.md', '# Lot 07\n\nBack-check due **Friday**.\n\n- ISO-1001 rev 0 issued\n- ISO-1005 waiting on stress\n')
  put('P12513 Refinery Revamp/README.txt', 'Project P12513 — refinery revamp, piping as-builts.\r\n')
  const hues = [[200, 260], [20, 60], [140, 190], [300, 340], [40, 10], [180, 220]]
  hues.forEach(([a, b], i) => put(`Site photos/IMG_${2040 + i}.png`, png(640, 420, a, b)))
  put('Site photos/survey-notes.txt', 'Pipe rack 3 — clearance checked.\r\n')
  mk('Transmittals')
  put('Transmittals/TR-0041.json', JSON.stringify({ number: 'DDS/TR/0041', to: 'Client', items: 12 }, null, 2))
  mk('Downloads')
  for (let i = 0; i < 40; i++) put(`Downloads/report-${String(i).padStart(3, '0')}.txt`, `line ${i}\n`.repeat(50 + i * 20))
  return DEMO
}

export async function launch({ userData = join(WORK, 'userdata'), fresh = true, env = {} } = {}) {
  if (fresh) rmSync(userData, { recursive: true, force: true })
  mkdirSync(userData, { recursive: true })
  const temp = join(WORK, 'tmp')
  mkdirSync(temp, { recursive: true })
  if (!existsSync(join(root, 'out', 'main', 'index.js'))) throw new Error('Build first: npm run build')
  const app = await electron.launch({
    executablePath: createRequire(join(root, 'package.json'))('electron'),
    // Chromium's sandbox can't start child processes from an exe on a network share (U:).
    args: [root, ...(/^[a-zA-Z]:/.test(root) && process.env.HOPPER_SANDBOX !== '1' ? ['--no-sandbox'] : [])],
    cwd: root,
    env: { ...process.env, HOPPER_USER_DATA: userData, TEMP: temp, TMP: temp, ...env }
  })
  const win = await app.firstWindow()
  await win.waitForFunction(() => window.__hopper?.ready === true, null, { timeout: 60000 })
  return { app, win }
}
