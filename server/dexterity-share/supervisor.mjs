// Dexterity Share supervisor — (c) Dexterity Design Services Private Limited. Internal software.
// Keeps the share server and the Cloudflare tunnel running, learns the public address, checks the
// service from the outside every minute, and publishes the address where the client page looks
// for it (a signed pointer file on GitHub, plus a heartbeat file in the store for Hopper).
// No dependencies (Node 20+).   node supervisor.mjs [--check]
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs, { promises as fsp } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Log, loadConfig, createShareServer } from './server.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit tested)

/** The address a quick tunnel prints, e.g. "|  https://calm-river-12ab.trycloudflare.com  |". */
export function parseQuickUrl(line) {
  const m = /https:\/\/(?!api\.)([a-z0-9]+(?:-[a-z0-9]+)*)\.trycloudflare\.com(?![a-z0-9.-])/i.exec(String(line))
  return m ? m[0].toLowerCase() : null
}

export function normalizeBase(base) {
  try {
    const u = new URL(String(base))
    if (u.protocol !== 'https:' || u.username || u.password) return null
    return u.origin
  } catch {
    return null
  }
}

const pointerMessage = (base, updated) => Buffer.from(`dxshare-pointer-v1\n${base}\n${updated}`)

/** Short fingerprint of the pointer's public key; it travels inside every client link. */
export function keyHash(jwk) {
  return crypto.createHash('sha256').update(`${jwk.x}.${jwk.y}`).digest('hex').slice(0, 20)
}

/**
 * {v, base, updated, sig[, key]}: signed with the server's private key so a stolen GitHub token alone
 * cannot redirect clients. With `publicJwk` the pointer carries its own public key; the page accepts
 * it only if the key's fingerprint matches the one in the client's link.
 */
export function buildPointer(base, privateKey, updated = new Date().toISOString(), publicJwk = null) {
  const p = publicJwk ? { v: 2, base, updated, key: publicJwk } : { v: 1, base, updated }
  if (privateKey) p.sig = crypto.sign('sha256', pointerMessage(base, updated), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  return p
}

export function verifyPointer(p, publicKey) {
  try {
    return crypto.verify('sha256', pointerMessage(p.base, p.updated), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(p.sig, 'base64url'))
  } catch {
    return false
  }
}

/** Load (or create on first run) the P-256 key that signs the pointer; returns the key and its public JWK. */
export function loadPointerKey(stateDir) {
  const file = path.join(stateDir, 'pointer-key.pem')
  let privateKey
  if (fs.existsSync(file)) privateKey = crypto.createPrivateKey(fs.readFileSync(file, 'utf8'))
  else {
    privateKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  }
  const { kty, crv, x, y } = crypto.createPublicKey(privateKey).export({ format: 'jwk' })
  const publicJwk = { kty, crv, x, y }
  fs.writeFileSync(path.join(stateDir, 'pointer-public.json'), JSON.stringify(publicJwk, null, 2))
  return { privateKey, publicJwk }
}

/**
 * Write the pointer file through GitHub's contents API. The token is a fine-grained one limited to
 * the pointer repository ("Contents: read and write"). Returns 'unchanged' or 'published'.
 */
export async function publishPointer({ api = 'https://api.github.com', repo, branch = 'main', file = 'pointer.json', token, pointer, fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('pointer.github.repo must look like "owner/name"')
  const url = `${api}/repos/${repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}`
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'dexterity-share', 'Content-Type': 'application/json' }
  let last = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await fetchImpl(`${url}?ref=${encodeURIComponent(branch)}`, { headers, signal: AbortSignal.timeout(20000) })
    let sha
    if (cur.status === 200) {
      const j = await cur.json()
      sha = j.sha
      try {
        if (JSON.parse(Buffer.from(j.content ?? '', 'base64').toString('utf8')).base === pointer.base) return 'unchanged'
      } catch {}
    } else if (cur.status !== 404) throw new Error(`GitHub answered ${cur.status} reading the pointer${cur.status === 401 || cur.status === 403 ? ' (check the token and its repository access)' : ''}`)
    const put = await fetchImpl(url, {
      method: 'PUT',
      headers,
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ message: 'Update share address', content: Buffer.from(JSON.stringify(pointer, null, 2) + '\n').toString('base64'), branch, ...(sha ? { sha } : {}) })
    })
    if (put.status === 200 || put.status === 201) return 'published'
    last = `GitHub answered ${put.status} writing the pointer`
    if (put.status !== 409 && put.status !== 422) throw new Error(last + (put.status === 401 || put.status === 403 || put.status === 404 ? ' (check the token: it needs "Contents: read and write" on the pointer repository)' : ''))
    await sleep(500 * (attempt + 1)) // someone else wrote in between: read the new sha and try again
  }
  throw new Error(last)
}

