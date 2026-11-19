// Small pure helpers for the Windows shell commands (Create shortcut, Run as administrator,
// recent files). No I/O here, so the rules are unit-tested (tests/unit/shellops.test.mjs).

/** File types Windows offers "Run as administrator" for. */
export const ADMIN_EXTS = ['exe', 'bat', 'cmd', 'msi', 'ps1']
export const canRunAsAdmin = (ext: string) => ADMIN_EXTS.includes((ext || '').toLowerCase().replace(/^\./, ''))

/** "report.pdf" -> "report.pdf - Shortcut.lnk", then "report.pdf - Shortcut (2).lnk"… while the name is taken. */
export function shortcutName(name: string, taken: (candidate: string) => boolean): string {
  const base = `${name.replace(/[\\/]+$/, '') || 'Drive'} - Shortcut`
  for (let i = 1; i < 1000; i++) {
    const n = i === 1 ? `${base}.lnk` : `${base} (${i}).lnk`
    if (!taken(n)) return n
  }
  return `${base} (${Date.now()}).lnk`
}

/** The name an item gets in a shortcut: a drive root "D:\" becomes "D". */
export function shortcutBaseName(path: string): string {
  const p = path.replace(/[\\/]+$/, '')
  if (/^[a-z]:$/i.test(p)) return p[0].toUpperCase()
  return p.split(/[\\/]/).pop() || p
}

export const RECENT_FILES_MAX = 20

/** Newest first, no duplicates (case-insensitive, as Windows paths are), at most `max`. */
export function pushRecent(list: readonly string[] | undefined, path: string, max = RECENT_FILES_MAX): string[] {
  const key = path.toLowerCase()
  return [path, ...(list ?? []).filter((x) => x.toLowerCase() !== key)].slice(0, max)
}
