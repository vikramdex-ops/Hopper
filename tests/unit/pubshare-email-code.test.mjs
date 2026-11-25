// Dexterity Share: links for named e-mail addresses (one-time codes), and the SMTP client.
import { TEST_WORK } from './pubshare-hooks.mjs'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as S from '../../server/dexterity-share/server.mjs'

const id = () => S.encodeId(crypto.randomBytes(16))
const ROOT = path.join(TEST_WORK, 'email-code')

function req(port, p, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    r.on('error', reject)
    r.end(body ? JSON.stringify(body) : undefined)
  })
}

function writeShare(store, sid, extra = {}) {
  const dir = path.join(store, sid)
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true })
  const body = 'hello drawings'
  fs.writeFileSync(path.join(dir, 'data', '0'), body)
  const now = Date.now()
  const m = { v: 1, id: sid, title: 'Lot 07', message: '', sender: 'Vikram', createdAt: now, expiresAt: now + 86400000, files: [{ name: 'lot.zip', size: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') }], password: extra.password ?? null, maxDownloads: 0, owner: { user: os.userInfo().username, host: os.hostname() } }
  if (extra.recipients) m.recipients = extra.recipients
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m))
  return dir
}

async function start(opts = {}) {
  const store = path.join(ROOT, `store-${process.pid}-${crypto.randomBytes(3).toString('hex')}`)
  const state = store + '-state'
  fs.mkdirSync(store, { recursive: true })
  const sent = []
  let clock = Date.now()
  const hooks = {
    log: { info() {}, warn() {}, error() {} },
    now: () => clock,
    ...(opts.noMail ? {} : { sendMail: opts.sendMail ?? (async (msg) => void sent.push(msg)) })
  }
  const app = S.createShareServer({ port: 0, store, stateDir: state, logDir: '', allowedOrigins: ['https://page.example'], ...opts.cfg }, hooks)
  const port = await app.listen()
  after(async () => {
    await app.close(0)
    fs.rmSync(store, { recursive: true, force: true })
    fs.rmSync(state, { recursive: true, force: true })
  })
  const codeOf = (msg) => /(\d{3}) (\d{3})/.exec(msg.text).slice(1).join('')
  return { app, port, store, sent, codeOf, tick: (ms) => (clock += ms) }
}

test('addresses: normalise, compare, mask, validate a list', () => {
  assert.equal(S.normEmail('  John.Doe@Client.COM '), 'john.doe@client.com')
  for (const bad of ['', 'a', 'a@b', '@b.com', 'a@b..com', 'a..b@c.com', 'a b@c.com', 'a@b.com\r\nBcc: x@y.com', 'x'.repeat(65) + '@a.com', 'a@-b.com']) assert.equal(S.normEmail(bad), '', JSON.stringify(bad))
  assert.equal(S.emailKey('J.O.H.N+lot7@GoogleMail.com'), S.emailKey('john@gmail.com'))
  assert.equal(S.emailKey('john+x@client.com'), 'john@client.com')
  assert.notEqual(S.emailKey('j.ohn@client.com'), S.emailKey('john@client.com'), 'dots matter outside Gmail')
  assert.equal(S.maskEmail('john@client.com'), 'jo•••@client.com')
  assert.equal(S.maskEmail('ab@x.io'), 'a•••@x.io')
  assert.deepEqual(S.validRecipients(['a@b.com', 'c@d.com']), ['a@b.com', 'c@d.com'])
  assert.equal(S.validRecipients([]), null)
  assert.equal(S.validRecipients(['A@b.com']), null, 'must be stored normalised')
  assert.equal(S.validRecipients(['a@b.com', 'a+x@b.com']), null, 'no duplicates')
  assert.equal(S.validRecipients(Array.from({ length: 11 }, (_, i) => `u${i}@b.com`)), null)
})

test('manifest: recipients validated, never together with a password', async () => {
  const sid = id()
  const base = { v: 1, id: sid, title: 'T', createdAt: 1, expiresAt: 2, files: [{ name: 'a', size: 1, sha256: 'a'.repeat(64) }], password: null, maxDownloads: 0 }
  assert.ok(S.validateManifest({ ...base, recipients: ['a@b.com'] }, sid))
  assert.equal(S.validateManifest({ ...base, recipients: ['not an address'] }, sid), null)
  assert.equal(S.validateManifest({ ...base, recipients: ['a@b.com'], password: await S.hashPassword('secret1', { N: 1024 }) }, sid), null)
})