const GH_HEADERS = (token) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'dexterity-share', 'Content-Type': 'application/json' })
export const GIST_FILE = 'pointer.json'

/**
 * Who does this token belong to, and may it edit gists? Classic tokens list their scopes; a token
 * with more than "gist" works but is more than this job needs, so that is reported too.
 */
export async function checkGistToken({ api = 'https://api.github.com', token, fetchImpl = fetch }) {
  if (!token || /\s/.test(token)) throw new Error('That does not look like a token. Paste the whole token, with no spaces.')
  let r
  try {
    r = await fetchImpl(`${api}/user`, { headers: GH_HEADERS(token), signal: AbortSignal.timeout(20000) })
  } catch {
    throw new Error('GitHub could not be reached. Check this PC\'s internet connection and try again.')
  }
  if (r.status === 401) throw new Error('GitHub does not accept this token. It may be mistyped, expired or deleted: create a new one and paste it again.')
  if (!r.ok) throw new Error(`GitHub answered ${r.status}. Try again in a minute.`)
  const login = (await r.json()).login
  const header = r.headers.get('x-oauth-scopes')
  const scopes = header == null ? null : header.split(',').map((x) => x.trim()).filter(Boolean)
  if (scopes && !scopes.includes('gist')) throw new Error('This token is not allowed to edit gists. Create a new token with only the "gist" box ticked.')
  return { login, scopes, extra: scopes ? scopes.filter((x) => x !== 'gist') : [] }
}

/** Create the (unlisted) gist that will hold the pointer. Returns its id. */
export async function createPointerGist({ api = 'https://api.github.com', token, pointer, fetchImpl = fetch }) {
  const r = await fetchImpl(`${api}/gists`, {
    method: 'POST',
    headers: GH_HEADERS(token),
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ description: 'Dexterity Share: current address of the office share server (written by Hopper; do not edit)', public: false, files: { [GIST_FILE]: { content: JSON.stringify(pointer, null, 2) + '\n' } } })
  })
  if (r.status === 403 || r.status === 404) throw new Error('This token is not allowed to create gists. Create a new token with only the "gist" box ticked.')
  if (r.status !== 201) throw new Error(`GitHub answered ${r.status} when creating the gist. Try again in a minute.`)
  const id = (await r.json()).id
  if (!/^[0-9a-f]{20,40}$/.test(id ?? '')) throw new Error('GitHub returned an unexpected gist id.')
  return id
}

