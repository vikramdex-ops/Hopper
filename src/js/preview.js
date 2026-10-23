// Rich preview renderer shared by the preview pane, Quick Look and the viewer.
// One place decides how a file type is presented, so a new type only has to be
// taught here to appear everywhere.
import { el, $, on, esc, fmtSize, fmtDate, iconFor, parentOf, baseName } from './util.js';
import { icon } from './icons.js';
import { catFor, isIMAGE, isVIDEO, isAUDIO, isPDF, isTEXT, isFONT, isMARKDOWN, isJSON, isCSV, isHTML, isARCHIVE, typeLabel, extOfEntry } from './filetypes.js';

export const previewUrl = p => 'x2file:///p/' + encodeURIComponent(p);

// ---------------------------------------------------------------- primitives
export function errorCard(title, detail, extraButtons = []) {
  const card = el('div', 'pv-error');
  card.appendChild(el('b', '', title));
  if (detail) card.appendChild(el('span', '', detail));
  if (extraButtons.length) {
    const row = el('div', 'pv-actions');
    row.style.padding = '4px 0 0';
    for (const b of extraButtons) row.appendChild(b);
    card.appendChild(row);
  }
  return card;
}

export function actionBtn(label, iconName, fn, cls = '') {
  const b = el('button', 'chr-btn ' + cls);
  b.appendChild(icon(iconName, 13));
  b.appendChild(document.createTextNode(label));
  on(b, 'click', fn);
  return b;
}

function badges(host, list) {
  const row = el('div', 'pv-badges');
  for (const [label, value] of list) {
    if (value == null || value === '') continue;
    const b = el('span', 'pv-badge');
    b.appendChild(document.createTextNode(label + ' '));
    b.appendChild(el('b', '', String(value)));
    row.appendChild(b);
  }
  if (row.childElementCount) host.appendChild(row);
}

const mediaWrap = (cls = '') => el('div', 'pv-media ' + cls);

// ---------------------------------------------------------------- markdown
function inlineMd(src) {
  let out = '';
  let i = 0;
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~]+~~)|(!?\[[^\]]*\]\([^)\s]+\))/g;
  let m;
  while ((m = re.exec(src))) {
    out += esc(src.slice(i, m.index));
    i = m.index + m[0].length;
    const tok = m[0];
    if (tok.startsWith('`')) {
      out += '<code>' + esc(tok.slice(1, -1)) + '</code>';
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      out += '<strong>' + esc(tok.slice(2, -2)) + '</strong>';
    } else if (tok.startsWith('~~')) {
      out += '<s>' + esc(tok.slice(2, -2)) + '</s>';
    } else if (tok.startsWith('*') || tok.startsWith('_')) {
      out += '<em>' + esc(tok.slice(1, -1)) + '</em>';
    } else if (tok.startsWith('![')) {
      out += esc(tok);
    } else {
      const label = tok.slice(1, tok.indexOf(']'));
      const href = tok.slice(tok.indexOf(']') + 2, -1);
      if (/^https?:\/\//i.test(href)) {
        out += `<a href="${esc(href)}" target="_blank" rel="noreferrer noopener">${esc(label)}</a>`;
      } else out += esc(label || href);
    }
  }
  return out + esc(src.slice(i));
}