test('mailSettings: refuses what cannot work or would leak the password', () => {
  assert.equal(S.mailSettings(null), null)
  assert.equal(S.mailSettings({ host: 'smtp.x.com' }), null, 'needs a sender address')
  assert.equal(S.mailSettings({ host: 'smtp.x.com', from: 'a@x.com', secure: 'none' }), null, 'plain text off this PC')
  const m = S.mailSettings({ host: 'smtp.x.com', user: 'share@x.com', secure: 'tls' })
  assert.equal(m.port, 465)
  assert.equal(m.from, 'share@x.com')
  assert.equal(S.mailSettings({ host: 'smtp.x.com', from: 'a@x.com' }).port, 587)
})

test('the named recipient gets a code and downloads; nobody else can', async () => {
  const { port, store, sent, codeOf } = await start()
  const sid = id()
  writeShare(store, sid, { recipients: ['john.doe@client.com', 'pm@client.com'] })

  // the page sees a locked link for named people, and no file names or addresses
  const meta = await req(port, `/api/s/${sid}`)
  assert.equal(meta.status, 200)
  assert.equal(meta.json.needsEmail, true)
  assert.equal(meta.json.mailReady, true)
  assert.equal(meta.json.unlocked, false)
  assert.equal(meta.json.files, null)
  assert.ok(!meta.text.includes('client.com'))
  assert.equal((await req(port, `/d/${sid}/0`)).status, 401)
  assert.equal((await req(port, `/d/${sid}/0`, { headers: { Accept: 'text/html' } })).text.includes('named person'), true)

  // someone else: a clean refusal, no mail sent
  const other = await req(port, `/api/s/${sid}/code`, { method: 'POST', body: { email: 'intruder@else.com' } })
  assert.equal(other.status, 403)
  assert.equal(other.json.error, 'not_recipient')
  assert.equal(other.json.sender, 'Vikram')
  assert.equal(sent.length, 0)

  // the recipient, typed differently: the code goes to the address the sender entered
  const ok = await req(port, `/api/s/${sid}/code`, { method: 'POST', body: { email: '  John.Doe+x@CLIENT.com ' } })
  assert.equal(ok.status, 200, ok.text)
  assert.equal(ok.json.to, 'jo•••@client.com')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].to, 'john.doe@client.com')
  assert.match(sent[0].subject, /^\d{6} is your code for Lot 07$/)
  const code = codeOf(sent[0])

  // a wrong code, then a code for the other recipient's address: both refused
  const wrong = await req(port, `/api/s/${sid}/verify`, { method: 'POST', body: { email: 'john.doe@client.com', code: code === '000000' ? '111111' : '000000' } })
  assert.equal(wrong.status, 403)
  assert.equal(wrong.json.error, 'wrong_code')
  assert.equal(wrong.json.attemptsLeft, 4)
  const cross = await req(port, `/api/s/${sid}/verify`, { method: 'POST', body: { email: 'pm@client.com', code } })
  assert.equal(cross.status, 409, 'no code was sent to that address')

  // the right code, with spaces as read from the e-mail
  const v = await req(port, `/api/s/${sid}/verify`, { method: 'POST', body: { email: 'john.doe@client.com', code: `${code.slice(0, 3)} ${code.slice(3)}` } })
  assert.equal(v.status, 200, v.text)
  assert.match(v.json.token, /^r0\./)
  assert.equal(v.json.files.length, 1)
  assert.equal(v.json.verifiedAs, 'jo•••@client.com')
  const t = encodeURIComponent(v.json.token)
  const meta2 = await req(port, `/api/s/${sid}?t=${t}`)
  assert.equal(meta2.json.unlocked, true)
  assert.equal(meta2.json.verifiedAs, 'jo•••@client.com')
  const dl = await req(port, `/d/${sid}/0?t=${t}`)
  assert.equal(dl.status, 200)
  assert.equal(dl.text, 'hello drawings')

  // once only
  const again = await req(port, `/api/s/${sid}/verify`, { method: 'POST', body: { email: 'john.doe@client.com', code } })
  assert.equal(again.json.error, 'code_expired')

  // a token cannot be moved to the other recipient, or used with a password-style token
  const moved = v.json.token.replace(/^r0\./, 'r1.')
  assert.equal((await req(port, `/d/${sid}/0?t=${encodeURIComponent(moved)}`)).status, 401)
  assert.equal((await req(port, `/d/${sid}/0?t=${encodeURIComponent(v.json.token.slice(3))}`)).status, 401)
  assert.equal((await req(port, `/d/${sid}/0?t=${encodeURIComponent('r9.' + v.json.token.slice(3))}`)).status, 401)

  // who downloaded, for the sender
  await new Promise((r) => setTimeout(r, 50))
})

