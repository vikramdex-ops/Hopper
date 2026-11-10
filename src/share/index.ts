// Share utility process: Hopper itself hosts the Dexterity Share server on the PC chosen in the
// setup wizard. It runs the same server and supervisor code as the standalone IT version
// (server/dexterity-share), in this process: no Node install, no second program. The main process
// sends the configuration (and the GitHub token, decrypted, in memory only) and relays requests.
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, promises as fsp, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import type { PublicShareConfig, ShareServerSettings, ShareServerState } from '@shared/pubshare'
// @ts-ignore plain JavaScript shared with the standalone service
import { Supervisor, buildPointer, checkGistToken, createPointerGist, keyHash, loadPointerKey, normalizeBase, publishGistPointer } from '../../server/dexterity-share/supervisor.mjs'
// @ts-ignore
import { Log } from '../../server/dexterity-share/server.mjs'

interface Config {
  settings: ShareServerSettings
  share: PublicShareConfig
  /** GitHub token for the pointer gist ('' = none saved) */
  token: string
  /** Cloudflare tunnel token for mode 'named' */
  tunnelToken: string
}

const DATA = join(process.env.HOPPER_DATA!, 'share')
const STATE = join(DATA, 'state')
const LOGS = join(DATA, 'logs')
// Tests point these at local stand-ins; nothing else may set them.
const GITHUB_API = process.env.HOPPER_SHARE_GITHUB_API || 'https://api.github.com'
const TEST_CLOUDFLARED = process.env.HOPPER_SHARE_CLOUDFLARED_CMD ? (JSON.parse(process.env.HOPPER_SHARE_CLOUDFLARED_CMD) as string[]) : null
const TEST_PUBLIC = process.env.HOPPER_SHARE_PUBLIC_VIA || ''
const RELEASE_ASSET = 'cloudflared-windows-amd64.exe'

let cfg: Config | null = null
let sup: any = null
let supKey = ''
const log = new Log(LOGS, 'hopper-share')

const bundled = () => join(DATA, 'cloudflared.exe')
const cloudflaredPath = () => cfg?.settings.cloudflaredPath?.trim() || bundled()

/** In tests the "public" address is reached through a local port instead of the internet. */
const viaFetch: typeof fetch = (input, init) => {
  const u = String(input)
  if (TEST_PUBLIC && /^https:\/\/[a-z0-9.-]+\.(trycloudflare\.com|example)(\/|$)/.test(u)) return fetch(u.replace(/^https:\/\/[^/]+/, TEST_PUBLIC), init)
  return fetch(input, init)
}

function cloudflaredInfo() {
  const path = cloudflaredPath()
  const found = existsSync(path)
  let version: string | undefined
  try {
    version = JSON.parse(readFileSync(join(DATA, 'cloudflared.json'), 'utf8')).version
  } catch {}
  return { path, found, version }
}

async function storeCheck(store: string) {
  if (!store) return 'The store folder is not set (Settings → Office → Dexterity Share)'
  try {
    await fsp.mkdir(store, { recursive: true })
    const probe = join(store, `_probe-${process.pid}.tmp`)
    await fsp.writeFile(probe, 'x')
    await fsp.rm(probe, { force: true })
    return ''
  } catch (e: any) {
    return `This PC cannot write to the store folder ${store} (${e.code ?? e.message}). Check that the server share is connected.`
  }
}

function pageOrigin(pageUrl: string) {
  try {
    return new URL(pageUrl).origin
  } catch {
    return 'https://vikramdex-ops.github.io'
  }
}

async function stop() {
  const s = sup
  sup = null
  supKey = ''
  if (s) await s.stop().catch(() => {})
}

