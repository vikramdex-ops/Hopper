// Paste-and-go: turn whatever a colleague pasted (a quoted path from Explorer's "Copy as path",
// a file:/// link from Outlook or Teams, a forward-slash path from a chat, a %USERPROFILE% path)
// into a Windows path Hopper can open. Pure, so the main process and the tests share it.

/** Environment lookup for %VAR% (main passes process.env; case-insensitive like Windows). */
export type EnvLookup = (name: string) => string | undefined

const QUOTES: Record<string, string> = { '"': '"', "'": "'", '“': '”', '‘': '’', '<': '>', '«': '»' }

/**
 * The path in pasted text, normalised, or null when the text is not a path.
 * Only the first non-empty line counts (a path copied with a trailing newline still works).
 */
export function parsePastedPath(raw: string, env?: EnvLookup): string | null {
  if (typeof raw !== 'string') return null
  let t = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  if (!t || t.length > 32767) return null
  // strip one pair of surrounding quotes or brackets (Explorer's "Copy as path" adds "")
  const close = QUOTES[t[0]]
  if (close && t.length > 1 && t.endsWith(close)) t = t.slice(1, -1).trim()
  if (!t) return null

  if (/^file:/i.test(t)) {
    t = fromFileUrl(t) ?? ''
    if (!t) return null
  }

  if (env && t.includes('%')) {
    t = t.replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (m, name: string) => env(name) ?? m)
    if (/%[A-Za-z_][A-Za-z0-9_()]*%/.test(t)) return null // unknown variable: not a usable path
  }

  t = t.replace(/\//g, '\\')
  const unc = t.startsWith('\\\\')
  // collapse doubled separators inside the path (keep the UNC lead)
  t = (unc ? '\\\\' : '') + t.slice(unc ? 2 : 0).replace(/\\{2,}/g, '\\')

  if (/^[a-zA-Z]:$/.test(t)) return t.toUpperCase() + '\\'
  if (/^[a-zA-Z]:\\/.test(t)) {
    if (/[<>"|?*]/.test(t.slice(2))) return null
    t = t[0].toUpperCase() + t.slice(1)
    return t.length > 3 ? t.replace(/\\+$/, '') : t
  }
  if (unc) {
    const parts = t.slice(2).split('\\').filter(Boolean)
    if (parts.length < 1 || /[<>"|?*]/.test(t.slice(2))) return null
    // \\server alone is a computer, not a folder: Hopper opens it as the computer's share list
    return '\\\\' + parts.join('\\')
  }
  return null
}

/** file:///C:/a%20b/c.pdf -> C:\a b\c.pdf; file://server/share/x -> \\server\share\x */
export function fromFileUrl(url: string): string | null {
  const m = /^file:(\/\/)?([^/]*)(\/.*)?$/i.exec(url.trim())
  if (!m) return null
  let host = m[2] ?? ''
  let rest = m[3] ?? ''
  try {
    host = decodeURIComponent(host)
    rest = decodeURIComponent(rest)
  } catch {
    return null
  }
  if (host && host.toLowerCase() !== 'localhost') return '\\\\' + host + rest.replace(/\//g, '\\')
  rest = rest.replace(/^\/+/, '')
  if (/^[a-zA-Z][:|]/.test(rest)) return rest[0] + ':' + rest.slice(2).replace(/\//g, '\\')
  return null
}

/** True when two Windows paths name the same place (case and trailing slash ignored). */
export function samePath(a: string, b: string) {
  const n = (p: string) => p.toLowerCase().replace(/\\+$/, '')
  return n(a) === n(b)
}
