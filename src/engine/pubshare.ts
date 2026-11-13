// Dexterity Share (client links): builds a share folder in the office store over SMB. The share
// server on the always-on machine only ever reads that store; Hopper never talks HTTP to create a
// link. The manifest is written last, so a half-copied share is never visible to a client.
import { createReadStream, promises as fsp } from 'node:fs'
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { hostname, userInfo } from 'node:os'
import { basename, dirname, join, relative, isAbsolute, resolve } from 'node:path'
import type { ArchivePreset, OfficeConfig } from '@shared/types'
import { DEFAULT_PRESETS } from '@shared/defaults'
import {
  DAY_MS, DEFAULT_MIN_FREE_GB, DEFAULT_PAGE_URL, GIST_ID_RE, KEY_HASH_RE, MANIFEST_VERSION, MAX_SHARE_FILES, STAFF_DIR, encodeShareId, isShareId, normalizeDays, normalizeStaffWeb, safeFileName, shareUrl, staffPassUrl,
  type PasswordVerifier, type PublicLink, type PublicShareConfig, type PublicShareCreated, type PublicShareSpec, type PublicShareStatus, type ShareManifest, type ShareStats,
  type StaffPass, type StaffPassCreated, type StaffPassInfo, PUBLIC_SENDER
} from '@shared/pubshare'
import type { EngineCtx } from './index'
import type { JobCtl } from './jobs'
import { createArchive } from './archive'
import { canConfigureOffice } from '@shared/office-access'

const CHUNK = 4 << 20
const ARCHIVES = /\.(zip|7z|rar)$/i
const SCRYPT = { N: 32768, r: 8, p: 1 }

export interface PubshareDeps {
  createArchive: typeof createArchive
  user: () => { user: string; host: string }
  fetch: typeof fetch
  now: () => number
  /** false = do not start the download-notice timer (tests) */
  watch?: boolean
}

const defaults: PubshareDeps = {
  createArchive,
  user: () => ({ user: userInfo().username, host: hostname() }),
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now()
}

export function publicShareConfig(ctx: Pick<EngineCtx, 'office' | 'settings'>): PublicShareConfig {
  const c: Partial<PublicShareConfig> = ctx.office?.publicShare ?? {}
  const officeFile = ctx.settings?.officeConfigPath ?? ''
  return {
    enabled: !!c.enabled,
    store: c.store?.trim() || (officeFile ? join(dirname(officeFile), 'PublicShares') : ''),
    pageUrl: c.pageUrl?.trim() || DEFAULT_PAGE_URL,
    defaultDays: normalizeDays(c.defaultDays),
    pointer: c.pointer && GIST_ID_RE.test(c.pointer.gist ?? '') && KEY_HASH_RE.test(c.pointer.key ?? '') ? { gist: c.pointer.gist, key: c.pointer.key } : undefined,
    minFreeGB: Number.isFinite(c.minFreeGB) && c.minFreeGB! >= 0 ? c.minFreeGB : DEFAULT_MIN_FREE_GB,
    host: c.host,
    web: normalizeStaffWeb(c.web)
  }
}

/** Office admins, by the same rule main uses (shared/office-access.ts). */
function isOfficeAdmin(ctx: Pick<EngineCtx, 'office'>, user: string, pc: string) {
  return canConfigureOffice(ctx.office, user, pc)
}

/** Same verifier the share server checks: scrypt over the NFKC-normalised password. Never stores the password. */
export function makeVerifier(password: string): Promise<PasswordVerifier> {
  const salt = randomBytes(16)
  return new Promise((res, rej) =>
    scrypt(password.normalize('NFKC'), salt, 32, { ...SCRYPT, maxmem: 256 * SCRYPT.N * SCRYPT.r }, (e, hash) =>
      e ? rej(e) : res({ kdf: 'scrypt', ...SCRYPT, salt: salt.toString('base64'), hash: hash.toString('base64') })
    )
  )
}