/** Start, restart or stop the server so that it matches the configuration. */
async function apply() {
  if (!cfg) return
  const { settings, share } = cfg
  const want = settings.enabled && !!share.store && (settings.mode !== 'quick' ? !!normalizeBase(settings.publicBase) : true) && cloudflaredReady()
  // everything that needs a restart when it changes (the token and the bandwidth limit do not)
  const key = JSON.stringify([want, share.store, share.pageUrl, share.pointer?.gist, settings.mode, settings.publicBase, settings.port, cloudflaredPath(), !!cfg.tunnelToken])
  if (sup && key === supKey) {
    sup.app?.setBandwidth(settings.bandwidth)
    sup.pointerDirty = true
    return
  }
  await stop()
  if (!want) return
  if (await storeCheck(share.store)) return
  supKey = key
  sup = new Supervisor(
    {
      inProcess: true,
      file: '',
      hostName: hostname(),
      server: { port: settings.port || 47880, store: share.store, allowedOrigins: [pageOrigin(share.pageUrl), ...(process.env.HOPPER_SHARE_EXTRA_ORIGIN ? [process.env.HOPPER_SHARE_EXTRA_ORIGIN] : [])], stateDir: STATE, logDir: LOGS, bandwidth: settings.bandwidth, shutdownGraceSeconds: 3 },
      tunnel: {
        mode: settings.mode,
        cloudflared: cloudflaredPath(),
        command: TEST_CLOUDFLARED,
        token: cfg.tunnelToken,
        tokenFile: '',
        publicBase: settings.mode === 'quick' ? null : normalizeBase(settings.publicBase),
        protocol: '',
        publicCheck: true,
        checkSeconds: Number(process.env.HOPPER_SHARE_CHECK_SECONDS) || 60,
        verifySeconds: 120
      },
      pointer: share.pointer?.gist ? { kind: 'gist', api: GITHUB_API, gistId: share.pointer.gist } : null
    },
    { fetch: viaFetch, log, getToken: () => cfg?.token ?? '', onChange: () => process.parentPort.postMessage({ type: 'share-changed' }) }
  )
  await sup.start()
}

const cloudflaredReady = () => cfg?.settings.mode === 'external' || cloudflaredInfo().found

async function state(): Promise<ShareServerState> {
  const share = cfg?.share
  const storeError = share ? await storeCheck(share.store) : 'Hopper has not loaded the office settings yet'
  let key: string | null = null
  try {
    if (existsSync(join(STATE, 'pointer-public.json'))) key = keyHash(JSON.parse(readFileSync(join(STATE, 'pointer-public.json'), 'utf8')))
  } catch {}
  return {
    pc: hostname(),
    enabled: !!cfg?.settings.enabled,
    running: !!sup,
    storeOk: !storeError,
    storeError: storeError || undefined,
    serverOk: !!sup?.app,
    serverError: sup?.serverError || undefined,
    cloudflared: cloudflaredInfo(),
    tunnel: { mode: cfg?.settings.mode ?? 'quick', base: sup?.verified ? sup.base : null, verified: !!sup?.verified, since: sup?.verified ? sup.baseSince : null, error: sup?.tunnelError || undefined },
    pointer: { gist: share?.pointer?.gist ?? null, key, hasToken: !!cfg?.token, published: !!sup && !!share?.pointer?.gist && !sup.pointerDirty && !!sup.verified, error: sup?.pointerError || undefined },
    health: sup?.app?.health() ?? null
  }
}

