// Who may configure the office (Settings → Office, Dexterity Share setup, office key, invites).
// One rule, used by main, the engine and the LAN process alike:
//   - until the office is set up (office.json has no `setup`), everyone may configure it, so any
//     PC can become the always-on share server;
//   - once a PC has set it up, only that PC and the standing admins below may change it;
//   - a revoke clears `setup`, and the office is open to everyone again until the next setup;
//   - a PC that cannot read office.json cannot tell whether it is set up, so only the standing
//     admins configure from it (everyone else gets the Join page to point at the right file).
// The rule guards against accidents, not attackers: anyone who can write the office folder can
// edit office.json by hand.
import type { OfficeConfig, OfficeSetup } from './types'

/** Windows accounts (lower-case) that may always configure the office, set up or not. */
export const STANDING_ADMINS = ['asha', 'admin2', 'admin3'] as const

export const normUser = (u: unknown) =>
  String(u ?? '')
    .replace(/^.*\\/, '')
    .trim()
    .toLowerCase()

export const normPc = (pc: unknown) => String(pc ?? '').trim().toLowerCase()

/** The office's setup record, or null when the office is not set up (or the record is unreadable). */
export function officeSetup(office: Partial<OfficeConfig> | null | undefined): OfficeSetup | null {
  const s = office?.setup
  return s && typeof s === 'object' && normPc(s.pc) ? s : null
}

export const isStandingAdmin = (user: string) => (STANDING_ADMINS as readonly string[]).includes(normUser(user))

/** True when this PC is the one that set the office up. */
export function isSetupPc(office: Partial<OfficeConfig> | null | undefined, pc: string) {
  const s = officeSetup(office)
  return !!s && !!normPc(pc) && normPc(s.pc) === normPc(pc)
}

export function canConfigureOffice(office: Partial<OfficeConfig> | null | undefined, user: string, pc: string) {
  if (!normUser(user)) return false
  if (isStandingAdmin(user)) return true
  if (office?.unreadable) return false
  if (!officeSetup(office)) return true
  return isSetupPc(office, pc)
}
