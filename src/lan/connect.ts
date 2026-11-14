// Dexterity Connect notices: Hopper's alerts as Direct messages from the "Hopper" integration,
// replacing the Zoho Cliq bot. One POST per notice to the office hub:
//   POST https://<hub>/api/bot/message   Authorization: Bearer <token>
//   { "text": "...", "to": ["<windows user>"], "card": { "title", "lines", "url" } }
// The hub's certificate is self-issued, so it is trusted only by its SHA-256 fingerprint
// (shown in Dexterity Connect → Control room → Integrations). Calls are serialised with a 10 s
// timeout and never throw. The token is never logged.
import https from 'node:https'
import type { TLSSocket } from 'node:tls'
import type { OfficeConfig } from '@shared/types'

const TIMEOUT_MS = 10_000
const MAX_TEXT = 4000

export interface ConnectResult {
  ok: boolean
  status: number
  error?: string
  delivered?: string[]
}

export interface ConnectCard {
  title?: string
  lines?: string[]
  url?: string
}

type ConnectConfig = NonNullable<OfficeConfig['connect']>

/** Configured well enough to send? (Connect takes over from Cliq when this is true.) */
export function connectEnabled(cfg: OfficeConfig['connect'] | undefined): cfg is ConnectConfig {
  return !!(cfg?.enabled && cfg.hub && cfg.token && /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(cfg.fingerprint ?? ''))
}

function hubAddress(hub: string): { host: string; port: number } | null {
  const m = hub.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').match(/^(\[[0-9a-f:]+\]|[\w.-]+)(?::(\d{1,5}))?$/i)
  if (!m) return null
  return { host: m[1].replace(/^\[|\]$/g, ''), port: m[2] ? Number(m[2]) : 47900 }
}

let chain: Promise<unknown> = Promise.resolve()

/** Send a notice to Windows user names (e.g. "priya.raman" or "DEXTERITY\\priya.raman"). Never throws. */
export function postConnect(cfg: OfficeConfig['connect'] | undefined, users: string[], text: string, card?: ConnectCard): Promise<ConnectResult> {
  const run = (): Promise<ConnectResult> =>
    new Promise((resolve) => {
      if (!connectEnabled(cfg)) return resolve({ ok: false, status: 0, error: 'Dexterity Connect is not configured (hub, fingerprint and token)' })
      const to = [...new Set(users.map((u) => u.trim()).filter(Boolean))]
      if (!to.length) return resolve({ ok: false, status: 0, error: 'no recipient' })
      const addr = hubAddress(cfg.hub)
      if (!addr) return resolve({ ok: false, status: 0, error: 'Dexterity Connect hub address is not valid' })
      const body = Buffer.from(JSON.stringify({ text: text.slice(0, MAX_TEXT), to, ...(card ? { card } : {}) }))
      const pin = cfg.fingerprint.toUpperCase()
      let settled = false
      const done = (r: ConnectResult) => { if (!settled) { settled = true; resolve(r) } }
      const req = https.request(
        {
          host: addr.host, port: addr.port, path: '/api/bot/message', method: 'POST', agent: false,
          rejectUnauthorized: false, // trust comes from the pinned fingerprint below
          headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json', 'content-length': body.length },
          timeout: TIMEOUT_MS
        },
        (res) => {
          let raw = ''
          res.setEncoding('utf8')
          res.on('data', (c) => { if (raw.length < 4000) raw += c })
          res.on('end', () => {
            let json: { ok?: boolean; delivered?: string[]; error?: string; unknown?: string[] } = {}
            try { json = JSON.parse(raw) } catch { /* not JSON */ }
            const status = res.statusCode ?? 0
            if (status === 200 && json.ok) done({ ok: true, status, delivered: json.delivered })
            else done({ ok: false, status, error: json.error ?? (json.unknown?.length ? `not known to Dexterity Connect: ${json.unknown.join(', ')}` : `HTTP ${status}`) })
          })
        }
      )
      req.on('socket', (sock) => {
        ;(sock as TLSSocket).once('secureConnect', () => {
          const fp = (sock as TLSSocket).getPeerX509Certificate?.()?.fingerprint256 ?? ''
          if (fp.toUpperCase() !== pin) {
            done({ ok: false, status: 0, error: 'the hub presented a different certificate than the configured fingerprint' })
            req.destroy()
          }
        })
      })
      req.on('timeout', () => { done({ ok: false, status: 0, error: 'timed out after 10 s' }); req.destroy() })
      req.on('error', (e: NodeJS.ErrnoException) => done({ ok: false, status: 0, error: String(e.code ?? e.message) }))
      req.end(body)
    })
  const p = chain.then(run, run)
  chain = p.catch(() => {})
  return p
}
