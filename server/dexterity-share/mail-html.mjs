// Dexterity Share e-mails, in the company brand (Dexterity brand kit: teal / ink / amber, Archivo,
// Instrument Sans, JetBrains Mono, the title-block grid and the "line of flow"), matching the client
// download page: a dark panel that names the delivery, then the one thing to do.
// Mail programs are not browsers: tables, inline styles, no SVG, scripts or web fonts are what Gmail,
// Outlook, Zoho and Apple Mail all render alike. The logo travels inside the message (cid:).

export const MARK_CID = 'dexterity-mark@dexterity-share'

const C = {
  teal: '#2a8c98',
  tealInk: '#1c7680',
  tealSoft: '#7fc3cb',
  ink: '#132b2e',
  inkDeep: '#0e2224',
  graphite: '#4c6366',
  amber: '#f7af44',
  paper: '#f6fafa',
  stone: '#e8f2f3',
  line: '#d3e3e5',
  onInk: '#a9cdd1',
  onInkLine: '#2b4b4f'
}
const DISPLAY = "'Archivo','Segoe UI Light','Segoe UI',Helvetica,Arial,sans-serif"
const BODY = "'Instrument Sans','Segoe UI',Helvetica,Arial,sans-serif"
const MONO = "'JetBrains Mono','Cascadia Mono',Consolas,'Courier New',monospace"

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

const label = (text, color, cls = '') => `<div${cls ? ` class="${cls}"` : ''} style="font:500 10px/1.4 ${MONO};letter-spacing:.16em;text-transform:uppercase;color:${color};">${esc(text)}</div>`