test('codes: expiry, tries, resend wait, hourly limit, failed mail', async () => {
  let fail = false
  const sent = []
  const env = await start({ sendMail: async (msg) => {
    if (fail) throw Object.assign(new Error('535 auth failed'), { code: 'ESMTP' })
    sent.push(msg)
  } })
  const { port, store, codeOf, tick } = env
  const sid = id()
  writeShare(store, sid, { recipients: ['a@client.com'] })
  const ask = () => req(port, `/api/s/${sid}/code`, { method: 'POST', body: { email: 'a@client.com' } })
  const verify = (code) => req(port, `/api/s/${sid}/verify`, { method: 'POST', body: { email: 'a@client.com', code } })

  assert.equal((await ask()).status, 200)
  const first = codeOf(sent[0])
  // too soon for another: the page is told to use the one sent
  const soon = await ask()
  assert.equal(soon.status, 429)
  assert.equal(soon.json.error, 'code_wait')
  assert.equal(soon.json.pending, true)
  assert.ok(soon.json.retryAfter > 0 && soon.json.retryAfter <= 60)
  assert.equal(sent.length, 1)

  // expired after 10 minutes
  tick(10 * 60_000 + 1)
  assert.equal((await verify(first)).json.error, 'code_expired')

  // a new code replaces the old one
  assert.equal((await ask()).status, 200)
  const second = codeOf(sent[1])
  tick(61_000)
  assert.equal((await ask()).status, 200)
  const third = codeOf(sent[2])
  if (second !== third) assert.equal((await verify(second)).status, 403, 'old code no longer works')

  // five wrong guesses use the code up
  const bad = third === '999999' ? '888888' : '999999'
  for (let i = second !== third ? 1 : 0; i < 4; i++) assert.equal((await verify(bad)).json.error, 'wrong_code')
  assert.equal((await verify(bad)).json.error, 'code_used_up')
  assert.equal((await verify(third)).json.error, 'code_expired')

  // a failed send: clean error, and the next try is not made to wait
  tick(61_000)
  fail = true
  const f = await ask()
  assert.equal(f.status, 502)
  assert.equal(f.json.error, 'mail_failed')
  fail = false
  const after1 = await ask()
  assert.equal(after1.status, 200, 'a failed send does not start the resend wait')

  // at most five codes an hour for one address (four sent so far)
  tick(61_000)
  assert.equal((await ask()).status, 200)
  tick(61_000)
  const lim = await ask()
  assert.equal(lim.status, 429)
  assert.equal(lim.json.error, 'code_limit')
  tick(60 * 60_000)
  assert.equal((await ask()).status, 200)
})

test('wrong addresses are limited per client, and never lock out the recipient', async () => {
  const { port, store, sent } = await start()
  const sid = id()
  writeShare(store, sid, { recipients: ['real@client.com'] })
  const ask = (email) => req(port, `/api/s/${sid}/code`, { method: 'POST', body: { email } })
  for (let i = 0; i < 6; i++) assert.equal((await ask(`guess${i}@client.com`)).json.error, 'not_recipient')
  const blocked = await ask('guess9@client.com')
  assert.equal(blocked.status, 429)
  // over its limit, this client learns nothing more, not even about the real address
  assert.equal((await ask('real@client.com')).status, 429)
  assert.equal(sent.length, 0)
  assert.equal((await ask('not an address')).json?.error ?? 'bad_email', 'bad_email')
})

test('no mail server: the page is told, and the browser page cannot make such links', async () => {
  const { port, store, app } = await start({ noMail: true })
  const sid = id()
  writeShare(store, sid, { recipients: ['a@client.com'] })
  const meta = await req(port, `/api/s/${sid}`)
  assert.equal(meta.json.mailReady, false)
  const r = await req(port, `/api/s/${sid}/code`, { method: 'POST', body: { email: 'a@client.com' } })
  assert.equal(r.status, 503)
  assert.equal(r.json.error, 'mail_unavailable')
  assert.equal(app.health().mail, false)
  await assert.rejects(app.testMail('a@client.com'), /not set up/)
})

