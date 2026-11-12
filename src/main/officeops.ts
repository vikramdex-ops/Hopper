// Office admin rules for main: who may write the shared office config (shared/office-access.ts:
// everyone until a PC sets the office up, then that PC and the standing admins), setting up and
// revoking, the key this PC really uses (shared config first, else the key it joined with), and
// moving the config elsewhere. The check is a guard against accidents, not a security boundary:
// anyone who can write the office folder can edit office.json by hand.
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, promises as fsp } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import type { OfficeConfig, OfficeMeta } from '@shared/types'
import { canConfigureOffice, isSetupPc, isStandingAdmin, officeSetup } from '@shared/office-access'
import { ctx } from './ctx'
import { OfficeStore } from './store'

/** This PC's computer name, as the LAN and share processes see it. */
export const thisPc = () => hostname()

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
  const o = readable()
  const own = ctx.settings.data.officeKeyOverride
  return validKey(o.officeKey) || !validKey(own) ? o : { ...o, officeKey: own.trim() }
}

/** The loaded config, marked when this PC could not read office.json (so it cannot tell whether it is set up). */
function readable(): OfficeConfig {
  return ctx.office.error ? { ...ctx.office.data, unreadable: true } : ctx.office.data
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
  return canConfigureOffice(readable(), user, thisPc())
}

export function officeMeta(user: string): OfficeMeta {
  const shared = ctx.office.data.officeKey
  const own = ctx.settings.data.officeKeyOverride ?? ''
  const keySource = validKey(shared) ? 'config' : validKey(own) ? 'override' : 'none'
  return {
    user,
    pc: thisPc(),
    admin: isAdmin(user),
    setup: officeSetup(ctx.office.data),
    setupPc: isSetupPc(ctx.office.data, thisPc()),
    standing: isStandingAdmin(user),
    keySource,
    fingerprint: fingerprint(keySource === 'config' ? shared : keySource === 'override' ? own : '')
  }
}

/**
 * Re-read office.json before a write, so a PC that has not polled yet cannot undo a setup or a
 * revoke made elsewhere a moment ago. A file that does not exist yet is fine (first save creates it).
 */
async function fresh() {
  const path = ctx.settings.data.officeConfigPath || ctx.office.loadedFrom
  if (!path || !existsSync(path)) return
  const s = new OfficeStore()
  await s.load(path)
  // a read that fails must not leave defaults behind: they have no setup, so anyone could save over it
  if (s.error) throw new Error(`Can't read the office config right now (${s.error}). Try again in a moment.`)
  Object.assign(ctx.office, { data: s.data, loadedFrom: s.loadedFrom, error: '' })
}

/** Mark the office as set up by this PC: from now on only this PC and the standing admins configure it. */
export async function lockOffice(user: string) {
  await fresh()
  if (!isAdmin(user)) throw new Error(`The office is already set up on ${officeSetup(ctx.office.data)?.pc || 'another PC'}. Ask for the setup to be revoked first.`)
  const path = ctx.office.loadedFrom || ctx.settings.data.officeConfigPath
  if (!path) throw new Error('Choose where the office config lives first')
  await ctx.office.save(path, { ...ctx.office.data, setup: { user, pc: thisPc(), at: Date.now() } })
  return officeSetup(ctx.office.data)
}

/**
 * Undo the setup so any PC can configure the office again (to move the always-on server). The
 * share-server claim goes too, so the next PC can take it; the old server keeps serving until then.
 */
export async function revokeOffice(user: string) {
  await fresh()
  if (!isAdmin(user)) throw new Error('Only the PC that set the office up, or Asha, Admin2 or Admin3, can revoke the setup')
  const path = ctx.office.loadedFrom || ctx.settings.data.officeConfigPath
  if (!path) throw new Error('No office config is loaded')
  const next: OfficeConfig = { ...ctx.office.data }
  delete next.setup
  if (next.publicShare) next.publicShare = { ...next.publicShare, host: undefined }
  await ctx.office.save(path, next)
}

/**
 * Save the shared config (admins only). With moveTo, write it into that folder instead, take the
 * announcements along, leave a pointer in the old file so other PCs follow, and use the new path.
 */
export async function saveOffice(user: string, cfg: OfficeConfig, opts?: { moveTo?: string }) {
  await fresh()
  if (!isAdmin(user)) throw new Error(`The office is set up on ${officeSetup(ctx.office.data)?.pc || 'another PC'}; only that PC, or Asha, Admin2 or Admin3, can change it`)
  if (!cfg || typeof cfg !== 'object') throw new Error('bad office config')
  const next: OfficeConfig = { ...cfg, admins: names(cfg.admins), announcers: names(cfg.announcers) }
  delete next.movedTo
  delete next.unreadable
  // setup and revoke have their own calls: a save keeps whatever the file says now
  const setup = officeSetup(ctx.office.data)
  if (setup) next.setup = setup
  else delete next.setup
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

/**
 * Keep every PC in step with office.json: a setup, a revoke or any admin change shows up on the
 * other PCs within one poll. Only a clean read replaces what this PC has (an unreachable server
 * keeps the last good config). onChange runs after each change is taken in.
 */
export function startOfficeSync(onChange: () => void, everyMs = 20_000) {
  let last = ''
  const tick = async () => {
    const path = ctx.office.loadedFrom || ctx.settings.data.officeConfigPath
    if (!path) return
    const st = await fsp.stat(path).catch(() => null)
    const stamp = st ? `${path}|${st.mtimeMs}|${st.size}` : ''
    if (!st || stamp === last) return
    const first = !last
    last = stamp
    if (first) return
    const s = new OfficeStore()
    await s.load(ctx.settings.data.officeConfigPath || path)
    if (s.error) return
    if (JSON.stringify(s.data) === JSON.stringify(ctx.office.data) && s.loadedFrom === ctx.office.loadedFrom) return
    Object.assign(ctx.office, { data: s.data, loadedFrom: s.loadedFrom, error: '' })
    onChange()
  }
  void tick()
  const t = setInterval(() => void tick().catch(() => {}), everyMs)
  t.unref()
  return () => clearInterval(t)
}