/** Download cloudflared from its official GitHub release and check it against the published SHA-256. */
async function downloadCloudflared(progress: (done: number, total: number) => void) {
  let rel: any
  try {
    const r = await fetch(`${GITHUB_API}/repos/cloudflare/cloudflared/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hopper' }, signal: AbortSignal.timeout(20000) })
    if (!r.ok) throw new Error(String(r.status))
    rel = await r.json()
  } catch {
    throw new Error('GitHub could not be reached to find the tunnel program. Check the internet connection, or download cloudflared yourself and choose "I already have it".')
  }
  const asset = (rel.assets ?? []).find((a: any) => a.name === RELEASE_ASSET)
  if (!asset?.browser_download_url) throw new Error('The latest cloudflared release has no Windows program attached. Download it from Cloudflare and choose "I already have it".')
  const url = String(asset.browser_download_url)
  // Only ever from the official release location (tests use a local stand-in).
  if (!process.env.HOPPER_SHARE_GITHUB_API && !/^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/download\//.test(url)) throw new Error('The download address is not the official cloudflared release. Nothing was downloaded.')
  const want = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '')?.[1] ?? null
  await fsp.mkdir(DATA, { recursive: true })
  const part = bundled() + '.part'
  const hash = createHash('sha256')
  let done = 0
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) })
    if (!r.ok || !r.body) throw new Error(`download answered ${r.status}`)
    const out = createWriteStream(part)
    for await (const chunk of r.body as any) {
      hash.update(chunk)
      done += chunk.length
      if (!out.write(chunk)) await new Promise<void>((res) => out.once('drain', () => res()))
      progress(done, asset.size ?? 0)
    }
    await new Promise<void>((res, rej) => out.end((e: any) => (e ? rej(e) : res())))
  } catch (e: any) {
    await fsp.rm(part, { force: true }).catch(() => {})
    throw new Error(`The download did not finish (${e.message}). Try again; if it keeps failing, download cloudflared on another PC and choose "I already have it".`)
  }
  const sha256 = hash.digest('hex')
  if (asset.size && done !== asset.size) {
    await fsp.rm(part, { force: true })
    throw new Error('The downloaded file is incomplete. Try again.')
  }
  if (want && sha256 !== want) {
    await fsp.rm(part, { force: true })
    throw new Error('The downloaded file does not match the checksum GitHub publishes for it, so it was deleted. Try again later.')
  }
  await stop() // the old copy may be running
  await fsp.rm(bundled(), { force: true }).catch(() => {})
  await fsp.rename(part, bundled())
  const info = { version: String(rel.tag_name ?? ''), sha256, size: done, verified: !!want, at: Date.now() }
  await fsp.writeFile(join(DATA, 'cloudflared.json'), JSON.stringify(info))
  await apply()
  return info
}

/** Is the chosen file really cloudflared? (Asks it for its version.) */
function probeCloudflared(path: string) {
  if (!existsSync(path)) throw new Error('That file does not exist.')
  const r = spawnSync(path, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  const m = /cloudflared version (\S+)/.exec(r.stdout ?? '')
  if (r.status !== 0 || !m) throw new Error('That file is not the cloudflared program. Choose cloudflared.exe (cloudflared-windows-amd64.exe).')
  return { version: m[1] }
}

/**
 * Step 3 of the wizard: check the pasted token, make (or reuse) the gist and publish a signed pointer.
 * Returns what the office config must record: the gist id and the key fingerprint — never the token.
 */
async function connectPointer(token: string) {
  token = token.trim()
  const who = await checkGistToken({ api: GITHUB_API, token, fetchImpl: fetch })
  await fsp.mkdir(STATE, { recursive: true })
  const key = loadPointerKey(STATE)
  // Until the tunnel is up the pointer names no server; the page treats that as "not reachable yet".
  const base = sup?.verified && sup.base ? sup.base : 'https://not-started.trycloudflare.com'
  const pointer = buildPointer(base, key.privateKey, undefined, key.publicJwk)
  let gist = cfg?.share.pointer?.gist ?? ''
  let reused = false
  if (gist) {
    try {
      await publishGistPointer({ api: GITHUB_API, gistId: gist, token, pointer, fetchImpl: fetch })
      reused = true
    } catch {
      gist = '' // made with another account, or deleted: start a fresh one
    }
  }
  if (!gist) gist = await createPointerGist({ api: GITHUB_API, token, pointer, fetchImpl: fetch })
  return { gist, key: keyHash(key.publicJwk), login: who.login, extraScopes: who.extra, reused }
}

/** A tiny share, fetched back through the public address exactly as a client would. */
async function selfTest() {
  if (!cfg || !sup) throw new Error('The share server is not running on this PC yet.')
  if (!sup.verified || !sup.base) throw new Error(sup.tunnelError ? `The tunnel is not up: ${sup.tunnelError}.` : 'The tunnel is still starting. Wait a minute and test again.')
  const base: string = sup.base
  const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
  const id = Array.from(randomBytes(26), (b) => B32[b & 31]).join('')
  const dir = join(cfg.share.store, id)
  const body = randomBytes(4096)
  const sha256 = createHash('sha256').update(body).digest('hex')
  const t0 = Date.now()
  try {
    await fsp.mkdir(join(dir, 'data'), { recursive: true })
    await fsp.writeFile(join(dir, 'data', '0'), body)
    const now = Date.now()
    await fsp.writeFile(join(dir, 'manifest.json'), JSON.stringify({ v: 1, id, title: 'Hopper self-test', message: '', sender: 'Hopper', createdAt: now, expiresAt: now + 10 * 60_000, files: [{ name: 'self-test.bin', size: body.length, sha256 }], password: null, maxDownloads: 0, owner: { user: userInfo().username, host: hostname() } }))
    const meta = await viaFetch(`${base}/api/s/${id}?quiet`, { signal: AbortSignal.timeout(20000) })
    if (meta.status !== 200) throw new Error(`The public address answered ${meta.status} for the test link.`)
    const file = await viaFetch(`${base}/d/${id}/0`, { signal: AbortSignal.timeout(30000) })
    const got = Buffer.from(await file.arrayBuffer())
    if (file.status !== 200 || createHash('sha256').update(got).digest('hex') !== sha256) throw new Error('The test file came back damaged through the tunnel.')
    let pointerOk: boolean | null = null
    if (cfg.share.pointer?.gist) {
      // what a client's browser will read
      const r = await fetch(`${GITHUB_API}/gists/${cfg.share.pointer.gist}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hopper' }, signal: AbortSignal.timeout(20000) }).catch(() => null)
      try {
        pointerOk = !!r && r.ok && JSON.parse((await r.json()).files['pointer.json'].content).base === base
      } catch {
        pointerOk = false
      }
    }
    return { ok: true, base, ms: Date.now() - t0, pointerOk }
  } catch (e: any) {
    if (e.name === 'TimeoutError' || e.message === 'fetch failed') throw new Error('The public address did not answer. Check that this PC can reach the internet (outbound port 7844 to Cloudflare), then test again.')
    throw e
  } finally {
    await fsp.rm(join(dir, 'manifest.json'), { force: true }).catch(() => {})
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {})
  }
}

