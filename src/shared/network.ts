// Network places and discovery: the pure parts (no Electron, no DOM) so they can be unit-tested.
// The native helper (native/Network.cs) returns raw Windows results; this file turns them into
// what the Network view shows, and turns Windows error numbers into plain language.

/** A share, folder or server the user added by hand. Stored in settings on this PC only. */
export interface NetworkPlace {
  id: string
  /** \\server, \\server\share or \\server\share\folder */
  path: string
  /** friendly name; empty = show the path */
  name?: string
  added: number
}

export interface NetworkSettings {
  places: NetworkPlace[]
  /** list administrative shares (C$, ADMIN$…) too */
  showHidden: boolean
  /** the sidebar's Network node is expanded */
  expanded: boolean
}

export const defaultNetworkSettings = (): NetworkSettings => ({ places: [], showHidden: false, expanded: false })

// ---------------------------------------------------------------------------------------------
// Addresses

export type ParsedAddress =
  | { ok: true; host: string; share: string; rest: string; unc: string; kind: 'server' | 'share' | 'folder' }
  | { ok: false; code: 'empty' | 'ftp' | 'web' | 'local' | 'port' | 'invalid'; message: string }

const BAD_SHARE = /["\/\\[\]:|<>+=;,?*]/
const BAD_SEGMENT = /[<>:"/\\|?*\x00-\x1f]/
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62})(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62}))*$/
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

/** True for a computer name, a DNS name or an IPv4 address that a UNC path can use. */
export function validHost(h: string) {
  if (IPV4.test(h)) return true
  // IPv6 in UNC form: fe80--1.ipv6-literal.net
  if (/^[0-9a-f-]+(s[0-9a-z]+)?\.ipv6-literal\.net$/i.test(h)) return true
  if (/^\d+(\.\d+)*$/.test(h)) return false // looks like an IP but isn't one
  return HOSTNAME.test(h) && !h.endsWith('-')
}

/**
 * Normalises what someone typed for a network place: \\server, \\server\share\folder,
 * //server/share, smb://server/share, or a bare server name. Refuses FTP and web addresses
 * plainly (Hopper only opens Windows network shares) and anything that isn't a valid name.
 */