/** Write the pointer into the gist. Returns 'unchanged' or 'published'. */
export async function publishGistPointer({ api = 'https://api.github.com', gistId, token, pointer, fetchImpl = fetch }) {
  if (!/^[0-9a-f]{20,40}$/.test(gistId ?? '')) throw new Error('The pointer gist id is not valid')
  const url = `${api}/gists/${gistId}`
  const cur = await fetchImpl(url, { headers: GH_HEADERS(token), signal: AbortSignal.timeout(20000) })
  if (cur.status === 404) throw new Error('The pointer gist no longer exists (or this token cannot see it). Run the Dexterity Share setup again.')
  if (cur.status === 401) throw new Error('GitHub no longer accepts the saved token. Paste a new one in the Dexterity Share setup.')
  if (!cur.ok) throw new Error(`GitHub answered ${cur.status} reading the pointer`)
  try {
    const old = JSON.parse((await cur.json()).files?.[GIST_FILE]?.content ?? 'null')
    if (old && old.base === pointer.base && JSON.stringify(old.key ?? null) === JSON.stringify(pointer.key ?? null)) return 'unchanged'
  } catch {}
  const r = await fetchImpl(url, { method: 'PATCH', headers: GH_HEADERS(token), signal: AbortSignal.timeout(20000), body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(pointer, null, 2) + '\n' } } }) })
  if (r.status === 403 || r.status === 404) throw new Error('The saved token may not edit the pointer gist. It must belong to the account that owns the gist and have the "gist" permission.')
  if (!r.ok) throw new Error(`GitHub answered ${r.status} writing the pointer`)
  return 'published'
}

export function loadSupervisorConfig(file, env = process.env) {
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {}
  const server = loadConfig(file, env)
  const dir = path.dirname(path.resolve(file))
  const t = raw.tunnel ?? {}
  const mode = t.mode ?? 'quick'
  if (!['quick', 'named', 'external'].includes(mode)) throw new Error('config: tunnel.mode must be "quick", "named" or "external"')
  const tunnel = {
    mode,
    cloudflared: t.cloudflared || (process.platform === 'win32' ? 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe' : 'cloudflared'),
    command: Array.isArray(t.command) ? t.command : null,
    tokenFile: t.tokenFile ? path.resolve(dir, t.tokenFile) : '',
    publicBase: t.publicBase ? normalizeBase(t.publicBase) : null,
    protocol: t.protocol ?? '',
    publicCheck: t.publicCheck !== false,
    checkSeconds: t.checkSeconds ?? 60,
    verifySeconds: t.verifySeconds ?? 120
  }
  if (mode !== 'quick' && !tunnel.publicBase) throw new Error(`config: tunnel.publicBase (https://...) is required when tunnel.mode is "${mode}"`)
  if (mode === 'named' && !tunnel.tokenFile && !env.TUNNEL_TOKEN) throw new Error('config: tunnel.tokenFile is required when tunnel.mode is "named"')
  const g = raw.pointer?.github
  const pointer = g?.repo
    ? { api: g.api || 'https://api.github.com', repo: g.repo, branch: g.branch || 'main', file: g.path || 'pointer.json', tokenFile: path.resolve(dir, g.tokenFile || 'pointer-token.txt') }
    : raw.pointer?.gist?.id
      ? { kind: 'gist', api: raw.pointer.gist.api || 'https://api.github.com', gistId: raw.pointer.gist.id, tokenFile: path.resolve(dir, raw.pointer.gist.tokenFile || 'pointer-token.txt') }
      : null
  return { file: path.resolve(file), server, tunnel, pointer }
}

function processName(pid) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
      const m = /^"([^"]+)"/.exec(r.stdout ?? '')
      return m ? m[1].toLowerCase() : ''
    }
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim().toLowerCase()
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------------------------

export class Supervisor {
  constructor(cfg, deps = {}) {
    this.cfg = cfg
    this.fetch = deps.fetch ?? ((...a) => fetch(...a))
    this.log = deps.log ?? new Log(cfg.server.logDir, 'supervisor')
    this.echo = deps.echo ?? (() => {})
    this.base = cfg.tunnel.mode === 'quick' ? null : cfg.tunnel.publicBase
    this.verified = false
    this.instance = null
    this.server = null
    this.tunnel = null
    this.stopping = false
    this.fails = 0
    this.pointerDirty = false
    this.pointerKey = null
    this.timer = null
    this.backoff = { server: 1000, tunnel: 2000 }
    this.events = [] // for tests and --check
    this.app = null
    this.health = null
    this.serverLog = deps.serverLog
    this.serverError = ''
    this.getToken = deps.getToken ?? null
    this.onChange = deps.onChange ?? (() => {})
    this.baseSince = 0
    this.pointerError = ''
    this.tunnelError = ''
  }

