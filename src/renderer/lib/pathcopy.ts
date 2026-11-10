// Path Copy: the forms of a path people paste into mails, Cliq and transmittals.
// UNC forms resolve mapped drives to \\server\share, and local folders to the share this PC
// publishes for them (falling back to the administrative \\PC\C$ share).
import { app } from './app.svelte'
import { host } from './api'
import { basename, dirname } from './format'
import { isArchivePath, isVirtual, splitArchive } from './pane.svelte'

export type PathMode = 'name' | 'path' | 'parent' | 'unc' | 'uncParent' | 'internet' | 'samba'

export const PATH_MODES: { id: PathMode; label: string; hint: string }[] = [
  { id: 'name', label: 'Name', hint: 'ISO-1001_RevB.pdf' },
  { id: 'path', label: 'Path', hint: 'Z:\\Project\\ISO-1001_RevB.pdf' },
  { id: 'parent', label: 'Parent Folder Path', hint: 'Z:\\Project' },
  { id: 'unc', label: 'UNC Path', hint: '\\\\server\\share\\Project\\ISO-1001_RevB.pdf' },
  { id: 'uncParent', label: 'UNC Parent Folder Path', hint: '\\\\server\\share\\Project' },
  { id: 'internet', label: 'Internet Path', hint: 'file://server/share/Project/ISO-1001_RevB.pdf' },
  { id: 'samba', label: 'Samba Path', hint: 'smb://server/share/Project/ISO-1001_RevB.pdf' }
]

let shares: { name: string; path: string }[] | null = null
async function localShares() {
  if (shares) return shares
  try {
    shares = ((await host.shell.shares()) as { name: string; path: string }[]).sort((a, b) => b.path.length - a.path.length)
  } catch {
    shares = []
  }
  setTimeout(() => (shares = null), 60000)
  return shares
}

/** \\server\share\… for any real path. Paths that are already UNC come back unchanged. */
export async function toUnc(p: string): Promise<string> {
  if (p.startsWith('\\\\')) return p
  const letter = p.slice(0, 2).toUpperCase()
  const rest = p.slice(2).replace(/^\\+/, '')
  const drive = app.drives.find((d) => d.root.slice(0, 2).toUpperCase() === letter)
  if (drive?.remote) return rest ? `${drive.remote.replace(/\\+$/, '')}\\${rest}` : drive.remote
  const pc = app.info?.identity?.host || 'localhost'
  const lower = p.toLowerCase()
  // A named share covering this folder reads better than C$ and works for colleagues without admin rights.
  for (const s of await localShares()) {
    if (s.name.endsWith('$')) continue
    const sp = s.path.replace(/\\+$/, '').toLowerCase()
    if (lower === sp || lower.startsWith(sp + '\\')) return `\\\\${pc}\\${s.name}${p.slice(sp.length)}`
  }
  return `\\\\${pc}\\${letter[0]}$${rest ? `\\${rest}` : ''}`
}

const encodeSegments = (s: string) => s.split('/').map((x) => encodeURIComponent(x).replace(/%3A/gi, ':').replace(/%24/g, '$')).join('/')

function quote(s: string) {
  const q = app.settings?.pathCopy?.quote ?? 'never'
  return q === 'always' || (q === 'spaces' && /\s/.test(s)) ? `"${s}"` : s
}

export async function formatPath(p: string, mode: PathMode): Promise<string> {
  // inside an archive, the path of the archive itself is what can be opened elsewhere
  if (isArchivePath(p)) {
    const { file, inner } = splitArchive(p)
    if (mode === 'name') return inner ? basename(inner) : basename(file)
    p = file
  }
  switch (mode) {
    case 'name':
      return basename(p) || p
    case 'path':
      return p
    case 'parent':
      return dirname(p)
    case 'unc':
      return toUnc(p)
    case 'uncParent':
      return toUnc(dirname(p))
    case 'internet': {
      const unc = await toUnc(p)
      const drive = app.drives.find((d) => d.root.slice(0, 2).toUpperCase() === p.slice(0, 2).toUpperCase())
      // local files that are not on a share keep the file:///C:/ form browsers expect
      if (!p.startsWith('\\\\') && !drive?.remote && /\\[A-Za-z]\$(\\|$)/.test(unc)) return 'file:///' + encodeSegments(p.replace(/\\/g, '/'))
      return 'file://' + encodeSegments(unc.slice(2).replace(/\\/g, '/'))
    }
    case 'samba':
      return 'smb://' + encodeSegments((await toUnc(p)).slice(2).replace(/\\/g, '/'))
  }
}

/** Copy the given paths (or the selection, else the current folder) in a mode. */
export async function copyPaths(mode: PathMode, paths?: string[]) {
  const pane = app.active
  const list = (paths ?? (pane.selected.length ? pane.selected.map((e) => e.path) : pane.focused && pane.selection.size ? [pane.focused.path] : [pane.path])).filter((p) => !isVirtual(p))
  if (!list.length) return app.toast('info', 'Nothing to copy a path for here')
  const out = await Promise.all(list.map((p) => formatPath(p, mode)))
  const text = out.map(quote).join('\r\n')
  await host.clip.writeText(text)
  const label = PATH_MODES.find((m) => m.id === mode)!.label
  app.toast('info', `${label} copied`, text.length > 160 ? `${text.slice(0, 160)}…` : text)
}
