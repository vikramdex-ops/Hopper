// "Who has it open" and Unlock across the office (see docs/UNLOCK.md and shared/unlock.ts).
// Every Hopper answers 'holders' questions with what its own PC knows: programs holding the files
// (Restart Manager), File Explorer windows showing the folder, Hopper's own handles (released at
// once), and whether its user opened the file through Hopper recently. The Hopper that runs ON the
// file server also answers with the server's own list of open files (the "server agent"), which
// covers PCs without Hopper and handles left behind by a crashed or sleeping PC.
// Nothing is ever closed without a person deciding: a close request becomes a prompt on the
// holder's PC, and only that PC's user can click [Close it]; a force close happens on the server,
// only for office admins proven by the server's own SMB session list, and is logged on the server.
// Other PCs may only ask about UNC paths on known hosts (see acceptRemotePath).
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { HopperShell } from '@shared/hshell'
import { folderKey } from '@shared/listing'
import { isStandingAdmin, normUser, officeSetup } from '@shared/office-access'
import {
  acceptRemotePath, bareUser, cleanClose, cleanForce, cleanNotify, cleanPaths, cleanQuery, cleanReply, cleanStatus, ID_RE, normIp, promptAllowed,
  serverLocalPath, serverUncPath, sessionAdmin, uncHost, within, type Holder, type HoldersReply, type HolderStatus
} from '@shared/unlock'
import type { Peer } from '@shared/types'
import { connectEnabled, postConnect } from './connect'
import type { Discovery } from './discovery'
import { sendAsk, sendSmall } from './transfer-client'
import type { LanCtx } from './types'

// SHA-256 of the helper this build ships (tools/build-native.mjs -> electron.vite.config.ts)
declare const __HOPPER_HELPER_SHA256__: string | undefined
export const HELPER_SHA256 = typeof __HOPPER_HELPER_SHA256__ !== 'undefined' ? __HOPPER_HELPER_SHA256__ : ''

export const AGENT_TASK = 'Hopper file unlock'
/** Where the elevated task's copy of the helper lives (Program Files: only administrators can change it). */
export const agentExe = () => join(process.env.ProgramFiles || 'C:\\Program Files', 'Hopper', 'Agent', 'HopperShell.exe')
const FOLDER_FILES_MAX = 2000
const WALK_MS = 15_000
const ASK_MS = 45_000

interface Prompt {
  promptId: string
  /** requester's Windows account and PC */
  from: string
  fromName: string
  replyPeer: string
  requestId: string
  holderId: string
  path: string
  kind: 'app' | 'explorer' | 'notice'
  pid: number
  start: string
  app: string
  at: number
}

/** Who is asking: this PC's own user (local) or another PC (its address, from the connection). */
export interface Asker {
  local?: boolean
  address?: string
}

type RmRow = { path: string; pid: number; start: string; app: string; exe?: string; user?: string; type: string; session: number }

const isUnc = (p: string) => p.startsWith('\\\\')

export class Unlock {
  private prompts = new Map<string, Prompt>()
  private drives: { root: string; remote?: string }[] = []
  private drivesAt = 0
  private shares: { name: string; path: string }[] | null = null
  private sharesAt = 0
  /** close requests sent from here: "<lookup>|<holder>" -> the account that was asked */
  private asked = new Map<string, { user: string; at: number }>()
  /** when each person last made this PC show a prompt */
  private promptTimes = new Map<string, number[]>()

  private ctx: LanCtx
  private discovery: Discovery
  private shell: HopperShell

  constructor(ctx: LanCtx, discovery: Discovery, shell: HopperShell) {
    this.ctx = ctx
    this.discovery = discovery
    this.shell = shell
  }

  // -------------------------------------------------------------------------
  // helpers

  private async refreshDrives() {
    if (Date.now() - this.drivesAt < 60_000) return
    this.drivesAt = Date.now()
    try {
      this.drives = await this.shell.call('drives', {}, 15_000)
    } catch {
      /* keep */
    }
  }

  /** The same place as this PC spells it: the UNC path and any mapped-drive spelling of it. */
  private spellings(p: string): string[] {
    const out = [p]
    if (isUnc(p)) {
      for (const d of this.drives) {
        const r = d.remote?.replace(/\\+$/, '')
        if (r && within(p, r)) out.push(d.root.replace(/\\+$/, '') + p.slice(r.length))
      }
    } else {
      const d = this.drives.find((x) => x.remote && x.root.charAt(0).toLowerCase() === p.charAt(0).toLowerCase())
      if (d?.remote) out.push(d.remote.replace(/\\+$/, '') + p.slice(2))
    }
    return [...new Set(out.map((x) => x.replace(/\\+$/, '') || x))]
  }