const methods: Record<string, (...a: any[]) => unknown> = {
  state,
  checkToken: (token: string) => checkGistToken({ api: GITHUB_API, token: String(token).trim(), fetchImpl: fetch }),
  connectPointer,
  probeCloudflared,
  downloadCloudflared: () => downloadCloudflared((done, total) => process.parentPort.postMessage({ type: 'share-progress', done, total })),
  selfTest,
  republish: async () => {
    if (sup) {
      sup.pointerDirty = true
      await sup.syncPointer()
      await sup.heartbeat()
    }
    return state()
  }
}

process.parentPort.on('message', async (e) => {
  const msg = e.data as any
  if (msg?.type === 'config') {
    cfg = msg.config
    await apply().catch((err) => log.error('apply', { message: String(err?.message ?? err) }))
    process.parentPort.postMessage({ type: 'share-changed' })
  } else if (msg?.type === 'call') {
    try {
      const fn = methods[msg.method]
      if (!fn) throw new Error(`no method ${msg.method}`)
      process.parentPort.postMessage({ type: 'reply', id: msg.id, ok: true, value: await fn(...(msg.args ?? [])) })
    } catch (err: any) {
      process.parentPort.postMessage({ type: 'reply', id: msg.id, ok: false, error: String(err?.message ?? err) })
    }
  } else if (msg?.type === 'shutdown') {
    await stop()
    process.parentPort.postMessage({ type: 'stopped' })
    process.exit(0)
  }
})

process.on('uncaughtException', (err) => log.error('uncaught', { message: String(err?.message ?? err) }))
process.on('unhandledRejection', (err) => log.error('unhandled', { message: String((err as any)?.message ?? err) }))
