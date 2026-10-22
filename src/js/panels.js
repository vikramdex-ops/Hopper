// Preview pane + scrap/mini-scrap panels
import { el, $, on, fmtSize, fmtDate, esc, iconFor, isIMAGE, isVIDEO, isAUDIO, isTEXT, isPDF, parentOf, baseName } from './util.js';
import { icon, hydrateIcons } from './icons.js';
import { typeLabel, catFor } from './filetypes.js';
import { pref, persist, S } from './store.js';

const previewUrl = p => 'x2file:///p/' + encodeURIComponent(p);

export class PreviewPane {
  constructor(app, rootEl) {
    this.app = app;
    this.root = rootEl;
    this.paneKey = null;
    this.locked = false;
    this.currentPath = null;
    this.root.innerHTML = `
      <div class="pv-head">
        <span class="pv-ico" id="pv-ico" data-icon="file"></span>
        <div class="pv-title"><b class="pv-name" id="pv-name"></b><span class="pv-sub" id="pv-sub"></span></div>
        <div class="pv-act">
          <button id="pv-lock" class="chr-btn icon-only sm muted" title="Lock preview to this item"><span data-icon="unlock"></span></button>
          <button id="pv-copy-path" class="chr-btn icon-only sm muted" title="Copy full path"><span data-icon="copy"></span></button>
          <button id="pv-reveal" class="chr-btn icon-only sm muted" title="Show in Explorer"><span data-icon="external-link"></span></button>
          <button id="pv-editor" class="chr-btn icon-only sm muted" title="Open in text editor"><span data-icon="pencil"></span></button>
          <button id="pv-close" class="chr-btn icon-only sm muted" title="Close preview (Ctrl+Alt+Z)"><span data-icon="close"></span></button>
        </div>
      </div>
      <div class="pv-body" id="pv-body"></div>`;
    hydrateIcons(this.root);
    on($('#pv-lock', rootEl), 'click', () => this.setLocked(!this.locked));
    on($('#pv-copy-path', rootEl), 'click', () => {
      if (!this.currentPath) return;
      this.app.copyText(this.currentPath);
      this.app.toast('Path copied');
    });
    on($('#pv-reveal', rootEl), 'click', () => {
      if (this.currentPath) window.x2.showInExplorer(this.currentPath);
    });
    on($('#pv-editor', rootEl), 'click', () => this.app.editText(this.currentPath));
    on($('#pv-close', rootEl), 'click', () => this.app.runCmd('togglePreview'));
  }
  setLocked(v) {
    this.locked = !!v;
    const b = $('#pv-lock', this.root);
    b.classList.toggle('on', this.locked);
    const slot = $('[data-icon]', b);
    if (slot) {
      slot.setAttribute('data-icon', this.locked ? 'lock' : 'unlock');
      slot.replaceChildren(icon(this.locked ? 'lock' : 'unlock', 14));
    }
    b.title = this.locked ? 'Preview locked — click to follow selection' : 'Lock preview to this item';
    if (this.locked && this.lastEntry) this.render(this.lastEntry);
  }
  target(pane) { if (!this.locked) this.paneKey = pane.id; }
  draw(pane, entry) {
    if (this.locked && this.lastEntry) return;
    if (!pane || pane.id !== this.paneKey) return;
    this.render(entry);
  }
  show(entry) {
    this.app.setPreview(true);
    this.target(this.app.active);
    this.render(entry);
  }
  clear() {
    this.currentPath = null;
    this.lastEntry = null;
    $('#pv-name', this.root).textContent = '';
    $('#pv-sub', this.root).textContent = '';
    const ico = $('#pv-ico', this.root);
    if (ico) ico.replaceChildren(icon('file', 15));
    const body = $('#pv-body', this.root);
    body.replaceChildren(el('div', 'pv-empty', 'Select an item to preview'));
  }
  render(entry) {
    if (pref('showPreview') !== true) return;
    const body = $('#pv-body', this.root);
    const nameEl = $('#pv-name', this.root);
    const subEl = $('#pv-sub', this.root);
    const icoEl = $('#pv-ico', this.root);
    this.lastEntry = entry || null;
    this.currentPath = entry?.path || null;
    nameEl.textContent = entry ? (entry.name || baseName(entry.path)) : '';
    nameEl.title = entry?.path || '';
    subEl.textContent = entry ? typeLabel(entry) : '';
    const icoEl2 = $('#pv-ico', this.root);
    if (icoEl2) { icoEl2.replaceChildren(icon(iconFor(entry || {}), 15)); icoEl2.dataset.cat = entry ? catFor(entry) : 'file'; }
    body.replaceChildren();

    if (!entry) {
      body.appendChild(el('div', 'pv-empty', 'Select an item to preview'));
      return;
    }

    if (entry.isDir) {
      body.appendChild(this.metaCard(entry));
      const note = el('div', 'pv-empty', 'Folder preview — press Enter or double-click to open.');
      body.appendChild(note);
      return;
    }

    body.appendChild(this.metaCard(entry));

    const u = previewUrl(entry.path);
    if (isIMAGE(entry)) {
      const wrap = el('div', 'pv-media');
      const im = el('img');
      im.src = u;
      im.alt = entry.name;
      im.addEventListener('click', () => im.classList.toggle('zoomed'));
      im.addEventListener('error', () => { wrap.replaceChildren(el('div', 'pv-empty', 'Preview unavailable for this image')); });
      wrap.appendChild(im);
      body.appendChild(wrap);
    } else if (isVIDEO(entry)) {
      const wrap = el('div', 'pv-media');
      const v = el('video');
      v.src = u; v.controls = true; v.preload = 'metadata';
      wrap.appendChild(v);
      body.appendChild(wrap);
    } else if (isAUDIO(entry)) {
      const wrap = el('div', 'pv-media audio');
      wrap.appendChild(icon('file-audio', 44));
      const a = el('audio');
      a.src = u; a.controls = true;
      wrap.appendChild(a);
      body.appendChild(wrap);
    } else if (isPDF(entry)) {
      const f = el('iframe');
      f.src = u;
      body.appendChild(f);
    } else if (isTEXT(entry) || entry.size < 512 * 1024) {
      this.app.readText(entry.path).then(r => {
        if (!r || this.currentPath !== entry.path) return;
        if (r.error) { body.appendChild(el('div', 'pv-empty', r.error)); return; }
        const pre = el('pre');
        const text = r.text.slice(0, 64 * 1024) + (r.truncated ? '\n…' : '');
        const hl = this.app.previewHighlight;
        const hit = hl ? text.toLowerCase().indexOf(String(hl).toLowerCase()) : -1;
        if (hit >= 0) {
          pre.appendChild(document.createTextNode(text.slice(0, hit)));
          const mark = el('mark', 'fuzzy-hl', text.slice(hit, hit + String(hl).length));
          pre.appendChild(mark);
          pre.appendChild(document.createTextNode(text.slice(hit + String(hl).length)));
        } else pre.textContent = text;
        body.appendChild(el('div', 'pv-note', `${r.encoding || 'text'} · ${fmtSize(r.size)}${r.truncated ? ' · truncated preview' : ''}`));
        body.appendChild(pre);
      });
    } else {
      this.app.hexOf(entry.path).then(bb => {
        if (!bb || this.currentPath !== entry.path) return;
        const pre = el('pre', 'hex');
        const rows = [];
        const count = Math.min(Math.floor(bb.length / 16), 2048);
        for (let i = 0; i < count; i++) {
          const row = bb.slice(i * 16, i * 16 + 16);
          const hex = [...row].map(h => String(h).padStart(2, '0')).join(' ').padEnd(16 * 3 - 1, ' ');
          const asc = [...row].map(h => (h >= 32 && h < 127) ? String.fromCharCode(h) : '·').join('');
          rows.push((i * 16).toString(16).padStart(8, '0') + '  ' + hex + '  ' + asc);
        }
        pre.textContent = rows.join('\n');
        body.appendChild(pre);
      });
    }
  }
  /** One metadata card: full resource path first, then the facts people ask for. */
  metaCard(entry) {
    const card = el('div', 'pv-info');
    const rows = el('div', 'pv-rows');
    const addRow = (iconName, label, value, opts = {}) => {
      if (value == null || value === '') return;
      const row = el('div', 'pv-row');
      const ic = el('span', 'pv-k-ic');
      ic.appendChild(icon(iconName, 13));
      row.appendChild(ic);
      row.appendChild(el('span', 'pv-k', label));
      const v = el('span', 'pv-v' + (opts.mono === false ? '' : ' mono'), value);
      v.title = value;
      if (opts.click) { v.classList.add('link-like'); on(v, 'click', opts.click); }
      row.appendChild(v);
      if (opts.copy != null) {
        const c = el('button', 'chr-btn icon-only sm muted pv-copy', '');
        c.title = 'Copy ' + label.toLowerCase();
        c.appendChild(icon('copy', 12));
        on(c, 'click', () => { this.app.copyText(opts.copy); this.app.toast(label + ' copied'); });
        row.appendChild(c);
      }
      rows.appendChild(row);
    };
    addRow('route', 'Full path', entry.path, { copy: entry.path });
    const parent = parentOf(entry.path);
    if (parent) addRow('folder-open', 'Folder', parent, { click: () => this.app.nav(this.app.active, parent) });
    addRow('info', 'Kind', typeLabel(entry), { mono: false });
    if (!entry.isDir) addRow('hard-drive', 'Size', `${fmtSize(entry.size)}${entry.size ? ` (${Number(entry.size).toLocaleString()} bytes)` : ''}`, { mono: false });
    addRow('clock', 'Modified', fmtDate(entry.mtimeMs), { mono: false });
    addRow('clock', 'Created', fmtDate(entry.ctimeMs), { mono: false });
    addRow('eye', 'Accessed', fmtDate(entry.atimeMs), { mono: false });
    if (entry.attrText) addRow('tag', 'Attributes', entry.attrText, { mono: true });
    if (entry.isDir) addRow('layers', 'Contents', 'Folder — press Enter to browse', { mono: false });
    card.appendChild(rows);
    return card;
  }
}