  private async myShares() {
    if (this.shares && Date.now() - this.sharesAt < 5 * 60_000) return this.shares
    try {
      const list = await this.shell.call<{ name: string; path: string }[]>('shares', {}, 15_000)
      this.shares = (Array.isArray(list) ? list : []).filter((s) => s && typeof s.name === 'string' && typeof s.path === 'string')
    } catch {
      this.shares = []
    }
    this.sharesAt = Date.now()
    return this.shares
  }

  /** Hosts another PC may ask about: this PC's own names and addresses, the servers behind its mapped drives, the office's servers. */
  allowedHosts(): string[] {
    const hosts = new Set(this.hostNames())
    for (const d of this.drives) {
      const h = uncHost(`${d.remote ?? ''}\\`)
      if (h) hosts.add(h)
    }
    for (const p of [this.ctx.officePath, this.ctx.office?.serverInbox, this.ctx.office?.publicShare?.store]) {
      const h = uncHost(String(p ?? ''))
      if (h) hosts.add(h)
    }
    return [...hosts]
  }

  private hostNames() {
    const names = new Set<string>([this.ctx.me.host, hostname(), 'localhost', '127.0.0.1'].map((n) => n.toLowerCase()))
    for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4') names.add(a.address)
    return [...names]
  }

  private me() {
    return { peer: this.discovery.id, person: this.ctx.me.displayName || this.ctx.me.user, pc: this.ctx.me.host, user: this.ctx.me.user }
  }