export function checkVerifier(password: string, v: PasswordVerifier): Promise<boolean> {
  return new Promise((res, rej) =>
    scrypt(password.normalize('NFKC'), Buffer.from(v.salt, 'base64'), 32, { N: v.N, r: v.r, p: v.p, maxmem: 256 * v.N * v.r }, (e, hash) =>
      e ? rej(e) : res(timingSafeEqual(hash, Buffer.from(v.hash, 'base64')))
    )
  )
}

async function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, text, 'utf8')
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(tmp, file)
      return
    } catch (e: any) {
      // the server may have the old file open for a moment
      if (i >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) {
        await fsp.rm(tmp, { force: true }).catch(() => {})
        throw e
      }
      await new Promise((r) => setTimeout(r, 60 * (i + 1)))
    }
  }
}

const readJson = async <T>(file: string): Promise<T | null> => {
  try {
    return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^﻿/, '')) as T
  } catch {
    return null
  }
}

function shareDir(store: string, id: string) {
  if (!isShareId(id)) throw new Error('Not a valid link id')
  const dir = join(store, id)
  const rel = relative(resolve(store), resolve(dir))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Not a valid link id')
  return dir
}

/** Copy one file into the store in chunks, hashing what is written. */
async function copyHashed(src: string, dst: string, ctl: JobCtl, scale = 1) {
  const hash = createHash('sha256')
  const out = await fsp.open(dst, 'wx')
  let size = 0
  try {
    for await (const chunk of createReadStream(src, { highWaterMark: CHUNK })) {
      await ctl.checkpoint()
      hash.update(chunk as Buffer)
      await out.write(chunk as Buffer)
      size += (chunk as Buffer).length
      ctl.add(Math.round((chunk as Buffer).length * scale))
    }
    await out.sync().catch(() => {})
  } finally {
    await out.close()
  }
  return { size, sha256: hash.digest('hex') }
}

/** Free bytes on the store's drive, or null when the system cannot say. */
export async function storeFree(store: string): Promise<number | null> {
  try {
    const v = await fsp.statfs(store)
    return v.bavail * v.bsize
  } catch {
    return null
  }
}

const gb = (n: number) => `${(n / 2 ** 30).toFixed(n < 10 * 2 ** 30 ? 1 : 0)} GB`

/** Throws a plain-language error when the store's drive is too full for `need` more bytes. */
export async function diskGuard(cfg: PublicShareConfig, need: number) {
  const free = await storeFree(cfg.store)
  if (free == null) return
  const min = (cfg.minFreeGB ?? DEFAULT_MIN_FREE_GB) * 2 ** 30
  if (free - need < min) {
    throw new Error(`The office server is nearly full: ${gb(free)} free, and client links must leave ${gb(min)}${need ? ` (this link needs ${gb(need)})` : ''}. Revoke old links under "My client links" or ask IT to free space.`)
  }
}

/**
 * A file that already sits on the store's drive is linked into the store instead of copied: instant,
 * and no second copy on disk. Returns false whenever that is not possible (other drive, file system
 * without hard links, no permission) so the caller copies as usual.
 */
async function tryLink(src: string, dst: string) {
  try {
    await fsp.link(src, dst)
    const [a, b] = await Promise.all([fsp.stat(src), fsp.stat(dst)])
    // (a link count is not reported over SMB, so the check is: same size and same modified time)
    if (a.size !== b.size || a.mtimeMs !== b.mtimeMs) throw new Error('not a real link')
    return true
  } catch {
    await fsp.rm(dst, { force: true }).catch(() => {})
    return false
  }
}

const LINKABLE = /\.(zip|7z|rar|pdf|iso|tar|gz|tgz|mp4|rvm|nwd|nwf)$/i

async function hashFile(file: string, ctl: JobCtl, scale: number) {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(file, { highWaterMark: CHUNK })) {
    await ctl.checkpoint()
    hash.update(chunk as Buffer)
    size += (chunk as Buffer).length
    ctl.add(Math.round((chunk as Buffer).length * scale))
  }
  return { size, sha256: hash.digest('hex') }
}