test('password links and open links are unchanged; the code calls refuse them', async () => {
  const { port, store } = await start({ noMail: true })
  const open = id()
  writeShare(store, open)
  assert.equal((await req(port, `/d/${open}/0`)).status, 200)
  const r = await req(port, `/api/s/${open}/code`, { method: 'POST', body: { email: 'a@client.com' } })
  assert.equal(r.status, 400)
  const meta = await req(port, `/api/s/${open}`)
  assert.equal(meta.json.needsEmail, false)
  assert.equal(meta.json.unlocked, true)
})

test('revoked or expired while waiting for the code', async () => {
  const { port, store, sent, codeOf, tick } = await start({ cfg: { manifestCacheMs: 0 } })
  const sid = id()
  const dir = writeShare(store, sid, { recipients: ['a@client.com'] })
  await req(port, `/api/s/${sid}/code`, { method: 'POST', body: { email: 'a@client.com' } })
  const code = codeOf(sent[0])
  fs.rmSync(path.join(dir, 'manifest.json'))
  const v = await req(port, `/api/s/${sid}/verify`, { method: 'POST', body: { email: 'a@client.com', code } })
  assert.equal(v.status, 404)
  const sid2 = id()
  writeShare(store, sid2, { recipients: ['a@client.com'] })
  tick(86400000 + 60_000)
  assert.equal((await req(port, `/api/s/${sid2}/code`, { method: 'POST', body: { email: 'a@client.com' } })).status, 410)
})

test('stats: codes sent, verified, downloads per recipient, refused addresses', async () => {
  const { app, port, store, sent, codeOf } = await start()
  const sid = id()
  const dir = writeShare(store, sid, { recipients: ['a@client.com', 'b@client.com'] })
  await req(port, `/api/s/${sid}/code`, { method: 'POST', body: { email: 'x@else.com' } })
  await req(port, `/api/s/${sid}/code`, { method: 'POST', body: { email: 'b@client.com' } })
  const v = await req(port, `/api/s/${sid}/verify`, { method: 'POST', body: { email: 'b@client.com', code: codeOf(sent[0]) } })
  await req(port, `/d/${sid}/0?t=${encodeURIComponent(v.json.token)}`)
  await app.flushStats()
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8'))
  assert.equal(st.refused, 1)
  assert.equal(st.recipients[0].codesSent, 0)
  assert.equal(st.recipients[1].codesSent, 1)
  assert.ok(st.recipients[1].verifiedAt > 0)
  assert.equal(st.recipients[1].downloads, 1)
  assert.equal(st.downloads, 1)
})

// ---- SMTP client against a scripted server --------------------------------------------------

function fakeSmtp({ starttls = false, authOk = true, rcptOk = true } = {}) {
  const log = []
  const server = net.createServer((s) => {
    let data = false
    let msg = ''
    let buf = ''
    s.write('220 fake ESMTP\r\n')
    s.on('data', (c) => {
      buf += c.toString('utf8')
      let i
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (data) {
          if (line === '.') {
            data = false
            log.push({ message: msg })
            s.write('250 queued\r\n')
          } else msg += line + '\r\n'
          continue
        }
        log.push(line)
        if (/^EHLO/.test(line)) s.write(`250-fake\r\n250-AUTH PLAIN LOGIN\r\n${starttls ? '250-STARTTLS\r\n' : ''}250 SIZE 1000000\r\n`)
        else if (/^AUTH PLAIN/.test(line)) s.write(authOk ? '235 ok\r\n' : '535 5.7.8 Authentication failed\r\n')
        else if (/^MAIL FROM/.test(line)) s.write('250 ok\r\n')
        else if (/^RCPT TO/.test(line)) s.write(rcptOk ? '250 ok\r\n' : '550 no such user\r\n')
        else if (line === 'DATA') {
          data = true
          s.write('354 go\r\n')
        } else if (line === 'QUIT') s.end('221 bye\r\n')
        else s.write('502 unknown\r\n')
      }
    })
    s.on('error', () => {})
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, log, close: () => server.close() })))
}