/** Small, safe Markdown subset — escapes everything before formatting. */
export function markdownToHtml(src) {
  const lines = String(src).split(/\r?\n/);
  const out = [];
  let list = null;      // 'ul' | 'ol'
  let para = [];
  let fence = null;
  let fenceLang = '';
  let fenceBuf = [];
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  const flushPara = () => {
    if (para.length) { out.push('<p>' + inlineMd(para.join(' ')) + '</p>'); para = []; }
  };
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    if (fence) {
      if (/^\s*```/.test(raw)) {
        out.push('<pre><code class="lang-' + esc(fenceLang) + '">' + esc(fenceBuf.join('\n')) + '</code></pre>');
        fence = null; fenceBuf = []; fenceLang = '';
      } else fenceBuf.push(raw);
      continue;
    }
    if (/^\s*```/.test(raw)) {
      flushPara(); closeList();
      fence = true; fenceLang = raw.trim().replace(/^```/, '').trim();
      continue;
    }
    if (!raw.trim()) { flushPara(); closeList(); continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(raw)) { flushPara(); closeList(); out.push('<hr>'); continue; }
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); closeList(); out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`); continue; }
    const q = raw.match(/^>\s?(.*)$/);
    if (q) { flushPara(); closeList(); out.push('<blockquote>' + inlineMd(q[1]) + '</blockquote>'); continue; }
    const ul = raw.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push('<li>' + inlineMd(ul[1]) + '</li>');
      continue;
    }
    const ol = raw.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push('<li>' + inlineMd(ol[1]) + '</li>');
      continue;
    }
    // table: a header row followed by a separator row
    if (/^\s*\|.*\|\s*$/.test(raw) && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[li + 1] || '')) {
      flushPara(); closeList();
      const cells = raw.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim());
      let j = li + 2;
      let body = '';
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
        body += '<tr>' + lines[j].trim().replace(/^\||\|$/g, '').split('|').map(s => '<td>' + inlineMd(s.trim()) + '</td>').join('') + '</tr>';
        j++;
      }
      out.push('<table><thead><tr>' + cells.map(c => '<th>' + inlineMd(c) + '</th>').join('') + '</tr></thead><tbody>' + body + '</tbody></table>');
      li = j - 1;
      continue;
    }
    para.push(raw.trim());
    flushPara();
  }
  if (fence) out.push('<pre><code>' + esc(fenceBuf.join('\n')) + '</code></pre>');
  flushPara(); closeList();
  return out.join('\n');
}

// ---------------------------------------------------------------- data formats
function jsonHtml(text) {
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
  let out = '', i = 0, m;
  while ((m = re.exec(text))) {
    out += esc(text.slice(i, m.index));
    i = m.index + m[0].length;
    if (m[1]) out += m[2] ? `<span class="j-key">${esc(m[1])}</span>${esc(m[2])}` : `<span class="j-str">${esc(m[1])}</span>`;
    else if (m[3]) out += `<span class="j-num">${esc(m[3])}</span>`;
    else out += `<span class="j-lit">${esc(m[0])}</span>`;
  }
  return out + esc(text.slice(i));
}