function initials(name) {
  const w = String(name || 'D').trim().split(/\s+/).filter(Boolean)
  return ((w[0]?.[0] ?? 'D') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase()
}

/** Label over value, hairlines between: the corner of a drawing. cells: [label, value, width%][] */
function titleBlock(cells) {
  const tds = cells
    .map(([k, v, w], i) => `<td class="dx-cell${i ? ' dx-rule' : ''}" width="${w}%" valign="top" style="padding:14px 14px 14px ${i ? 14 : 0}px;${i ? `border-left:1px solid ${C.line};` : ''}">${label(k, C.graphite, 'dx-soft')}<div class="dx-ink" style="margin-top:5px;font:600 14px/1.45 ${BODY};color:${C.ink};word-break:break-word;">${esc(v)}</div></td>`)
    .join('')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="dx-rule" style="border-top:1px solid ${C.line};border-bottom:1px solid ${C.line};"><tr>${tds}</tr></table>`
}

/** Our office to you: one pipe run, a node at each end and the amber gate valve the code opens. */
function lineOfFlow(rightLabel) {
  const node = (fill) => `<td width="12" style="width:12px;padding:0;"><div style="width:10px;height:10px;border-radius:50%;border:1px solid ${C.tealSoft};background:${fill};font-size:0;line-height:0;">&nbsp;</div></td>`
  const pipe = `<td style="padding:0 4px;"><div style="border-top:1px solid ${C.tealSoft};height:1px;font-size:0;line-height:0;">&nbsp;</div></td>`
  const valve = `<td width="22" align="center" style="width:22px;padding:0;"><div style="width:10px;height:10px;margin:0 auto;background:${C.amber};transform:rotate(45deg);font-size:0;line-height:0;">&nbsp;</div></td>`
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${node(C.tealSoft)}${pipe}${valve}${pipe}${node('transparent')}</tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;"><tr><td>${label('Our office', C.onInk)}</td><td align="right">${label(rightLabel, C.onInk)}</td></tr></table>`
}

/** Numbered steps across: what happens next. */
function steps(list) {
  const tds = list
    .map((s, i) => `<td class="dx-cell" width="${Math.floor(100 / list.length)}%" valign="top" style="padding:0 ${i < list.length - 1 ? 12 : 0}px 0 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="top" style="padding-right:10px;"><div style="width:24px;height:24px;border-radius:50%;background:${C.teal};color:#ffffff;font:600 12px/24px ${MONO};text-align:center;">${i + 1}</div></td>
<td valign="top"><div class="dx-ink" style="font:600 13px/1.4 ${BODY};color:${C.ink};">${esc(s[0])}</div><div class="dx-soft" style="margin-top:2px;font:400 12.5px/1.45 ${BODY};color:${C.graphite};">${esc(s[1])}</div></td>
</tr></table></td>`)
    .join('')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${tds}</tr></table>`
}

/** Every Dexterity Share e-mail. p: { preheader, title, kicker, heading, from, flowTo, main, note } */
function shell(p, year) {
  const from = p.from
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;"><tr>
<td valign="middle"><div style="width:34px;height:34px;border-radius:50%;background:${C.teal};color:#ffffff;font:600 13px/34px ${BODY};text-align:center;">${esc(initials(p.from))}</div></td>
<td valign="middle" style="padding-left:12px;font:400 14px/1.45 ${BODY};color:${C.onInk};"><b style="color:#ffffff;font-weight:600;">${esc(p.from)}</b> ${p.fromText}</td>
</tr></table>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(p.title)}</title>
<style>
  body { margin:0; padding:0; -webkit-text-size-adjust:100%; }
  a { color:${C.tealInk}; }
  @media (max-width:600px) {
    .dx-pad { padding-left:22px !important; padding-right:22px !important; }
    .dx-h1 { font-size:27px !important; }
    .dx-code { font-size:34px !important; letter-spacing:.14em !important; }
    .dx-cell { display:block !important; width:100% !important; border-left:0 !important; padding:10px 0 !important; }
    .dx-hide-sm { display:none !important; }
  }
  @media (prefers-color-scheme: dark) {
    .dx-bg { background:#081214 !important; }
    .dx-card { background:#10262a !important; border-color:#24474b !important; }
    .dx-ink { color:#eef6f6 !important; }
    .dx-soft { color:#a9c4c7 !important; }
    .dx-codebox { background:#0b1d20 !important; border-left-color:#24474b !important; border-right-color:#24474b !important; border-bottom-color:#24474b !important; }
    .dx-rule { border-color:#24474b !important; }
    .dx-foot { background:#0b1d20 !important; border-color:#24474b !important; }
  }
</style>
</head>
<body class="dx-bg" style="margin:0;padding:0;background:${C.stone};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(p.preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="dx-bg" style="background:${C.stone};">
<tr><td align="center" style="padding:28px 10px 36px;">
<table role="presentation" width="580" cellpadding="0" cellspacing="0" border="0" class="dx-card" style="width:100%;max-width:580px;background:#ffffff;border:1px solid ${C.line};border-radius:6px;border-collapse:separate;">

<tr><td class="dx-pad" style="background-color:${C.ink};background-image:radial-gradient(ellipse at 100% 0%, #1e6066 0%, rgba(30,96,102,0) 62%), linear-gradient(160deg, ${C.ink} 0%, ${C.inkDeep} 100%);padding:26px 36px 28px;border-radius:6px 6px 0 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="42" valign="middle" style="width:42px;"><img src="cid:${MARK_CID}" width="38" height="38" alt="Dexterity" style="display:block;width:38px;height:38px;border:0;"></td>
<td valign="middle" style="padding-left:12px;"><div style="font:600 16px/1.2 ${BODY};color:#ffffff;">Dexterity Share</div><div style="margin-top:3px;font:500 9.5px/1.3 ${MONO};letter-spacing:.18em;text-transform:uppercase;color:${C.onInk};">Dexterity Design Services</div></td>
<td class="dx-hide-sm" align="right" valign="middle">${label(p.kicker, C.tealSoft)}</td>
</tr></table>
<div style="height:1px;margin:22px 0 24px;background:${C.onInkLine};font-size:0;line-height:0;">&nbsp;</div>
<h1 class="dx-h1" style="margin:0;font:300 31px/1.16 ${DISPLAY};letter-spacing:-.025em;color:#ffffff;">${p.heading}</h1>
${from}
<div style="margin-top:26px;">${lineOfFlow(p.flowTo)}</div>
</td></tr>

${p.main}

<tr><td class="dx-pad" style="padding:6px 36px 30px;"><div class="dx-soft" style="font:400 13px/1.6 ${BODY};color:${C.graphite};">${p.note}</div></td></tr>

<tr><td class="dx-pad dx-foot" style="background:${C.paper};border-top:1px solid ${C.line};padding:20px 36px 22px;border-radius:0 0 6px 6px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="30" valign="top" style="width:30px;"><img src="cid:${MARK_CID}" width="22" height="22" alt="" style="display:block;width:22px;height:22px;border:0;"></td>
<td valign="top" style="padding-left:8px;">
<div class="dx-ink" style="font:600 12.5px/1.4 ${BODY};color:${C.ink};">© ${year} Dexterity Design Services Private Limited</div>
<div class="dx-soft" style="margin-top:3px;font:400 12px/1.5 ${BODY};color:${C.graphite};">Sent by Dexterity Share, our own file delivery service. <a href="https://dexteritydesign.co.in" style="color:${C.tealInk};text-decoration:none;">dexteritydesign.co.in</a></div>
</td></tr></table>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`
}

const fmtDate = (ms) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(ms))

