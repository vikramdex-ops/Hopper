// Folder templates: preview and create a template's folder tree under a destination folder.
// Simple templates are a list of paths with {name} {project} {date}; structured templates
// (inputs, conditions, repeats, automatic numbering) are expanded by @shared/template-model.
// Nothing is ever overwritten: folders that already exist are kept and reported.
import { promises as fsp } from 'node:fs'
import { join, resolve } from 'node:path'
import type { FolderTemplate } from '@shared/types'
import { BUILTIN_TEMPLATES, OLD_DEFAULT_PROJECT } from '@shared/project-template'
import { expandTree, isTree, MAX_PATH_WARN, type TemplateWarning, type Values } from '@shared/template-model'
import type { EngineCtx } from '../index'
import { exists, isInside } from '../fsutil'
import { checkSegment, localDate, officeOf } from './util'
import type { TemplatePreview, TemplateResult, TemplateVars } from './types'

/** Built-in templates first (an office template with the same id replaces one), then the office's own. */
export function list(ctx: EngineCtx): FolderTemplate[] {
  const office = (officeOf(ctx).templates ?? []).filter(
    // a saved copy of the old shipped "Project folder" is superseded by the built-in project template
    (t) => !(t.id === 'project' && !isTree(t) && JSON.stringify(t.folders) === JSON.stringify(OLD_DEFAULT_PROJECT))
  )
  const ids = new Set(office.map((t) => t.id))
  return [...BUILTIN_TEMPLATES.filter((t) => !ids.has(t.id)), ...office]
}