export class Scrap {
  constructor(app) {
    this.app = app;
    this.items = [];    // {path, name, isDir, size, mtimeMs}
    this.minis = new Set();
    this.dialogEl = null;
  }
  add(entries) {
    for (const e of entries) {
      if (!this.items.find(i => i.path.toLowerCase() === e.path.toLowerCase())) this.items.push(e);
    }
    this.redrawMinis();
    this.app.toast(`Scrap: ${this.items.length} items`, 'ok');
  }
  remove(p) { this.items = this.items.filter(i => i.path !== p); this.redrawMinis(); if (this.dialogEl) this.renderDialog(); }
  clear() { this.items = []; this.redrawMinis(); if (this.dialogEl) this.renderDialog(); }
  redrawMinis() {
    for (const key of this.minis) {
      const root = $(`#${key} .mini-list`);
      if (!root) continue;
      root.replaceChildren();
      for (const it of this.items) {
        const itEl = el('div', 'it');
        const ic = el('span', 'ic');
        ic.appendChild(icon(iconFor(it), 13));
        itEl.appendChild(ic);
        itEl.appendChild(el('span', 'nm', it.name));
        itEl.title = it.path;
        const rm = el('span', 'rm');
        rm.appendChild(icon('close', 11));
        on(rm, 'click', ev => { ev.stopPropagation(); this.remove(it.path); });
        itEl.appendChild(rm);
        on(itEl, 'dblclick', () => this.app.runScrapItem(it));
        root.appendChild(itEl);
      }
      if (!this.items.length) root.appendChild(el('div', 'mini-empty', 'Empty — Ctrl+S sends the selection'));
    }
  }
  openDialog() {
    if (this.dialogEl) { this.renderDialog(); return; }
    const ov = $('#overlay');
    ov.classList.remove('hidden');
    const d = el('div', 'dlg');
    d.style.width = '760px';
    const head = el('div', 'dlg-head');
    head.innerHTML = `<span class="dlg-title"><span class="ic"></span>Scrap pane</span>`;
    $('.ic', head).appendChild(icon('plus-square', 15));
    const x = el('button', 'dlg-x');
    x.appendChild(icon('close', 14));
    on(x, 'click', () => { ov.classList.add('hidden'); });
    head.appendChild(x);
    d.appendChild(head);
    const body = el('div', 'dlg-body');
    d.appendChild(body);
    const foot = el('div', 'dlg-foot');
    const clearBtn = el('button', 'chr-btn danger');
    clearBtn.append(icon('trash', 14), document.createTextNode('Clear scrap'));
    on(clearBtn, 'click', () => { this.items = []; this.renderDialog(); this.redrawMinis(); });
    const copy = el('button', 'chr-btn');
    copy.append(icon('copy', 14), document.createTextNode('Copy all to…'));
    on(copy, 'click', async () => {
      const dst = await this.app.pickDir();
      if (dst) await this.app.transferEls(this.items.map(i => ({ src: i.path, name: i.name })), dst, { overwrite: false, skipOlder: false, move: false });
    });
    const close = el('button', 'chr-btn primary', 'Close');
    on(close, 'click', () => { ov.classList.add('hidden'); });
    foot.append(clearBtn, copy, close);
    d.appendChild(foot);
    ov.appendChild(d);
    this.dialogEl = d; this.bodyEl = body;
    this.renderDialog();
  }
  renderDialog() {
    if (!this.dialogEl) return;
    const t = el('table', 'tbl');
    t.innerHTML = `<thead><tr><th style="width:26px"></th><th style="width:44px"></th><th>Name</th><th>Folder</th><th style="width:90px">Size</th><th style="width:120px"></th></tr></thead>`;
    const tb = el('tbody');
    this.items.forEach((it, i) => {
      const tr = el('tr');
      const ck = el('td');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = true; cb.dataset.idx = String(i);
      ck.appendChild(cb);
      tr.appendChild(ck);
      const icd = el('td', 'icon-cell');
      icd.appendChild(icon(iconFor(it), 15));
      tr.appendChild(icd);
      tr.appendChild(el('td', '', it.name));
      tr.appendChild(el('td', 'dim', parentOf(it.path)));
      tr.appendChild(el('td', '', it.isDir ? 'Folder' : fmtSize(it.size)));
      const act = el('td', 'row-actions');
      const rmBtn = el('button', 'chr-btn icon-only sm muted');
      rmBtn.title = 'Remove from scrap';
      rmBtn.appendChild(icon('close', 12));
      on(rmBtn, 'click', () => this.remove(it.path));
      const delP = el('button', 'chr-btn icon-only sm danger');
      delP.title = 'Delete from disk';
      delP.appendChild(icon('trash', 12));
      on(delP, 'click', async () => { await this.app.deleteEntries([it.path], false); this.remove(it.path); });
      act.append(rmBtn, delP);
      tr.appendChild(act);
      on(tr, 'dblclick', () => this.app.runScrapItem(it));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    const wrap2 = el('div', 'scroll-tbl');
    wrap2.appendChild(t);
    this.bodyEl.replaceChildren(wrap2);
    if (!this.items.length) this.bodyEl.appendChild(el('div', 'empty-note', 'Scrap is empty — send items with Ctrl+S'));
  }
  async save() {
    const r = await window.x2.pick('save', { title: 'Save scrap as', defaultPath: 'scrapItems.csv' });
    if (r.canceled) return;
    const csv = 'name,path\n' + this.items.map(i => `"${i.name}",` + `"${i.path}"`).join('\n');
    await window.x2.writeText(r.filePath, csv);
    this.app.toast('Scrap saved');
  }
}
