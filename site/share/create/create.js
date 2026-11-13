// Dexterity Share — staff page: create a client link from a browser by uploading a .zip, .rar or .7z.
// (c) Dexterity Design Services Private Limited. Internal software.
// Sign-in: Hopper makes a personal "browser pass" and a link "create/#<pass>.<secret>[.<gist>.<key>]".
// This page keeps it in this browser's storage and removes it from the address bar at once, so a
// bookmark or the history never holds the secret. Text from the server is always put on the page as
// text, never as HTML.
;(function () {
  'use strict'

  var PASS_RE = /^([a-z2-7]{26})\.([A-Za-z0-9_-]{43})(?:\.([0-9a-f]{20,40})\.([0-9a-f]{20}))?$/
  var PASS_KEY = 'dxs-staff-pass'
  var EXT_RE = /\.(zip|rar|7z)$/i
  var DAY = 86400000
  var LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
  var main = document.getElementById('main')
  var toastEl = document.getElementById('toast')
  var whoEl = document.getElementById('who')
  var signoutBtn = document.getElementById('signout')
  // S.cfg, S.gist, S.keyHash are the names the pointer code copied from share.js expects
  var S = { cfg: null, gist: '', keyHash: '', base: '', pass: null, me: null, links: [], uploads: [], now: 0, skew: 0, off: {}, memoryOnly: false }
  var F = { file: null, days: 7, password: '', note: '', title: '', titleTouched: false, resume: null, error: '' }
  var U = null // the upload in progress

  // ---- small helpers --------------------------------------------------------------------------
  function h(tag, props) {
    var el = document.createElement(tag)
    var k
    if (props) {
      for (k in props) {
        if (k === 'class') el.className = props[k]
        else if (k === 'text') el.textContent = props[k]
        else if (k === 'on') for (var ev in props.on) el.addEventListener(ev, props.on[ev])
        else if (props[k] !== false && props[k] != null) el.setAttribute(k, props[k] === true ? '' : props[k])
      }
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i]
      if (c == null || c === false) continue
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    }
    return el
  }
  /**
   * The line of flow (brand/dx.css), as on the client page: our office on the left, this browser on
   * the right. On this page files travel the other way, so an upload is drawn "flowing reverse" and a
   * finished one ticks the office end. kind: flowing | done | valved busy | valved shut | broken | capped …
   */
  function route(kind, id) {
    var ns = 'http://www.w3.org/2000/svg'
    var mk = function (tag, attrs) {
      var el = document.createElementNS(ns, tag)
      for (var k in attrs) el.setAttribute(k, attrs[k])
      return el
    }
    var svg = mk('svg', { viewBox: '0 0 400 24', 'aria-hidden': 'true', focusable: 'false', class: 'route ' + (kind || 'idle') })
    if (id) svg.setAttribute('id', id)
    svg.appendChild(mk('path', { class: 'seg a', d: 'M12 12H200', pathLength: '1' }))
    svg.appendChild(mk('path', { class: 'seg b', d: 'M200 12H388', pathLength: '1' }))
    svg.appendChild(mk('path', { class: 'pulse', d: 'M12 12H388', pathLength: '1' }))
    svg.appendChild(mk('path', { class: 'gap', d: 'M194 12H206' }))
    var fl = mk('g', { class: 'flange' })
    fl.appendChild(mk('path', { d: 'M192 5V19M208 5V19' }))
    svg.appendChild(fl)
    svg.appendChild(mk('path', { class: 'cap', d: 'M200 5V19' }))
    var valve = mk('g', { class: 'valve' })
    valve.appendChild(mk('path', { d: 'M189 5 200 12 189 19ZM211 5 200 12 211 19Z' }))
    svg.appendChild(valve)
    svg.appendChild(mk('circle', { class: 'node a', cx: '6', cy: '12', r: '5.5' }))
    svg.appendChild(mk('circle', { class: 'node b', cx: '394', cy: '12', r: '5' }))
    svg.appendChild(mk('path', { class: 'tick', d: 'M3.4 12.2l1.9 1.9 3.4-3.8', pathLength: '1' }))
    return svg
  }
  /** The line with its two ends named. */
  function flow(kind, id) {
    return h('div', { class: 'flow' }, route(kind, id), h('div', { class: 'route-labels eyebrow' }, h('span', { text: 'Our office' }), h('span', { text: 'This browser' })))
  }
  function extOf(name) {
    return (/\.([a-z0-9]+)$/i.exec(name) || ['', 'file'])[1].toUpperCase()
  }
  /** Eyebrow over a large heading, as each section of the page opens. */
  function heading(eyebrow, id, text) {
    return h('div', { class: 'sec-head' }, h('p', { class: 'eyebrow kicker', text: eyebrow }), h('h2', { id: id, text: text }))
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B'
    var u = ['KB', 'MB', 'GB', 'TB']
    var v = n / 1024
    var i = 0
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024
      i++
    }
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + u[i]
  }
  function fmtLimit(n) {
    var gb = n / Math.pow(2, 30)
    return gb >= 1 ? (Math.round(gb * 10) / 10) + ' GB' : fmtBytes(n)
  }
  function fmtDuration(sec) {
    if (!isFinite(sec) || sec <= 0) return ''
    if (sec < 60) return Math.ceil(sec) + ' s left'
    if (sec < 3600) return Math.ceil(sec / 60) + ' min left'
    return Math.floor(sec / 3600) + ' h ' + Math.round((sec % 3600) / 60) + ' min left'
  }
  var shortDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
  var shortDateYear = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  var longDate = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  function serverNow() {
    return Date.now() + S.skew
  }
  function dayText(ms) {
    var d = new Date(ms - S.skew)
    return (d.getFullYear() === new Date().getFullYear() ? shortDate : shortDateYear).format(d)
  }
  function madeText(ms) {
    var d = new Date(ms - S.skew)
    var t = new Date()
    if (d.toDateString() === t.toDateString()) return 'made today'
    t.setDate(t.getDate() - 1)
    if (d.toDateString() === t.toDateString()) return 'made yesterday'
    return 'made ' + dayText(ms)
  }
  function daysLeft(expiresAt) {
    return Math.max(0, Math.ceil((expiresAt - serverNow()) / DAY))
  }
  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's')
  }
  var toastTimer
  function toast(text) {
    toastEl.textContent = text
    toastEl.classList.add('on')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('on')
    }, 2600)
  }
  function copy(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast(done || 'Copied')
      }, function () {
        toast('Select the text and copy it')
      })
    } else toast('Select the text and copy it')
  }
  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms)
    })
  }
  // sessionStorage, as in share.js (the pointer code below caches the server address in it)
  function store(key, value) {
    try {
      if (value === undefined) return sessionStorage.getItem(key)
      if (value === null) sessionStorage.removeItem(key)
      else sessionStorage.setItem(key, value)
    } catch (e) {}
    return null
  }
  function local(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key)
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
      return true
    } catch (e) {
      return value === undefined ? null : false
    }
  }
  function timedFetch(url, opts, ms) {
    var ctl = new AbortController()
    var t = setTimeout(function () {
      ctl.abort()
    }, ms || 20000)
    opts = opts || {}
    opts.signal = ctl.signal
    return fetch(url, opts).finally(function () {
      clearTimeout(t)
    })
  }
  /** The same rules as Hopper's safeFileName (src/shared/pubshare.ts). */
  function safeFileName(name, fallback) {
    var s = String(name)
      .normalize('NFC')
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
      .replace(/[. ]+$/, '')
      .trim()
      .slice(0, 180)
    return s || fallback || 'file'
  }
  // No look-alikes (0/O, 1/l/I), exactly as Hopper's generatePassword (src/shared/pubshare.ts).
  var PW_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  function generatePassword() {
    var out = []
    while (out.length < 12) {
      var r = crypto.getRandomValues(new Uint8Array(32))
      for (var i = 0; i < r.length; i++) if (r[i] < 224 && out.length < 12) out.push(PW_CHARS[r[i] % 56])
    }
    return out.slice(0, 4).join('') + '-' + out.slice(4, 8).join('') + '-' + out.slice(8).join('')
  }

  // ---- the e-mail text: the same wording as Hopper's buildEmail (src/shared/pubshare.ts) ------
  function fmtExpiryDate(ms) {
    return longDate.format(new Date(ms)).replace(',', '')
  }
  function buildEmail(e) {
    var company = e.company || 'Dexterity Design Services Private Limited'
    var total = e.files.reduce(function (a, f) {
      return a + f.size
    }, 0)
    var n = Math.max(0, Math.ceil((e.expiresAt - (e.now || Date.now())) / DAY))
    var what = e.files.length === 1 ? e.files[0].name + ' (' + fmtBytes(total) + ')' : e.files.length + ' files (' + fmtBytes(total) + ' in total)'
    var lines = ['Hello,', '']
    if (e.message && e.message.trim()) lines.push(e.message.trim(), '')
    lines.push('Please download ' + (e.files.length === 1 ? 'the file' : 'the files') + ' we have prepared for you from this link:', '', e.url, '', 'Contents: ' + what)
    if (e.files.length > 1 && e.files.length <= 12) e.files.forEach(function (f) {
      lines.push('  - ' + f.name + ' (' + fmtBytes(f.size) + ')')
    })
    lines.push('', 'This link expires on ' + fmtExpiryDate(e.expiresAt) + ' (' + n + ' ' + (n === 1 ? 'day' : 'days') + ' from today). Please download before then.')
    if (e.hasPassword) lines.push('The link is password protected. We will send you the password separately.')
    lines.push('', 'If the link does not open or the download fails, please reply to this e-mail and we will help.', '', 'Regards,', e.sender, company)
    return { subject: e.title + ' - files from ' + company, body: lines.join('\r\n') }
  }

  /** The client link, exactly as Hopper's shareUrl builds it: the client page is the folder above this one. */
  function clientUrl(id) {
    var base = new URL('../', location.href.replace(/[#?].*$/, '')).href
    var p = S.pass
    var ref = p && /^[0-9a-f]{20,40}$/.test(p.gist || '') && /^[0-9a-f]{20}$/.test(p.key || '') ? '.' + p.gist + '.' + p.key : ''
    return base + '#' + id + ref
  }

  // ---- sign-in ----------------------------------------------------------------------------------
  function readPass() {
    var raw = local(PASS_KEY)
    if (!raw) return null
    try {
      var p = JSON.parse(raw)
      if (p && /^[a-z2-7]{26}$/.test(p.id) && /^[A-Za-z0-9_-]{43}$/.test(p.secret)) return { id: p.id, secret: p.secret, gist: p.gist || '', key: p.key || '' }
    } catch (e) {}
    return null
  }
  /** A sign-in link in the address: keep it in this browser and take it out of the address at once. */
  function takeFragment() {
    var frag = ''
    try {
      frag = decodeURIComponent(location.hash.replace(/^#\/?/, '')).trim()
    } catch (e) {}
    if (!location.hash) return null
    history.replaceState(null, '', location.pathname + location.search)
    var m = PASS_RE.exec(frag)
    if (!m) return null
    var p = { id: m[1], secret: m[2], gist: m[3] || '', key: m[4] || '' }
    if (!local(PASS_KEY, JSON.stringify(p))) S.memoryOnly = true // this browser will not keep it
    return p
  }
  function signOut(why) {
    local(PASS_KEY, null)
    S.pass = null
    S.me = null
    stopUpload(true)
    whoEl.hidden = true
    signoutBtn.hidden = true
    showSignedOut(why)
  }

  // ---- finding the server ------------------------------------------------------------------------
  // validBase, hostAllowed, b64url, hex, pointerGenuine, readPointer and candidates are copied
  // unchanged from the client page, site/share/share.js (Hopper 2.3.0), so both pages find the office
  // server the same way: the signed pointer named by the link, checked against its key fingerprint,
  // or a known tunnel host.
  function validBase(base) {
    var u
    try {
      u = new URL(base)
    } catch (e) {
      return ''
    }
    if (u.username || u.password) return ''
    if (LOCAL && u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname)) return u.origin // local testing only
    if (u.protocol !== 'https:') return ''
    return u.origin
  }
  function hostAllowed(origin) {
    var host = new URL(origin).hostname
    if (LOCAL && /^(localhost|127\.0\.0\.1)$/.test(host)) return true
    return (S.cfg.allowedHosts || []).some(function (p) {
      p = String(p).toLowerCase()
      return p.slice(0, 2) === '*.' ? host.length > p.length - 1 && host.slice(-(p.length - 1)) === p.slice(1) : host === p
    })
  }
  function b64url(s) {
    var b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'))
    var out = new Uint8Array(b.length)
    for (var i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
    return out
  }
  function hex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) {
      return ('0' + b.toString(16)).slice(-2)
    }).join('')
  }
  /**
   * The pointer is signed by the office server; a forged or altered one is ignored. For a link that
   * names its key fingerprint, the pointer brings the public key and the fingerprint must match:
   * whoever can edit the gist still cannot send clients anywhere else.
   */
  async function pointerGenuine(p) {
    var jwk = S.cfg.pointerKey
    if (S.keyHash) {
      if (!p.key || p.key.kty !== 'EC' || p.key.crv !== 'P-256' || typeof p.key.x !== 'string' || typeof p.key.y !== 'string' || !p.sig) return false
      try {
        var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p.key.x + '.' + p.key.y))
        if (hex(digest).slice(0, 20) !== S.keyHash) return false
      } catch (e) {
        return false
      }
      jwk = { kty: 'EC', crv: 'P-256', x: p.key.x, y: p.key.y }
    }
    if (!jwk) return true
    try {
      var pointerKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pointerKey, b64url(p.sig), new TextEncoder().encode('dxshare-pointer-v1\n' + p.base + '\n' + p.updated))
    } catch (e) {
      return false
    }
  }
  async function readPointer(url, fresh) {
    var api = /^https:\/\/api\.github\.com\//.test(url)
    // GitHub's raw file host caches for a few minutes; a changing query asks for a new copy when we need one
    var u = fresh && !api ? url + (url.indexOf('?') < 0 ? '?' : '&') + 'v=' + Date.now() : url
    var r = await timedFetch(u, { cache: 'no-store', headers: api ? { Accept: 'application/vnd.github.raw+json' } : {} }, 12000)
    if (!r.ok) throw new Error('pointer ' + r.status)
    var p = await r.json()
    if (p && p.content && p.encoding === 'base64') p = JSON.parse(atob(p.content.replace(/\s/g, '')))
    if (p && p.files && p.files['pointer.json']) p = JSON.parse(p.files['pointer.json'].content) // GitHub's gist API answer
    if (!p || typeof p.base !== 'string') throw new Error('pointer shape')
    var origin = validBase(p.base)
    // An address signed with the key this link names is the office's own statement; otherwise only known tunnel hosts.
    if (!origin || origin !== p.base || !(await pointerGenuine(p)) || !(S.keyHash || hostAllowed(origin))) throw new Error('pointer rejected')
    return { base: origin, updated: Date.parse(p.updated) || 0 }
  }
  /** Candidate server addresses, most recently published first. */
  async function candidates(fresh) {
    var cfg = S.cfg
    var fixed = cfg.base ? validBase(cfg.base) : ''
    if (fixed && !S.gist) return [fixed]
    var urls = cfg.pointers || []
    // the link's own pointer: GitHub's file host first (no request limit, may be up to five minutes old), then its API (current)
    if (S.gist) urls = [(cfg.gistRaw || 'https://gist.githubusercontent.com/raw/') + S.gist + '/pointer.json', (cfg.gistApi || 'https://api.github.com/gists/') + S.gist]
    if (!fresh) urls = urls.slice(0, 1)
    var found = await Promise.all(urls.map(function (u) {
      return readPointer(u, fresh).catch(function () {
        return null
      })
    }))
    found = found.filter(Boolean).sort(function (a, b) {
      return b.updated - a.updated
    })
    var out = []
    var cached = !fresh && store('dxs-base-' + (S.gist || 'cfg'))
    if (cached && validBase(cached) === cached && (S.keyHash || hostAllowed(cached))) out.push(cached)
    found.forEach(function (f) {
      if (out.indexOf(f.base) < 0) out.push(f.base)
    })
    return out
  }
  // ---- end of the code copied from share.js ----

  function authHeader() {
    return 'Bearer ' + S.pass.id + '.' + S.pass.secret
  }
  /** One API call. Resolves to {status, json}; status 0 = the server could not be reached. */
  async function call(method, p, body, ms) {
    var opts = { method: method, cache: 'no-store', headers: { Authorization: authHeader() } }
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json'
      opts.body = JSON.stringify(body)
    }
    var r
    try {
      r = await timedFetch(S.base + p, opts, ms || 30000)
    } catch (e) {
      return { status: 0, json: null }
    }
    var j = null
    try {
      j = await r.json()
    } catch (e) {}
    // anything that is not our server speaking (a tunnel error page, a proxy…) counts as not reachable
    if (!j || typeof j !== 'object') return { status: 0, json: null, http: r.status }
    if (r.status === 401 && j.error === 'signed_out') signOut('revoked')
    return { status: r.status, json: j, retryAfter: Number(r.headers.get('Retry-After')) || 0 }
  }

  async function ask(base) {
    S.base = base
    var r = await call('GET', '/api/staff/me', undefined, 20000)
    if (r.status === 200 && r.json && r.json.v === 1) return { kind: 'ok', me: r.json }
    if (r.status === 401) return { kind: 'signed_out' }
    if (r.status === 403 && r.json && r.json.error === 'disabled') return { kind: 'disabled' }
    if (r.status === 429) return { kind: 'busy', retry: r.retryAfter || 30 }
    return { kind: 'unreachable' }
  }
  async function connect(fresh) {
    var list = await candidates(fresh)
    for (var i = 0; i < list.length; i++) {
      var res = await ask(list[i])
      if (res.kind !== 'unreachable') {
        S.base = list[i]
        store('dxs-base-' + (S.gist || 'cfg'), list[i])
        return res
      }
    }
    if (!fresh && (S.gist || !(S.cfg.base && validBase(S.cfg.base)))) return connect(true) // the cached address may be stale: read every pointer afresh
    return { kind: 'unreachable', configured: list.length > 0 || !!S.gist || !!(S.cfg.pointers || []).length || !!S.cfg.base }
  }

  // ---- views ----------------------------------------------------------------------------------------
  function setMain(nodes, wide) {
    main.replaceChildren.apply(main, nodes)
    main.classList.toggle('single', !!wide)
    main.setAttribute('aria-busy', 'false')
  }
  /** A full-width message: an ink plate with the eyebrow, the heading and the line in its state, then the words. */
  function stateCard(title, paras, actions, kind, eyebrow, line) {
    var body = h('div', { class: 'body' })
    paras.forEach(function (p) {
      body.appendChild(typeof p === 'string' ? h('p', { text: p }) : p)
    })
    if (actions && actions.length) body.appendChild(h.apply(null, ['div', { class: 'row' }].concat(actions)))
    return h('section', { class: 'card wide state' + (kind ? ' ' + kind : '') },
      h('div', { class: 'plate' }, h('p', { class: 'eyebrow kicker', text: eyebrow || 'Dexterity Share' }), h('h1', { text: title, tabindex: '-1' }), flow(line || 'capped')),
      body)
  }
  function focusHeading() {
    var head = main.querySelector('h1')
    if (head) head.focus({ preventScroll: true })
  }

  function showSignedOut(why) {
    var first = why === 'revoked' ? 'This browser has been signed out. Its sign-in was switched off in Hopper, or it no longer exists.' : why === 'manual' ? 'You signed out on this browser.' : 'This page lets Dexterity Design Services staff create client links from a browser. This browser is not signed in.'
    var steps = h('ol', { class: 'steps' },
      h('li', null, 'In Hopper, open ', h('b', { text: 'My client links' }), ' and choose ', h('b', { text: 'Use in a browser' }), '.'),
      h('li', null, 'Choose ', h('b', { text: 'Make a sign-in link' }), ', then ', h('b', { text: 'Open in browser' }), '. You can also copy the link into this browser.'),
      h('li', null, 'Bookmark this page. The bookmark does not hold your sign-in; this browser remembers it.'))
    setMain([stateCard('Sign in from Hopper', [h('p', { class: 'lead', text: first }), steps, h('p', { class: 'muted small', text: 'Each sign-in link is personal, so do not send it to anyone. Whoever has it can create links in your name until you switch it off in Hopper.' })], null, 'signedout', why === 'revoked' ? 'Signed out' : 'Staff sign-in', 'capped')], true)
    focusHeading()
  }
  function showUnreachable(configured) {
    var wait = 15
    var count = h('span', { class: 'tn', text: String(wait) })
    var btn = h('button', { class: 'btn primary', type: 'button', text: 'Try again now', on: { click: function () {
      clearInterval(timer)
      start(true)
    } } })
    setMain([stateCard(configured ? 'The office server is not reachable' : 'This page is not connected to the office server', configured ? [h('p', { class: 'lead', text: 'The office share server did not answer. It may be restarting, or the office internet may be down. Nothing you made is lost.' }), h('p', { class: 'muted' }, 'Trying again in ', count, ' s.')] : [h('p', { class: 'lead', text: 'Make a new sign-in link in Hopper (My client links → Use in a browser) and open it here.' })], configured ? [btn] : null, 'warn', configured ? 'No answer' : 'Not connected', configured ? 'broken' : 'capped')], true)
    if (!configured) return
    var timer = setInterval(function () {
      if (--wait <= 0) {
        clearInterval(timer)
        start(true)
      } else count.textContent = String(wait)
    }, 1000)
  }
  function showDisabled() {
    setMain([stateCard('Creating links from a browser is switched off', [h('p', { class: 'lead', text: 'An office admin has switched this off (Hopper → Settings → Office → Dexterity Share). You can still make links in Hopper.' })], null, 'warn', 'Switched off', 'capped')], true)
  }

  // ---- the workbench ------------------------------------------------------------------------------
  var refs = {}
  function showWorkbench() {
    whoEl.textContent = 'Signed in as ' + (S.me.name || S.me.user)
    whoEl.hidden = false
    signoutBtn.hidden = false
    refs.left = h('section', { class: 'card', id: 'new', 'aria-labelledby': 'new-h' })
    refs.right = h('section', { class: 'card', id: 'links', 'aria-labelledby': 'links-h' })
    setMain([refs.left, refs.right], false)
    renderLeft()
    renderLinks()
    void loadLinks()
  }

  // ---- left card: new link -------------------------------------------------------------------------
  function renderLeft() {
    if (U) return renderUpload()
    var lim = S.me.limits
    var c = refs.left
    var input = h('input', { type: 'file', id: 'file', class: 'sr', accept: '.zip,.rar,.7z', on: { change: function () {
      if (input.files && input.files[0]) chooseFile(input.files[0])
    } } })
    // a drawing sheet: hairline frame, corner registration marks, and a small title block
    var drop = h('label', { class: 'drop' + (F.file ? ' has' : ''), for: 'file' },
      h('span', { class: 'marks', 'aria-hidden': 'true' }),
      F.file ? h('span', { class: 'fname' }, h('span', { class: 'ext', text: extOf(F.file.name) }), h('span', { class: 'fn' }, h('b', { text: F.file.name }), h('small', { class: 'tn', text: fmtBytes(F.file.size) + ' · choose another file' })))
        : h('span', { class: 'drop-ask' }, h('span', { class: 'drop-ico', 'aria-hidden': 'true' }), h('b', { text: 'Drop a .zip, .rar or .7z' }), h('span', null, 'or choose a file · up to ' + fmtLimit(lim.maxBytes))),
      h('span', { class: 'tblock', 'aria-hidden': 'true' }, h('span', null, h('i', { class: 'eyebrow', text: 'Accepts' }), ' .zip .rar .7z'), h('span', { class: 'tn' }, h('i', { class: 'eyebrow', text: 'Limit' }), ' ' + fmtLimit(lim.maxBytes))))
    ;['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault()
        drop.classList.add('over')
      })
    })
    ;['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault()
        drop.classList.remove('over')
        if (ev === 'drop' && e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          if (e.dataTransfer.files.length > 1) return setError('Drop one file. Zip several files into one archive first.')
          chooseFile(e.dataTransfer.files[0])
        }
      })
    })
    // keyboard: the label is not focusable by itself, so the hidden input carries focus and shows it on the label
    input.addEventListener('focus', function () {
      drop.classList.add('focus')
    })
    input.addEventListener('blur', function () {
      drop.classList.remove('focus')
    })

    var chips = h('div', { class: 'chips', role: 'group', 'aria-labelledby': 'days-l' })
    lim.days.forEach(function (d) {
      chips.appendChild(h('button', { type: 'button', 'aria-pressed': String(F.days === d), text: String(d), 'aria-label': plural(d, 'day'), on: { click: function () {
        F.days = d
        chips.querySelectorAll('button').forEach(function (b) {
          b.setAttribute('aria-pressed', String(b.textContent === String(d)))
        })
        daysNote.textContent = 'Until ' + fmtExpiryDate(Date.now() + d * DAY)
      } } }))
    })
    var daysNote = h('small', { class: 'muted', text: 'Until ' + fmtExpiryDate(Date.now() + F.days * DAY) })

    var pw = h('input', { class: 'in', id: 'pw', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'None', value: F.password, maxlength: '256', on: { input: function () {
      F.password = pw.value
    } } })
    var gen = h('button', { type: 'button', class: 'btn sm', text: 'Generate', on: { click: function () {
      F.password = pw.value = generatePassword()
      pw.focus()
    } } })
    var note = h('textarea', { class: 'in', id: 'note', rows: '3', maxlength: '4000', placeholder: 'Optional · appears on the download page and in the e-mail', on: { input: function () {
      F.note = note.value
    } } })
    note.value = F.note
    var title = h('input', { class: 'in', id: 'title', type: 'text', maxlength: '200', placeholder: F.file ? F.file.name : 'The file name', value: F.title, on: { input: function () {
      F.title = title.value
      F.titleTouched = true
    } } })
    var err = h('p', { class: 'err', id: 'form-err', role: 'alert', text: F.error })
    err.hidden = !F.error
    var go = h('button', { class: 'go', type: 'button', id: 'create', text: F.resume ? 'Continue upload' : 'Create link', on: { click: create } })

    var kids = [
      heading('Send to a client', 'new-h', 'New link'),
      input,
      drop,
      F.resume ? h('p', { class: 'note-box' }, 'An unfinished upload of this file was found (' + Math.floor((F.resume.received / F.resume.size) * 100) + '% sent). ', h('b', { text: 'Continue upload' }), ' carries on with the settings chosen then.') : null,
      h('div', { class: 'field' }, h('span', { class: 'lbl eyebrow', id: 'days-l', text: 'Link open for (days)' }), chips, daysNote),
      h('div', { class: 'field' }, h('label', { class: 'lbl eyebrow', for: 'pw', text: 'Password (optional)' }), h('div', { class: 'pwrow' }, pw, gen), h('small', { class: 'muted', text: 'At least 6 characters. It is shown once, when the link is ready. Send it separately from the link.' })),
      h('div', { class: 'field' }, h('label', { class: 'lbl eyebrow', for: 'note', text: 'Note to the client' }), note),
      h('div', { class: 'field' }, h('label', { class: 'lbl eyebrow', for: 'title', text: 'Title' }), title),
      err,
      go
    ]
    if (S.uploads.length) {
      var ul = h('ul', { class: 'unfinished', 'aria-label': 'Unfinished uploads' })
      S.uploads.forEach(function (u) {
        ul.appendChild(h('li', null, h('span', null, h('b', { text: u.name }), h('small', { class: 'tn', text: fmtBytes(u.received) + ' of ' + fmtBytes(u.size) + ' sent · choose the same file to continue' })), discardButton(u)))
      })
      kids.push(h('div', { class: 'field' }, h('span', { class: 'lbl eyebrow', text: 'Unfinished uploads' }), ul))
    }
    c.replaceChildren.apply(c, kids.filter(Boolean))
  }

  function discardButton(u) {
    var b = h('button', { type: 'button', class: 'act r', text: 'Discard', on: { click: function () {
      var row = b.parentNode
      var yes = h('button', { type: 'button', class: 'act r', text: 'Yes, discard', on: { click: async function () {
        yes.disabled = true
        var r = await call('DELETE', '/api/staff/uploads/' + u.id)
        if (r.status === 200 || r.status === 404) {
          store('dxs-pw-' + u.id, null)
          toast('Upload discarded')
          if (F.resume && F.resume.id === u.id) F.resume = null
          await loadLinks()
          renderLeft()
        } else toast(problem(r))
      } } })
      var no = h('button', { type: 'button', class: 'act', text: 'Keep', on: { click: function () {
        row.replaceChild(b, wrap)
      } } })
      var wrap = h('span', { class: 'confirm' }, yes, no)
      row.replaceChild(wrap, b)
      yes.focus()
    } } })
    return b
  }

  function setError(text) {
    F.error = text
    var e = document.getElementById('form-err')
    if (e) {
      e.textContent = text
      e.hidden = !text
    }
  }

  function chooseFile(file) {
    F.error = ''
    var lim = S.me.limits
    if (!EXT_RE.test(file.name)) {
      F.file = null
      F.resume = null
      renderLeft()
      return setError('Only .zip, .rar and .7z files can be sent from here. Zip the files first (Hopper: Ctrl+Alt+Z), or make the link in Hopper.')
    }
    if (file.size > lim.maxBytes) {
      F.file = null
      F.resume = null
      renderLeft()
      return setError(file.name + ' is ' + fmtBytes(file.size) + '. The limit for links made in a browser is ' + fmtLimit(lim.maxBytes) + '; make bigger links in Hopper.')
    }
    if (file.size === 0) {
      renderLeft()
      return setError(file.name + ' is empty.')
    }
    F.file = file
    if (!F.titleTouched) F.title = ''
    // the same file again: carry on with its unfinished upload
    var name = safeFileName(file.name)
    F.resume = null
    for (var i = 0; i < S.uploads.length; i++) {
      if (S.uploads[i].name === name && S.uploads[i].size === file.size) F.resume = S.uploads[i]
    }
    renderLeft()
  }

  function problem(r, file) {
    var j = r.json || {}
    if (r.status === 0) return 'The office server is not reachable right now. Check your internet connection and try again.'
    if (j.error === 'too_big') return 'The file is too big: the limit for links made in a browser is ' + fmtLimit(j.maxBytes || S.me.limits.maxBytes) + '.'
    if (j.error === 'bad_type') return 'Only .zip, .rar and .7z files can be sent from here.'
    if (j.error === 'bad_name') return 'The file name cannot be used. Rename the file and choose it again.'
    if (j.error === 'bad_password') return 'Use a password of at least 6 characters.'
    if (j.error === 'disk_full') return (j.message || 'The office server is nearly full.') + ' Ask IT to free space, or switch off old links.'
    if (j.error === 'too_many_uploads') return 'You already have ' + (j.max || 2) + ' unfinished uploads. Continue one (choose the same file again) or discard it below.'
    if (j.error === 'wrong_content') return (file ? file : 'The file') + ' is not really a .' + (j.extension || 'zip') + ' file, so it was not sent. Check you chose the right file.'
    if (j.error === 'disabled') return 'Creating links from a browser has been switched off by an office admin.'
    if (j.error === 'rate_limited') return 'Too many requests. Wait a minute and try again.'
    if (j.error === 'not_found') return 'The upload is no longer on the server (it was cancelled or cleared). Start again.'
    return 'Something went wrong on the office server (' + (j.error || r.status) + '). Try again.'
  }

  async function create() {
    if (!F.file) return setError('Choose a .zip, .rar or .7z file first.')
    if (F.password && F.password.length < 6) return setError('Use a password of at least 6 characters, or leave it empty.')
    setError('')
    var btn = document.getElementById('create')
    btn.disabled = true
    btn.textContent = 'Starting…'
    var file = F.file
    var up
    if (F.resume) {
      var st = await call('GET', '/api/staff/uploads/' + F.resume.id)
      if (!S.pass) return
      if (st.status !== 200 || st.json.state === 'done') {
        F.resume = null
        await loadLinks()
        renderLeft()
        return setError(st.status === 200 ? 'That upload has already finished; it is in your links.' : problem(st))
      }
      up = { id: F.resume.id, chunkBytes: st.json.chunkBytes, chunks: st.json.chunks, have: st.json.have, resumed: true }
    } else {
      var r = await call('POST', '/api/staff/uploads', { name: safeFileName(file.name), size: file.size, days: F.days, password: F.password || undefined, message: F.note.trim() || undefined, title: F.title.trim() || undefined })
      if (!S.pass) return
      if (r.status !== 201) {
        btn.disabled = false
        btn.textContent = 'Create link'
        return setError(problem(r))
      }
      up = { id: r.json.id, chunkBytes: r.json.chunkBytes, chunks: r.json.chunks, have: [], resumed: false }
      if (F.password) store('dxs-pw-' + up.id, F.password)
    }
    startUpload(file, up)
  }

  // ---- the upload ----------------------------------------------------------------------------------
  var PARALLEL = 3
  function startUpload(file, up) {
    var have = {}
    up.have.forEach(function (n) {
      have[n] = true
    })
    U = {
      id: up.id,
      file: file,
      chunkBytes: up.chunkBytes,
      chunks: up.chunks,
      done: have,
      sent: 0,
      inflight: {}, // n -> {xhr, loaded}
      paused: false,
      stopped: false,
      fails: 0,
      state: 'uploading',
      message: up.resumed ? 'Continuing the upload you started earlier.' : '',
      started: Date.now(),
      samples: [],
      speed: 0,
      password: F.password || store('dxs-pw-' + up.id) || '',
      resumed: up.resumed
    }
    U.sent = sentBytes()
    renderUpload()
    pump()
  }
  function chunkLen(n) {
    return n === U.chunks - 1 ? U.file.size - n * U.chunkBytes : U.chunkBytes
  }
  function sentBytes() {
    var s = 0
    for (var k in U.done) s += chunkLen(Number(k))
    for (var j in U.inflight) s += U.inflight[j].loaded
    return s
  }
  function stopUpload(silent) {
    if (!U) return
    U.stopped = true
    for (var k in U.inflight) U.inflight[k].xhr.abort()
    U.inflight = {}
    if (silent) U = null
  }

  function pump() {
    if (!U || U.stopped || U.paused || U.state !== 'uploading') return
    var busy = Object.keys(U.inflight).length
    for (var n = 0; n < U.chunks && busy < PARALLEL; n++) {
      if (U.done[n] || U.inflight[n] || (U.waitUntil && U.waitUntil[n] > Date.now())) continue
      sendChunk(n)
      busy++
    }
    if (!busy && Object.keys(U.done).length === U.chunks) finish()
  }

  function sendChunk(n) {
    var u = U
    var xhr = new XMLHttpRequest()
    var slot = { xhr: xhr, loaded: 0 }
    u.inflight[n] = slot
    xhr.open('PUT', S.base + '/api/staff/uploads/' + u.id + '/' + n)
    xhr.setRequestHeader('Authorization', authHeader())
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.timeout = 15 * 60000
    xhr.upload.onprogress = function (e) {
      slot.loaded = e.loaded
      tick()
    }
    var settle = function (status, json) {
      if (u !== U || u.stopped) return
      delete u.inflight[n]
      if (status === 200) {
        u.done[n] = true
        u.fails = 0
        u.message = ''
        tick()
        return pump()
      }
      var err = json && json.error
      if (status === 401) return signOut('revoked')
      if (status === 404) return failUpload(problem({ status: 404, json: json }))
      if (status === 403 && err === 'disabled') return failUpload(problem({ status: 403, json: json }))
      if (status === 507) return pauseWith(problem({ status: 507, json: json }))
      if (status === 409 && err === 'finishing') return finish()
      if (status === 400 && err === 'wrong_size') return failUpload('The server expected a different piece of the file (' + err + '). Start the upload again.')
      // anything else (no connection, a dropped request, the server restarting, busy): try again after a pause
      u.fails++
      var wait = Math.min(30, Math.pow(2, Math.min(u.fails, 5))) * 1000
      if (u.fails > 8) return pauseWith('The connection to the office server keeps dropping. Check your internet connection, then choose Resume.')
      u.waitUntil = u.waitUntil || {}
      u.waitUntil[n] = Date.now() + wait
      u.message = status === 0 ? 'Connection lost. Trying again in ' + Math.round(wait / 1000) + ' s…' : 'The server did not take a piece (' + (err || status) + '). Trying again in ' + Math.round(wait / 1000) + ' s…'
      renderUploadStatus()
      setTimeout(pump, wait + 20)
    }
    xhr.onload = function () {
      var j = null
      try {
        j = JSON.parse(xhr.responseText)
      } catch (e) {}
      settle(j ? xhr.status : 0, j)
    }
    xhr.onerror = xhr.ontimeout = function () {
      settle(0, null)
    }
    xhr.onabort = function () {
      if (u.inflight[n] === slot) delete u.inflight[n]
    }
    var start = n * u.chunkBytes
    xhr.send(u.file.slice(start, start + chunkLen(n)))
  }

  function tick() {
    if (!U) return
    var now = Date.now()
    U.sent = sentBytes()
    U.samples.push([now, U.sent])
    while (U.samples.length > 2 && now - U.samples[0][0] > 8000) U.samples.shift()
    var a = U.samples[0]
    if (now - a[0] > 700) U.speed = (U.sent - a[1]) / ((now - a[0]) / 1000)
    if (now - (U.painted || 0) > 200) {
      U.painted = now
      renderUploadStatus()
    }
  }

  function pauseWith(msg) {
    if (!U) return
    U.paused = true
    for (var k in U.inflight) U.inflight[k].xhr.abort()
    U.inflight = {}
    U.message = msg
    U.speed = 0
    U.samples = []
    renderUpload()
  }
  function failUpload(msg) {
    if (!U) return
    stopUpload(false)
    U.state = 'failed'
    U.message = msg
    renderUpload()
  }

  async function finish() {
    var u = U
    if (!u || u.state !== 'uploading') return
    u.state = 'finishing'
    u.message = ''
    renderUpload()
    for (var attempt = 0; u === U && !u.stopped; attempt++) {
      var r = await call('POST', '/api/staff/uploads/' + u.id + '/finish', {}, 60000)
      if (u !== U || !S.pass) return
      if (r.status === 200) return finished(u, r.json)
      if (r.status === 202) {
        u.message = 'Checking the file on the server…'
        renderUploadStatus()
        await sleep(1500)
        continue
      }
      if (r.status === 409 && r.json && r.json.error === 'incomplete') {
        // a piece went missing: ask what the server has and send the rest
        var st = await call('GET', '/api/staff/uploads/' + u.id)
        if (st.status === 200 && st.json.have) {
          u.done = {}
          st.json.have.forEach(function (n) {
            u.done[n] = true
          })
          u.state = 'uploading'
          renderUpload()
          return pump()
        }
      }
      if (r.status === 0 || r.status >= 500 || r.status === 429 || (r.status === 409 && r.json && r.json.error === 'busy')) {
        if (attempt > 20) return failUpload(problem(r))
        u.message = r.status === 0 ? 'Waiting for the office server…' : 'The server is busy; trying again…'
        renderUploadStatus()
        await sleep(Math.min(30000, 2000 * (attempt + 1)))
        continue
      }
      return failUpload(problem(r, u.file.name))
    }
  }

  function finished(u, res) {
    u.state = 'done'
    u.result = res
    u.url = clientUrl(res.id)
    store('dxs-pw-' + u.id, null)
    renderUpload()
    void loadLinks()
  }

  function renderUpload() {
    var c = refs.left
    var u = U
    if (!c || !u) return
    var kids = [heading(u.state === 'done' ? 'Sent to our office' : u.state === 'failed' ? 'Upload stopped' : 'Uploading', 'new-h', u.state === 'done' ? 'Link ready' : 'New link')]
    var fileLine = h('div', { class: 'fname' }, h('span', { class: 'ext', text: extOf(u.file.name) }), h('span', { class: 'fn' }, h('b', { text: u.file.name }), h('small', { class: 'tn', text: fmtBytes(u.file.size) })))
    if (u.state === 'done') {
      var link = h('input', { class: 'in mono', id: 'result-link', readonly: true, value: u.url, 'aria-label': 'Client link', on: { focus: function () {
        link.select()
      } } })
      var email = function () {
        var l = linkOf(u.id) || {}
        var m = buildEmail({ url: u.url, title: l.title || titleOf(u), message: l.message != null ? l.message : F.note, sender: l.sender || S.me.name, company: S.cfg.company, files: [{ name: safeFileName(u.file.name), size: u.file.size }], expiresAt: u.result.expiresAt - S.skew, hasPassword: !!u.password || !!l.hasPassword })
        return 'Subject: ' + m.subject + '\r\n\r\n' + m.body
      }
      kids.push(
        h('div', { class: 'plate done' }, fileLine, flow('done reverse')),
        h('p', { class: 'ok-line reveal' }, h('b', { text: safeFileName(u.file.name) }), ' is ready for your client. The link expires on ' + fmtExpiryDate(u.result.expiresAt - S.skew) + '.'),
        h('div', { class: 'field reveal' }, h('label', { class: 'lbl eyebrow', for: 'result-link', text: 'Client link' }), link),
        h('div', { class: 'row reveal' },
          h('button', { class: 'btn primary', type: 'button', id: 'copy-link', text: 'Copy link', on: { click: function () {
            copy(u.url, 'Link copied')
          } } }),
          h('button', { class: 'btn', type: 'button', id: 'copy-email', text: 'Copy e-mail text', on: { click: function () {
            copy(email(), 'E-mail text copied')
          } } }))
      )
      if (u.password) {
        kids.push(h('div', { class: 'pwbox reveal', role: 'note' },
          h('span', { class: 'lbl eyebrow', text: 'Password (shown only now)' }),
          h('div', { class: 'pwrow' }, h('code', { id: 'result-pw', class: 'pw', text: u.password }), h('button', { class: 'btn sm', type: 'button', id: 'copy-pw', text: 'Copy password', on: { click: function () {
            copy(u.password, 'Password copied')
          } } })),
          h('small', null, 'Send the password separately from the link, for example by phone or text message. Never in the same e-mail.')))
      } else if (u.resumed && hasPasswordOnServer(u.id)) {
        kids.push(h('p', { class: 'muted reveal', text: 'This link is password protected with the password you chose when you started the upload.' }))
      }
      kids.push(h('button', { class: 'btn ghost reveal', type: 'button', id: 'another', text: 'Make another link', on: { click: function () {
        U = null
        F.file = null
        F.password = ''
        F.note = ''
        F.title = ''
        F.titleTouched = false
        F.resume = null
        renderLeft()
        var d = document.getElementById('file')
        if (d) d.focus()
      } } }))
    } else {
      var pct = Math.floor((u.sent / u.file.size) * 100)
      var bar = h('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Upload progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, h('i', { id: 'bar-fill' }))
      kids.push(
        h('div', { class: 'plate' }, fileLine, flow('flowing reverse', 'up-route'),
          h('div', { class: 'prog' }, h('div', { class: 'pct tn', id: 'pct' }), bar, h('div', { class: 'meta tn', id: 'meta' }))),
        h('p', { class: 'msg', id: 'up-msg', role: 'status' })
      )
      var row = h('div', { class: 'row' })
      if (u.state === 'uploading') {
        row.appendChild(h('button', { class: 'btn', type: 'button', id: 'pause', text: u.paused ? 'Resume' : 'Pause', on: { click: function () {
          if (u.paused) {
            u.paused = false
            u.fails = 0
            u.waitUntil = {}
            u.message = ''
            renderUpload()
            pump()
          } else pauseWith('Paused. Nothing is lost; choose Resume to carry on.')
        } } }))
        row.appendChild(cancelButton(u))
      } else if (u.state === 'failed') {
        row.appendChild(h('button', { class: 'btn', type: 'button', text: 'Start again', on: { click: async function () {
          await call('DELETE', '/api/staff/uploads/' + u.id)
          U = null
          F.resume = null
          await loadLinks()
          renderLeft()
        } } }))
      }
      kids.push(row)
    }
    c.replaceChildren.apply(c, kids)
    renderUploadStatus()
  }

  function linkOf(id) {
    return S.links.filter(function (x) {
      return x.id === id
    })[0]
  }
  function hasPasswordOnServer(id) {
    var l = linkOf(id)
    return !!(l && l.hasPassword)
  }
  function titleOf(u) {
    var l = S.links.filter(function (x) {
      return x.id === u.id
    })[0]
    return (l && l.title) || F.title.trim() || safeFileName(u.file.name)
  }

  function cancelButton(u) {
    var b = h('button', { class: 'btn danger', type: 'button', id: 'cancel', text: 'Cancel', on: { click: function () {
      var row = b.parentNode
      var yes = h('button', { class: 'btn danger', type: 'button', id: 'cancel-yes', text: 'Yes, cancel the upload', on: { click: async function () {
        yes.disabled = true
        stopUpload(false)
        await call('DELETE', '/api/staff/uploads/' + u.id)
        store('dxs-pw-' + u.id, null)
        U = null
        F.resume = null
        toast('Upload cancelled')
        await loadLinks()
        renderLeft()
      } } })
      var no = h('button', { class: 'btn', type: 'button', text: 'Keep uploading', on: { click: function () {
        renderUpload()
      } } })
      row.replaceChildren(h('span', { class: 'ask', text: 'Cancel? What was sent is deleted.' }), yes, no)
      yes.focus()
    } } })
    return b
  }

  function renderUploadStatus() {
    var u = U
    if (!u || u.state === 'done') return
    var pctEl = document.getElementById('pct')
    if (!pctEl) return
    var pct = u.state === 'finishing' ? 100 : Math.min(100, Math.floor((u.sent / u.file.size) * 1000) / 10)
    pctEl.textContent = u.state === 'finishing' ? 'Checking…' : pct + '%'
    var fill = document.getElementById('bar-fill')
    fill.style.width = pct + '%'
    fill.parentNode.setAttribute('aria-valuenow', String(Math.floor(pct)))
    var meta = document.getElementById('meta')
    var bits = [fmtBytes(Math.min(u.sent, u.file.size)) + ' of ' + fmtBytes(u.file.size)]
    if (u.state === 'uploading' && !u.paused && u.speed > 0) {
      bits.push(fmtBytes(Math.round(u.speed)) + '/s')
      bits.push(fmtDuration((u.file.size - u.sent) / u.speed))
    }
    if (u.state === 'finishing') bits = ['All ' + fmtBytes(u.file.size) + ' sent; the server is checking the file']
    meta.textContent = bits.join(' · ')
    var msg = document.getElementById('up-msg')
    msg.textContent = u.message || (u.state === 'failed' ? 'The upload stopped.' : '')
    msg.className = 'msg' + (u.state === 'failed' ? ' err' : u.paused ? ' warn' : '')
    // the line and the pipe show the same state as the words (presentation only)
    var look = upLook(u)
    var r = document.getElementById('up-route')
    if (r && r.getAttribute('class') !== 'route reverse ' + look[0]) r.setAttribute('class', 'route reverse ' + look[0])
    var barCls = 'bar' + (look[1] ? ' ' + look[1] : '')
    if (fill.parentNode.className !== barCls) fill.parentNode.className = barCls
  }
  /** [route state, bar state] for an upload in progress. */
  function upLook(u) {
    var m = u.message || ''
    if (u.state === 'failed') return ['valved shut', 'bad']
    if (/^(Connection lost|Waiting for the office server)|keeps dropping/.test(m)) return ['broken', 'wait']
    if (u.paused || /busy|did not take a piece/.test(m)) return ['valved busy', 'wait']
    if (u.state === 'finishing') return ['flowing', 'slow']
    return ['flowing', '']
  }

  // ---- right card: your links --------------------------------------------------------------------
  async function loadLinks() {
    var r = await call('GET', '/api/staff/links')
    if (!S.pass) return
    var before = JSON.stringify(S.uploads.map(function (x) {
      return [x.id, x.received]
    }))
    if (r.status === 200) {
      if (typeof r.json.now === 'number') S.skew = r.json.now - Date.now()
      S.links = r.json.links || []
      S.uploads = (r.json.uploads || []).filter(function (x) {
        return x.state !== 'finishing' && (!U || x.id !== U.id)
      })
      S.linksError = ''
    } else S.linksError = problem(r)
    renderLinks()
    if (U && U.state === 'done' && U.resumed && !U.password) renderUpload() // can now say whether it has a password
    var after = JSON.stringify(S.uploads.map(function (x) {
      return [x.id, x.received]
    }))
    // the form is drawn again only when the unfinished list changed (what is typed stays in F)
    if (!U && refs.left && before !== after) {
      if (F.file && !F.resume) chooseFileQuiet()
      renderLeft()
    }
  }
  function chooseFileQuiet() {
    var name = safeFileName(F.file.name)
    S.uploads.forEach(function (u) {
      if (u.name === name && u.size === F.file.size) F.resume = u
    })
  }

  function statusOf(l) {
    if (S.off[l.id]) return ['Switched off', 'off']
    if (l.expiresAt <= serverNow()) return ['Expired', 'off']
    var d = daysLeft(l.expiresAt)
    if (d <= 3) return [d <= 1 ? 'Last day' : d + ' days left', 'soon']
    return ['Active', 'ok']
  }

  function renderLinks() {
    var c = refs.right
    if (!c) return
    var rows = S.links.slice()
    Object.keys(S.off).forEach(function (id) {
      if (!rows.some(function (l) {
        return l.id === id
      })) rows.push(S.off[id])
    })
    rows.sort(function (a, b) {
      return b.createdAt - a.createdAt
    })
    var t = serverNow()
    var active = S.links.filter(function (l) {
      return l.expiresAt > t
    })
    var downloads = S.links.reduce(function (a, l) {
      return a + (l.downloads || 0)
    }, 0)
    var week = active.filter(function (l) {
      return l.expiresAt - t < 7 * DAY
    }).length
    // title-block cells: the figure first for screen readers ("3 active"), the label drawn above it
    var cell = function (n, label) {
      return h('div', { class: 'stat' }, h('b', { class: 'tn', text: String(n) }), h('span', { class: 'eyebrow', text: ' ' + label }))
    }
    var kids = [
      h('div', { class: 'head' }, heading('Register', 'links-h', 'Your links'), h('button', { class: 'btn sm', type: 'button', text: 'Refresh', on: { click: function () {
        void loadLinks()
      } } })),
      h('div', { class: 'stats', id: 'counts' },
        cell(active.length, 'active'),
        cell(downloads, downloads === 1 ? 'download' : 'downloads'),
        cell(week, (week === 1 ? 'expires' : 'expire') + ' this week'))
    ]
    if (S.linksError) kids.push(h('p', { class: 'err', role: 'alert', text: S.linksError }))
    if (!rows.length) {
      kids.push(h('p', { class: 'muted empty', text: S.linksError ? '' : 'No links yet. Links you make here or in Hopper appear in this list.' }))
    } else {
      var tb = h('tbody')
      rows.forEach(function (l) {
        tb.appendChild(linkRow(l))
      })
      kids.push(h('div', { class: 'tw' }, h('table', { class: 'links' },
        h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'File' }), h('th', { scope: 'col', text: 'Downloads' }), h('th', { scope: 'col', text: 'Expires' }), h('th', { scope: 'col', text: 'Status' }), h('th', { scope: 'col' }, h('span', { class: 'sr', text: 'Actions' })))),
        tb)))
    }
    c.replaceChildren.apply(c, kids)
  }

  function linkRow(l) {
    var st = statusOf(l)
    var file = l.files && l.files.length === 1 ? l.files[0].name : plural((l.files || []).length, 'file')
    var tr = h('tr', { 'data-id': l.id },
      h('td', { class: 'f', 'data-label': 'File' }, h('b', { text: l.title && l.title !== file ? l.title : file }), h('small', { class: 'tn', text: (l.title && l.title !== file ? file + ' · ' : '') + fmtBytes(l.bytes) + ' · ' + madeText(l.createdAt) + (l.hasPassword ? ' · password' : '') })),
      h('td', { class: 'tn', 'data-label': 'Downloads', text: S.off[l.id] ? '–' : String(l.downloads || 0) }),
      h('td', { class: 'tn', 'data-label': 'Expires', text: dayText(l.expiresAt) }),
      h('td', { 'data-label': 'Status' }, h('span', { class: 'pill ' + st[1], text: st[0] })),
      h('td', { class: 'acts' }))
    fillActions(tr.lastChild, l)
    return tr
  }

  function fillActions(cell, l) {
    cell.replaceChildren()
    if (S.off[l.id]) return
    var expired = l.expiresAt <= serverNow()
    if (!expired) cell.appendChild(h('button', { class: 'act', type: 'button', text: 'Copy', 'aria-label': 'Copy the link for ' + l.title, on: { click: function () {
      copy(clientUrl(l.id), 'Link copied')
    } } }))
    cell.appendChild(h('button', { class: 'act', type: 'button', text: 'Renew', 'aria-label': 'Renew ' + l.title, on: { click: function () {
      var sel = h('select', { class: 'in sm', 'aria-label': 'Days to add' })
      S.me.limits.days.forEach(function (d) {
        sel.appendChild(h('option', { value: String(d), text: '+' + plural(d, 'day') }))
      })
      sel.value = '7'
      var ok = h('button', { class: 'act', type: 'button', text: 'Renew', on: { click: async function () {
        ok.disabled = true
        var r = await call('POST', '/api/staff/links/' + l.id + '/renew', { days: Number(sel.value) })
        if (r.status === 200) {
          toast('Now expires on ' + fmtExpiryDate(r.json.expiresAt - S.skew))
          await loadLinks()
        } else {
          toast(problem(r))
          fillActions(cell, l)
        }
      } } })
      cell.replaceChildren(sel, ok, h('button', { class: 'act', type: 'button', text: 'Cancel', on: { click: function () {
        fillActions(cell, l)
      } } }))
      sel.focus()
    } } }))
    cell.appendChild(h('button', { class: 'act r', type: 'button', text: 'Switch off', 'aria-label': 'Switch off ' + l.title, on: { click: function () {
      var yes = h('button', { class: 'act r', type: 'button', text: 'Yes, switch off', on: { click: async function () {
        yes.disabled = true
        var r = await call('POST', '/api/staff/links/' + l.id + '/revoke', {})
        if (r.status === 200 || r.status === 404) {
          S.off[l.id] = l
          toast('Link switched off. The client can no longer download.')
          await loadLinks()
        } else {
          toast(problem(r))
          fillActions(cell, l)
        }
      } } })
      cell.replaceChildren(h('span', { class: 'ask', text: 'The client loses access.' }), yes, h('button', { class: 'act', type: 'button', text: 'Keep', on: { click: function () {
        fillActions(cell, l)
      } } }))
      yes.focus()
    } } }))
  }

  // ---- start ----------------------------------------------------------------------------------------
  async function start(fresh) {
    if (!S.pass) return showSignedOut()
    S.gist = S.pass.gist || ''
    S.keyHash = S.pass.key || ''
    if (!S.cfg) {
      try {
        var r = await timedFetch('../config.json', { cache: 'no-cache' }, 10000)
        S.cfg = await r.json()
      } catch (e) {
        S.cfg = { base: '', pointers: [], allowedHosts: ['*.trycloudflare.com'] } // config.json is optional
      }
    }
    var res = await connect(fresh === true)
    if (!S.pass) return
    if (res.kind === 'ok') {
      S.me = res.me
      if (typeof res.me.now === 'number') S.skew = res.me.now - Date.now()
      F.days = S.me.limits.defaultDays || 7
      showWorkbench()
      if (S.memoryOnly) toast('This browser does not let the page remember you: bookmarking will not keep you signed in.')
      return
    }
    if (res.kind === 'signed_out') return signOut('revoked')
    if (res.kind === 'disabled') return showDisabled()
    if (res.kind === 'busy') {
      await sleep(Math.min(120, res.retry) * 1000)
      return start(true)
    }
    showUnreachable(res.configured)
  }

  // theme: the system's, or the one chosen here (shared with the client page)
  var root = document.documentElement
  try {
    var saved = localStorage.getItem('hopper-theme')
    if (saved === 'dark' || saved === 'light') root.dataset.theme = saved
  } catch (e) {}
  document.getElementById('theme').addEventListener('click', function () {
    var dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
    root.dataset.theme = dark ? 'light' : 'dark'
    local('hopper-theme', root.dataset.theme)
  })
  signoutBtn.addEventListener('click', function () {
    var bar = signoutBtn.parentNode
    var yes = h('button', { class: 'nav-btn strong', type: 'button', text: 'Yes, sign out', on: { click: function () {
      bar.removeChild(ask)
      signoutBtn.hidden = false
      signOut('manual')
    } } })
    var no = h('button', { class: 'nav-btn', type: 'button', text: 'Stay signed in', on: { click: function () {
      bar.removeChild(ask)
      signoutBtn.hidden = false
      signoutBtn.focus()
    } } })
    var ask = h('span', { class: 'nav-ask' }, U && U.state === 'uploading' ? 'Signing out stops the upload. ' : '', yes, no)
    signoutBtn.hidden = true
    bar.insertBefore(ask, signoutBtn)
    yes.focus()
  })

  S.pass = takeFragment() || readPass()
  void start()
})()