/** Simple template folders after substitution, as relative segment lists. Throws on anything unsafe. */
export function expand(t: FolderTemplate, vars: TemplateVars): string[][] {
  const date = vars.date || localDate()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Date "${date}" is not YYYY-MM-DD`)
  const values: Record<string, string | undefined> = { name: vars.name, project: vars.project, date }
  // Values are single folder names: a "/" in a value must not create extra levels.
  for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== '') checkSegment(v, `{${k}}`)

  const out: string[][] = []
  for (const raw of t.folders ?? []) {
    const rel = raw.replace(/\{(\w+)\}/g, (_, k: string) => {
      if (!(k in values)) throw new Error(`Template "${t.name}" uses an unknown token {${k}}`)
      const v = values[k]
      if (!v) throw new Error(`Template "${t.name}" needs a value for {${k}}`)
      return v
    })
    if (/^[\\/]/.test(rel) || /^[a-z]:/i.test(rel)) throw new Error(`Template folder "${raw}" is an absolute path`)
    const segs = rel.split(/[\\/]+/).filter(Boolean)
    if (!segs.length) continue
    for (const s of segs) {
      if (s === '..' || s === '.') throw new Error(`Template folder "${raw}" leaves the destination folder`)
      checkSegment(s, `Folder "${s}"`)
    }
    out.push(segs)
  }
  return out
}

function find(ctx: EngineCtx, template: string | FolderTemplate): FolderTemplate {
  const t = typeof template === 'string' ? list(ctx).find((x) => x.id === template) : template
  if (!t) throw new Error(`No folder template "${template}"`)
  return t
}

const simpleVars = (v: Values): TemplateVars => ({
  name: typeof v.name === 'string' ? v.name.trim() || undefined : undefined,
  project: typeof v.project === 'string' ? v.project.trim() || undefined : undefined,
  date: typeof v.date === 'string' ? v.date.trim() || undefined : undefined
})

/** Every folder the template makes for these values (relative, parents first), without touching disk. */
function plan(t: FolderTemplate, values: Values, destLength: number): { top: string | null; folders: string[][]; warnings: TemplateWarning[]; errors: string[] } {
  if (isTree(t)) return expandTree(t, values, destLength)
  try {
    const raw = expand(t, simpleVars(values))
    // parents first, once each (a simple template lists only the leaves)
    const seen = new Set<string>()
    const folders: string[][] = []
    for (const segs of raw)
      for (let i = 1; i <= segs.length; i++) {
        const key = segs.slice(0, i).join('\\').toLowerCase()
        if (!seen.has(key)) seen.add(key), folders.push(segs.slice(0, i))
      }
    const warnings: TemplateWarning[] = []
    const long = folders.filter((p) => destLength > 0 && destLength + 1 + p.join('\\').length > MAX_PATH_WARN)
    if (long.length) warnings.push({ kind: 'long', message: `${long.length} folder path${long.length === 1 ? '' : 's'} would be longer than ${MAX_PATH_WARN} characters here`, path: long[0].join('\\') })
    return { top: null, folders, warnings, errors: [] }
  } catch (e: any) {
    return { top: null, folders: [], warnings: [], errors: [String(e?.message ?? e)] }
  }
}

/** Which of these relative folders exist under root. Only descends into folders that exist. */
async function existing(root: string, folders: string[][]): Promise<Set<string>> {
  const found = new Set<string>()
  const byDepth = new Map<number, string[][]>()
  for (const f of folders) byDepth.set(f.length, [...(byDepth.get(f.length) ?? []), f])
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    const todo = byDepth.get(depth)!.filter((f) => depth === 1 || found.has(f.slice(0, -1).join('\\').toLowerCase()))
    for (let i = 0; i < todo.length; i += 16) {
      const batch = todo.slice(i, i + 16)
      const hits = await Promise.all(batch.map((f) => exists(join(root, ...f))))
      batch.forEach((f, k) => hits[k] && found.add(f.join('\\').toLowerCase()))
    }
  }
  return found
}

/** The resolved tree for these inputs, with warnings, without writing anything. */
export async function preview(ctx: EngineCtx, template: string | FolderTemplate, destDir: string, inputs: Values = {}): Promise<TemplatePreview> {
  const t = find(ctx, template)
  const dest = destDir ? resolve(destDir) : ''
  const destOk = dest ? !!(await fsp.stat(dest).catch(() => null))?.isDirectory() : false
  const p = plan(t, inputs ?? {}, dest.length)
  const errors = [...p.errors]
  if (destDir && !destOk) errors.unshift(`"${destDir}" is not a folder`)
  const there = destOk && !errors.length ? await existing(dest, p.folders) : new Set<string>()
  const paths = p.folders.map((f) => f.join('\\'))
  const exist = paths.filter((x) => there.has(x.toLowerCase()))
  const warnings = [...p.warnings]
  if (exist.length) {
    warnings.push({
      kind: 'exists',
      message: exist.length === paths.length ? 'Every folder already exists here; nothing would be created' : `${exist.length} of ${paths.length} folders already exist here and are kept as they are`,
      path: exist[0]
    })
  }
  const depth = p.folders.reduce((m, f) => Math.max(m, f.length), 0)
  const longest = p.folders.reduce((m, f) => Math.max(m, (dest ? dest.length + 1 : 0) + f.join('\\').length), 0)
  return { dest, top: p.top, paths, existing: exist, warnings, errors, count: paths.length - exist.length, depth, longest }
}

export async function create(ctx: EngineCtx, template: string | FolderTemplate, destDir: string, vars: TemplateVars | Values = {}): Promise<TemplateResult> {
  const t = find(ctx, template)
  const st = await fsp.stat(destDir).catch(() => null)
  if (!st?.isDirectory()) throw new Error(`"${destDir}" is not a folder`)

  const root = resolve(destDir)
  const p = plan(t, (vars ?? {}) as Values, root.length)
  if (p.errors.length) throw new Error(p.errors[0])
  const created: string[] = []
  const existing: string[] = []
  /** created folders whose parent was not created by us: removing these undoes everything */
  const tops: string[] = []
  try {
    for (const segs of p.folders) {
      let cur = root
      for (const s of segs) {
        checkSegment(s, `Folder "${s}"`)
        cur = join(cur, s)
        if (!isInside(cur, root)) throw new Error(`"${cur}" is outside "${root}"`)
        if (created.includes(cur) || existing.includes(cur)) continue
        if (await exists(cur)) {
          existing.push(cur)
          continue
        }
        await fsp.mkdir(cur)
        created.push(cur)
        if (!tops.some((x) => isInside(cur, x))) tops.push(cur)
      }
    }
  } finally {
    if (tops.length) ctx.undo.record({ kind: 'new', label: `New from template ${t.name}`, pairs: tops.map((x) => ['', x] as [string, string]) })
  }
  const first = p.top ?? p.folders[0]?.[0]
  return { created, existing, top: first ? join(root, first) : null }
}
