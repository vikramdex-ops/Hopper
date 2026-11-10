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
  DAY_MS, DEFAULT_PAGE_URL, MANIFEST_VERSION, MAX_SHARE_FILES, encodeShareId, isShareId, normalizeDays, safeFileName, shareUrl,
  type PasswordVerifier, type PublicLink, type PublicShareConfig, type PublicShareCreated, type PublicShareSpec, type PublicShareStatus, type ShareManifest, type ShareStats
} from '@shared/pubshare'
import type { EngineCtx } from './index'
import type { JobCtl } from './jobs'
import { createArchive } from './archive'

const CHUNK = 4 << 20
const ARCHIVES = /\.(zip|7z|rar)$/i
const SCRYPT = { N: 32768, r: 8, p: 1 }

export interface PubshareDeps {
  createArchive: typeof createArchive
  user: () => { user: string; host: string }
  fetch: typeof fetch
  now: () => number
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
    defaultDays: normalizeDays(c.defaultDays)
  }
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
    const dir = shareDir(cfg.store, id)
    const data = join(dir, 'data')
    const who = deps.user()
    try {
      await fsp.mkdir(data, { recursive: true })
      // tells the server's clean-up this folder is ours if the PC dies before the manifest is written
      await fsp.writeFile(join(dir, 'creating.json'), JSON.stringify({ v: 1, id, owner: who, createdAt }), 'utf8')

      const files: ShareManifest['files'] = []
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
        try {
          const fsStat = await fsp.statfs(cfg.store)
          if (fsStat.bavail * fsStat.bsize < total + (64 << 20)) throw Object.assign(new Error('The office server does not have enough free space for this link.'), { fatal: true })
        } catch (e: any) {
          if (e.fatal) throw e // statfs itself is best-effort
        }
        const names = uniqueNames(paths.map((p) => basename(p)))
        for (let n = 0; n < paths.length; n++) {
          await ctl.checkpoint()
          ctl.setCurrent(paths[n])
          const h = await copyHashed(paths[n], join(data, String(n)), ctl)
          files.push({ name: names[n], size: h.size, sha256: h.sha256 })
          ctl.add(0, 1)
        }
      }

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
        sender: (ctx.settings?.profile?.displayName || who.user).slice(0, 120),
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
    return shareUrl(cfg.pageUrl, id)
  }

  async function readLink(cfg: PublicShareConfig, id: string): Promise<PublicLink | null> {
    const dir = join(cfg.store, id)
    const m = await readJson<ShareManifest>(join(dir, 'manifest.json'))
    if (!m || m.id !== id || !Array.isArray(m.files)) return null
    const stats = await readJson<ShareStats>(join(dir, 'stats.json'))
    return {
      id,
      url: shareUrl(cfg.pageUrl, id),
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
      return { jobId, id, url: shareUrl(cfg.pageUrl, id), expiresAt }
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

    /** Is the store reachable, and does the share server answer through its public address? */
    'pubshare.status': async (): Promise<PublicShareStatus> => {
      const cfg = publicShareConfig(ctx)
      const st: PublicShareStatus = { enabled: cfg.enabled, store: cfg.store, storeOk: false, pageUrl: cfg.pageUrl, healthy: false }
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
      const beat = await readJson<{ base?: string; updated?: number }>(join(cfg.store, '_server.json'))
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
