// Client-link notices to the sender on Zoho Cliq, sent by the PC that runs the Dexterity Share server
// (publicShare.host.pc), so they arrive even when the sender's own PC is off:
//   - the first time a client downloads a link;
//   - shortly before a link closes (two days before, or a third of its life for short links),
//     saying whether it was downloaded, so the sender can renew it in time.
// What was sent is kept in <store>\<id>\notices.json, so a notice goes out once per link across the
// office. A link already downloaded before this ran is recorded without a notice.
import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ShareManifest, ShareStats } from '@shared/pubshare'
import { DEFAULT_PAGE_URL, GIST_ID_RE, KEY_HASH_RE, isShareId, shareUrl } from '@shared/pubshare'
import { postCliq } from './cliq'
import type { Discovery } from './discovery'
import { formatBytes } from './protocol'
import type { LanCtx } from './types'

const SWEEP_MS = 5 * 60_000
const HOUR = 3600_000
const MAX_TRIES = 6

interface Notices {
  v: 1
  firstDownload?: number
  expiring?: number
  tries?: { firstDownload?: number; expiring?: number }
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })
const when = (ms: number) => `${dateFmt.format(new Date(ms)).replace(',', '')}, ${timeFmt.format(new Date(ms))}`

function left(ms: number) {
  if (ms >= 36 * HOUR) return `${Math.round(ms / (24 * HOUR))} days`
  if (ms >= 2 * HOUR) return `${Math.round(ms / HOUR)} hours`
  return `${Math.max(1, Math.round(ms / 60_000))} minutes`
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** Notice text and card for one event. Exported for tests. */
export function linkNotice(kind: 'firstDownload' | 'expiring', m: ShareManifest, stats: ShareStats | null, url: string, pageUrl: string, now: number) {
  const files = m.files.length
  const bytes = m.files.reduce((a, f) => a + f.size, 0)
  const what = `${files} ${files === 1 ? 'file' : 'files'} · ${formatBytes(bytes)}`
  const downloads = stats?.downloads ?? 0
  let thumbnail = ''
  try {
    thumbnail = new URL('brand/mark-180.png', (pageUrl || DEFAULT_PAGE_URL).replace(/[#?].*$/, '').replace(/([^/])$/, '$1/')).href
  } catch {}
  if (kind === 'firstDownload') {
    const at = stats?.lastDownloadAt || now
    return {
      title: 'Your client has downloaded it',
      text: [
        `*${m.title}* was downloaded on ${when(at)}.`,
        `${what} · the link stays open until ${when(m.expiresAt)} (${left(m.expiresAt - now)}).`,
        `This is the only download notice for this link. Every download is listed in Hopper under Share ▾ › My client links.`
      ].join('\n'),
      thumbnail,
      url
    }
  }
  return {
    title: `Closes in ${left(m.expiresAt - now)}`,
    text: [
      `Your client link *${m.title}* closes on ${when(m.expiresAt)}.`,
      downloads > 0
        ? `Downloaded ${downloads === 1 ? 'once' : `${downloads} times`}, last on ${when(stats!.lastDownloadAt)}.`
        : `Not downloaded yet, so your client may still need it.`,
      `To keep it open, choose Renew in Hopper under Share ▾ › My client links.`
    ].join('\n'),
    thumbnail,
    url
  }
}

export class LinkNotices {
  private timer: NodeJS.Timeout | null = null
  private running = false

  private ctx: LanCtx
  private discovery: Discovery

  constructor(ctx: LanCtx, discovery: Discovery) {
    this.ctx = ctx
    this.discovery = discovery
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.sweep().catch((e) => this.ctx.log('notices', String(e?.message ?? e))), SWEEP_MS)
    this.timer.unref()
    setTimeout(() => void this.sweep().catch(() => {}), 60_000).unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** True when this PC runs the office share server and notices are switched on. */
  private active() {
    const o = this.ctx.office
    const ps = o?.publicShare
    if (!o?.cliq?.enabled || o.cliq.linkNotices === false || !ps?.enabled) return false
    const pc = ps.host?.pc?.trim().toLowerCase()
    return !!pc && pc === this.ctx.me.host.trim().toLowerCase()
  }

  private store() {
    const ps = this.ctx.office?.publicShare
    return ps?.store?.trim() || (this.ctx.officePath ? join(dirname(this.ctx.officePath), 'PublicShares') : '')
  }

  async sweep(now = Date.now()) {
    if (this.running || !this.active()) return 0
    this.running = true
    let sent = 0
    try {
      const store = this.store()
      if (!store) return 0
      const ps = this.ctx.office!.publicShare!
      const pageUrl = ps.pageUrl?.trim() || DEFAULT_PAGE_URL
      const pointer = ps.pointer && GIST_ID_RE.test(ps.pointer.gist ?? '') && KEY_HASH_RE.test(ps.pointer.key ?? '') ? ps.pointer : null
      const names = (await fsp.readdir(store, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && isShareId(d.name)).map((d) => d.name)
      for (const id of names) {
        const dir = join(store, id)
        const m = await readJson<ShareManifest>(join(dir, 'manifest.json'))
        if (!m || m.id !== id || !Array.isArray(m.files) || !m.owner?.user) continue
        if (m.expiresAt <= now) continue
        const stats = await readJson<ShareStats>(join(dir, 'stats.json'))
        const file = join(dir, 'notices.json')
        const had = await readJson<Notices>(file)
        const n: Notices = had?.v === 1 ? had : { v: 1 }
        const before = JSON.stringify(n)
        const downloads = stats?.v === 1 ? stats.downloads : 0
        const due: ('firstDownload' | 'expiring')[] = []
        if (downloads > 0 && !n.firstDownload) {
          // first sight of a link downloaded more than an hour ago (before this ran): record only
          if (!had && (stats?.lastDownloadAt ?? 0) < now - HOUR) n.firstDownload = -1
          else due.push('firstDownload')
        }
        const life = m.expiresAt - m.createdAt
        if (!n.expiring && m.expiresAt - now <= Math.min(48 * HOUR, life / 3)) due.push('expiring')
        for (const kind of due) {
          const ok = await this.send(kind, m, stats?.v === 1 ? stats : null, shareUrl(pageUrl, id, pointer), pageUrl, now)
          const tries = (n.tries ??= {})
          if (ok) {
            n[kind] = now
            sent++
          } else if ((tries[kind] = (tries[kind] ?? 0) + 1) >= MAX_TRIES) n[kind] = -2 // give up quietly after half an hour
        }
        if (JSON.stringify(n) !== before) await fsp.writeFile(file, JSON.stringify(n), 'utf8').catch((e) => this.ctx.log('notices', `${id}: ${e?.message ?? e}`))
      }
    } finally {
      this.running = false
    }
    return sent
  }

  private async send(kind: 'firstDownload' | 'expiring', m: ShareManifest, stats: ShareStats | null, url: string, pageUrl: string, now: number) {
    const user = m.owner.user.toLowerCase()
    const email = this.discovery.emailFor(user)
    if (!email) {
      this.ctx.log('notices', `no Zoho email known for ${user}; ${kind} notice for ${m.id} skipped`)
      return false
    }
    const note = linkNotice(kind, m, stats, url, pageUrl, now)
    const extra = {
      card: { title: note.title, theme: 'modern-inline', ...(note.thumbnail ? { thumbnail: note.thumbnail } : {}) },
      buttons: [{ label: 'Open the link', type: '+', action: { type: 'open.url', data: { web: note.url } } }]
    }
    let res = await postCliq(this.ctx.office?.cliq, [email], note.text, extra)
    // a bot that refuses the card still gets the words
    if (!res.ok && res.status >= 400 && res.status < 500) res = await postCliq(this.ctx.office?.cliq, [email], `${note.title}\n${note.text}\n${note.url}`)
    this.ctx.log('notices', res.ok ? `${kind} notice for ${m.id} sent to ${user}` : `${kind} notice for ${m.id} to ${user} failed: ${res.status ? `HTTP ${res.status} ` : ''}${res.error ?? ''}`)
    return res.ok
  }
}