/** The one-time code e-mail. m: manifest; to: the address it goes to. */
export function codeMailHtml(m, code, minutes, to, now = new Date()) {
  const shown = `${code.slice(0, 3)} ${code.slice(3)}`
  const main = `<tr><td class="dx-pad" style="padding:30px 36px 6px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="dx-codebox" style="background:${C.paper};border:1px solid ${C.line};border-top:3px solid ${C.amber};border-radius:4px;">
<tr><td align="center" style="padding:24px 14px 22px;">
${label('Your one-time code', C.tealInk, 'dx-soft')}
<div class="dx-ink dx-code" style="margin-top:12px;font:500 42px/1.1 ${MONO};letter-spacing:.2em;color:${C.ink};white-space:nowrap;">${shown}</div>
<div class="dx-soft" style="margin-top:12px;font:400 13px/1.5 ${BODY};color:${C.graphite};">Works once, for ${minutes} minutes</div>
</td></tr></table>
</td></tr>
<tr><td class="dx-pad" style="padding:26px 36px 4px;">${steps([
    ['Type the code', 'on the download page you have open.'],
    ['Your files open', 'in that same browser tab.'],
    ['Download', 'each file is checked as it arrives.']
  ])}</td></tr>
<tr><td class="dx-pad" style="padding:26px 36px 20px;">${titleBlock([
    ['Sent to', to, 46],
    ['Code valid', `${minutes} min, once`, 24],
    ['Link closes', fmtDate(m.expiresAt), 30]
  ])}</td></tr>`
  return shell(
    {
      preheader: `${shown} is your code. It works once, for ${minutes} minutes.`,
      title: `${shown} is your code for ${m.title}`,
      kicker: 'Transmittal · one-time code',
      heading: `Your code for<br><span style="font-weight:400;">${esc(m.title)}</span>`,
      from: m.sender || 'Dexterity Design Services',
      fromText: 'shared these files with you',
      flowTo: 'You',
      main,
      note: '<b class="dx-ink" style="color:#132b2e;">Direct from our office.</b> Your files stay on our own server and are never uploaded to a file-sharing service. Encrypted in transit.<br><br>Did not ask for this code? Ignore this e-mail: nothing can be downloaded without it. Please do not forward it.'
    },
    now.getFullYear()
  )
}

/** The test e-mail from the setup screen: shows exactly what clients will see around their code. */
export function testMailHtml(from, now = new Date()) {
  const main = `<tr><td class="dx-pad" style="padding:30px 36px 6px;"><div class="dx-soft" style="font:400 15px/1.6 ${BODY};color:${C.graphite};">This test came from the Dexterity Share server. Clients of links limited to named e-mail addresses receive their one-time codes in an e-mail with this design, from this address.</div></td></tr>
<tr><td class="dx-pad" style="padding:22px 36px 20px;">${titleBlock([
    ['Sent from', from, 55],
    ['Sent at', new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(now) + ' IST', 45]
  ])}</td></tr>`
  return shell(
    {
      preheader: 'E-mail codes are working.',
      title: 'Dexterity Share test e-mail',
      kicker: 'Setup check',
      heading: 'E-mail codes<br><span style="font-weight:400;">are ready</span>',
      from: '',
      flowTo: 'Your clients',
      main,
      note: 'Nothing else to do. If this e-mail landed in spam or junk, mark it as not spam so codes reach the inbox.'
    },
    now.getFullYear()
  )
}