function uniqueNames(names: string[]) {
  const seen = new Set<string>()
  return names.map((raw) => {
    const n = safeFileName(raw)
    const dot = n.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [n.slice(0, dot), n.slice(dot)] : [n, '']
    let c = n
    for (let i = 2; seen.has(c.toLowerCase()); i++) c = `${stem} (${i})${ext}`
    seen.add(c.toLowerCase())
    return c
  })
}

function presetFor(ctx: EngineCtx, id?: string): ArchivePreset {
  const list = ctx.settings?.archivePresets?.length ? ctx.settings.archivePresets : DEFAULT_PRESETS
  const p = list.find((x) => x.id === id) ?? list.find((x) => x.id === 'fast') ?? list[0]
  // one file per link: never split volumes; the page password replaces an archive password
  return { ...p, volumeMB: 0, password: false }
}

export function pubshareHandlers(ctx: EngineCtx, overrides: Partial<PubshareDeps> = {}) {
  const deps = { ...defaults, ...overrides }

  function ready() {
    const cfg = publicShareConfig(ctx)
    if (!cfg.enabled) throw new Error('Dexterity Share is not switched on. Ask whoever looks after the office setup (Settings → Office → Dexterity Share).')
    if (!cfg.store) throw new Error('The Dexterity Share store folder is not set (Settings → Office → Dexterity Share).')
    return cfg
  }

  async function build(ctl: JobCtl, cfg: PublicShareConfig, spec: PublicShareSpec, id: string, expiresAt: number, createdAt: number) {
    const paths = spec.paths
    const stats = await Promise.all(paths.map((p) => fsp.stat(p)))
    const hasDir = stats.some((s) => s.isDirectory())
    // undefined = decide here (several items or a folder become one zip); null = the caller said no
    const zip = spec.zip === undefined ? (hasDir || paths.length > 1 ? {} : null) : spec.zip
    if (!zip && hasDir) throw new Error('Folders are sent as one zip file: tick "Zip into one file".')
    if (!zip && paths.length > MAX_SHARE_FILES) throw new Error(`A link can hold at most ${MAX_SHARE_FILES} files; zip them into one file instead.`)

    await fsp.mkdir(cfg.store, { recursive: true })
    await diskGuard(cfg, zip ? 0 : stats.reduce((a, s) => a + s.size, 0))
    const dir = shareDir(cfg.store, id)
    const data = join(dir, 'data')
    const who = deps.user()
    try {
      await fsp.mkdir(data, { recursive: true })
      // tells the server's clean-up this folder is ours if the PC dies before the manifest is written
      await fsp.writeFile(join(dir, 'creating.json'), JSON.stringify({ v: 1, id, owner: who, createdAt }), 'utf8')

      const files: ShareManifest['files'] = []
      let linked = false
      if (zip) {
        const preset = presetFor(ctx, zip.presetId)
        const name = safeFileName((zip.name || spec.title || 'Files').replace(ARCHIVES, '')) + '.' + preset.format
        const tmp = join(data, `payload.${preset.format}`)
        // Phase 1 (zip) fills the first half of the bar, phase 2 (checksum of what the server holds) the second.
        let sourceBytes = 0
        const zipCtl: JobCtl = Object.create(ctl, {
          setTotal: { value: (b: number, f: number) => ((sourceBytes = b), ctl.setTotal(b * 2, f)) }
        })
        // An archive in the store must not land in the undo journal: Ctrl+Z would delete a client's download.
        const quiet = Object.create(ctx, { undo: { value: { record() {} } } }) as EngineCtx
        await deps.createArchive(quiet, zipCtl, paths, tmp, preset)
        await ctl.checkpoint()
        ctl.setCurrent(name)
        const size = (await fsp.stat(tmp)).size
        const h = await hashFile(tmp, ctl, size ? sourceBytes / size : 0)
        await fsp.rename(tmp, join(data, '0'))
        files.push({ name, size: h.size, sha256: h.sha256 })
      } else {
        const total = stats.reduce((a, s) => a + s.size, 0)
        ctl.setTotal(total, paths.length)
        const names = uniqueNames(paths.map((p) => basename(p)))
        for (let n = 0; n < paths.length; n++) {
          await ctl.checkpoint()
          ctl.setCurrent(paths[n])
          const dst = join(data, String(n))
          // Finished deliverables (archives, PDFs…) on the server's own drive are linked, not copied.
          // The link shares its bytes with the original, so its size and time are recorded and the
          // server refuses to send it if the original is ever edited in place.
          if (paths.length === 1 && LINKABLE.test(paths[n]) && (await tryLink(paths[n], dst))) {
            const h = await hashFile(dst, ctl, 1)
            const st = await fsp.stat(dst)
            if (st.size !== h.size || st.mtimeMs !== stats[n].mtimeMs) throw new Error(`${names[n]} changed while the link was being made. Try again when nobody is saving it.`)
            files.push({ name: names[n], size: h.size, sha256: h.sha256, mtime: st.mtimeMs })
            linked = true
          } else {
            const h = await copyHashed(paths[n], dst, ctl)
            files.push({ name: names[n], size: h.size, sha256: h.sha256 })
          }
          ctl.add(0, 1)
        }
      }

      if (linked) ctl.info.title += ' (linked, no copy)'
      // What the server will serve must be exactly what we hashed.
      for (let n = 0; n < files.length; n++) {
        const st = await fsp.stat(join(data, String(n)))
        if (st.size !== files[n].size) throw new Error(`The copy of ${files[n].name} on the server is incomplete. Check the network and try again.`)
      }
      await ctl.checkpoint()

      const manifest: ShareManifest = {
        v: MANIFEST_VERSION,
        id,
        title: spec.title.trim().slice(0, 200) || files[0].name,
        message: (spec.message ?? '').trim().slice(0, 4000),
        // clients see this: a person's display name, never their Windows account name
        sender: (ctx.settings?.profile?.displayName?.trim() || PUBLIC_SENDER).slice(0, 120),
        createdAt,
        expiresAt,
        files,
        password: spec.password ? await makeVerifier(spec.password) : null,
        maxDownloads: Math.max(0, Math.floor(spec.maxDownloads ?? 0)),
        owner: who
      }
      await writeAtomic(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
      await fsp.rm(join(dir, 'creating.json'), { force: true }).catch(() => {})
    } catch (e) {
      await fsp.rm(join(dir, 'manifest.json'), { force: true }).catch(() => {})
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {})
      throw e
    }
    return shareUrl(cfg.pageUrl, id, cfg.pointer)
  }

  // ---- "your client downloaded it" ---------------------------------------------------------
  // Remembers, per link, how many completed downloads have been announced. Cheap: one small
  // stats.json per live link of mine, every two minutes, and only while I have live links.
  const seenFile = () => join(ctx.dataDir || '.', 'pubshare-seen.json')
  let seen: Record<string, number> | null = null
  let quiet = 0
  async function watchDownloads() {
    let cfg: PublicShareConfig
    try {
      cfg = ready()
    } catch {
      return 0
    }
    const first = seen === null
    if (first) seen = (await readJson<Record<string, number>>(seenFile())) ?? {}
    let names: string[]
    try {
      names = (await fsp.readdir(cfg.store, { withFileTypes: true })).filter((d) => d.isDirectory() && isShareId(d.name)).map((d) => d.name)
    } catch {
      return 0
    }
    const me = deps.user().user.toLowerCase()
    const next: Record<string, number> = {}
    let live = 0
    let told = 0
    for (const id of names) {
      const stats = await readJson<ShareStats>(join(cfg.store, id, 'stats.json'))
      const known = seen![id]
      // only links already known to be mine cost a manifest read again when their count moved
      if (known !== undefined && (stats?.downloads ?? 0) === known) {
        next[id] = known
        live++
        continue
      }
      const l = await readLink(cfg, id)
      if (!l || l.owner.toLowerCase() !== me) continue
      if (!l.expired) live++
      const n = l.stats?.downloads ?? 0
      // a link first seen with downloads already on it (new PC, cleared data) is recorded, not announced
      if (known !== undefined && n > known) {
        told++
        ctx.emit('pubshare-download', { id, title: l.title, downloads: n, first: known === 0, at: l.stats?.lastDownloadAt || deps.now() })
      }
      next[id] = n
    }
    if (JSON.stringify(next) !== JSON.stringify(seen)) {
      seen = next
      await fsp.writeFile(seenFile(), JSON.stringify(next), 'utf8').catch(() => {})
    }
    quiet = live ? 0 : 4 // with no live links, look only every ten minutes
    return told
  }
  if (deps.watch !== false) {
    setInterval(() => {
      if (quiet-- > 0) return
      void watchDownloads().catch(() => {})
    }, 120_000).unref()
  }

  async function readLink(cfg: PublicShareConfig, id: string): Promise<PublicLink | null> {
    const dir = join(cfg.store, id)
    const m = await readJson<ShareManifest>(join(dir, 'manifest.json'))
    if (!m || m.id !== id || !Array.isArray(m.files)) return null
    const stats = await readJson<ShareStats>(join(dir, 'stats.json'))
    return {
      id,
      url: shareUrl(cfg.pageUrl, id, cfg.pointer),
      title: m.title,
      message: m.message ?? '',
      sender: m.sender ?? '',
      owner: m.owner?.user ?? '',
      createdAt: m.createdAt,
      expiresAt: m.expiresAt,
      expired: m.expiresAt <= deps.now(),
      files: m.files.map((f) => ({ name: f.name, size: f.size })),
      bytes: m.files.reduce((a, f) => a + f.size, 0),
      hasPassword: !!m.password,
      maxDownloads: m.maxDownloads ?? 0,
      stats: stats?.v === 1 ? stats : null
    }
  }

  return {
    /** Starts the job and returns at once: the link address is known before the copy finishes. */
    'pubshare.create': async (spec: PublicShareSpec): Promise<PublicShareCreated> => {
      const cfg = ready()
      if (!spec?.paths?.length) throw new Error('Nothing selected')
      if (spec.password != null && spec.password !== '' && spec.password.length < 6) throw new Error('Use a password of at least 6 characters')
      const id = encodeShareId(randomBytes(16))
      const createdAt = deps.now()
      const expiresAt = createdAt + normalizeDays(spec.days, cfg.defaultDays) * DAY_MS
      const title = spec.title?.trim() || basename(spec.paths[0])
      const jobId = ctx.jobs.create('share', `Client link: ${title}`, (ctl) => build(ctl, cfg, { ...spec, title }, id, expiresAt, createdAt), { immediate: true, dest: cfg.store })
      return { jobId, id, url: shareUrl(cfg.pageUrl, id, cfg.pointer), expiresAt }
    },

    /** Links in the store, newest first. scope 'mine' = created from this Windows account. */
    'pubshare.list': async (scope: 'mine' | 'all' = 'mine'): Promise<PublicLink[]> => {
      const cfg = ready()
      let names: string[] = []
      try {
        names = (await fsp.readdir(cfg.store, { withFileTypes: true })).filter((d) => d.isDirectory() && isShareId(d.name)).map((d) => d.name)
      } catch (e: any) {
        if (e.code === 'ENOENT') return []
        throw new Error(`The share store is not reachable (${e.code ?? e.message})`)
      }
      const me = deps.user().user.toLowerCase()
      const out: PublicLink[] = []
      for (let i = 0; i < names.length; i += 16) {
        const part = await Promise.all(names.slice(i, i + 16).map((id) => readLink(cfg, id)))
        for (const l of part) if (l && (scope === 'all' || l.owner.toLowerCase() === me)) out.push(l)
      }
      return out.sort((a, b) => b.createdAt - a.createdAt)
    },

    /** Withdraw a link now. The manifest goes first, so the server stops serving it within seconds. */
    'pubshare.revoke': async (id: string) => {
      const cfg = ready()
      const dir = shareDir(cfg.store, id)
      const man = join(dir, 'manifest.json')
      try {
        await fsp.rename(man, join(dir, 'revoked.json'))
      } catch (e: any) {
        if (e.code !== 'ENOENT') await fsp.rm(man, { force: true })
      }
      // If a download still holds a file open the folder survives for now; the server's clean-up finishes the job.
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {})
      return true
    },

    /** Add days to a link (from today if it has already expired). Returns the new expiry. */
    'pubshare.extend': async (id: string, days: number) => {
      const cfg = ready()
      const dir = shareDir(cfg.store, id)
      const file = join(dir, 'manifest.json')
      const m = await readJson<ShareManifest>(file)
      if (!m || m.id !== id) throw new Error('This link no longer exists')
      const now = deps.now()
      const add = Math.max(1, Math.min(90, Math.floor(Number(days) || 0)))
      m.expiresAt = Math.min(Math.max(m.expiresAt, now) + add * DAY_MS, now + 365 * DAY_MS)
      await writeAtomic(file, JSON.stringify(m, null, 2))
      return m.expiresAt
    },

    // ---- browser passes: staff create links from site/share/create/ ---------------------------
    /** Make a personal pass for this Windows account and return its sign-in link (shown once). */
    'pubshare.passCreate': async (): Promise<StaffPassCreated> => {
      const cfg = ready()
      if (!cfg.web?.enabled) throw new Error('Creating links from a browser is switched off for the office (Settings → Office → Dexterity Share).')
      const who = deps.user()
      const user = who.user.replace(/^.*\\/, '').trim().toLowerCase()
      if (!user) throw new Error('Hopper cannot tell which Windows account this is')
      const id = encodeShareId(randomBytes(16))
      const secret = randomBytes(32)
      const pass: StaffPass = {
        v: 1,
        id,
        user,
        host: who.host,
        name: (ctx.settings?.profile?.displayName?.trim() || PUBLIC_SENDER).slice(0, 120), // becomes the public sender
        createdAt: deps.now(),
        verifier: createHash('sha256').update(secret).digest('hex')
      }
      const dir = join(cfg.store, STAFF_DIR)
      await fsp.mkdir(dir, { recursive: true })
      await writeAtomic(join(dir, `${id}.json`), JSON.stringify(pass, null, 2))
      const link = staffPassUrl(cfg.pageUrl, id, secret.toString('base64url'), cfg.pointer)
      secret.fill(0)
      const { verifier: _v, v: _n, ...info } = pass
      return { ...info, lastUsedAt: null, link }
    },

    /** Passes in the store: mine, or everyone's (office admins only). Newest first. */
    'pubshare.passList': async (scope: 'mine' | 'all' = 'mine'): Promise<StaffPassInfo[]> => {
      const cfg = ready()
      const me = deps.user().user.replace(/^.*\\/, '').trim().toLowerCase()
      if (scope === 'all' && !isOfficeAdmin(ctx, me, deps.user().host)) throw new Error('Only an office admin can see everyone\'s browser passes')
      const dir = join(cfg.store, STAFF_DIR)
      let names: string[] = []
      try {
        names = (await fsp.readdir(dir)).filter((n) => /^[a-z2-7]{26}\.json$/.test(n))
      } catch (e: any) {
        if (e.code === 'ENOENT') return []
        throw new Error(`The share store is not reachable (${e.code ?? e.message})`)
      }
      const beat = await readJson<{ staffUsed?: Record<string, number> }>(join(cfg.store, '_server.json'))
      const usedAt = beat?.staffUsed && typeof beat.staffUsed === 'object' ? beat.staffUsed : {}
      const out: StaffPassInfo[] = []
      for (const n of names) {
        const p = await readJson<StaffPass>(join(dir, n))
        if (!p || p.v !== 1 || p.id !== n.slice(0, 26) || typeof p.user !== 'string' || !/^[0-9a-f]{64}$/.test(String(p.verifier)) || (p as any).revokedAt) continue
        if (scope !== 'all' && p.user.toLowerCase() !== me) continue
        const t = Number(usedAt[p.id])
        out.push({ id: p.id, user: p.user.toLowerCase(), host: String(p.host ?? ''), name: String(p.name ?? p.user), createdAt: Number(p.createdAt) || 0, lastUsedAt: Number.isFinite(t) && t > 0 ? t : null })
      }
      return out.sort((a, b) => b.createdAt - a.createdAt)
    },

    /** Switch a pass off: its file goes, and the server refuses it within a few seconds. Mine, or any for an admin. */
    'pubshare.passRevoke': async (id: string) => {
      const cfg = ready()
      if (!isShareId(id)) throw new Error('Not a valid pass')
      const file = join(cfg.store, STAFF_DIR, `${id}.json`)
      const p = await readJson<StaffPass>(file)
      if (!p) return true
      const me = deps.user().user.replace(/^.*\\/, '').trim().toLowerCase()
      if (String(p.user).toLowerCase() !== me && !isOfficeAdmin(ctx, me, deps.user().host)) throw new Error('This browser pass belongs to someone else')
      await fsp.rm(file, { force: true })
      return true
    },

    /** Look once for new client downloads of my links (also runs by itself every two minutes). */
    'pubshare.checkDownloads': () => watchDownloads(),

    /** Is the store reachable, and does the share server answer through its public address? */
    'pubshare.status': async (): Promise<PublicShareStatus> => {
      const cfg = publicShareConfig(ctx)
      const st: PublicShareStatus = { enabled: cfg.enabled, store: cfg.store, storeOk: false, pageUrl: cfg.pageUrl, healthy: false, selfContained: !!cfg.pointer }
      if (!cfg.store) {
        st.storeError = 'No store folder is set'
        return st
      }
      try {
        if (!(await fsp.stat(cfg.store)).isDirectory()) throw new Error('not a folder')
        st.storeOk = true
      } catch (e: any) {
        st.storeError = e.code === 'ENOENT' ? 'The store folder does not exist yet' : `The store folder is not reachable (${e.code ?? e.message})`
        return st
      }
      // The server's supervisor leaves its current public address in the store.
      const free = await storeFree(cfg.store)
      if (free != null) st.freeBytes = free
      st.minFreeBytes = (cfg.minFreeGB ?? DEFAULT_MIN_FREE_GB) * 2 ** 30
      const beat = await readJson<{ base?: string; updated?: number } & NonNullable<PublicShareStatus['server']>>(join(cfg.store, '_server.json'))
      if (beat) {
        const { uptimeSec, activeDownloads, bytesToday, downloadsToday, freeBytes, totalBytes, limitMbps, mode, baseSince, host } = beat
        st.server = { uptimeSec, activeDownloads, bytesToday, downloadsToday, freeBytes, totalBytes, limitMbps, mode, baseSince, host }
        st.serverSeenAt = beat.updated
      }
      if (!beat?.base || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(beat.base)) {
        st.healthError = 'The share server has not reported in yet'
        return st
      }
      st.base = beat.base
      st.serverSeenAt = beat.updated
      try {
        const r = await deps.fetch(`${beat.base}/healthz`, { signal: AbortSignal.timeout(5000), redirect: 'error', cache: 'no-store' })
        const j: any = await r.json().catch(() => null)
        if (r.ok && j?.ok === true) st.healthy = true
        else st.healthError = `The share server answered ${r.status}`
      } catch (e: any) {
        st.healthError = e.name === 'TimeoutError' ? 'The share server did not answer within 5 seconds' : 'The share server is not reachable from the internet right now'
      }
      return st
    }
  }
}
