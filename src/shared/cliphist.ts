// Hopper Clipboard: the model. The main process records what is copied (text, rich text, images,
// files and folders), keeps it across restarts and shows it on Win+V; this file holds the pure
// parts - classification, duplicate detection, eviction - so they can be tested.

export interface ClipSettings {
  /** record clipboard history */
  enabled: boolean
  /** Win+V opens Hopper's clipboard instead of Windows' */
  winV: boolean
  /** entries kept (pinned ones never count against this) */
  max: number
  /** picking an entry pastes it into the window you were in (else it is only copied) */
  pasteAfterPick: boolean
}

export type ClipKind = 'text' | 'image' | 'files'
export type TextHint = '' | 'url' | 'path' | 'email' | 'color' | 'number' | 'code'

export interface ClipFile {
  path: string
  dir: boolean
  /** set when the list is shown: the file or folder is gone */
  missing?: boolean
}

export interface ClipEntry {
  id: string
  kind: ClipKind
  /** content fingerprint: the same content copied again moves this entry to the top */
  hash: string
  /** first and last time it was copied, and how many times */
  at: number
  first: number
  count: number
  pinned: boolean
  /** program it was copied from (process name), when known */
  source?: string
  text?: string
  html?: string
  rtf?: string
  hint?: TextHint
  /** files: the list and whether it was a Cut */
  files?: ClipFile[]
  cut?: boolean
  /** image: file name under the history folder, size, and a small preview (data URL) */
  image?: string
  width?: number
  height?: number
  thumb?: string
  bytes: number
}

export const CLIP_DEFAULTS: ClipSettings = { enabled: true, winV: true, max: 500, pasteAfterPick: true }
export const MAX_TEXT = 2_000_000
export const MAX_HTML = 500_000

export function cleanClipSettings(raw: unknown): ClipSettings {
  const r = (raw ?? {}) as Partial<ClipSettings>
  const max = Number(r.max)
  return {
    enabled: r.enabled !== false,
    winV: r.winV !== false,
    max: Number.isFinite(max) ? Math.min(5000, Math.max(25, Math.round(max))) : CLIP_DEFAULTS.max,
    pasteAfterPick: r.pasteAfterPick !== false
  }
}

/** What a piece of copied text looks like (for the icon, filter and the actions offered). */
export function textHint(text: string): TextHint {
  const t = text.trim()
  if (!t) return ''
  if (!t.includes('\n')) {
    if (/^(https?|ftp):\/\/\S+$/i.test(t) || /^www\.\S+\.\S+$/i.test(t)) return 'url'
    if (/^"?([a-zA-Z]:\\|\\\\[^\\]+\\|file:\/\/)/.test(t)) return 'path'
    if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(t)) return 'email'
    if (/^(#[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\))$/i.test(t)) return 'color'
    if (/^[-+]?[\d,]*\.?\d+(e[-+]?\d+)?$/i.test(t)) return 'number'
  }
  const lines = t.split('\n')
  const codey = lines.filter((l) => /[{};]\s*$|^\s*(import|export|const|let|var|function|def|class|public|private|SELECT|<\/?[a-z])/i.test(l)).length
  if (lines.length >= 2 && codey / lines.length >= 0.4) return 'code'
  return ''
}

/** Fingerprint input for duplicate detection (the caller hashes it). Text ignores outer whitespace and line endings. */
export function dedupeKey(e: Pick<ClipEntry, 'kind' | 'text' | 'files'> & { imageHash?: string }) {
  if (e.kind === 'text') return 't:' + (e.text ?? '').replace(/\r\n/g, '\n').trim()
  if (e.kind === 'files') return 'f:' + (e.files ?? []).map((f) => f.path.toLowerCase()).sort().join('\n')
  return 'i:' + (e.imageHash ?? '')
}

/**
 * Add an entry: an existing one with the same hash moves to the top (count + 1, keeping its pin);
 * then unpinned entries past `max` drop off the bottom. Returns the new list and what was dropped.
 */
export function addEntry(list: ClipEntry[], e: ClipEntry, max: number): { list: ClipEntry[]; dropped: ClipEntry[]; merged: boolean } {
  const i = list.findIndex((x) => x.hash === e.hash)
  let next: ClipEntry
  let merged = false
  if (i >= 0) {
    const old = list[i]
    next = { ...e, id: old.id, first: old.first, count: old.count + 1, pinned: old.pinned, image: e.image ?? old.image, thumb: e.thumb ?? old.thumb }
    merged = true
  } else next = e
  const rest = list.filter((_, k) => k !== i)
  const all = [next, ...rest]
  const dropped: ClipEntry[] = []
  let unpinned = 0
  const kept = all.filter((x) => {
    if (x.pinned) return true
    if (++unpinned <= max) return true
    dropped.push(x)
    return false
  })
  return { list: kept, dropped, merged }
}

/**
 * Clean up: entries whose text is the same once whitespace is collapsed (keep the newest),
 * file entries whose files are all gone, and empty text. Pinned entries are never removed.
 */
export function tidy(list: ClipEntry[]): { list: ClipEntry[]; removed: ClipEntry[] } {
  const seen = new Set<string>()
  const removed: ClipEntry[] = []
  const kept = list.filter((e) => {
    if (e.pinned) return true
    let key = e.hash
    if (e.kind === 'text') {
      const t = (e.text ?? '').replace(/\s+/g, ' ').trim()
      if (!t) {
        removed.push(e)
        return false
      }
      key = 'T:' + t
    }
    if (e.kind === 'files' && e.files?.length && e.files.every((f) => f.missing)) {
      removed.push(e)
      return false
    }
    if (seen.has(key)) {
      removed.push(e)
      return false
    }
    seen.add(key)
    return true
  })
  return { list: kept, removed }
}

/** Search: every word must appear in the text, a file name/path, or the source program. */
export function matches(e: ClipEntry, q: string) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = [e.text ?? '', ...(e.files ?? []).map((f) => f.path), e.source ?? '', e.kind === 'image' ? 'image picture screenshot' : ''].join('\n').toLowerCase()
  return words.every((w) => hay.includes(w))
}

export type ClipFilter = 'all' | 'text' | 'links' | 'images' | 'files' | 'pinned'

export function byFilter(e: ClipEntry, f: ClipFilter) {
  switch (f) {
    case 'text':
      return e.kind === 'text'
    case 'links':
      return e.kind === 'text' && (e.hint === 'url' || e.hint === 'path' || e.hint === 'email')
    case 'images':
      return e.kind === 'image'
    case 'files':
      return e.kind === 'files'
    case 'pinned':
      return e.pinned
    default:
      return true
  }
}

/** One-line title for an entry (list row, notification). */
export function entryTitle(e: ClipEntry) {
  if (e.kind === 'image') return `Image ${e.width ?? '?'} × ${e.height ?? '?'}`
  if (e.kind === 'files') {
    const n = e.files?.length ?? 0
    const first = e.files?.[0]?.path.split('\\').pop() ?? ''
    return n === 1 ? first : `${first} and ${n - 1} more`
  }
  const t = (e.text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > 120 ? t.slice(0, 117) + '…' : t
}
