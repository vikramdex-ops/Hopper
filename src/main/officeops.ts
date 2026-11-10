// Office admin rules for main: who may write the shared office config, the key this PC really
// uses (shared config first, else the key it joined with), and moving the config elsewhere.
// The admin check is a guard against accidents, not a security boundary: anyone who can write
// the office folder can edit office.json by hand, so keep that folder's permissions tight.
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import type { OfficeConfig, OfficeMeta } from '@shared/types'
import { ctx } from './ctx'

const DEFAULT_ADMINS = ['asha']

/** Hex, at least 16 bytes: the same rule as the LAN process. */
export function validKey(k: unknown): k is string {
  const hex = typeof k === 'string' ? k.trim() : ''
  return hex.length >= 32 && hex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(hex)
}

export function fingerprint(k: string) {
  return validKey(k) ? createHash('sha256').update(Buffer.from(k.trim(), 'hex')).digest('hex').slice(0, 8) : ''
}

/** The office config as the utilities should see it: with the joined key when the shared one is missing. */
export function effectiveOffice(): OfficeConfig {
  const o = ctx.office.data
  const own = ctx.settings.data.officeKeyOverride
  return validKey(o.officeKey) || !validKey(own) ? o : { ...o, officeKey: own.trim() }
}

/**
 * The Windows account that office rules apply to, lower-case, without a domain prefix.
 * HOPPER_LAN_USER overrides it in unpackaged (dev/test) runs only, to match the LAN process.
 */
export function officeUser(identity: { user?: string } | undefined) {
  const test = !app.isPackaged ? process.env.HOPPER_LAN_USER : ''
  return String(test || identity?.user || '')
    .replace(/^.*\\/, '')
    .trim()
    .toLowerCase()
}

const names = (list: unknown) => [...new Set((Array.isArray(list) ? list : []).map((u) => String(u).trim().toLowerCase()).filter(Boolean))]

export function isAdmin(user: string) {
  const admins = names(ctx.office.data.admins)
  return !!user && (admins.length ? admins : DEFAULT_ADMINS).includes(user)
}

export function officeMeta(user: string): OfficeMeta {
  const shared = ctx.office.data.officeKey
  const own = ctx.settings.data.officeKeyOverride ?? ''
  const keySource = validKey(shared) ? 'config' : validKey(own) ? 'override' : 'none'
  return { user, admin: isAdmin(user), keySource, fingerprint: fingerprint(keySource === 'config' ? shared : keySource === 'override' ? own : '') }
}

/**
 * Save the shared config (admins only). With moveTo, write it into that folder instead, take the
 * announcements along, leave a pointer in the old file so other PCs follow, and use the new path.
 */
export async function saveOffice(user: string, cfg: OfficeConfig, opts?: { moveTo?: string }) {
  if (!isAdmin(user)) throw new Error('Only an office admin can change the office config')
  if (!cfg || typeof cfg !== 'object') throw new Error('bad office config')
  const admins = names(cfg.admins)
  const next: OfficeConfig = { ...cfg, admins: admins.length ? admins : [user], announcers: names(cfg.announcers) }
  delete next.movedTo
  if (next.officeKey && !validKey(next.officeKey)) throw new Error('The office key must be hex, at least 32 characters')
  const oldPath = ctx.office.loadedFrom || ctx.settings.data.officeConfigPath
  const moveTo = opts?.moveTo?.trim()
  if (!moveTo) {
    await ctx.office.save(oldPath, next)
    return { path: oldPath }
  }
  const newPath = join(moveTo, 'office.json')
  if (newPath.toLowerCase() === oldPath.toLowerCase()) throw new Error('The office config is already in that folder')
  if (existsSync(newPath)) throw new Error('That folder already has an office.json. Load it under "Office config file", or pick another folder.')
  await ctx.office.save(newPath, next)
  ctx.settings.set({ officeConfigPath: newPath })
  // best effort from here on: the new config is already in place
  const oldDir = dirname(oldPath)
  await fsp.copyFile(join(oldDir, 'announcements.json'), join(moveTo, 'announcements.json')).catch(() => {})
  await fsp.cp(join(oldDir, 'announcement-acks'), join(moveTo, 'announcement-acks'), { recursive: true }).catch(() => {})
  let pointer = false
  if (existsSync(oldPath)) {
    pointer = await fsp
      .writeFile(oldPath, JSON.stringify({ ...next, movedTo: newPath }, null, 1), 'utf8')
      .then(() => true)
      .catch(() => false)
  }
  return { path: newPath, pointer }
}
