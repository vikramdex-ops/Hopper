// ListView: virtualized file rows for a pane. Clean-room implementation.
import { el, $, $$, on, fmtSize, fmtDate, iconFor, catFor, matchFilter, parentOf, baseName, isIMAGE, keyOfEntry, cmpBy } from './util.js';
import { icon } from './icons.js';
import { typeLabel } from './filetypes.js';
import { S, pref } from './store.js';
const matchesColorRule = null;

export const DEFAULT_COLUMNS = ['name', 'size', 'type', 'mtimeMs'];
export const COLUMN_DEFS = {
  name: { label: 'Name', w: 260 },
  size: { label: 'Size', w: 90, cls: 'num' },
  type: { label: 'Type', w: 110 },
  mtimeMs: { label: 'Modified', w: 132, cls: 'date' },
  ctimeMs: { label: 'Created', w: 132, cls: 'date' },
  atimeMs: { label: 'Accessed', w: 132, cls: 'date' },
  attr: { label: 'Attr', w: 54 },
  folderSize: { label: 'Size (folders)', w: 100, cls: 'num' },
  files: { label: 'Files', w: 70, cls: 'num' },
  hash: { label: 'Checksum', w: 120 },
  dim: { label: 'Dimensions', w: 100, cls: 'num' }
};

