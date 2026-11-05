// Low-level helpers shared by engine modules.
import { constants, promises as fsp } from 'node:fs'
import { basename, dirname, extname, join, parse } from 'node:path'

export const sameVolume = (a: string, b: string) => volumeOf(a) === volumeOf(b)

export function volumeOf(p: string) {
  const unc = /^\\\\([^\\]+)\\([^\\]+)/.exec(p)
  if (unc) return `\\\\${unc[1]}\\${unc[2]}`.toLowerCase()
  return p.slice(0, 2).toLowerCase()
}

export async function exists(p: string) {
  try {
    await fsp.lstat(p)
    return true
  } catch {
    return false
  }
}

/** "name.ext" -> "name (2).ext", the first free one. */
export async function freeName(p: string) {
  if (!(await exists(p))) return p
  const { dir, name, ext } = parse(p)
  const m = /^(.*) \((\d+)\)$/.exec(name)
  const stem = m ? m[1] : name
  for (let i = m ? Number(m[2]) + 1 : 2; i < 10000; i++) {
    const c = join(dir, `${stem} (${i})${ext}`)
    if (!(await exists(c))) return c
  }
  throw new Error('no free name')
}

/** Rename, falling back to copy+delete across volumes. */
export async function moveOne(from: string, to: string) {
  try {
    await fsp.rename(from, to)
  } catch (e: any) {
    if (e.code !== 'EXDEV') throw e
    await fsp.cp(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false })
    await fsp.rm(from, { recursive: true, force: true })
  }
}

export async function removeTree(p: string) {
  await fsp.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

/** Is `child` inside (or equal to) `parent`? Case-insensitive, Windows paths. */
export function isInside(child: string, parent: string) {
  const c = child.toLowerCase().replace(/[\\/]+$/, '')
  const p = parent.toLowerCase().replace(/[\\/]+$/, '')
  return c === p || c.startsWith(p + '\\')
}

/** Wildcard list "*.pdf;*.dwg" -> predicate on a file name. Empty = everything. */
export function wildcard(filter?: string) {
  const parts = (filter ?? '').split(/[;,]/).map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return () => true
  const res = parts.map((g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'))
  return (name: string) => res.some((r) => r.test(name))
}

export const extOf = (name: string) => extname(name).slice(1).toLowerCase()
export { basename, dirname, join, constants }