test('smtpSend: plain session to this PC, AUTH PLAIN, base64 body, encoded subject', async () => {
  const f = await fakeSmtp()
  after(() => f.close())
  const mail = S.mailSettings({ host: '127.0.0.1', port: f.port, secure: 'none', user: 'share@office.com', pass: 'pw', from: 'share@office.com', fromName: 'Dexterity Share' })
  await S.smtpSend(mail, { to: 'client@x.com', subject: '123456 is your code for Zeichnung – Übersicht', text: 'Hello\n\nCode 123 456' })
  assert.ok(f.log.includes('MAIL FROM:<share@office.com>'))
  assert.ok(f.log.includes('RCPT TO:<client@x.com>'))
  const auth = f.log.find((l) => typeof l === 'string' && l.startsWith('AUTH PLAIN '))
  assert.equal(Buffer.from(auth.slice(11), 'base64').toString(), '\0share@office.com\0pw')
  const m = f.log.find((l) => l.message).message
  assert.match(m, /^Subject: =\?UTF-8\?B\?/m)
  assert.match(m, /^From: Dexterity Share <share@office.com>$/m)
  const body = Buffer.from(m.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8')
  assert.equal(body, 'Hello\r\n\r\nCode 123 456')
})

test('smtpSend: refusals come back with the server\'s words; STARTTLS is required when asked for', async () => {
  const f = await fakeSmtp({ authOk: false })
  after(() => f.close())
  const mail = S.mailSettings({ host: '127.0.0.1', port: f.port, secure: 'none', user: 'u@x.com', pass: 'bad', from: 'u@x.com' })
  await assert.rejects(S.smtpSend(mail, { to: 'c@x.com', subject: 's', text: 't' }), /AUTH refused: 535/)
  const g = await fakeSmtp({ rcptOk: false })
  after(() => g.close())
  await assert.rejects(S.smtpSend({ ...mail, port: g.port }, { to: 'c@x.com', subject: 's', text: 't' }), /RCPT TO refused: 550/)
  // a server that does not offer STARTTLS is not used for the password
  const h = await fakeSmtp()
  after(() => h.close())
  await assert.rejects(S.smtpSend({ ...mail, port: h.port, secure: 'starttls' }, { to: 'c@x.com', subject: 's', text: 't' }), /does not offer STARTTLS/)
  assert.ok(!h.log.some((l) => typeof l === 'string' && l.startsWith('AUTH')))
  await assert.rejects(S.smtpSend(mail, { to: 'c@x.com\r\nRCPT TO:<evil@x.com>', subject: 's', text: 't' }), /bad recipient/)
})

// ---- 2.10.2: branded e-mails, blank user name, plain-word refusals ---------------------------

import * as H from '../../server/dexterity-share/mail-html.mjs'

/** The decoded parts of a built message: [{ type, body, headers }] (one level of nesting is enough here). */
function parts(raw) {
  const out = []
  const walk = (block) => {
    const [head, ...rest] = block.split('\r\n\r\n')
    const body = rest.join('\r\n\r\n')
    const b = /boundary="([^"]+)"/.exec(head)?.[1]
    if (b) return body.split(`--${b}`).slice(1).filter((p) => !p.startsWith('--')).forEach((p) => walk(p.replace(/^\r\n/, '')))
    const type = /Content-Type: ([^;\r\n]+)/i.exec(head)?.[1]
    out.push({ type, headers: head, body: Buffer.from(body.replace(/\r\n/g, ''), 'base64') })
  }
  walk(raw.slice(raw.indexOf('Content-Type:')))
  return out
}