  note(event, data = {}) {
    this.events.push({ event, ...data })
    if (this.events.length > 500) this.events.shift()
    this.log.info(event, data)
    try {
      this.onChange(event, data)
    } catch {}
    this.echo(`${event}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}`)
  }

  local(p) {
    return `http://127.0.0.1:${this.cfg.server.port}${p}`
  }

  // ---- share server ---------------------------------------------------------
  startServer() {
    if (this.stopping) return
    if (this.cfg.inProcess) {
      // Hopper hosts the server inside its own share process: no second program to start.
      const app = createShareServer(this.cfg.server, { log: this.serverLog })
      app.listen().then(
        () => {
          this.app = app
          this.note('server-listening', { port: this.cfg.server.port })
        },
        (e) => {
          this.serverError = e.code === 'EADDRINUSE' ? `Port ${this.cfg.server.port} is already in use on this PC` : String(e.message)
          this.note('server-start-failed', { message: this.serverError })
          if (!this.stopping) setTimeout(() => this.startServer(), 15000).unref?.()
        }
      )
      return
    }
    const started = Date.now()
    const child = spawn(process.execPath, ['--no-warnings', path.join(HERE, 'server.mjs')], {
      env: { ...process.env, DXSHARE_CONFIG: this.cfg.file, DXSHARE_PARENT_PID: String(process.pid) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true
    })
    this.server = child
    const out = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => this.note('server-out', { line: l.slice(0, 300) }))
    child.stdout.on('data', out)
    child.stderr.on('data', out)
    child.on('message', (m) => m?.type === 'health' && (this.health = m.health))
    child.on('error', (e) => this.note('server-spawn-failed', { message: e.message }))
    child.on('exit', (code) => {
      if (this.server === child) this.server = null
      this.instance = null
      if (this.stopping) return
      // a config mistake (exit 2) will not fix itself: retry slowly and say so
      const wait = code === 2 ? 30000 : Date.now() - started > 60000 ? 1000 : this.backoff.server
      this.backoff.server = Date.now() - started > 60000 ? 1000 : Math.min(this.backoff.server * 2, 30000)
      this.note('server-exited', { code, restartInMs: wait })
      setTimeout(() => this.startServer(), wait).unref?.()
    })
  }

  async localHealth() {
    try {
      const r = await this.fetch(this.local('/healthz'), { signal: AbortSignal.timeout(4000) })
      const j = await r.json()
      if (j?.i) this.instance = j.i
      return r.ok && j.ok === true
    } catch {
      return false
    }
  }

  /** Is our own server answering at the public address? (The instance id proves it is ours.) */
  async publicHealth(base = this.base) {
    if (!base) return false
    try {
      const r = await this.fetch(`${base}/healthz`, { signal: AbortSignal.timeout(10000), redirect: 'error', cache: 'no-store' })
      const j = await r.json()
      return r.ok && j?.ok === true && (!this.instance || j.i === this.instance)
    } catch {
      return false
    }
  }

  // ---- tunnel ---------------------------------------------------------------
  killStaleTunnel() {
    // After a hard stop of the supervisor an old cloudflared may still be running: end it, but only
    // if the remembered process id really is a cloudflared.
    const pidFile = path.join(this.cfg.server.stateDir, 'cloudflared.pid')
    try {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'))
      if (pid > 0 && /cloudflared/.test(processName(pid))) {
        process.kill(pid)
        this.note('stale-tunnel-stopped', { pid })
      }
    } catch {}
    fs.rmSync(pidFile, { force: true })
  }

