// Small helpers shared by the office tools.
import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { defaultOffice } from '@shared/defaults'
import type { OfficeConfig } from '@shared/types'
import type { EngineCtx } from '../index'

/** The office config, or the shipped defaults until the shared one has loaded. */
export function officeOf(ctx: EngineCtx): OfficeConfig {
  return ctx.office ?? defaultOffice()
}

/** Write to a temp file beside `out`, then rename over it, so a half-written file never appears. */
export async function writeAtomic(out: string, data: Uint8Array) {
  const tmp = join(dirname(out), `.${basename(out)}.${process.pid}.hopper-tmp`)
  try {
    await fsp.writeFile(tmp, data)
    await fsp.rename(tmp, out)
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

const BAD = /[<>:"/\\|?*\u0000-\u001f]/

/** A single path segment that Windows accepts as-is (no separators, no trailing dot/space). */
export function checkSegment(s: string, what: string) {
  if (!s || !s.trim()) throw new Error(`${what} is empty`)
  if (s === '.' || s === '..') throw new Error(`${what} "${s}" is not allowed`)
  if (BAD.test(s)) throw new Error(`${what} "${s}" contains a character Windows does not allow in names`)
  if (/[. ]$/.test(s)) throw new Error(`${what} "${s}" ends with a dot or space`)
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(s)) throw new Error(`${what} "${s}" is a reserved Windows name`)
  return s
}

/** Replace characters Windows forbids in file names (for names built from user text). */
export const safeFilePart = (s: string) => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '').trim()

export function localDate(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function localDateTime(ms: number) {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${localDate(ms)} ${p(d.getHours())}:${p(d.getMinutes())}`
}