test('code e-mail: plain text and branded HTML, logo inline, code in both', () => {
  const m = { title: 'Lot 09 <isometrics> & "rev B"', sender: 'Priya Sharma', expiresAt: Date.UTC(2026, 11, 2) }
  const msg = S.codeMail(m, '482913', 10, 'client.pm@client-co.com')
  const mail = S.mailSettings({ host: 'smtp.x.com', from: 'share@office.com', fromName: 'Dexterity Design Services' })
  const raw = S.buildMessage(mail, { to: 'client.pm@client-co.com', ...msg })
  assert.match(raw, /^Content-Type: multipart\/related; boundary=/m)
  assert.ok(!raw.split('\r\n').some((l) => l.length > 998), 'no line over the SMTP limit')
  assert.ok(!raw.split('\r\n').some((l) => l.startsWith('.')), 'no line starts with a dot')
  const p = parts(raw)
  assert.deepEqual(p.map((x) => x.type), ['text/plain', 'text/html', 'image/png'])
  assert.match(p[0].body.toString(), /482 913/)
  const html = p[1].body.toString()
  assert.match(html, /482 913/)
  assert.match(html, new RegExp(`src="cid:${H.MARK_CID}"`))
  assert.match(p[2].headers, new RegExp(`Content-ID: <${H.MARK_CID}>`))
  assert.equal(p[2].body.subarray(1, 4).toString(), 'PNG', 'the logo is a real PNG')
  // manifest text is escaped, never markup
  assert.ok(html.includes('Lot 09 &lt;isometrics&gt; &amp; &quot;rev B&quot;'))
  assert.ok(!html.includes('<isometrics>'))
  assert.ok(html.includes('client.pm@client-co.com') && html.includes('Priya Sharma'))
  assert.ok(!/<script|<svg|https?:\/\/(?!dexteritydesign\.co\.in)/i.test(html), 'no scripts, SVG or remote content')
})

test('test e-mail: same design, logo inline', () => {
  const raw = S.buildMessage(S.mailSettings({ host: 'smtp.x.com', from: 'info@office.com' }), { to: 'a@b.com', ...S.testMail('info@office.com') })
  const p = parts(raw)
  assert.deepEqual(p.map((x) => x.type), ['text/plain', 'text/html', 'image/png'])
  assert.match(p[1].body.toString(), /E-mail codes<br>.*are ready/)
  assert.match(p[1].body.toString(), /info@office\.com/)
})

test('a saved password with no user name signs in as the sender', () => {
  assert.equal(S.mailSettings({ host: 'smtppro.zoho.in', from: 'info@office.com', pass: 'app pw' }).user, 'info@office.com')
  assert.equal(S.mailSettings({ host: 'smtppro.zoho.in', from: 'info@office.com' }).user, '', 'no password: no sign-in (a relay)')
  assert.equal(S.mailSettings({ host: 'smtppro.zoho.in', from: 'info@office.com', user: 'sam@office.com', pass: 'x' }).user, 'sam@office.com')
})

test('refusals in plain words', () => {
  assert.match(S.smtpHint(530, 'MAIL FROM', false), /fill in User name/)
  assert.match(S.smtpHint(535, 'AUTH', true), /app password/)
  assert.match(S.smtpHint(553, 'MAIL FROM', true), /Sender address/)
  assert.equal(S.smtpHint(421, 'DATA', true), '')
})

test('smtpSend: no user name and a server that wants a sign-in gives the plain-words hint', async () => {
  const f = await fakeSmtp()
  after(() => f.close())
  const srv = net.createServer((s) => {
    s.write('220 x\r\n')
    s.on('data', (c) => {
      const l = c.toString()
      if (/^EHLO/.test(l)) s.write('250 x\r\n')
      else if (/^MAIL FROM/.test(l)) s.write('530 5.7.0 Authentication Required\r\n')
      else if (/^QUIT/.test(l)) s.end('221 bye\r\n')
    })
    s.on('error', () => {})
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  after(() => srv.close())
  const mail = S.mailSettings({ host: '127.0.0.1', port: srv.address().port, secure: 'none', from: 'info@office.com' })
  await assert.rejects(S.smtpSend(mail, { to: 'c@x.com', subject: 's', text: 't' }), /needs a sign-in: fill in User name.*530 5\.7\.0/)
})

test('every e-mail says not to reply and names whom to contact', () => {
  const m = { title: 'Lot 09', sender: 'Priya Sharma', expiresAt: Date.UTC(2026, 11, 2) }
  const code = S.codeMail(m, '482913', 10, 'a@b.com')
  for (const t of [code.text, code.html]) {
    assert.match(t, /Please do not reply to this e-mail/)
    assert.match(t, /please contact Priya Sharma directly/)
  }
  assert.match(S.codeMail({ ...m, sender: '' }, '482913', 10, 'a@b.com').text, /contact the person at Dexterity Design Services who shared the files with you/)
  const test = S.testMail('info@office.com')
  assert.match(test.text, /not monitored/)
  assert.match(test.html, /Please do not reply/)
  const raw = S.buildMessage(S.mailSettings({ host: 'smtp.x.com', from: 'info@office.com' }), { to: 'a@b.com', ...code })
  assert.match(raw, /^X-Auto-Response-Suppress: All$/m)
})