function parseCsv(text, delim) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------- archive
async function renderArchive(host, entry, app) {
  const ext = extOfEntry(entry);
  const note = el('div', 'pv-note', 'Reading archive…');
  host.appendChild(note);
  const res = await window.x2.listArchive(entry.path, ext);
  note.remove();
  if (!res || res.error) {
    host.appendChild(errorCard('Archive could not be listed', res?.error || 'No archive reader is available for this format.', [
      actionBtn('Open with the default app', 'external-link', () => app.openPath(entry.path))
    ]));
    return;
  }
  const entries = res.entries || [];
  const files = entries.filter(e => !e.isDir);
  const total = files.reduce((n, e) => n + (e.size || 0), 0);
  badges(host, [['Items', entries.length], ['Files', files.length], ['Uncompressed', fmtSize(total)]]);
  const wrap = el('div', 'pv-scroll');
  const table = el('table');
  table.innerHTML = '<thead><tr><th></th><th>Name</th><th>Size</th></tr></thead>';
  const tb = el('tbody');
  for (const e of entries.slice(0, 500)) {
    const tr = el('tr');
    const icd = el('td');
    icd.appendChild(icon(e.isDir ? 'folder' : iconFor({ name: e.name }), 13));
    tr.appendChild(icd);
    tr.appendChild(el('td', '', e.name));
    tr.appendChild(el('td', 'num', e.isDir ? '' : fmtSize(e.size)));
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  wrap.appendChild(table);
  host.appendChild(wrap);
  if (entries.length > 500) host.appendChild(el('div', 'pv-note', `Showing 500 of ${entries.length} entries`));
}

// ---------------------------------------------------------------- font
async function renderFont(host, entry) {
  const fam = 'x2font-' + Math.random().toString(36).slice(2);
  const face = new FontFace(fam, `url(${previewUrl(entry.path)})`);
  try {
    await face.load();
    document.fonts.add(face);
  } catch (e) {
    host.appendChild(errorCard('Font could not be decoded', 'The file may be corrupt or use an unsupported format.', []));
    return;
  }
  const card = el('div', 'pv-font');
  const spec = el('div', 'spec', 'Handgloves');
  spec.style.fontFamily = `"${fam}", var(--font-ui)`;
  const alphabet = el('div', 'meta', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ · abcdefghijklmnopqrstuvwxyz · 0123456789');
  alphabet.style.fontFamily = `"${fam}", var(--font-ui)`;
  alphabet.style.fontSize = '13px';
  const pangram = el('div', 'meta', 'The quick brown fox jumps over the lazy dog — 0123456789 €$&@');
  pangram.style.fontFamily = `"${fam}", var(--font-ui)`;
  pangram.style.fontSize = '15px';
  const meta = el('div', 'meta', `${face.family || fam} · ${face.status} · ${fmtSize(entry.size)}`);
  card.append(spec, alphabet, pangram, meta);
  host.appendChild(card);
}

// ---------------------------------------------------------------- main
export async function renderPreview(host, entry, app, opts = {}) {
  host.replaceChildren();
  if (!entry) {
    host.appendChild(el('div', 'pv-empty', 'Select an item to preview'));
    return;
  }
  const ext = extOfEntry(entry);
  const big = !!opts.large;

  if (entry.isDir) {
    const info = el('div', 'pv-empty', 'Folder preview — press Enter or double-click to open.');
    host.appendChild(info);
    try {
      const es = await window.x2.listDir(entry.path);
      if (!es || !es.length) { host.appendChild(el('div', 'pv-note', 'This folder is empty')); return; }
      const dirs = es.filter(e => e.isDir).length;
      badges(host, [['Folders', dirs], ['Files', es.length - dirs]]);
      const wrap = el('div', 'pv-scroll');
      const table = el('table');
      table.innerHTML = '<thead><tr><th></th><th>Name</th><th>Size</th></tr></thead>';
      const tb = el('tbody');
      for (const e of es.slice(0, 300)) {
        const tr = el('tr');
        const icd = el('td');
        icd.appendChild(icon(iconFor(e), 13));
        tr.appendChild(icd);
        tr.appendChild(el('td', '', e.name));
        tr.appendChild(el('td', 'num', e.isDir ? '' : fmtSize(e.size)));
        on(tr, 'dblclick', () => { if (e.isDir) app.nav(app.active, entry.path + '\\' + e.name); else app.openPath(entry.path + '\\' + e.name); });
        tb.appendChild(tr);
      }
      table.appendChild(tb);
      wrap.appendChild(table);
      host.appendChild(wrap);
      if (es.length > 300) host.appendChild(el('div', 'pv-note', `Showing 300 of ${es.length} entries`));
    } catch { /* unreadable folder */ }
    return;
  }

  // images ---------------------------------------------------------------
  if (isIMAGE(entry)) {
    const wrap = mediaWrap();
    const im = el('img');
    im.alt = entry.name;
    im.src = previewUrl(entry.path);
    im.addEventListener('error', () => {
      wrap.replaceChildren(errorCard('This image could not be decoded', `${ext.toUpperCase()} may use a codec the renderer does not support.`, [
        actionBtn('Open with the default app', 'external-link', () => app.openPath(entry.path))
      ]));
    });
    if (opts.zoom !== false) {
      im.title = 'Open the viewer';
      on(im, 'click', () => app.openViewer(entry.path));
    }
    wrap.appendChild(im);
    host.appendChild(wrap);
    return;
  }

  // video ---------------------------------------------------------------
  if (isVIDEO(entry)) {
    const wrap = mediaWrap('video');
    const v = el('video');
    v.src = previewUrl(entry.path);
    v.controls = true;
    v.preload = 'metadata';
    v.autoplay = !!opts.autoplay;
    const meta = el('div', 'pv-note');
    v.addEventListener('loadedmetadata', () => {
      const d = v.duration;
      meta.textContent = `${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, '0')} · ${v.videoWidth || '?'}×${v.videoHeight || '?'} · ${fmtSize(entry.size)}`;
    });
    v.addEventListener('error', () => {
      wrap.replaceChildren(errorCard('This video cannot be played here', `The ${ext.toUpperCase()} container or codec is not supported by Chromium.`, [
        actionBtn('Open with the default app', 'external-link', () => app.openPath(entry.path))
      ]));
      meta.textContent = '';
    });
    wrap.appendChild(v);
    host.appendChild(wrap);
    host.appendChild(meta);
    return;
  }

  // audio ---------------------------------------------------------------
  if (isAUDIO(entry)) {
    const wrap = mediaWrap('audio');
    wrap.appendChild(icon('file-audio', 40));
    const a = el('audio');
    a.src = previewUrl(entry.path);
    a.controls = true;
    wrap.appendChild(a);
    const meta = el('div', 'pv-note');
    a.addEventListener('loadedmetadata', () => {
      meta.textContent = `Duration ${Math.floor(a.duration / 60)}:${String(Math.round(a.duration % 60)).padStart(2, '0')} · ${fmtSize(entry.size)}`;
    });
    a.addEventListener('error', () => {
      wrap.replaceChildren(errorCard('This audio file cannot be played here', `The ${ext.toUpperCase()} codec is not supported.`, [
        actionBtn('Open with the default app', 'external-link', () => app.openPath(entry.path))
      ]));
    });
    wrap.appendChild(meta);
    host.appendChild(wrap);
    return;
  }

  // pdf -----------------------------------------------------------------
  if (isPDF(entry)) {
    const iframe = el('iframe', 'pv-pdf');
    iframe.src = previewUrl(entry.path) + '#view=FitH';
    iframe.title = entry.name;
    host.appendChild(iframe);
    host.appendChild(el('div', 'pv-note', 'Rendered by the built-in PDF viewer · use the toolbar to zoom or print'));
    return;
  }

  // html ----------------------------------------------------------------
  if (isHTML(entry)) {
    const iframe = el('iframe', 'pv-pdf');
    iframe.setAttribute('sandbox', '');           // static render, no scripts
    iframe.src = previewUrl(entry.path);
    iframe.title = entry.name;
    host.appendChild(iframe);
    host.appendChild(el('div', 'pv-note', 'Rendered with scripts disabled · open the file to interact'));
    return;
  }

  // fonts ---------------------------------------------------------------
  if (isFONT(entry)) {
    await renderFont(host, entry);
    return;
  }

  // archives ------------------------------------------------------------
  if (isARCHIVE(entry)) {
    await renderArchive(host, entry, app);
    return;
  }

  // markdown ------------------------------------------------------------
  if (isMARKDOWN(entry)) {
    const r = await app.readText(entry.path, 1024 * 1024);
    if (!r || r.error) { host.appendChild(errorCard('Could not read this Markdown file', r?.error || '', [])); return; }
    const doc = el('div', 'pv-doc');
    doc.innerHTML = markdownToHtml(r.text);
    host.appendChild(doc);
    if (r.truncated) host.appendChild(el('div', 'pv-note', 'Preview truncated · open the file to see all of it'));
    return;
  }

  // json ----------------------------------------------------------------
  if (isJSON(entry)) {
    const r = await app.readText(entry.path, 2 * 1024 * 1024);
    if (!r || r.error) { host.appendChild(errorCard('Could not read this JSON file', r?.error || '', [])); return; }
    let pretty = r.text;
    let valid = true;
    try { pretty = JSON.stringify(JSON.parse(r.text), null, 2); } catch { valid = false; }
    const pre = el('pre', 'pv-json');
    pre.innerHTML = jsonHtml(pretty.slice(0, 200000));
    host.appendChild(pre);
    host.appendChild(el('div', 'pv-note', `${valid ? 'Valid JSON' : 'Invalid JSON — showing the raw text'} · ${fmtSize(r.size)}${r.truncated ? ' · truncated' : ''}`));
    return;
  }

  // delimited data ------------------------------------------------------
  if (isCSV(entry)) {
    const r = await app.readText(entry.path, 2 * 1024 * 1024);
    if (!r || r.error) { host.appendChild(errorCard('Could not read this data file', r?.error || '', [])); return; }
    const delim = ext === 'tsv' ? '\t' : ',';
    const rows = parseCsv(r.text, delim);
    if (!rows.length) { host.appendChild(el('div', 'pv-empty', 'This file has no rows')); return; }
    const head = rows[0];
    badges(host, [['Rows', rows.length - 1], ['Columns', head.length], ['Encoding', r.encoding || 'utf8']]);
    const wrap = el('div', 'pv-scroll');
    const table = el('table');
    table.innerHTML = '<thead><tr><th class="idx">#</th>' + head.map(h => `<th>${esc(h)}</th>`).join('') + '</tr></thead>';
    const tb = el('tbody');
    for (let i = 1; i < Math.min(rows.length, 400); i++) {
      const tr = el('tr');
      tr.appendChild(el('td', 'idx', String(i)));
      for (const cell of rows[i]) tr.appendChild(el('td', '', cell));
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    wrap.appendChild(table);
    host.appendChild(wrap);
    if (rows.length > 400) host.appendChild(el('div', 'pv-note', `Showing 400 of ${rows.length - 1} rows`));
    return;
  }

  // text / code ---------------------------------------------------------
  if (isTEXT(entry) || entry.size < 512 * 1024) {
    const r = await app.readText(entry.path, 512 * 1024);
    if (!r || r.error) {
      host.appendChild(errorCard('Could not read this file', r?.error || '', [
        actionBtn('Open with the default app', 'external-link', () => app.openPath(entry.path))
      ]));
      return;
    }
    if (/^\u0000|\u0000{2,}/.test(r.text.slice(0, 4096))) {
      // decoded text is mostly NULs: treat as binary below
    } else {
      const note = el('div', 'pv-note');
      note.append(el('span', 'grow', `${r.encoding || 'utf8'} · ${fmtSize(r.size)}${r.truncated ? ' · truncated to 512 KB' : ''}`));
      const copy = el('button', 'chr-btn icon-only sm muted');
      copy.title = 'Copy text';
      copy.appendChild(icon('copy', 12));
      on(copy, 'click', () => { app.copyText(r.text); app.toast('Text copied'); });
      note.appendChild(copy);
      const pre = el('pre');
      const hl = app.previewHighlight;
      const text = r.text.slice(0, 256 * 1024);
      const hit = hl ? text.toLowerCase().indexOf(String(hl).toLowerCase()) : -1;
      if (hit >= 0) {
        pre.appendChild(document.createTextNode(text.slice(0, hit)));
        pre.appendChild(el('mark', 'fuzzy-hl', text.slice(hit, hit + String(hl).length)));
        pre.appendChild(document.createTextNode(text.slice(hit + String(hl).length)));
      } else pre.textContent = text;
      host.appendChild(note);
      host.appendChild(pre);
      return;
    }
  }

  // binary / unsupported ------------------------------------------------
  if (!entry.size) {
    host.appendChild(el('div', 'pv-empty', 'This file is empty'));
    return;
  }
  const bb = await app.hexOf(entry.path);
  if (bb && bb.length) {
    const pre = el('pre', 'hex');
    const rows = [];
    const count = Math.min(Math.floor(bb.length / 16), 4096);
    for (let i = 0; i < count; i++) {
      const row = bb.slice(i * 16, i * 16 + 16);
      const hex = [...row].map(h => String(h).padStart(2, '0')).join(' ').padEnd(16 * 3 - 1, ' ');
      const asc = [...row].map(h => (h >= 32 && h < 127) ? String.fromCharCode(h) : '·').join('');
      rows.push((i * 16).toString(16).padStart(8, '0') + '  ' + hex + '  ' + asc);
    }
    host.appendChild(el('div', 'pv-note', `Binary — first ${Math.min(entry.size, 64 * 1024)} bytes shown as hex`));
    pre.textContent = rows.join('\n');
    host.appendChild(pre);
  }
  const actions = el('div', 'pv-actions');
  actions.appendChild(actionBtn('Open with the default app', 'external-link', () => app.openPath(entry.path)));
  host.appendChild(actions);
}

export { badges };