  /** Files under a folder, bounded in number and time (holders are per file; Restart Manager ignores folders). */
  private async filesUnder(dir: string, out: string[], deadline: number) {
    const queue = [dir]
    while (queue.length && out.length < FOLDER_FILES_MAX && Date.now() < deadline) {
      const d = queue.shift()!
      let list
      try {
        list = await fsp.readdir(d, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of list) {
        const p = join(d, e.name)
        if (e.isDirectory()) queue.push(p)
        else if (out.length < FOLDER_FILES_MAX) out.push(p)
      }
    }
    return queue.length > 0 || out.length >= FOLDER_FILES_MAX
  }

  // -------------------------------------------------------------------------
  // answering: what this PC knows

  async localHolders(paths: string[], who: Asker = { local: true }): Promise<HoldersReply & { partial?: boolean }> {
    await this.refreshDrives()
    const me = this.me()
    const holders: Holder[] = []
    let n = 0
    const id = (k: string) => `${me.peer}:${k}:${++n}`
    const files: string[] = []
    const dirs: string[] = []
    let partial = false
    const deadline = Date.now() + WALK_MS
    for (const p of paths) {
      const st = await fsp.stat(p).catch(() => null)
      if (st?.isDirectory()) {
        dirs.push(p)
        if (await this.filesUnder(p, files, deadline)) partial = true
      } else if (st) files.push(p)
    }
    // programs on this PC
    if (files.length) {
      try {
        const rows = await this.shell.call<RmRow[]>('rmHolders', { paths: files }, 120_000)
        const self = process.execPath.toLowerCase()
        for (const r of rows) {
          const exe = (r.exe ?? '').toLowerCase()
          const hopper = exe === self || basename(exe) === 'hoppershell.exe'
          const user = bareUser(r.user) || me.user
          const path = r.path || paths[0]
          holders.push({
            id: id(hopper ? 'hopper' : 'app'),
            kind: hopper ? 'hopper' : 'app',
            path,
            user,
            person: user === me.user ? me.person : user,
            pc: me.pc,
            peer: me.peer,
            app: r.app || basename(r.exe ?? '') || 'A program',
            pid: r.pid,
            start: r.start,
            status: hopper ? 'released' : 'open'
          })
        }
      } catch (e: any) {
        this.ctx.log('unlock', 'rmHolders', e?.message ?? e)
      }
    }
    // File Explorer windows showing the folder (or a folder inside it)
    if (dirs.length) {
      try {
        const wins = await this.shell.call<{ path: string }[]>('explorerWindows', { paths: dirs.flatMap((d) => this.spellings(d)).slice(0, 200) }, 15_000)
        for (const w of wins) {
          const target = dirs.find((d) => this.spellings(d).some((s) => within(w.path, s))) ?? dirs[0]
          holders.push({ id: id('explorer'), kind: 'explorer', path: target, user: me.user, person: me.person, pc: me.pc, peer: me.peer, app: `File Explorer (${basename(w.path) || w.path})`, status: 'open' })
        }
      } catch (e: any) {
        this.ctx.log('unlock', 'explorerWindows', e?.message ?? e)
      }
    }
    // Hopper's own handles: let them go now, nobody needs to be asked
    if (holders.some((h) => h.kind === 'hopper') || dirs.length) this.ctx.emit('unlock-release', { paths: paths.flatMap((p) => this.spellings(p)) })
    // opened recently through Hopper on this PC
    const want = new Set(paths.map((p) => folderKey(p, this.drives)).filter(Boolean))
    const recent = (this.ctx.settings?.recentFiles ?? []).filter((r) => want.has(folderKey(r, this.drives)))
    const reply: HoldersReply & { partial?: boolean } = { holders, recent: recent.length ? paths.filter((p) => recent.some((r) => folderKey(r, this.drives) === folderKey(p, this.drives))) : [] }
    if (partial) reply.partial = true
    // the server agent: this PC is the file server for these paths
    const server = await this.serverView(paths, id, who)
    if (server) {
      reply.server = server.status
      reply.holders.push(...server.holders)
    }
    return reply
  }

  private async serverView(paths: string[], id: (k: string) => string, who: Asker): Promise<{ status: { agent: true; ok: boolean; error?: string }; holders: Holder[] } | null> {
    const unc = paths.filter(isUnc)
    if (!unc.length) return null
    const shares = await this.myShares()
    const names = this.hostNames()
    const mine = unc.map((p) => ({ p, local: serverLocalPath(p, names, shares) })).filter((x): x is { p: string; local: string } => !!x.local)
    if (!mine.length) return null
    const holders: Holder[] = []
    let admin: boolean | null = null
    for (const { p, local } of mine) {
      const r = await this.smb('smbOpenFiles', { path: local })
      if (!r?.ok) return { status: { agent: true, ok: false, error: r?.error === 'needs-admin' ? 'needs-admin' : String(r?.error ?? 'failed') }, holders }
      const host = /^\\\\([^\\]+)/.exec(p)![1]
      // NetFileEnum matches by prefix ("Job 1" also finds "Job 10"): keep what is really inside
      const files = (r.files ?? []).filter((f: any) => within(String(f.path ?? ''), local))
      // open-file ids (what a force close needs) only for an office admin the server itself recognises
      if (files.length && admin === null) admin = 'user' in (await this.verifiedAdmin(who))
      for (const f of files) {
        const path = serverUncPath(String(f.path ?? ''), host, shares) ?? p
        const user = bareUser(f.user)
        const peer = user ? this.discovery.find(user) : undefined
        holders.push({ id: id('smb'), kind: 'smb', path, user: user || undefined, person: peer?.displayName ?? (user ? this.discovery.nameFor(user) : undefined), peer: this.discovery.id, ...(admin ? { fileId: Number(f.id) } : {}), locks: Number(f.locks) || 0, status: 'open' })
      }
    }
    return { status: { agent: true, ok: true }, holders }
  }

  /**
   * The office admin asking, as the server proves it: this PC's own user (local), or the account of an
   * SMB session the server has with the asking PC's address. Never the name a Hopper claims.
   */
  async verifiedAdmin(who: Asker): Promise<{ user: string } | { error: string }> {
    if (who.local) {
      const u = bareUser(process.env.USERNAME)
      return this.isAdmin(u) ? { user: u } : { error: 'not-admin' }
    }
    const s = await this.smb('smbSessions', {})
    if (!s?.ok) return { error: s?.error === 'needs-admin' ? 'needs-admin' : 'sessions-unavailable' }
    return sessionAdmin(Array.isArray(s.sessions) ? s.sessions : [], who.address ?? '', (u) => this.isAdmin(u))
  }

  /** Server-side calls that need admin rights: this Hopper's helper when it has them, else the elevated agent. */
  private async smb(cmd: 'smbOpenFiles' | 'smbCloseFile' | 'smbSessions' | 'auditLog', args: Record<string, unknown>): Promise<any> {
    let r: any
    try {
      r = await this.shell.call(cmd, args, 30_000)
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
    if (r?.ok === false && r.error === 'needs-admin') {
      const a = await this.agentCall(cmd, args).catch(() => null)
      if (a) return a
    }
    return r
  }

  /**
   * Through the helper, which checks that the pipe is served by the agent exe in Program Files
   * (elevated) before sending anything; starts the scheduled task when the agent is not running.
   */
  private async agentCall(cmd: string, args: Record<string, unknown>) {
    const once = () => this.shell.call<any>('agentCall', { cmd, args }, 30_000)
    try {
      return await once()
    } catch (e: any) {
      if (!/agent-not-running/.test(String(e?.message))) {
        this.ctx.log('unlock', 'agent', e?.message ?? e)
        return null
      }
    }
    const started = await run('schtasks.exe', ['/run', '/tn', AGENT_TASK])
    if (!started.ok) return null
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 500))
      try {
        return await once()
      } catch (e: any) {
        if (!/agent-not-running/.test(String(e?.message))) return null
      }
    }
    return null
  }

  // -------------------------------------------------------------------------
  // incoming questions

  async onAsk(identity: string, frame: any, from: { fromName: string; host: string; address?: string }): Promise<unknown> {
    await this.refreshDrives()
    const allowed = this.allowedHosts()
    const name = this.discovery.find(identity)?.displayName || identity
    switch (frame?.t) {
      case 'holders': {
        const q = cleanQuery(frame)
        if (!q) return { t: 'err', code: 'bad-request' }
        // never look at (or connect to) a path on a host this PC does not know
        const paths = q.paths.map((p) => acceptRemotePath(p, allowed)).filter((p): p is string => !!p)
        if (!paths.length) return { t: 'holders', holders: [], recent: [] }
        return { t: 'holders', ...(await this.localHolders(paths, { address: from.address })) }
      }
      case 'close': {
        const c = cleanClose(frame)
        if (!c) return { t: 'err', code: 'bad-request' }
        if (!acceptRemotePath(c.path, allowed)) return { t: 'err', code: 'path-not-allowed' }
        // what the prompt shows comes from this PC, not from the request
        const app = await this.stillHolding(c.kind, c.path, c.pid, c.start)
        if (!app) return { t: 'err', code: 'not-open' }
        const holderId = String(frame.holder ?? '').slice(0, 80)
        const replyPeer = typeof frame.reply === 'string' ? frame.reply.slice(0, 64) : ''
        if (!this.prompt({ from: identity, fromName: name, replyPeer, requestId: c.id, holderId, path: c.path, kind: c.kind, pid: c.pid, start: c.start, app })) return { t: 'err', code: 'too-many' }
        return { t: 'ok' }
      }
      case 'notify': {
        const n = cleanNotify(frame)
        if (!n) return { t: 'err', code: 'bad-request' }
        if (!acceptRemotePath(n.path, allowed)) return { t: 'err', code: 'path-not-allowed' }
        // "closed on the file server" only from the file server for that path
        if (n.reason === 'forced' && !this.isServerFor(n.path, from.address ?? '')) return { t: 'err', code: 'not-server' }
        if (!this.prompt({ from: identity, fromName: name, replyPeer: '', requestId: n.id, holderId: '', path: n.path, kind: 'notice', pid: 0, start: '', app: n.reason })) return { t: 'err', code: 'too-many' }
        return { t: 'ok' }
      }
      case 'force':
        return this.forceHere(identity, frame, { fromName: name, host: from.host, address: from.address })
      default:
        return { t: 'err', code: 'unknown-request' }
    }
  }

  /** The program (or Explorer window) still holds the path on this PC: its real name; else ''. */
  private async stillHolding(kind: 'app' | 'explorer', path: string, pid: number, start: string): Promise<string> {
    try {
      if (kind === 'explorer') {
        const wins = await this.shell.call<{ path: string }[]>('explorerWindows', { paths: this.spellings(path) }, 15_000)
        return wins.length ? 'File Explorer' : ''
      }
      const rows = await this.shell.call<RmRow[]>('rmHolders', { paths: [path] }, 60_000)
      const r = rows.find((x) => x.pid === pid && x.start === start)
      return r ? r.app || basename(r.exe ?? '') || 'A program' : ''
    } catch {
      return ''
    }
  }

  /** Did this request come from the file server of `path`? (its address, or the name of the Hopper at that address) */
  private isServerFor(path: string, address: string) {
    const host = uncHost(path)
    const ip = normIp(address)
    if (!host || !ip) return false
    if (host === ip) return true
    const peer = this.discovery.online().find((p) => normIp(p.address) === ip)
    return !!peer && peer.host.toLowerCase() === host
  }

  /** Status of a close request, from the PC that was asked. */
  onStatus(identity: string, frame: any): true | string {
    const s = cleanStatus(frame)
    if (!s) return 'bad-status'
    // only from the person whose PC was asked about that holder
    const key = `${s.id}|${s.holder}`
    const asked = this.asked.get(key)
    if (!asked || asked.user !== identity.toLowerCase()) return 'unexpected-status'
    if (s.status !== 'asked') this.asked.delete(key)
    this.ctx.emit('unlock-status', { ...s, from: identity })
    return true
  }

  /** Show a prompt; false when this person already has too many open or asks too often. */
  private prompt(p: Omit<Prompt, 'promptId' | 'at'>): boolean {
    const now = Date.now()
    for (const [k, x] of this.prompts) if (now - x.at > 3600_000) this.prompts.delete(k)
    // one prompt per requester, file and process
    for (const [k, x] of this.prompts) if (x.from === p.from && x.path === p.path && x.pid === p.pid && x.kind === p.kind) this.prompts.delete(k)
    const times = (this.promptTimes.get(p.from) ?? []).filter((t) => now - t < 60_000)
    if (!promptAllowed([...this.prompts.values()].filter((x) => x.from === p.from).length, times, now)) return false
    this.promptTimes.set(p.from, [...times, now])
    const promptId = randomBytes(8).toString('hex')
    this.prompts.set(promptId, { ...p, promptId, at: now })
    this.ctx.emit('unlock-prompt', { promptId, from: p.from, fromName: p.fromName, path: p.path, kind: p.kind, app: p.app })
    this.ctx.attention()
    return true
  }

  pending() {
    return [...this.prompts.values()].map((p) => ({ promptId: p.promptId, from: p.from, fromName: p.fromName, path: p.path, kind: p.kind, app: p.app }))
  }

  /** This PC's user answered a prompt: 'close' (Restart Manager, graceful), 'self' (they will close it) or 'later'. */
  async answer(promptId: string, choice: 'close' | 'self' | 'later') {
    const p = this.prompts.get(String(promptId))
    if (!p) return { ok: false, error: 'This request is no longer open' }
    this.prompts.delete(p.promptId)
    if (p.kind === 'notice') return { ok: true }
    let status: HolderStatus = 'declined'
    let message = ''
    if (choice === 'close') {
      const r = await this.closeHere(p.kind, p.path, p.pid, p.start)
      status = r.ok ? 'closed' : 'failed'
      message = r.error ?? ''
    } else if (choice === 'self') {
      status = 'asked'
      message = 'They will save and close it themselves'
    } else message = 'Not now'
    await this.tell(p, status, message)
    return { ok: status !== 'failed', status, error: status === 'failed' ? message : undefined }
  }

  /** Close one holder on THIS PC, after this PC's user chose to. */
  async closeHere(kind: 'app' | 'explorer', path: string, pid: number, start: string): Promise<{ ok: boolean; error?: string }> {
    await this.refreshDrives()
    try {
      if (kind === 'explorer') {
        const parent = dirname(path)
        await this.shell.call('explorerRelease', { paths: this.spellings(path), to: parent !== path ? parent : '' }, 30_000)
        return { ok: true }
      }
      // the file the process holds, as this PC spells it (any spelling works for Restart Manager)
      const r = await this.shell.call<{ ok: boolean; error?: string }>('rmShutdown', { path, pid, start }, 120_000)
      return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'The app did not close' }
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) }
    }
  }

  private async tell(p: Prompt, status: HolderStatus, message: string) {
    const peer = (p.replyPeer && this.discovery.online().find((x) => x.id === p.replyPeer)) || this.discovery.find(p.from)
    if (!peer) return
    const ac = new AbortController()
    await sendSmall(this.ctx, peer, { t: 'unlock-status', id: p.requestId, holder: p.holderId, status, ...(message ? { message } : {}) }, ac.signal).catch((e) => this.ctx.log('unlock', 'status reply', e?.message ?? e))
  }

  // -------------------------------------------------------------------------
  // asking: the requester's side

  /** Ask every Hopper (this one included) who holds these paths. Answers arrive as 'unlock-update' events. */
  find(raw: string[]) {
    const paths = cleanPaths(raw)
    if (!paths) throw new Error('Pick up to 50 files or folders with full paths')
    const id = `u${randomBytes(8).toString('hex')}`
    const unc = paths.filter(isUnc)
    const peers = this.ctx.key && unc.length ? this.discovery.online().filter((p) => p.port && p.address) : []
    void this.collect(id, paths, unc, peers)
    return { id, peers: peers.length }
  }

  private async collect(id: string, paths: string[], unc: string[], peers: Peer[]) {
    const me = this.me()
    const local = this.localHolders(paths)
      .then((reply) => this.ctx.emit('unlock-update', { id, peer: me.peer, name: me.person, host: me.pc, self: true, reply }))
      .catch((e) => this.ctx.emit('unlock-update', { id, peer: me.peer, name: me.person, host: me.pc, self: true, error: String(e?.message ?? e) }))
    const remote = peers.map(async (p) => {
      const ac = new AbortController()
      try {
        const f = await sendAsk(this.ctx, p, { t: 'holders', id, paths: unc }, ac.signal, ASK_MS)
        const reply = cleanReply(f)
        if (!reply) throw new Error(f?.t === 'err' ? String(f.code) : 'no answer')
        // who and where come from the authenticated connection, not from the answer
        for (const h of reply.holders) {
          h.peer = p.id
          if (h.kind !== 'smb') {
            h.pc = p.host
            if (!h.user || bareUser(h.user) === p.user) {
              h.user = p.user
              h.person = p.displayName
            }
          }
          h.id = `${p.id}:${h.id}`.slice(0, 80)
        }
        this.ctx.emit('unlock-update', { id, peer: p.id, name: p.displayName, host: p.host, user: p.user, reply })
      } catch (e: any) {
        // Hopper before 2.8 closes the connection: it simply does not answer
        this.ctx.emit('unlock-update', { id, peer: p.id, name: p.displayName, host: p.host, user: p.user, error: String(e?.message ?? e) })
      }
    })
    await Promise.all([local, ...remote])
    this.ctx.emit('unlock-done', { id })
  }

  private text(h: Holder, file: string) {
    const who = this.ctx.me.displayName || this.ctx.me.user
    const where = h.pc ? ` on ${h.pc}` : ''
    return `${who} needs ${file}. It is open in ${h.app || 'a program'}${where}. Please save your work and close it.`
  }

  /** Ask a holder to close: a prompt on their PC (Hopper), a Dexterity Connect message, or both. */
  async ask(lookupId: string, h: Holder, via: 'hopper' | 'connect' | 'both') {
    if (!ID_RE.test(String(lookupId))) throw new Error('bad request')
    const out: { hopper?: string; connect?: string; error?: string } = {}
    const file = basename(h.path)
    if ((via === 'hopper' || via === 'both') && (h.kind === 'app' || h.kind === 'explorer')) {
      if (h.peer === this.discovery.id) {
        // on this PC the person asking is the person who decides: close it now
        const r = await this.closeHere(h.kind, h.path, h.pid ?? 0, h.start ?? '')
        out.hopper = r.ok ? 'closed' : 'failed'
        if (r.error) out.error = r.error
        return out
      }
      const peer = this.discovery.online().find((p) => p.id === h.peer)
      if (!peer) out.hopper = 'unreachable'
      else {
        const ac = new AbortController()
        try {
          const r = await sendAsk(this.ctx, peer, { t: 'close', id: lookupId, holder: h.id, reply: this.discovery.id, path: h.path, kind: h.kind, pid: h.pid, start: h.start, app: h.app, byName: this.ctx.me.displayName || this.ctx.me.user }, ac.signal)
          out.hopper = r?.t === 'ok' ? 'asked' : 'failed'
          if (r?.t === 'ok') {
            for (const [k, v] of this.asked) if (Date.now() - v.at > 3600_000) this.asked.delete(k)
            this.asked.set(`${lookupId}|${h.id}`, { user: peer.user.toLowerCase(), at: Date.now() })
          } else out.error = r?.code === 'not-open' ? 'It is no longer open there' : r?.code === 'too-many' ? 'They already have several requests open' : String(r?.code ?? 'refused')
        } catch (e: any) {
          out.hopper = 'failed'
          out.error = String(e?.message ?? e)
        }
      }
    }
    if ((via === 'connect' || via === 'both' || h.kind === 'smb') && h.user) {
      out.connect = await this.dm([h.user], this.text(h, file), file)
    }
    return out
  }

  /** People who opened the file recently (or the server names) but no Hopper claims it: a message only. */
  async notify(lookupId: string, users: string[], path: string, via: 'hopper' | 'connect' | 'both') {
    if (!ID_RE.test(String(lookupId)) || !cleanPaths([path])) throw new Error('bad request')
    const list = [...new Set(users.map(bareUser).filter(Boolean))].slice(0, 20)
    const file = basename(path)
    const who = this.ctx.me.displayName || this.ctx.me.user
    const out: Record<string, string> = {}
    for (const u of list) {
      const res: string[] = []
      if (via !== 'connect') {
        const peer = this.discovery.find(u)
        if (peer) {
          const ac = new AbortController()
          const r = await sendAsk(this.ctx, peer, { t: 'notify', id: lookupId, path, byName: who, reason: 'recent' }, ac.signal).catch(() => null)
          res.push(r?.t === 'ok' ? 'hopper' : 'hopper-failed')
        }
      }
      if (via !== 'hopper') res.push(await this.dm([u], `${who} needs ${file} and cannot change it: it is still open somewhere. If you have it open, please save your work and close it.`, file))
      out[u] = res.join(',') || 'unreachable'
    }
    return out
  }

  private async dm(users: string[], text: string, file: string) {
    const cfg = this.ctx.office?.connect
    if (!connectEnabled(cfg)) return 'connect-off'
    const r = await postConnect(cfg, users, text, { title: `File needed: ${file}` })
    return r.ok ? 'sent' : `failed: ${r.error ?? r.status}`
  }

  // -------------------------------------------------------------------------
  // force close (server agent, office admins only)

  /** Office admins: the standing admins and the account that set the office up. */
  isAdmin(user: string) {
    const u = normUser(user)
    if (!u) return false
    if (isStandingAdmin(u)) return true
    const s = officeSetup(this.ctx.office)
    return !!s && normUser(s.user) === u
  }

  /** Ask the server agent (another PC, or this one) to close one open file. */
  async force(lookupId: string, h: Holder, fileId: number) {
    if (!this.isAdmin(this.ctx.me.user)) throw new Error('Only office admins can force a file closed')
    const frame = { t: 'force', id: lookupId, fileId, path: h.path }
    if (!cleanForce(frame)) throw new Error('bad request')
    if (h.peer === this.discovery.id) return this.forceHere(this.ctx.me.user, frame, { fromName: this.ctx.me.displayName, host: this.ctx.me.host, local: true })
    const peer = this.discovery.online().find((p) => p.id === h.peer)
    if (!peer) throw new Error('The file server’s Hopper is not reachable')
    const ac = new AbortController()
    return sendAsk(this.ctx, peer, frame, ac.signal, 60_000)
  }

  private async forceHere(identity: string, raw: any, from: { fromName: string; host: string; address?: string; local?: boolean }) {
    const f = cleanForce(raw)
    if (!f) return { t: 'err', code: 'bad-request' }
    const shares = await this.myShares()
    const local = serverLocalPath(f.path, this.hostNames(), shares)
    if (!local) return { t: 'err', code: 'not-server' }
    // the admin is who the server says is connected from that PC, not who the Hopper says it is
    const auth = await this.verifiedAdmin(from.local ? { local: true } : { address: from.address })
    if (!('user' in auth)) return { t: 'err', code: auth.error }
    // only an id that is really open inside that path right now
    const list = await this.smb('smbOpenFiles', { path: local })
    if (!list?.ok) return { t: 'err', code: list?.error === 'needs-admin' ? 'needs-admin' : 'failed', message: String(list?.error ?? '') }
    const open = (list.files ?? []).find((x: any) => Number(x.id) === f.fileId && within(String(x.path ?? ''), local))
    if (!open) return { t: 'err', code: 'not-open' }
    const r = await this.smb('smbCloseFile', { id: f.fileId })
    const user = bareUser(open.user)
    const entry = { at: new Date().toISOString(), action: 'force-close', by: auth.user, claimed: identity, from: from.local ? 'server console' : normIp(from.address), server: this.ctx.me.host, path: f.path, user, fileId: f.fileId, locks: Number(open.locks) || 0, ok: !!r?.ok, ...(r?.ok ? {} : { error: String(r?.error ?? '') }) }
    const logged = await this.smb('auditLog', { line: JSON.stringify(entry) })
    if (!logged?.ok) this.ctx.log('unlock', 'force-close log failed', logged?.error ?? '')
    if (!r?.ok) return { t: 'err', code: r?.error === 'needs-admin' ? 'needs-admin' : 'failed', message: String(r?.error ?? '') }
    // tell the person whose handle was closed, naming the admin the server recognised
    if (user) {
      const file = basename(f.path)
      const admin = this.discovery.nameFor(auth.user)
      const text = `${admin} (office admin) closed ${file} on the file server so it could be changed. If you had unsaved work in it, save it under a new name and tell them.`
      const sent = await this.dm([user], text, file)
      if (sent !== 'sent') {
        const peer = this.discovery.find(user)
        if (peer) await sendAsk(this.ctx, peer, { t: 'notify', id: f.id, path: f.path, byName: admin, reason: 'forced' }, new AbortController().signal).catch(() => {})
      }
    }
    return { t: 'forced', ok: true, user, by: auth.user, logged: !!logged?.ok }
  }

  // -------------------------------------------------------------------------
  // the server agent on this PC

  /** Is this PC a file server, and can its Hopper see and close open files? */
  async agentStatus() {
    const shares = await this.myShares()
    const elevated = await this.shell.call<boolean>('elevated', {}, 10_000).catch(() => false)
    const task = (await run('schtasks.exe', ['/query', '/tn', AGENT_TASK])).ok
    const deployed = await fsp.readFile(agentExe()).then((b) => createHash('sha256').update(b).digest('hex'), () => '')
    const upToDate = !!deployed && !!HELPER_SHA256 && deployed === HELPER_SHA256
    let agent = false
    if (!elevated && task && upToDate) agent = (await this.agentCall('elevated', {}).catch(() => false)) === true
    return { shares: shares.map((s) => s.name), elevated, task, deployed: !!deployed, upToDate, ready: elevated || agent }
  }

  /**
   * One UAC prompt on the server: copy the helper to Program Files\Hopper\Agent (administrators only
   * may change it), check the copy against the hash built into this Hopper, and register a scheduled
   * task that starts that copy with admin rights when needed. No password is stored.
   */
  async agentSetup(remove = false) {
    const exe = process.env.HOPPER_HELPER ?? ''
    const q = (v: string) => `'${v.replace(/'/g, "''")}'`
    const dest = dirname(agentExe())
    let script: string
    if (remove) {
      script = [
        `Unregister-ScheduledTask -TaskName ${q(AGENT_TASK)} -Confirm:$false -ErrorAction SilentlyContinue`,
        `Get-Process HopperShell -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ${q(agentExe())} } | Stop-Process -Force`,
        `Remove-Item -LiteralPath ${q(dest)} -Recurse -Force -ErrorAction SilentlyContinue`
      ].join('; ')
    } else {
      if (!exe) throw new Error('The helper is missing')
      if (!/^[0-9a-f]{64}$/.test(HELPER_SHA256)) throw new Error('This build of Hopper has no helper checksum; build it with npm run build')
      await this.refreshDrives()
      const onNetwork = exe.startsWith('\\\\') || this.drives.some((d) => !!d.remote && exe.toLowerCase().startsWith(d.root.toLowerCase()))
      if (onNetwork) throw new Error('Hopper runs from a network drive here; install Hopper on this PC first')
      const account = `${process.env.USERDOMAIN || hostname()}\\${process.env.USERNAME ?? ''}`
      const target = agentExe()
      script = [
        `$ErrorActionPreference = 'Stop'`,
        `Get-Process HopperShell -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ${q(target)} } | Stop-Process -Force`,
        `New-Item -ItemType Directory -Force -Path ${q(dest)} | Out-Null`,
        // SYSTEM and Administrators may change it; Users may only read and run it
        `& icacls.exe ${q(dest)} /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null`,
        `Copy-Item -LiteralPath ${q(exe)} -Destination ${q(target)} -Force`,
        `if ((Get-FileHash -Algorithm SHA256 -LiteralPath ${q(target)}).Hash -ne ${q(HELPER_SHA256.toUpperCase())}) { Remove-Item -LiteralPath ${q(target)} -Force; throw 'The helper does not match this Hopper build' }`,
        `$a = New-ScheduledTaskAction -Execute ${q(target)} -Argument '--agent'`,
        `$p = New-ScheduledTaskPrincipal -UserId ${q(account)} -LogonType Interactive -RunLevel Highest`,
        `$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew`,
        `Register-ScheduledTask -TaskName ${q(AGENT_TASK)} -Action $a -Principal $p -Settings $s -Description 'Lets Hopper list and close open files on this file server (Who has it open). Started on demand; exits when idle.' -Force | Out-Null`
      ].join('; ')
    }
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    // UAC: Windows asks once; a "No" there leaves everything as it was
    const outer = `$p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'; exit $p.ExitCode`
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', outer], 180_000)
    if (!r.ok) throw new Error(/canceled|cancelled/i.test(r.err) ? 'Windows did not get permission (the prompt was declined)' : r.err.trim().split(/\r?\n/)[0] || 'setup failed')
    return this.agentStatus()
  }
}

function run(file: string, args: string[], timeout = 20_000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout }, (e, out, err) => resolve({ ok: !e, out: String(out ?? ''), err: String(err ?? e?.message ?? '') }))
  })
}