export class ListView {
  constructor(pane, listEl) {
    this.pane = pane;
    this.root = listEl;
    this.entries = [];        // full entries of current dir
    this.view = [];           // filtered+sorted view
    this.sel = new Set();     // name keys
    this.anchors = new Set(); // selection anchors for cfg-sheet anchor/range
    this.focused = null;      // key of focused item
    this.sortCol = pref('sortCol') || 'name';
    this.sortDir = pref('sortDir') || 1;
    this.lastClickKey = null;
    this.sizes = new Map();      // path -> {size, files, dirs} folder sizes cache
    this.checksums = new Map();  // path -> hash string
    this.dims = new Map();
    this.markSet = new Map();    // used by compare: key -> 'm-up'|'m-both'|'m-l'|'m-r'
    this.buildHead();
    on(listEl, 'scroll', () => this.render());
    on(listEl, 'mousedown', e => this._md(e));
    on(listEl, 'click', e => this._click(e));
    on(listEl, 'dblclick', e => this._dbl(e));
    on(listEl, 'contextmenu', e => { this._md(e); this.pane.app.openCtx(e, this.pane, null); });
    on(listEl, 'keydown', e => this._key(e));
    listEl.addEventListener('dragstart', e => this._dragstart(e));
    listEl.addEventListener('dragover', e => this._dragover(e));
    listEl.addEventListener('drop', e => this._drop(e));
    listEl.addEventListener('dragend', () => {
      $$('.row.drag-src', this.root).forEach(r => r.classList.remove('drag-src'));
    });
  }
  head() { return el('div', 'head'); }
  buildHead() {
    const h = this.headEl || el('div', 'head');
    h.innerHTML = '';
    const cols = this.columns();
    if (pref('checkboxSelection')) {
      const ck = el('div', 'col col-check');
      const cb = el('input'); cb.type = 'checkbox';
      on(cb, 'change', () => { if (cb.checked) this.selectAll(); else this.clearSel(); });
      ck.appendChild(cb); h.appendChild(ck);
    }
    for (const c of cols) {
      const d = COLUMN_DEFS[c] || { label: c };
      const col = el('div', 'col', d.label);
      col.style.width = (this.pane.colWidths?.[c] || d.w) + 'px';
      if (c === 'name') col.style.flex = '1 1 auto'; else col.style.flex = 'none';
      if (this.sortCol === c) col.classList.add('sort', this.sortDir === 1 ? 'asc' : 'desc');
      on(col, 'click', () => {
        if (this.sortCol === c) this.sortDir = -this.sortDir; else { this.sortCol = c; this.sortDir = 1; }
        pref('sortCol', this.sortCol); pref('sortDir', this.sortDir);
        this.sort(); this.render();
      });
      // resize handle
      const rs = el('span', 'rh');
      rs.style.cssText = 'position:absolute;right:0;top:0;width:4px;height:100%;cursor:ew-resize';
      col.style.position = 'relative';
      col.appendChild(rs);
      on(rs, 'mousedown', e => {
        e.preventDefault(); e.stopPropagation();
        const startX = e.clientX, w0 = parseInt(col.style.width) || d.w;
        const mm = ev => {
          const nw = Math.max(30, w0 + ev.clientX - startX);
          col.style.width = nw + 'px';
          this.pane.colWidths = this.pane.colWidths || {}; this.pane.colWidths[c] = nw;
          $$(`.col[data-c="${c}"] .col-name`, this.root);
        };
        const mu = () => { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); this.go(); };
        document.addEventListener('mousemove', mm);
        document.addEventListener('mouseup', mu);
      });
      col.dataset.c = c;
      h.appendChild(col);
    }
    this.headEl = h;
    if (!this.headEl.parentElement) this.root.appendChild(this.headEl);
  }
  columns() {
    if (this.viewMode === 'thumbs' || this.viewMode === 'list') return ['name'];
    return this.pane.columns || pref('columns') || DEFAULT_COLUMNS;
  }
  apply(entries) {
    this.entries = entries;
    this.filterText = this.filterText || ''; // keep the typed filter
    this.sort();
    this.render();
    this.pane.drawFoot();
  }
  async sort() {
    const c = this.sortCol, d = this.sortDir;
    const keyFn = e => keyOfEntry(e);
    let view = this.entries;
    const f = this.filterText || '';
    if (f) view = view.filter(e => e.name.toLowerCase().includes(f.toLowerCase().replace(/\*/g, '')) || matchFilter(e.name, f));
    const sizes = this.sizes;
    view = [...view].sort(cmpBy(c === 'folderSize' ? 'size' : c, d, sizes));
    if (c === 'folderSize') {
      view.sort((a, b) => (!a.isDir - !b.isDir) || d * ((sizes.get(a.path)?.size || 0) - (sizes.get(b.path)?.size || 0)) || a.name.localeCompare(b.name));
    }
    this.view = view;
  }
  // selection ---------------------------------------------------------------
  keyAt(i) { return this.view[i] ? keyOfEntry(this.view[i]) : null; }
  idxOf(key) { return this.view.findIndex(e => keyOfEntry(e) === key); }
  toggleSel(key, add) {
    if (keyOfEntry(this.view[this.idxOf(key)] ?? {}) === key || this.sel.has(key)) {
      if (add) { this.sel.has(key) ? this.sel.delete(key) : this.sel.add(key); }
      else this.sel = new Set([key]);
      this.focused = key;
    }
  }
  clearSel() { this.sel.clear(); this.render(); this.pane.drawFoot(); this.pane.app.previewPane.draw(this.pane, null); }
  selectAll() { this.view.forEach(e => this.sel.add(keyOfEntry(e))); this.render(); this.pane.drawFoot(); }
  invertSel() { const s = new Set(this.view.map(keyOfEntry)); s.forEach(k => { if (this.sel.has(k)) s.delete(k); }); this.sel = s; this.render(); this.pane.drawFoot(); }
  selectByFilter(pattern) {
    for (const e of this.view) { const re = wildcardToReLocal(pattern); if (re && re.test(e.name)) this.sel.add(keyOfEntry(e)); }
    this.render(); this.pane.drawFoot();
  }
  selected() { // entries, sorted index order
    return this.view.filter(e => this.sel.has(keyOfEntry(e)));
  }
  focusedEntry() { return this.view[this.idxOf(this.focused)] || null; }

  // rendering --------------------------------------------------------------
  rowH() { return this.viewMode === 'thumbs' ? pref('thumbnailSize') + 18 : 26; }
  render() {
    const root = this.root;
    this.root.classList.toggle('thumbs', this.viewMode === 'thumbs');
    document.documentElement.style.setProperty('--row-h', this.rowH() + 'px');
    const scroll = root.scrollTop;
    const h = root.clientHeight;
    const start = Math.max(0, Math.floor(scroll / this.rowH()) - 6);
    const end = Math.min(this.view.length, start + Math.ceil(h / this.rowH()) + 12);
    // spacer
    let spacer = root.querySelector('.spacer');
    if (!spacer) { spacer = el('div', 'spacer'); spacer.style.cssText = 'position:absolute;top:0;left:0;width:100%'; root.appendChild(spacer); }
    spacer.style.height = this.view.length * this.rowH() + 40 + 'px';
    $$('.row', root).forEach(r => r.remove());
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const e = this.view[i];
      const row = this.mkRow(e, i);
      frag.appendChild(row);
    }
    root.appendChild(frag);
    if (!this.view.length) {
      const n = el('div', 'empty-note', this.entries.length ? 'No items match this filter' : 'Empty folder');
      root.appendChild(n);
    }
  }
  mkRow(e, i) {
    const row = el('div', 'row');
    row.dataset.key = keyOfEntry(e);
    row.dataset.idx = i;
    row.style.position = 'absolute';
    row.style.top = i * this.rowH() + 'px';
    row.style.width = '100%';
    row.draggable = true;
    if (this.sel.has(keyOfEntry(e))) row.classList.add('sel');
    if (this.focused === keyOfEntry(e)) row.classList.add('focused');
    if (this.markSet.get(keyOfEntry(e))) row.classList.add(this.markSet.get(keyOfEntry(e)));

    if (this.viewMode === 'thumbs') this.mkThumbRow(e, row);
    else this.mkDetailRow(e, row, i);
    return row;
  }
  mkDetailRow(e, row, i) {
    const ck = pref('checkboxSelection');
    if (ck) { const c = el('div', 'ckcell col col-check'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = this.sel.has(keyOfEntry(e)); c.appendChild(cb); row.appendChild(c); }
    const cols = this.columns();
    for (const c of cols) {
      const d = COLUMN_DEFS[c] || { label: c };
      const cell = el('div', `col ${d.cls || ''}`);
      cell.dataset.c = c;
      if (c === 'name') cell.style.flex = '1 1 auto'; else cell.style.flex = 'none';
      // width sync with header
      const hw = this.headEl.querySelector(`.col[data-c="${c}"]`);
      cell.style.width = hw ? hw.style.width : ((this.pane.colWidths?.[c] || d.w) + 'px');
      this.fillCell(c, e, cell);
      row.appendChild(cell);
    }
  }
  fillCell(c, e, cell) {
    switch (c) {
      case 'name': {
        cell.classList.add('name');
        const ic = el('span', 'icon');
        ic.dataset.cat = catFor(e);
        const fallback = () => { ic.replaceChildren(icon(iconFor(e), 16)); };
        if (isIMAGE(e)) {
          const im = el('img');
          im.src = 'x2file:///p/' + encodeURIComponent(e.path);
          im.loading = 'lazy';
          im.addEventListener('error', () => { im.remove(); fallback(); });
          ic.appendChild(im);
        } else fallback();
        cell.appendChild(ic);
        const tag = this.pane.app.tagsFor(e.path);
        if (tag) { const dot = el('i', 'tagdot'); dot.style.background = tag.color; cell.appendChild(dot); }
        const nm = el('span', 'nm', e.name);
        cell.appendChild(nm);
        if (e.brokenLink) cell.title = e.path + '\n(broken link)';
        else cell.title = e.path;
        break;
      }
      case 'size': {
        if (e.isDir) {
          const s = this.sizes.get(e.path);
          cell.textContent = s ? fmtSize(s.size) : '';
        } else cell.textContent = fmtSize(e.size);
        break;
      }
      case 'folderSize': cell.textContent = e.isDir ? fmtSize(this.sizes.get(e.path)?.size ?? -1) : ''; if (!this.sizes.get(e.path) && e.isDir) cell.textContent = ''; break;
      case 'files': cell.textContent = e.isDir ? (this.sizes.get(e.path)?.files ?? '') : ''; break;
      case 'type': cell.textContent = typeLabel(e); break;
      case 'mtimeMs': cell.textContent = fmtDate(e.mtimeMs); break;
      case 'ctimeMs': cell.textContent = fmtDate(e.ctimeMs); break;
      case 'atimeMs': cell.textContent = fmtDate(e.atimeMs); break;
      case 'attr': { if (e.attrText == null) e.attrText = e.isDir ? 'd' : ''; cell.textContent = e.attrText || ''; break; }
      case 'hash': cell.textContent = this.checksums.get(e.path) ? this.checksums.get(e.path).slice(0, 12) + '…' : ''; break;
      case 'dim': cell.textContent = this.dims.get(e.path) || ''; break;
      default: cell.textContent = e[c];
    }
  }
  mkThumbRow(e, row) {
    const t = el('div', 'thumbcell');
    const fallback = () => t.replaceChildren(icon(iconFor(e), 30));
    if (isIMAGE(e)) {
      const im = el('img');
      im.src = 'x2file:///p/' + encodeURIComponent(e.path);
      im.loading = 'lazy';
      im.addEventListener('error', () => { im.remove(); fallback(); });
      t.appendChild(im);
    } else fallback();
    row.appendChild(t);
    const col = el('div', 'col name');
    col.appendChild(el('span', 'nm', e.name));
    row.appendChild(col);
  }

  // interaction ------------------------------------------------------------
  _rowOf(t) { return t.closest?.('.row'); }
  _md(e) {
    const row = this._rowOf(e.target);
    this.pane.activate();
    if (!row) return;
    const key = row.dataset.key;
    if (e.button !== 0) return;
    if (e.detail === 1) this.lastClickKey = key;
  }
  _click(e) {
    const row = this._rowOf(e.target);
    if (!row) { this.clearSel(); return; }
    const key = row.dataset.key;
    const i = +row.dataset.idx;
    this.focused = key;
    if (e.ctrlKey && !e.altKey) {
      if (pref('stickySelection')) { this.sel.add(key); }
      else { this.sel.has(key) ? this.sel.delete(key) : this.sel.add(key); }
    } else if (e.shiftKey) {
      const last = this.lastClickKey;
      const a = last == null ? 0 : this.idxOf(last);
      if (a >= 0) this.rangeSelect(a, i);
      else this.sel.add(key);
    } else {
      if (!pref('stickySelection')) this.sel = new Set([key]);
      this.sel.add(key);
    }
    this.lastClickKey = key;
    this.render();
    this.pane.drawFoot();
    this.pane.app.previewPane.draw(this.pane, this.focusedEntry());
  }
  async _dbl(e) {
    const row = this._rowOf(e.target);
    if (!row) return;
    const ent = this.view[+row.dataset.idx];
    const app = this.pane.app;
    if (ent.isDir) { await app.nav(this.pane, ent.path); }
    else if (!ent.isDir && !ent.brokenLink) app.openEntry(ent);
  }
  rangeSelect(a, b) {
    const [s, t] = a < b ? [a, b] : [b, a];
    for (let i = s; i <= t; i++) if (this.keyAt(i)) this.sel.add(this.keyAt(i));
  }
  _key(e) {
    const app = this.pane.app;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const n = this.view.length; if (!n) return;
      let i = this.idxOf(this.focused);
      if (e.key === 'ArrowDown') i = Math.min(n - 1, i + 1);
      else if (e.key === 'ArrowUp') i = Math.max(0, i <= 0 ? 0 : i - 1);
      else if (e.key === 'Home') i = 0;
      else i = n - 1;
      const key = this.keyAt(i);
      e.preventDefault();
      const sc = this.root.scrollTop;
      const y0 = i * this.rowH(), y1 = y0 + this.rowH();
      if (y0 < sc) this.root.scrollTop = Math.max(0, y0 - 20);
      else if (y1 > sc + this.root.clientHeight) this.root.scrollTop = y0 - this.root.clientHeight + this.rowH() + 20;
      if (e.shiftKey) { this.rangeSelect(this.idxOf(this.focused), i); this.focused = key; }
      else if (!pref('stickySelection')) { this.sel = new Set([key]); this.focused = key; }
      else { this.sel.add(key); this.focused = key; }
      this.render(); this.pane.drawFoot();
      app.previewPane.draw(this.pane, this.view[i]);
    } else if (e.key === 'a' && e.ctrlKey) { e.preventDefault(); this.selectAll(); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
      // typeahead find
      const t0 = Date.now();
      this.typeahead = (this.typeahead && t0 - this.typeahead.t < 1300) ? { s: this.typeahead.s + e.key.toLowerCase(), t: t0 } : { s: e.key.toLowerCase(), t: t0 };
      const cands = this.view.map(keyOfEntry);
      const hit = cands.find(k => k.startsWith(this.typeahead.s));
      if (hit != null) {
        const i = this.idxOf(hit);
        if (!e.shiftKey && !pref('stickySelection')) this.sel = new Set([hit]);
        this.sel.add(hit);
        this.focused = hit;
        this.root.scrollTop = Math.max(0, i * this.rowH() - this.root.clientHeight / 2);
        this.render(); this.pane.drawFoot();
        app.previewPane.draw(this.pane, this.view[i]);
      }
    }
  }
  _dragstart(e) {
    const row = this._rowOf(e.target);
    if (!row) { e.preventDefault(); return; }
    const key = row.dataset.key;
    if (!this.sel.has(key)) { this.sel = new Set([key]); this.render(); }
    const paths = this.selected().map(x => x.path);
    e.dataTransfer.setData('text/x2paths', JSON.stringify(paths));
    e.dataTransfer.effectAllowed = 'copyMove';
    row.classList.add('drag-src');
  }
  _dragover(e) {
    const row = this._rowOf(e.target);
    if (row && e.dataTransfer.types.includes('text/x2paths')) { e.preventDefault(); row.classList.add('drop-target'); }
  }
  async _drop(e) {
    const row = this._rowOf(e.target);
    $$('.row.drop-target', this.root).forEach(r => r.classList.remove('drop-target'));
    const raw = e.dataTransfer.getData('text/x2paths') || (e.dataTransfer.files?.length ? JSON.stringify([...e.dataTransfer.files].map(f => f.path).filter(Boolean)) : null);
    if (!raw && !row) return;
    const paths = raw ? JSON.parse(raw) : [];
    const dst = row ? (this.view[+row.dataset.idx].path) : this.pane.cwd();
    const move = e.shiftKey || e.dataTransfer.dropEffect === 'move';
    if (!paths.length) return;
    e.preventDefault();
    this.pane.app.dropTransfer(paths, dst, move);
  }
  invalidate() {
    // called after fs mutations
    this.sizes.clear(); this.markSet.clear();
  }
}
function wildcardToReLocal(f) {
  f = (f || '').trim(); if (!f) return null;
  const p = f.split(/\*+/).map(s => s.replace(/[.+^${}()|[\]\\?]/g, c => '\\' + c)).join('.*');
  try { return new RegExp('^' + p + '$', 'i'); } catch { return null; }
}