export function parseAddress(input: string): ParsedAddress {
  let s = (input ?? '').trim().replace(/^"(.*)"$/, '$1').trim()
  if (!s) return { ok: false, code: 'empty', message: 'Type a network address, for example \\\\server\\share.' }
  if (/^(s?ftp|ftps|ftpes):\/\//i.test(s) || /^ftp\./i.test(s))
    return { ok: false, code: 'ftp', message: "FTP isn't supported in Hopper yet. Hopper opens Windows network shares, such as \\\\server\\share." }
  if (/^(https?|webdavs?|davs?):\/\//i.test(s))
    return { ok: false, code: 'web', message: "Web addresses can't be opened as network places. Hopper opens Windows network shares, such as \\\\server\\share." }
  let port = ''
  if (/^(smb|cifs):\/\//i.test(s)) {
    s = s.replace(/^(smb|cifs):\/\//i, '')
    // smb://user@server/share: Hopper asks for the user name when the server needs one; never keep it in the address
    const at = s.indexOf('@')
    const slash = s.search(/[\\/]/)
    if (at >= 0 && (slash < 0 || at < slash)) s = s.slice(at + 1)
    s = '\\\\' + s
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
    return { ok: false, code: 'invalid', message: `Hopper can't open "${s.split(':')[0]}:" addresses. Type a network share such as \\\\server\\share.` }
  }
  if (/^[a-zA-Z]:([\\/]|$)/.test(s)) return { ok: false, code: 'local', message: 'That is a folder on this PC, not a network address. Network addresses start with \\\\, like \\\\server\\share.' }
  s = s.replace(/\//g, '\\')
  if (!s.startsWith('\\\\')) {
    // a bare name ("NAS01", "192.168.1.20") means that computer
    if (s.startsWith('\\')) return { ok: false, code: 'invalid', message: 'A network address starts with two backslashes, like \\\\server\\share.' }
    s = '\\\\' + s
  }
  const parts = s.slice(2).split('\\').filter((p, i) => p.length > 0 || i === 0)
  let host = parts[0] ?? ''
  const pm = /^(.+):(\d+)$/.exec(host)
  if (pm && !host.includes('::')) {
    host = pm[1]
    port = pm[2]
  }
  if (port && port !== '445') return { ok: false, code: 'port', message: "Windows network shares always use the standard port, so an address can't name a different one." }
  if (!host) return { ok: false, code: 'invalid', message: 'Type the computer name after the two backslashes, like \\\\server\\share.' }
  if (!validHost(host)) return { ok: false, code: 'invalid', message: `"${host}" isn't a valid computer name or IP address.` }
  const share = parts[1] ?? ''
  if (share && (BAD_SHARE.test(share) || share.length > 80)) return { ok: false, code: 'invalid', message: `"${share}" isn't a valid share name.` }
  const restParts = parts.slice(2)
  for (const seg of restParts) {
    if (BAD_SEGMENT.test(seg) || seg === '.' || seg === '..') return { ok: false, code: 'invalid', message: `"${seg}" isn't a valid folder name.` }
  }
  const rest = restParts.join('\\')
  const unc = '\\\\' + host + (share ? '\\' + share : '') + (rest ? '\\' + rest : '')
  return { ok: true, host, share, rest, unc, kind: rest ? 'folder' : share ? 'share' : 'server' }
}

/** Case-insensitive identity of a computer: "nas01", "NAS01.office.local" and "\\NAS01" are the same machine. */
export function hostKey(name: string) {
  const h = name.trim().replace(/^\\+/, '').split('\\')[0]
  if (IPV4.test(h)) return h
  return h.split('.')[0].toUpperCase()
}

export const samePlacePath = (a: string, b: string) => a.replace(/\\+$/, '').toLowerCase() === b.replace(/\\+$/, '').toLowerCase()

// ---------------------------------------------------------------------------------------------
// Virtual paths: hopper:network (everything) and hopper:network?host=NAME (one computer's shares)

export const NETWORK_ROOT = 'hopper:network'
export const networkHostPath = (host: string) => `${NETWORK_ROOT}?host=${encodeURIComponent(host)}`
export function networkHostOf(path: string): string | null {
  if (!path.startsWith(NETWORK_ROOT + '?')) return null
  return new URLSearchParams(path.slice(NETWORK_ROOT.length + 1)).get('host') || null
}
/** \\server or \\server\ (no share): the address bar and Up land on that server's share list. */
export function serverOnlyUnc(path: string): string | null {
  const m = /^\\\\([^\\]+)\\?$/.exec(path.trim())
  return m ? m[1] : null
}
/** \\server\share (the share's root), for Up. */
export function shareRootHost(path: string): string | null {
  const m = /^\\\\([^\\]+)\\[^\\]+\\?$/.exec(path.trim())
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------------------------
// Discovery: merge what each source found into one list of computers

export type SourceId = 'wsd' | 'browse' | 'serverEnum' | 'connected' | 'peers'

export interface RawSource {
  id: SourceId | string
  ms?: number
  error?: number
  items: { name: string; address?: string; unnamed?: boolean }[]
}

export interface NetComputer {
  /** name to show and to put in \\name */
  name: string
  key: string
  address?: string
  sources: string[]
  /** Hopper users on that PC (from the LAN peer list) */
  people?: string[]
  self?: boolean
}

export const SOURCE_LABEL: Record<string, string> = {
  wsd: 'Found on the network',
  browse: 'Windows network list',
  serverEnum: 'Windows network list',
  connected: 'Connected from this PC',
  peers: 'Runs Hopper'
}

/**
 * One entry per computer, whichever sources saw it. Names from different sources may differ in case
 * or carry a DNS suffix; an address-only WS-Discovery reply is dropped when a named entry has the same
 * address. The PC itself is kept (marked) because its own shares are useful to see.
 */
export function mergeComputers(sources: RawSource[], peers: { host: string; displayName?: string; self?: boolean }[] = [], selfHost = ''): NetComputer[] {
  const byKey = new Map<string, NetComputer>()
  const add = (name: string, source: string, address?: string, person?: string) => {
    name = name.trim().replace(/^\\+/, '').split('\\')[0]
    if (!name || /^(localhost|127\.0\.0\.1|::1)$/i.test(name)) return
    const key = hostKey(name)
    let c = byKey.get(key)
    if (!c) {
      // show a plain computer name (no DNS suffix); keep IP addresses as they are
      const shown = IPV4.test(name) ? name : name.split('.')[0]
      c = { name: shown === shown.toLowerCase() ? shown.toUpperCase() : shown, key, sources: [] }
      byKey.set(key, c)
    }
    if (!c.sources.includes(source)) c.sources.push(source)
    if (address && !c.address) c.address = address
    if (person) {
      c.people ??= []
      if (!c.people.includes(person)) c.people.push(person)
    }
  }
  for (const s of sources) for (const it of s.items ?? []) if (!it.unnamed) add(it.name, s.id, it.address)
  for (const p of peers) if (p.host) add(p.host, 'peers', undefined, p.self ? undefined : p.displayName)
  // address-only replies: keep only when no named computer has that address
  const known = new Set([...byKey.values()].map((c) => c.address).filter(Boolean))
  for (const s of sources) for (const it of s.items ?? []) if (it.unnamed && it.address && !known.has(it.address)) add(it.address, s.id, it.address)
  const self = selfHost ? hostKey(selfHost) : ''
  const out = [...byKey.values()]
  for (const c of out) if (self && c.key === self) c.self = true
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
}

// ---------------------------------------------------------------------------------------------
// Shares

export interface RawShare {
  name: string
  type: number
  remark?: string
}

export interface NetShare {
  name: string
  remark: string
  path: string
  hidden: boolean
}

const STYPE_MASK = 0xff
const STYPE_DISKTREE = 0
const STYPE_SPECIAL = 0x80000000

/** Folders only (no printers, IPC$ or devices); administrative and $-hidden shares only when asked for. */
export function visibleShares(host: string, raw: RawShare[], showHidden = false): NetShare[] {
  return raw
    .filter((s) => s.name && (s.type & STYPE_MASK) === STYPE_DISKTREE)
    .map((s) => ({ name: s.name, remark: s.remark ?? '', path: `\\\\${host}\\${s.name}`, hidden: s.name.endsWith('$') || ((s.type >>> 0) & STYPE_SPECIAL) !== 0 }))
    .filter((s) => showHidden || !s.hidden)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
}

// ---------------------------------------------------------------------------------------------
// Errors

export type NetErrorCode = 'notfound' | 'offline' | 'denied' | 'badlogin' | 'conflict' | 'timeout' | 'unsupported' | 'noshare' | 'busy' | 'failed'

export interface NetError {
  code: NetErrorCode
  /** one plain sentence for the user */
  message: string
  /** Windows error number, for the details line */
  winerr?: number
  /** signing in may help */
  canSignIn: boolean
}

/** Windows error (and which step failed) to a plain-language error. */
export function netError(e: { stage?: string; code?: number } | undefined, host: string): NetError {
  const code = e?.code ?? 0
  const stage = e?.stage ?? ''
  const H = host || 'The server'
  const mk = (c: NetErrorCode, message: string, canSignIn = false): NetError => ({ code: c, message, winerr: code || undefined, canSignIn })
  if (code === 1460) {
    return stage === 'resolve'
      ? mk('timeout', `Looking up ${H} took too long. The network may be slow, or the name may be wrong.`)
      : mk('timeout', `${H} took too long to answer. It may be busy or on a slow connection. Try again.`)
  }
  if (stage === 'resolve') return mk('notfound', `Hopper can't find a computer called ${H} on the network. Check the name, or try its IP address.`)
  if (stage === 'connect' && code === 1231) return mk('offline', `${H} isn't answering. It may be switched off, asleep, or not sharing any folders.`)
  if (stage === 'input') return mk('notfound', 'That is not a valid computer name.')
  switch (code) {
    case 5: // ERROR_ACCESS_DENIED
    case 65: // ERROR_NETWORK_ACCESS_DENIED
    case 2221: // NERR_UserNotFound
      return stage === 'signin'
        ? mk('denied', `That account isn't allowed to open ${H}.`, true)
        : mk('denied', `${H} needs you to sign in before it shows its shared folders.`, true)
    case 1272: // guest access blocked by policy
      return mk('denied', `${H} only allows guest access, which Windows blocks for security. Sign in with an account on ${H}.`, true)
    case 86: // ERROR_INVALID_PASSWORD
    case 1326: // ERROR_LOGON_FAILURE
      return mk('badlogin', 'The user name or password is incorrect.', true)
    case 1327: // account restriction (often a blank password)
      return mk('badlogin', 'Windows refused that account. Accounts with a blank password can\'t sign in over the network.', true)
    case 1330: // password expired
      return mk('badlogin', 'The password for that account has expired. Change it on the server, then try again.', true)
    case 1331: // account disabled
    case 1909: // account locked out
      return mk('badlogin', 'That account is disabled or locked out on the server.', true)
    case 1219: // ERROR_SESSION_CREDENTIAL_CONFLICT
      return mk('conflict', `Windows is already connected to ${H} with a different account. Sign out of ${H} first, then sign in again.`)
    case 67: // ERROR_BAD_NET_NAME
      return mk('noshare', `${H} has no shared folder with that name.`)
    case 53: // ERROR_BAD_NETPATH
    case 51: // ERROR_REM_NOT_LIST
    case 64: // ERROR_NETNAME_DELETED
    case 1203: // ERROR_NO_NET_OR_BAD_PATH
    case 1231: // ERROR_NETWORK_UNREACHABLE
    case 1232: // ERROR_HOST_UNREACHABLE
      return mk('offline', `${H} isn't answering. It may be switched off, asleep, or not sharing any folders.`)
    case 50: // ERROR_NOT_SUPPORTED
    case 1722: // RPC_S_SERVER_UNAVAILABLE
    case 1726: // RPC_S_CALL_FAILED
    case 2102: // NERR_WkstaNotStarted
    case 2114: // NERR_ServerNotStarted
      return mk('unsupported', `${H} doesn't let Hopper list its shared folders. If you know a share's name, add it with "Add a network place", for example \\\\${host || 'server'}\\share.`)
    case 2401: // ERROR_OPEN_FILES
    case 2404: // ERROR_DEVICE_IN_USE
      return mk('busy', `Files on ${H} are still open. Close them, then sign out again.`)
    default:
      return mk('failed', `Hopper couldn't open ${H} (Windows error ${code || 'unknown'}).`)
  }
}

/** An error thrown by the IPC call itself (helper timed out or exited). */
export function netCallError(err: unknown, host: string): NetError {
  const m = String((err as any)?.message ?? err)
  if (/timed out/i.test(m)) return netError({ stage: 'enum', code: 1460 }, host)
  return { code: 'failed', message: `Hopper couldn't reach ${host || 'the network'}: ${m.replace(/^Error:\s*/, '').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')}`, canSignIn: false }
}

/** A listing error from the file list that means "sign in first". */
export const isAccessDenied = (message: string) => /access (is )?denied|user name or password|logon failure|network access/i.test(message)