  startTunnel() {
    const t = this.cfg.tunnel
    if (this.stopping || t.mode === 'external') return
    const started = Date.now()
    const [exe, ...prefix] = t.command ?? [t.cloudflared]
    const proto = t.protocol ? ['--protocol', t.protocol] : []
    const args = t.mode === 'quick' ? ['tunnel', '--no-autoupdate', ...proto, '--url', `http://127.0.0.1:${this.cfg.server.port}`] : ['tunnel', '--no-autoupdate', ...proto, 'run']
    const env = { ...process.env }
    if (t.mode === 'named' && t.token) env.TUNNEL_TOKEN = t.token // handed over in memory by Hopper
    else if (t.mode === 'named' && t.tokenFile) {
      // passed in the environment, not on the command line, so it never shows in the process list
      try {
        env.TUNNEL_TOKEN = fs.readFileSync(t.tokenFile, 'utf8').trim()
      } catch (e) {
        this.note('tunnel-token-unreadable', { code: e.code })
        setTimeout(() => this.startTunnel(), 60000).unref?.()
        return
      }
    }
    let child
    try {
      child = spawn(exe, [...prefix, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      this.note('tunnel-spawn-failed', { message: e.message })
      setTimeout(() => this.startTunnel(), 60000).unref?.()
      return
    }
    this.tunnel = child
    this.note('tunnel-starting', { mode: t.mode })
    if (child.pid) fsp.writeFile(path.join(this.cfg.server.stateDir, 'cloudflared.pid'), String(child.pid)).catch(() => {})
    let buf = ''
    const onData = (d) => {
      buf += String(d)
      const lines = buf.split(/\r?\n/)
      buf = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        if (/\b(ERR|WRN)\b|error/i.test(line)) this.log.warn('tunnel-out', { line: line.slice(0, 400) })
        if (t.mode === 'quick') {
          const url = parseQuickUrl(line)
          if (url && url !== this.base) void this.onBase(url, child)
        }
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (e) => {
      this.tunnelError = e.code === 'ENOENT' ? `cloudflared not found at ${exe}` : e.message
      this.note('tunnel-spawn-failed', { message: this.tunnelError })
    })
    child.on('close', (code) => {
      if (this.tunnel !== child) return
      this.tunnel = null
      if (t.mode === 'quick') {
        this.base = null
        this.verified = false
      }
      if (this.stopping) return
      const lived = Date.now() - started
      const wait = lived > 120000 ? 2000 : this.backoff.tunnel
      // creating quick tunnels too fast gets refused; back off up to five minutes
      this.backoff.tunnel = lived > 120000 ? 2000 : Math.min(this.backoff.tunnel * 2, 300000)
      this.note('tunnel-exited', { code, restartInMs: wait })
      void this.heartbeat()
      setTimeout(() => this.startTunnel(), wait).unref?.()
    })
    if (t.mode === 'named') void this.onBase(t.publicBase, child)
  }

  restartTunnel(why) {
    this.note('tunnel-restart', { why })
    this.fails = 0
    const child = this.tunnel
    if (child) child.kill()
    else this.startTunnel()
  }

  /** A (new) public address: wait until it really serves our server, then tell the world. */
  async onBase(base, child) {
    this.base = base
    this.verified = false
    this.note('public-address', { base })
    const t = this.cfg.tunnel
    if (t.publicCheck) {
      const deadline = Date.now() + t.verifySeconds * 1000
      let ok = false
      while (!this.stopping && this.tunnel === child && this.base === base && Date.now() < deadline) {
        if ((await this.localHealth()) && (await this.publicHealth(base))) {
          ok = true
          break
        }
        await sleep(Math.min(3000, t.verifySeconds * 100))
      }
      if (this.stopping || this.base !== base || (child && this.tunnel !== child)) return
      if (!ok) {
        this.note('public-address-not-reachable', { base })
        if (t.mode !== 'external') this.restartTunnel('address never became reachable')
        return
      }
    }
    this.verified = true
    this.fails = 0
    this.baseSince = Date.now()
    this.tunnelError = ''
    this.note('public-address-verified', { base })
    this.pointerDirty = true
    await this.syncPointer()
    await this.heartbeat()
  }

  // ---- telling the page and Hopper where the server is ------------------------
  async syncPointer() {
    const p = this.cfg.pointer
    if (!p || !this.pointerDirty || !this.base || !this.verified) return
    let token
    try {
      token = this.getToken ? await this.getToken() : fs.readFileSync(p.tokenFile, 'utf8').trim()
      if (!token) throw new Error('empty')
    } catch {
      this.pointerError = 'No GitHub token is saved for the pointer'
      this.note('pointer-token-missing', {})
      return
    }
    try {
      this.pointerKey ??= loadPointerKey(this.cfg.server.stateDir)
      let r
      if (p.kind === 'gist') {
        const pointer = buildPointer(this.base, this.pointerKey.privateKey, undefined, this.pointerKey.publicJwk)
        r = await publishGistPointer({ api: p.api, gistId: p.gistId, token, pointer, fetchImpl: this.fetch })
      } else {
        const pointer = buildPointer(this.base, this.pointerKey.privateKey)
        r = await publishPointer({ ...p, token, pointer, fetchImpl: this.fetch })
      }
      this.pointerDirty = false
      this.pointerError = ''
      this.note('pointer-' + r, { base: this.base })
    } catch (e) {
      // stays dirty: the next check tries again
      this.pointerError = String(e.message).split(token).join('***')
      this.note('pointer-failed', { message: this.pointerError })
    }
  }

  /** _server.json in the store: Hopper reads it over the office network to show "server online". */
  async heartbeat(extra = {}) {
    const file = path.join(this.cfg.server.store, '_server.json')
    const health = this.app ? this.app.health() : this.health
    const body = JSON.stringify({ v: 1, base: this.verified ? this.base : null, mode: this.cfg.tunnel.mode, healthy: this.verified && this.fails === 0, updated: Date.now(), baseSince: this.verified ? this.baseSince : null, host: this.cfg.hostName ?? null, ...(health ?? {}), ...extra })
    try {
      await fsp.writeFile(file + '.tmp', body)
      await fsp.rename(file + '.tmp', file)
    } catch (e) {
      this.log.warn('heartbeat-failed', { code: e.code })
    }
  }

  async tick() {
    if (this.stopping) return
    const local = await this.localHealth()
    if (!local) this.note('server-not-answering')
    if (this.base && this.verified && this.cfg.tunnel.publicCheck) {
      if (local && (await this.publicHealth())) this.fails = 0
      else if (local) {
        this.fails++
        this.note('public-check-failed', { fails: this.fails })
        if (this.fails >= 3 && this.cfg.tunnel.mode !== 'external') this.restartTunnel('public address stopped answering')
      }
    }
    await this.syncPointer()
    await this.heartbeat()
  }

  async start() {
    fs.mkdirSync(this.cfg.server.stateDir, { recursive: true })
    this.note('supervisor-start', { mode: this.cfg.tunnel.mode, port: this.cfg.server.port, pointer: this.cfg.pointer ? this.cfg.pointer.repo : null })
    this.killStaleTunnel()
    this.startServer()
    for (let i = 0; i < 60 && !this.stopping && !(await this.localHealth()); i++) await sleep(500)
    if (this.cfg.tunnel.mode === 'external') void this.onBase(this.cfg.tunnel.publicBase, null)
    else this.startTunnel()
    this.timer = setInterval(() => void this.tick(), this.cfg.tunnel.checkSeconds * 1000)
  }

  async stop() {
    if (this.stopping) return
    this.stopping = true
    clearInterval(this.timer)
    this.note('supervisor-stop')
    const t = this.tunnel
    if (t) {
      const gone = new Promise((r) => t.once('close', r))
      t.kill()
      await Promise.race([gone, sleep(5000)])
      fs.rmSync(path.join(this.cfg.server.stateDir, 'cloudflared.pid'), { force: true })
    }
    if (this.app) {
      await this.app.close().catch(() => {})
      this.app = null
    }
    const s = this.server
    if (s) {
      const gone = new Promise((r) => s.once('exit', r))
      try {
        s.send('shutdown') // lets running downloads finish (up to the server's grace period)
      } catch {
        s.kill()
      }
      if ((await Promise.race([gone, sleep(20000).then(() => 'late')])) === 'late') s.kill()
    }
    this.verified = false
    await this.heartbeat({ stopped: true })
  }
}

// ---------------------------------------------------------------------------------------------

async function check(cfg) {
  const lines = []
  let bad = 0
  const say = (ok, text) => {
    lines.push(`${ok ? '  ok  ' : ' FAIL '} ${text}`)
    if (!ok) bad++
  }
  say(Number(process.versions.node.split('.')[0]) >= 20, `Node ${process.versions.node} (20 or newer needed)`)
  const st = await fsp.stat(cfg.server.store).catch(() => null)
  say(!!st?.isDirectory(), `store folder ${cfg.server.store}`)
  if (st?.isDirectory()) {
    const probe = path.join(cfg.server.store, `_probe-${process.pid}.tmp`)
    const w = await fsp.writeFile(probe, 'x').then(() => fsp.rm(probe)).then(() => true, () => false)
    say(w, 'store folder is writable by this account (needed for statistics and clean-up)')
  }
  const free = await new Promise((r) => {
    const s = net.createServer().once('error', () => r(false)).listen(cfg.server.port, '127.0.0.1', () => s.close(() => r(true)))
  })
  say(free, `port ${cfg.server.port} on 127.0.0.1 is free (FAIL is expected while the service is running)`)
  if (cfg.tunnel.mode !== 'external') {
    const [exe, ...prefix] = cfg.tunnel.command ?? [cfg.tunnel.cloudflared]
    const v = spawnSync(exe, [...prefix, '--version'], { encoding: 'utf8', windowsHide: true })
    say(v.status === 0, `cloudflared: ${v.status === 0 ? v.stdout.trim().split('\n')[0] : `not runnable at ${exe}`}`)
  }
  if (cfg.tunnel.mode === 'named') say(fs.existsSync(cfg.tunnel.tokenFile), `tunnel token file ${cfg.tunnel.tokenFile}`)
  if (cfg.tunnel.mode !== 'quick') say(true, `public address ${cfg.tunnel.publicBase}`)
  if (cfg.pointer) {
    say(fs.existsSync(cfg.pointer.tokenFile), `pointer token file ${cfg.pointer.tokenFile}`)
    const { publicJwk } = loadPointerKey(cfg.server.stateDir)
    lines.push(`       pointer public key for site/share/config.json ("pointerKey"): ${JSON.stringify(publicJwk)}`)
  } else if (cfg.tunnel.mode === 'quick') say(false, 'tunnel.mode is "quick" but no pointer.github is configured: client links cannot find the server')
  lines.push(`       allowed page origins: ${cfg.server.allowedOrigins.join(', ') || '(none)'}`)
  console.log(lines.join('\n'))
  return bad
}

async function main() {
  const file = process.env.DXSHARE_CONFIG || path.join(HERE, 'config.json')
  let cfg
  try {
    cfg = loadSupervisorConfig(file)
  } catch (e) {
    console.error(`Dexterity Share: ${e.message} (${file})`)
    process.exit(2)
  }
  if (process.argv.includes('--check')) process.exit((await check(cfg)) ? 1 : 0)
  const sup = new Supervisor(cfg, { echo: (l) => console.log(`${new Date().toISOString()} ${l}`) })
  const stop = async () => {
    await sup.stop()
    process.exit(0)
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => void stop())
  process.on('uncaughtException', (e) => sup.note('uncaught', { message: String(e?.message ?? e) }))
  process.on('unhandledRejection', (e) => sup.note('unhandled', { message: String(e?.message ?? e) }))
  await sup.start()
}

function isMain() {
  try {
    if (path.basename(process.argv[1] ?? '') !== 'supervisor.mjs') return false // bundled into Hopper: never self-start
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}
if (isMain()) void main()
