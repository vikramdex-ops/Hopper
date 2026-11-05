// Folder templates: create a template's folder tree under a destination folder.
// Tokens {name} {project} {date} are substituted; every resulting path must stay inside destDir.
import { promises as fsp } from 'node:fs'
import { join, resolve } from 'node:path'
import type { FolderTemplate } from '@shared/types'
import type { EngineCtx } from '../index'
import { exists, isInside } from '../fsutil'
import { checkSegment, localDate, officeOf } from './util'
import type { TemplateResult, TemplateVars } from './types'

export function list(ctx: EngineCtx): FolderTemplate[] {
  return officeOf(ctx).templates ?? []
}

/** Template folders after substitution, as relative segment lists. Throws on anything unsafe. */
export function expand(t: FolderTemplate, vars: TemplateVars): string[][] {
  const date = vars.date ?? localDate()
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

export async function create(ctx: EngineCtx, template: string | FolderTemplate, destDir: string, vars: TemplateVars = {}): Promise<TemplateResult> {
  const t = typeof template === 'string' ? list(ctx).find((x) => x.id === template) : template
  if (!t) throw new Error(`No folder template "${template}"`)
  const st = await fsp.stat(destDir).catch(() => null)
  if (!st?.isDirectory()) throw new Error(`"${destDir}" is not a folder`)

  const root = resolve(destDir)
  const plan = expand(t, vars)
  const created: string[] = []
  const existing: string[] = []
  /** created folders whose parent was not created by us: removing these undoes everything */
  const tops: string[] = []
  try {
    for (const segs of plan) {
      let cur = root
      for (const s of segs) {
        cur = join(cur, s)
        if (!isInside(cur, root)) throw new Error(`"${cur}" is outside "${root}"`)
        if (created.includes(cur)) continue
        if (await exists(cur)) {
          if (!existing.includes(cur)) existing.push(cur)
          continue
        }
        await fsp.mkdir(cur)
        created.push(cur)
        if (!tops.some((p) => isInside(cur, p))) tops.push(cur)
      }
    }
  } finally {
    if (tops.length) ctx.undo.record({ kind: 'new', label: `New from template ${t.name}`, pairs: tops.map((p) => ['', p] as [string, string]) })
  }
  return { created, existing }
}
