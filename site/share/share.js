// Dexterity Share client page — (c) Dexterity Design Services Private Limited.
// Reads the link id from the address fragment (so it never reaches this site's host), finds the
// office share server (fixed address from config.json, or the signed pointer file), and shows the
// files. Every piece of text that comes from the server is put on the page as text, never as HTML.
;(function () {
  'use strict'

  // "<id>" or "<id>.<gist id>.<key fingerprint>": the second form tells this page where the office
  // publishes its server address and which key must have signed it, so no per-office setup is needed here.
  var LINK_RE = /^([a-z2-7]{26})(?:\.([0-9a-f]{20,40})\.([0-9a-f]{20}))?$/
  var card = document.getElementById('card')
  var toastEl = document.getElementById('toast')
  var LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
  var S = { id: '', gist: '', keyHash: '', cfg: null, base: '', meta: null, files: null, token: '', skew: 0, timers: [], run: 0, active: 0 }

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

  var ICONS = {
    download: ['M10 3v9.5', 'M6 9l4 4 4-4', 'M4 16.5h12'],
    lock: ['M5 9h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z', 'M7 9V6.5a3 3 0 0 1 6 0V9'],
    clock: ['M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M10 6v4.2l2.6 1.6'],
    info: ['M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M10 9v4.5', 'M10 6.3v.4'],
    check: ['M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M6.8 10.2l2.2 2.2 4.2-4.6'],
    warn: ['M10 3.2 17.5 16h-15z', 'M10 8v3.6', 'M10 13.7v.4'],
    cloudOff: ['M5.5 15.5a3.5 3.5 0 0 1-.6-6.95A5 5 0 0 1 14.6 7.4a4 4 0 0 1 .9 7.9', 'M3 3l14 14'],
    unlink: ['M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.9.9', 'M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l.9-.9', 'M3 3l14 14'],
    box: ['M3.5 6.5 10 3l6.5 3.5v7L10 17l-6.5-3.5z', 'M3.5 6.5 10 10l6.5-3.5', 'M10 10v7'],
    shield: ['M10 2.5 16 5v5c0 3.6-2.5 6.5-6 7.5-3.5-1-6-3.9-6-7.5V5z', 'M7.3 10.2l1.9 1.9 3.6-3.9'],
    folder: ['M3 6a1.5 1.5 0 0 1 1.5-1.5h3l1.5 2h6.5A1.5 1.5 0 0 1 17 8v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z']
  }
  function icon(name, cls) {
    var ns = 'http://www.w3.org/2000/svg'
    var svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 20 20')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.6')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('class', cls || 'ico')
    ICONS[name].forEach(function (d) {
      var p = document.createElementNS(ns, 'path')
      p.setAttribute('d', d)
      svg.appendChild(p)
    })
    return svg
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
  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's')
  }
  function fmtDuration(sec) {
    if (!isFinite(sec) || sec <= 0) return ''
    if (sec < 60) return Math.ceil(sec) + ' s left'
    if (sec < 3600) return Math.ceil(sec / 60) + ' min left'
    return Math.floor(sec / 3600) + ' h ' + Math.round((sec % 3600) / 60) + ' min left'
  }
  var dateFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  var timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })
  function serverNow() {
    return Date.now() + S.skew
  }
  /** "in 5 days", "in 7 hours" … measured against the server's clock, so a wrong PC clock cannot mislead. */
  function expiryText(expiresAt) {
    var left = expiresAt - serverNow()
    var when = new Date(expiresAt - S.skew)
    var d = dateFmt.format(when).replace(',', '')
    if (left <= 0) return { rel: 'expired', abs: d, soon: true, over: true }
    var rel
    if (left >= 47.5 * 3600e3) rel = 'in ' + Math.round(left / 86400e3) + ' days'
    else if (left >= 3600e3) rel = 'in ' + plural(Math.round(left / 3600e3), 'hour')
    else rel = 'in ' + plural(Math.max(1, Math.round(left / 60e3)), 'minute')
    var soon = left < 48 * 3600e3
    return { rel: rel, abs: soon ? d + ', ' + timeFmt.format(when) : d, soon: soon, over: false }
  }
  var TYPES = {
    zip: ['ZIP', 'ZIP archive', ''], '7z': ['7Z', '7-Zip archive', ''], rar: ['RAR', 'RAR archive', ''],
    pdf: ['PDF', 'PDF document', 'pdf'], dwg: ['DWG', 'AutoCAD drawing', 'cad'], dxf: ['DXF', 'CAD drawing', 'cad'], dgn: ['DGN', 'MicroStation drawing', 'cad'],
    rvm: ['RVM', '3D model', 'cad'], nwd: ['NWD', 'Navisworks model', 'cad'], ifc: ['IFC', '3D model', 'cad'], step: ['STEP', '3D model', 'cad'], stp: ['STP', '3D model', 'cad'],
    xlsx: ['XLS', 'Excel workbook', 'sheet'], xls: ['XLS', 'Excel workbook', 'sheet'], csv: ['CSV', 'CSV table', 'sheet'],
    docx: ['DOC', 'Word document', ''], doc: ['DOC', 'Word document', ''], pptx: ['PPT', 'PowerPoint deck', ''], txt: ['TXT', 'Text file', 'other'],
    png: ['PNG', 'Image', 'other'], jpg: ['JPG', 'Image', 'other'], jpeg: ['JPG', 'Image', 'other'], tif: ['TIF', 'Image', 'other'], tiff: ['TIF', 'Image', 'other'], mp4: ['MP4', 'Video', 'other']
  }
  function fileType(name) {
    var m = /\.([A-Za-z0-9]{1,5})$/.exec(name)
    var ext = m ? m[1].toLowerCase() : ''
    return TYPES[ext] || [ext ? ext.toUpperCase().slice(0, 4) : 'FILE', ext ? ext.toUpperCase() + ' file' : 'File', 'other']
  }
  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean)
    if (!parts.length) return 'D'
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
  }
  var toastTimer
  function toast(text) {
    toastEl.textContent = text
    toastEl.classList.add('on')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('on')
    }, 2400)
  }
  function copy(text, done) {
    var ok = function () {
      toast(done || 'Copied')
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, function () {
      toast('Select the text and copy it')
    })
    else toast('Select the text and copy it')
  }
  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms)
    })
  }
  function store(key, value) {
    try {
      if (value === undefined) return sessionStorage.getItem(key)
      if (value === null) sessionStorage.removeItem(key)
      else sessionStorage.setItem(key, value)
    } catch (e) {}
    return null
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

  function clearTimers() {
    S.timers.forEach(function (t) {
      clearInterval(t)
      clearTimeout(t)
    })
    S.timers = []
  }
  /** Swap the card's content, move focus to the new heading and announce it. */
  function show(view) {
    clearTimers()
    view.classList.add('view')
    card.replaceChildren(view)
    card.setAttribute('aria-busy', 'false')
    var head = view.querySelector('h1')
    if (head) {
      head.setAttribute('tabindex', '-1')
      head.focus({ preventScroll: true })
    }
  }

  // ---- finding the server ---------------------------------------------------------------------
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

  /** Ask one address for the link. Resolves to {kind, ...}; "unreachable" means try elsewhere or later. */
  async function ask(base) {
    var r
    try {
      r = await timedFetch(base + '/api/s/' + S.id + (S.token ? '?t=' + encodeURIComponent(S.token) : ''), { cache: 'no-store' }, 20000)
    } catch (e) {
      return { kind: 'unreachable' }
    }
    var j = null
    try {
      j = await r.json()
    } catch (e) {}
    if (r.status === 200 && j && j.v === 1 && typeof j.title === 'string') return { kind: 'ok', meta: j }
    if (r.status === 404 && j && j.error === 'not_found') return { kind: 'notfound' }
    if (r.status === 410 && j && j.error === 'expired') return { kind: 'expired' }
    if (r.status === 429) return { kind: 'busy', retry: Number(r.headers.get('Retry-After')) || 30 }
    return { kind: 'unreachable' } // anything else is not our server speaking (a tunnel error page, a proxy…)
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

  // ---- views ----------------------------------------------------------------------------------
  function kids(el, list) {
    list.forEach(function (c) {
      if (c != null && c !== false) el.appendChild(typeof c === 'string' ? h('p', { text: c }) : c)
    })
    return el
  }
  /** Every view has two columns: the blue panel says what this is, the work column holds what to do. */
  function split(cls, side, main) {
    return h('div', { class: 'split' + (cls ? ' ' + cls : '') }, kids(h('div', { class: 'side' }), side), kids(h('div', { class: 'main' }), main))
  }
  function stateView(kind, glyph, title, paras, actions) {
    var main = [h('h2', { class: 'label', text: 'What to do' })].concat(paras)
    if (actions && actions.length) main.push(kids(h('div', { class: 'actions' }), actions))
    return split('state ' + kind, [h('div', { class: 'glyph' }, icon(glyph)), h('h1', { text: title })], main)
  }

  function showLoading(note) {
    clearTimers()
    var n = h('p', { class: 'loading-note', role: 'status', text: note || 'Opening your link…' })
    var v = split('loading', [h('div', { class: 'sk sk-hero' }), h('div', { class: 'sk sk-hero short' }), h('div', { class: 'sk sk-line' })],
      [h('div', { class: 'sk sk-label' }), h('div', { class: 'sk sk-row' }), h('div', { class: 'sk sk-row' }), h('div', { class: 'sk sk-btn' }), n])
    card.replaceChildren(v)
    card.setAttribute('aria-busy', 'true')
    S.timers.push(setTimeout(function () {
      n.textContent = 'Still connecting — our file server may be on a slow link. One moment…'
    }, 6000))
  }

  function showNoLink() {
    show(stateView('muted', 'unlink', 'This page needs your download link', [
      'Open the complete link from the e-mail you received. If you typed or pasted it, part of it may be missing — it ends with a long code after a # sign.',
      h('p', { class: 'small', text: 'If the link was split across two lines in the e-mail, copy both parts into the address bar.' })
    ]))
  }
  function showNotFound() {
    show(stateView('muted', 'unlink', 'This link is no longer available', [
      'The files may have been withdrawn by the sender, or the link expired some time ago and its files were removed.',
      'Please ask the person who sent you the link for a new one.'
    ]))
  }
  function showExpired() {
    show(stateView('warn', 'clock', 'This link has expired', [
      'For your security, download links from Dexterity Design Services stop working after the date chosen by the sender.',
      'Please reply to the e-mail that brought you here and ask for a fresh link — it only takes us a moment.'
    ]))
  }
  function showBusy(retry) {
    var left = Math.min(Math.max(retry, 5), 120)
    var count = h('span', { class: 'countdown', text: String(left) })
    show(stateView('muted', 'clock', 'One moment — the server is busy', [h('p', null, 'Trying again in ', count, ' s.')], [h('button', { class: 'btn', type: 'button', text: 'Try now', on: { click: start } })]))
    S.timers.push(setInterval(function () {
      if (--left <= 0) start()
      else count.textContent = String(left)
    }, 1000))
  }

  var retryStep = 0
  function showUnreachable(configured) {
    if (!configured) {
      show(stateView('warn', 'cloudOff', 'This service is not set up yet', ['The download page has not been connected to the office file server. Please let the sender know.']))
      return
    }
    var waits = [5, 10, 20, 30, 60]
    var left = waits[Math.min(retryStep, waits.length - 1)]
    retryStep++
    var offline = navigator.onLine === false
    var count = h('span', { class: 'countdown', text: String(left) })
    var v = stateView('warn', 'cloudOff', offline ? 'You appear to be offline' : "We can't reach our file server right now", offline ? ['Check your internet connection. This page will carry on by itself as soon as you are back online.'] : [
      'This is usually brief — a short internet or power interruption at our office. Your link is still valid; nothing is lost.',
      h('p', null, 'Trying again automatically in ', count, ' s.')
    ], [h('button', { class: 'btn primary', type: 'button', text: 'Try again now', on: { click: function () {
      start(true)
    } } })])
    v.querySelector('.main').appendChild(h('p', { class: 'small', text: retryStep > 3 ? 'Still not working? Please reply to the e-mail that brought you here so we can check the server.' : 'You can leave this page open.' }))
    show(v)
    S.timers.push(setInterval(function () {
      if (--left <= 0) start(true)
      else count.textContent = String(left)
    }, 1000))
  }

  /** The blue panel of a link: "N files are ready for you.", the link title, who sent it, their note, size and expiry. */
  function headView(meta, locked) {
    var head = []
    var n = meta.fileCount
    var one = n === 1
    head.push(h('p', { class: 'hero' }, h('span', { class: 'n', text: one ? (locked ? 'A file' : 'Your file') : n + ' files' }), (one ? ' is ' : ' are ') + (locked ? 'waiting for you.' : 'ready for you.')))
    head.push(h('h1', { class: 'title', text: meta.title }))
    var sent = typeof meta.createdAt === 'number' ? ' on ' + dateFmt.format(new Date(meta.createdAt - S.skew)).replace(',', '') : ''
    head.push(h('div', { class: 'from' }, h('div', { class: 'avatar', 'aria-hidden': 'true', text: initials(meta.sender) }),
      h('span', null, h('b', { text: meta.sender || 'Dexterity Design Services' }), ' sent you ' + (one ? 'a file' : n + ' files') + sent)))
    var pills = h('div', { class: 'pills' })
    pills.appendChild(h('span', { class: 'pill' }, icon('box'), h('b', { text: fmtBytes(meta.totalSize) }), n === 1 ? '' : ' in ' + n + ' files'))
    var ex = h('span', { class: 'pill' })
    var paint = function () {
      var e = expiryText(meta.expiresAt)
      if (e.over) return showExpired()
      ex.className = 'pill' + (e.soon ? ' soon' : '')
      ex.replaceChildren(icon('clock'), 'Expires ', h('b', { text: e.rel }), ' · ' + e.abs)
    }
    paint()
    pills.appendChild(ex)
    if (meta.needsPassword) pills.appendChild(h('span', { class: 'pill' }, icon('lock'), 'Password protected'))
    if (meta.message) head.push(h('blockquote', { class: 'message', text: meta.message }))
    head.push(pills)
    head.tick = paint
    return head
  }

  function showLocked(meta, problem) {
    var input = h('input', { id: 'pw', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-describedby': 'pw-err', required: true })
    var err = h('p', { class: 'err', id: 'pw-err', role: 'alert', text: problem || '' })
    var btn = h('button', { class: 'btn primary', type: 'submit' }, icon('lock'), 'Unlock')
    var showPw = h('input', { type: 'checkbox', on: { change: function () {
      input.type = showPw.checked ? 'text' : 'password'
    } } })
    var form = h('form', { class: 'lock', novalidate: true }, h('label', { for: 'pw', text: 'Password' }), h('div', { class: 'field' }, input, btn), err, h('label', { class: 'show' }, showPw, 'Show password'))
    form.addEventListener('submit', async function (e) {
      e.preventDefault()
      if (btn.disabled) return // a check is already on its way
      var pw = input.value
      if (!pw) {
        err.textContent = 'Enter the password the sender gave you.'
        input.setAttribute('aria-invalid', 'true')
        return input.focus()
      }
      btn.disabled = true
      btn.replaceChildren(h('span', { class: 'spin' }), 'Checking…')
      var r = null
      var j = null
      try {
        r = await timedFetch(S.base + '/api/s/' + S.id + '/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }), cache: 'no-store' }, 30000)
        j = await r.json().catch(function () {
          return null
        })
      } catch (e2) {}
      btn.disabled = false
      btn.replaceChildren(icon('lock'), 'Unlock')
      if (r && r.status === 200 && j && j.token) {
        S.token = j.token
        store('dxs-t-' + S.id, j.token)
        S.files = j.files
        meta.unlocked = true
        return showReady(meta)
      }
      input.setAttribute('aria-invalid', 'true')
      if (r && r.status === 403) {
        var left = j && typeof j.attemptsLeft === 'number' ? j.attemptsLeft : null
        err.textContent = "That password isn't right." + (left === 0 ? ' No attempts left for now.' : left != null && left <= 3 ? ' ' + plural(left, 'attempt') + ' left.' : ' Check for capital letters and try again.')
        input.select()
      } else if (r && r.status === 429) {
        var mins = Math.max(1, Math.ceil((Number(r.headers.get('Retry-After')) || 600) / 60))
        err.textContent = 'Too many wrong attempts. For security, please wait ' + plural(mins, 'minute') + ' before trying again.'
      } else if (r && r.status === 404) showNotFound()
      else if (r && r.status === 410) showExpired()
      else err.textContent = "We couldn't reach the server. Check your connection and try again."
    })
    var head = headView(meta, true)
    // the page has one h1: the link title stays the heading, the password field is the focus target
    var v = split('locked', head, [h('div', { class: 'lock-glyph' }, icon('lock')), h('h2', { class: 'ask', text: 'Enter the password to see your files' }),
      h('p', { text: 'The sender protected this link. They will have given you the password separately — by phone or in another message.' }), form])
    show(v)
    v.querySelector('h1').removeAttribute('tabindex')
    S.timers.push(setInterval(head.tick, 30000))
    input.focus({ preventScroll: true })
  }

  // ---- downloads ------------------------------------------------------------------------------
  function fileUrl(f) {
    return S.base + '/d/' + S.id + '/' + f.n + (S.token ? '?t=' + encodeURIComponent(S.token) : '')
  }
  /** A quick look before the browser takes over, so a problem is explained here rather than on a bare error page. */
  async function precheck(f) {
    var r
    try {
      r = await timedFetch(fileUrl(f), { method: 'HEAD', cache: 'no-store' }, 15000)
    } catch (e) {
      return { kind: 'unreachable' }
    }
    if (r.status === 200) return { kind: 'ok' }
    if (r.status === 401) return { kind: 'locked' }
    if (r.status === 404) return { kind: 'notfound' }
    if (r.status === 409) return { kind: 'changed' }
    if (r.status === 410) return { kind: 'gone' } // expired, or the link's download limit is used up
    if (r.status === 429) return { kind: 'busy', retry: Number(r.headers.get('Retry-After')) || 30 }
    return { kind: 'unavailable' }
  }
  function problemText(p) {
    if (p.kind === 'busy') return 'The server is handling many downloads right now. Please try again in ' + (p.retry >= 90 ? Math.ceil(p.retry / 60) + ' minutes.' : 'about ' + p.retry + ' seconds.')
    if (p.kind === 'changed') return 'This file was changed on our side after the link was made, so we will not send it. Please ask the sender for a new link.'
    if (p.kind === 'limit') return 'This file has reached the number of downloads the sender allowed. Please ask the sender for a new link.'
    if (p.kind === 'unavailable') return 'This file is temporarily unavailable on our server. Please try again in a few minutes, or reply to the sender.'
    if (p.kind === 'unreachable') return navigator.onLine === false ? 'You appear to be offline. Check your connection and try again.' : "We couldn't reach our file server just now. Please try again in a moment."
    return 'This download is not available.'
  }
  /** Handles the problems that change the whole page; returns true when it did. */
  function fatal(p) {
    if (p.kind === 'locked') {
      S.token = ''
      store('dxs-t-' + S.id, null)
      showLocked(S.meta, 'Your access has timed out. Please enter the password again.')
      return true
    }
    if (p.kind === 'notfound') return showNotFound(), true
    if (p.kind === 'gone') {
      // expired while the page was open: show that; otherwise it is the sender's download limit
      if (!S.meta || serverNow() >= S.meta.expiresAt) return start(), true
      p.kind = 'limit'
    }
    return false
  }
  function navigate(f) {
    var a = h('a', { href: fileUrl(f), rel: 'noopener' })
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  var canSave = typeof window.showSaveFilePicker === 'function' && typeof window.DxSha256 === 'function'
  var canFolder = typeof window.showDirectoryPicker === 'function' && typeof window.DxSha256 === 'function'
  window.addEventListener('beforeunload', function (e) {
    if (S.active > 0) {
      e.preventDefault()
      e.returnValue = ''
    }
  })
  function safeName(name) {
    return String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || 'download'
  }

  /**
   * Download one file straight to disk with progress, automatic resume and a checksum at the end.
   * (Chromium browsers only: it needs the File System Access API. Nothing is buffered in memory.)
   */
  async function streamTo(f, handle, ui) {
    var size = f.size
    var writable = await handle.createWritable()
    var sha = new window.DxSha256()
    var got = 0
    var etag = ''
    var fails = 0
    var ctl = null
    var cancelled = false
    var marks = []
    ui.cancel = function () {
      cancelled = true
      if (ctl) ctl.abort()
    }
    var paint = function (text, cls) {
      var now = Date.now()
      marks.push([now, got])
      while (marks.length > 2 && now - marks[0][0] > 6000) marks.shift()
      var dt = (now - marks[0][0]) / 1000
      var rate = dt > 0.5 ? (got - marks[0][1]) / dt : 0
      ui.update({ got: got, size: size, rate: rate, text: text, cls: cls })
    }
    S.active++
    try {
      for (;;) {
        try {
          ctl = new AbortController()
          var headers = {}
          if (got > 0) {
            headers.Range = 'bytes=' + got + '-'
            if (etag) headers['If-Range'] = etag
          }
          paint(got ? 'Reconnecting…' : 'Connecting…')
          var r = await fetch(fileUrl(f), { headers: headers, signal: ctl.signal, cache: 'no-store' })
          if (r.status === 200 && got > 0) {
            // the server sent the whole file again (it changed, or would not resume): start clean
            await writable.seek(0)
            await writable.truncate(0)
            sha = new window.DxSha256()
            got = 0
          } else if (r.status !== 200 && r.status !== 206) {
            var kind = r.status === 401 ? 'locked' : r.status === 404 ? 'notfound' : r.status === 409 ? 'changed' : r.status === 410 ? 'gone' : r.status === 429 ? 'busy' : 'unavailable'
            if (kind === 'busy' || kind === 'unavailable') throw new Error(kind)
            await writable.abort().catch(function () {})
            return { kind: kind }
          }
          etag = r.headers.get('ETag') || etag
          var reader = r.body.getReader()
          for (;;) {
            var step = await reader.read()
            if (step.done) break
            await writable.write(step.value)
            sha.update(step.value)
            got += step.value.length
            fails = 0
            paint()
          }
          if (got >= size) break
          throw new Error('ended early')
        } catch (e) {
          if (cancelled) {
            await writable.abort().catch(function () {})
            return { kind: 'cancelled' }
          }
          if (++fails > 10) {
            await writable.abort().catch(function () {})
            return { kind: 'failed' }
          }
          var wait = Math.min(60, 2 * Math.pow(2, Math.min(fails, 5)))
          // the office server's address can change after an outage: look it up again before retrying
          if (fails >= 2) await connect(true).catch(function () {})
          for (var s = wait; s > 0 && !cancelled; s--) {
            paint((navigator.onLine === false ? 'You are offline' : 'Connection interrupted') + ' — resuming in ' + s + ' s', 'warn')
            await sleep(1000)
          }
          if (cancelled) {
            await writable.abort().catch(function () {})
            return { kind: 'cancelled' }
          }
        }
      }
      paint('Checking the file…')
      await writable.close()
      var hex = sha.hex()
      return hex === f.sha256 && got === size ? { kind: 'verified' } : { kind: 'corrupt' }
    } finally {
      S.active--
    }
  }

  function progressUi(row) {
    var bar = h('i')
    var left = h('span')
    var right = h('span')
    var cancel = h('button', { class: 'link', type: 'button', text: 'Cancel' })
    var box = h('div', { class: 'prog more', role: 'group', 'aria-label': 'Download progress' }, h('div', { class: 'bar' }, bar), h('div', { class: 'line' }, left, right))
    var old = row.querySelector('.prog')
    if (old) old.remove()
    row.appendChild(box)
    var slowSince = 0
    var ui = {
      box: box,
      update: function (p) {
        var pct = p.size ? Math.min(100, (p.got / p.size) * 100) : 100
        bar.style.width = pct.toFixed(1) + '%'
        if (p.text) {
          left.textContent = p.text
          right.replaceChildren(p.got ? fmtBytes(p.got) + ' of ' + fmtBytes(p.size) + ' · ' : '', cancel)
          return
        }
        var eta = p.rate > 0 ? fmtDuration((p.size - p.got) / p.rate) : ''
        left.textContent = fmtBytes(p.got) + ' of ' + fmtBytes(p.size) + ' · ' + Math.floor(pct) + '%'
        right.replaceChildren((p.rate > 0 ? fmtBytes(p.rate) + '/s' : '') + (eta ? ' · ' + eta : '') + ' · ', cancel)
        // a long transfer on a slow line: say so once, kindly
        var slow = p.rate > 0 && (p.size - p.got) / p.rate > 1800
        if (slow && !slowSince) slowSince = Date.now()
        if (!slow) slowSince = 0
        if (slowSince && Date.now() - slowSince > 8000 && !box.querySelector('.note')) box.appendChild(h('div', { class: 'note' }, icon('info'), h('span', { text: 'This is a large download on a slow connection. You can keep working — leave this tab open and it will resume by itself if the connection drops.' })))
      },
      finish: function (cls, node) {
        bar.style.width = '100%'
        box.className = 'prog more ' + cls
        var n = box.querySelector('.note')
        if (n) n.remove()
        left.replaceChildren(node)
        right.replaceChildren()
      }
    }
    cancel.addEventListener('click', function () {
      if (ui.cancel) ui.cancel()
    })
    return ui
  }

  async function verifiedDownload(f, row, dir) {
    var handle
    try {
      handle = dir ? await dir.getFileHandle(safeName(f.name), { create: true }) : await window.showSaveFilePicker({ suggestedName: safeName(f.name) })
    } catch (e) {
      return { kind: e && e.name === 'AbortError' ? 'cancelled-picker' : 'nopicker' }
    }
    var ui = progressUi(row)
    var lock = null
    try {
      lock = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null
    } catch (e) {}
    var res
    try {
      res = await streamTo(f, handle, ui)
    } catch (e) {
      res = { kind: 'failed' }
    }
    if (lock) lock.release().catch(function () {})
    if (res.kind === 'verified') ui.finish('done', h('span', { class: 'ok', text: 'Saved and verified — the file arrived complete and unaltered (SHA-256 matches).' }))
    else if (res.kind === 'cancelled') ui.box.remove()
    else if (res.kind === 'corrupt') ui.finish('bad', h('span', { class: 'err', text: 'The file did not arrive intact. Please download it again; if it keeps happening, tell the sender.' }))
    else if (res.kind === 'failed') ui.finish('bad', h('span', { class: 'err', text: 'The download could not be completed after several tries. Please try again later.' }))
    else {
      ui.box.remove()
      if (!fatal(res)) toast(problemText(res))
    }
    return res
  }

  function showReady(meta) {
    S.meta = meta
    var files = S.files || meta.files || []
    var single = files.length === 1
    var head = headView(meta)
    var body = []
    var status = h('div', { class: 'status', 'aria-live': 'polite' })
    var say = function (cls, glyph, text, extra) {
      var n = h('div', { class: 'note ' + cls }, icon(glyph), h('span', null, text, extra || ''))
      status.replaceChildren(n)
      return n
    }

    async function native(f, btn) {
      var keep = Array.prototype.slice.call(btn.childNodes)
      btn.disabled = true
      // the round per-file button has room for the spinner only; the word is still there for screen readers
      btn.replaceChildren(h('span', { class: 'spin' }), btn.classList.contains('round') ? h('span', { class: 'vh', text: 'Starting…' }) : 'Starting…')
      var p = await precheck(f)
      btn.disabled = false
      btn.replaceChildren.apply(btn, keep)
      if (p.kind !== 'ok') {
        if (!fatal(p)) say('warn', 'warn', problemText(p))
        return false
      }
      navigate(f)
      say('good', 'check', 'Your download has started — look for ' + (single ? 'it' : '“' + f.name + '”') + " in your browser's downloads. ", h('button', { class: 'link', type: 'button', text: "Didn't start? Try again", on: { click: function () {
        navigate(f)
      } } }))
      return true
    }

    var rows = []
    function fileRow(f) {
      var t = fileType(f.name)
      var row = h('li', { class: 'file' })
      var dl = h('button', { class: 'btn round', type: 'button', 'aria-label': 'Download ' + f.name, title: 'Download' }, icon('download'))
      dl.addEventListener('click', function () {
        native(f, dl)
      })
      var hashBox = null
      var detail = h('button', { class: 'btn ghost sm', type: 'button', 'aria-expanded': 'false', text: 'Checksum' })
      detail.addEventListener('click', function () {
        if (hashBox) {
          hashBox.remove()
          hashBox = null
          detail.setAttribute('aria-expanded', 'false')
          return
        }
        hashBox = h('div', { class: 'hash more' }, h('b', { text: 'SHA-256 checksum' }), h('code', { text: f.sha256 }),
          h('button', { class: 'btn sm', type: 'button', text: 'Copy checksum', on: { click: function () {
            copy(f.sha256, 'Checksum copied')
          } } }),
          h('p', { class: 'how', text: 'A fingerprint of the exact file we sent. To compare on Windows: open PowerShell and run  Get-FileHash "' + safeName(f.name) + '"  — the result should match.' }))
        if (canSave) {
          hashBox.appendChild(h('button', { class: 'btn sm', type: 'button', on: { click: function () {
            verifiedDownload(f, row)
          } } }, icon('shield'), 'Download and verify automatically'))
          hashBox.appendChild(h('p', { class: 'how', text: 'Saves the file through this page with live progress, resumes by itself after a dropped connection, and checks the fingerprint for you. Keep this tab open until it finishes.' }))
        }
        row.appendChild(hashBox)
        detail.setAttribute('aria-expanded', 'true')
      })
      row.appendChild(h('div', { class: 'badge ' + t[2], 'aria-hidden': 'true', text: t[0] }))
      row.appendChild(h('div', { class: 'name', text: f.name }))
      row.appendChild(h('div', { class: 'act' }, detail, single ? null : dl))
      row.appendChild(h('div', { class: 'meta', text: t[1] + ' · ' + fmtBytes(f.size) }))
      rows.push(row)
      return row
    }

    var list = h('ul', { class: 'files' })
    files.forEach(function (f) {
      list.appendChild(fileRow(f))
    })

    var cta = h('div', { class: 'cta' })
    if (single) {
      var main = h('button', { class: 'btn primary lg', type: 'button' }, icon('download'), h('span', { class: 'lbl', text: 'Download' }), h('span', { class: 'vh', text: ' · ' }), h('span', { class: 'size', text: fmtBytes(files[0].size) }))
      main.addEventListener('click', function () {
        native(files[0], main)
      })
      cta.appendChild(main)
      cta.appendChild(h('span', { class: 'sub', text: 'Saved by your browser to its usual downloads folder.' }))
    } else {
      var all = h('button', { class: 'btn primary lg', type: 'button' }, icon('download'), h('span', { class: 'lbl', text: 'Download all' }), h('span', { class: 'vh', text: ' · ' }), h('span', { class: 'size', text: fmtBytes(meta.totalSize) }))
      all.addEventListener('click', async function () {
        if (canFolder) {
          var dir
          try {
            dir = await window.showDirectoryPicker({ mode: 'readwrite' })
          } catch (e) {
            return
          }
          all.disabled = true
          var okCount = 0
          for (var i = 0; i < files.length; i++) {
            say('', 'folder', 'Saving file ' + (i + 1) + ' of ' + files.length + ' to the folder you chose. Keep this tab open.')
            rows[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' })
            var res = await verifiedDownload(files[i], rows[i], dir)
            if (res.kind === 'verified') okCount++
            else if (res.kind === 'cancelled') break
            else if (res.kind === 'locked' || res.kind === 'notfound' || res.kind === 'gone') return
          }
          all.disabled = false
          if (okCount === files.length) say('good', 'check', 'All ' + files.length + ' files were saved and verified.')
          else say('warn', 'warn', okCount + ' of ' + files.length + ' files were saved. You can download the others one by one below.')
          return
        }
        // other browsers: hand each file to the browser's own download manager, one after another
        all.disabled = true
        var p = await precheck(files[0])
        if (p.kind !== 'ok') {
          all.disabled = false
          if (!fatal(p)) say('warn', 'warn', problemText(p))
          return
        }
        for (var k = 0; k < files.length; k++) {
          say('', 'info', 'Starting download ' + (k + 1) + ' of ' + files.length + '… If your browser asks whether to allow several downloads, choose Allow.')
          navigate(files[k])
          await sleep(1200)
        }
        all.disabled = false
        say('good', 'check', "All downloads have been handed to your browser — check its downloads list. Any that are missing can be started one by one below.")
      })
      cta.appendChild(all)
      cta.appendChild(h('span', { class: 'sub', text: canFolder ? 'You choose a folder; each file is saved there and verified.' : 'Or pick single files below.' }))
    }
    // the main action comes first in reading and Tab order; the style sheet shows it under the list
    body.push(cta, status, h('h2', { class: 'files-title', text: single ? 'Your file' : 'Your files' }), list)
    if (meta.totalSize > 300 * 1048576) body.push(h('div', { class: 'note' }, icon('info'), h('span', { text: 'This is a large download, sent straight from our office. It may take a while on a slow connection; if it is interrupted, your browser can resume it from its downloads list.' })))
    // "Trouble downloading? Reply to the e-mail…" is in the page footer, under this
    body.push(h('p', { class: 'fine', text: 'Only download files you were expecting from ' + (meta.sender || 'us') + '.' }))

    show(split('ready', head, body))
    retryStep = 0
    S.timers.push(setInterval(head.tick, 30000))
  }

  // ---- start ----------------------------------------------------------------------------------
  async function start(fresh) {
    var run = ++S.run
    var link = LINK_RE.exec(decodeURIComponent(location.hash.replace(/^#\/?/, '')).trim())
    if (!link) return showNoLink()
    var id = link[1]
    S.gist = link[2] || ''
    S.keyHash = link[3] || ''
    if (id !== S.id) {
      S.id = id
      S.files = null
      S.token = store('dxs-t-' + id) || ''
    }
    showLoading(fresh === true ? 'Looking for our file server…' : '')
    if (!S.cfg) {
      try {
        var r = await timedFetch('config.json', { cache: 'no-cache' }, 10000)
        S.cfg = await r.json()
      } catch (e) {
        S.cfg = { base: '', pointers: [], allowedHosts: ['*.trycloudflare.com'] } // config.json is optional
      }
    }
    var res = await connect(fresh === true)
    if (run !== S.run) return
    if (res.kind === 'ok') {
      var m = res.meta
      if (typeof m.now === 'number') S.skew = m.now - Date.now()
      S.meta = m
      if (m.needsPassword && !m.unlocked) {
        if (S.token) {
          S.token = ''
          store('dxs-t-' + id, null)
        }
        return showLocked(m)
      }
      S.files = m.files
      return showReady(m)
    }
    if (res.kind === 'notfound') return showNotFound()
    if (res.kind === 'expired') return showExpired()
    if (res.kind === 'busy') return showBusy(res.retry)
    showUnreachable(res.configured)
  }

  var root = document.documentElement
  try {
    var saved = localStorage.getItem('hopper-theme')
    if (saved) root.dataset.theme = saved
  } catch (e) {}
  document.getElementById('theme').addEventListener('click', function () {
    var dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
    root.dataset.theme = dark ? 'light' : 'dark'
    try {
      localStorage.setItem('hopper-theme', root.dataset.theme)
    } catch (e) {}
  })
  window.addEventListener('hashchange', function () {
    start()
  })
  window.addEventListener('online', function () {
    if (card.querySelector('.state.warn .countdown')) start(true)
  })
  start()
})()
