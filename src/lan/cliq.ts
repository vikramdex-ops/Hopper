// Zoho Cliq office-bot notices. One POST per notice to the bot's message endpoint:
//   POST {endpoint}?zapikey={webhook token}   body {"text": "...", "userids": "a@x.com,b@x.com"}
// (Cliq REST API v2 "Post message to a bot"; `userids` takes user ids or email ids and limits the
// message to those bot subscribers). Calls are serialised with a 10 s timeout and no retries.
// The zapikey is never logged.
import type { OfficeConfig, ShareKind } from '@shared/types'
import { formatBytes } from './protocol'

const TIMEOUT_MS = 10_000
const GAP_MS = 400
const MAX_TEXT = 4000

export interface CliqResult {
  ok: boolean
  status: number
  error?: string
}

let chain: Promise<unknown> = Promise.resolve()

/** Post a bot message to the given emails; `extra` adds Cliq message fields (card, buttons). Never throws. */
export function postCliq(cfg: OfficeConfig['cliq'] | undefined, emails: string[], text: string, extra?: Record<string, unknown>): Promise<CliqResult> {
  const run = async (): Promise<CliqResult> => {
    if (!cfg?.endpoint || !cfg.zapikey) return { ok: false, status: 0, error: 'Cliq bot is not configured (endpoint and zapikey)' }
    const to = [...new Set(emails.map((e) => e.trim()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))]
    if (!to.length) return { ok: false, status: 0, error: 'no valid recipient email' }
    let url: URL
    try {
      url = new URL(cfg.endpoint.trim())
    } catch {
      return { ok: false, status: 0, error: 'Cliq endpoint is not a valid URL' }
    }
    if (url.protocol !== 'https:') return { ok: false, status: 0, error: 'Cliq endpoint must be https' }
    url.searchParams.set('zapikey', cfg.zapikey.trim())
    const redact = (s: string) => s.split(cfg.zapikey).join('<zapikey>')
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(extra ?? {}), text: text.slice(0, MAX_TEXT), userids: to.join(',') }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (res.ok) return { ok: true, status: res.status }
      const body = redact((await res.text().catch(() => '')).slice(0, 300))
      return { ok: false, status: res.status, error: body || res.statusText || `HTTP ${res.status}` }
    } catch (e: any) {
      const msg = e?.name === 'TimeoutError' ? 'timed out after 10 s' : String(e?.cause?.code ?? e?.message ?? e)
      return { ok: false, status: 0, error: redact(msg) }
    } finally {
      await new Promise((r) => setTimeout(r, GAP_MS).unref())
    }
  }
  const p = chain.then(run, run)
  chain = p.catch(() => {})
  return p
}

export function shareText(o: { fromName: string; files: number; bytes: number; message: string; zipped: boolean; via: 'direct' | 'server'; kind?: ShareKind; linkPath?: string }) {
  const body = o.message.trim().slice(0, 1000)
  const seen = o.via === 'direct' ? 'it is in your Hopper Inbox' : 'it will appear in your Hopper Inbox when Hopper starts'
  if (o.kind === 'message') return `${o.fromName} sent you a message in Hopper: "${body}"`
  if (o.kind === 'link') return `${o.fromName} sent you a folder link in Hopper: ${o.linkPath ?? ''}${body ? ` — "${body}"` : ''} (${seen})`
  if (o.kind === 'request') return `${o.fromName} is asking you for files in Hopper: "${body}" (${seen}; reply from there)`
  const what
 = `${o.files} ${o.files === 1 ? 'file' : 'files'} (${formatBytes(o.bytes)}${o.zipped ? ', zipped' : ''})`
  const msg = o.message.trim() ? `: "${o.message.trim().slice(0, 1000)}"` : ''
  const where =
    o.via === 'direct' ? 'saved to your Hopper Inbox' : 'on the office server, it will appear in your Hopper Inbox when Hopper starts'
  return `${o.fromName} sent you ${what}${msg} — ${where}`
}
