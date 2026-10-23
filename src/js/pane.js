// Pane: one side of the dual-pane manager with tabs, address history, tree, mini-scrap
import { el, $, $$, on, baseName, parentOf, iconFor, sleep, fmtSize } from './util.js';
import { S, pref, persist } from './store.js';
import { ListView, DEFAULT_COLUMNS } from './views.js';
import { icon } from './icons.js';

let paneSeq = 0;

export class Pane {
  constructor(app, root, id) {
    this.app = app;
    this.root = root;
    this.id = id;
    this.tabsEl = $('.tabs', root);
    this.listEl = $('.list', root);
    this.treeEl = $('.tree', root);
    this.miniEl = $('.mini', root);
    this.columns = pref('columns') || DEFAULT_COLUMNS;
    this.colWidths = {};
    this.activeTab = null;
    this.tabs = [];      // {id, path, hist: [], hi: -1, locked, tag,color}
    this.view = new ListView(this, this.listEl);
    on(root, 'mousedown', () => this.activate());
    on(this.listEl, 'focus', () => this.activate());
    on(root, 'wheel', e => {
      if (e.ctrlKey) {
        e.preventDefault();
        const cur = this.view.viewMode === 'thumbs' ? pref('thumbnailSize') : 26;
        const nv = Math.max(64, Math.min(260, cur + (e.deltaY < 0 ? 8 : -8)));
        if (cur !== 26 || nv > 26) { pref('thumbnailSize', nv); if (this.view.viewMode === 'thumbs') this.refresh(); }
      }
    }, { passive: false });
    // drag & drop into pane background => copy/move here
    on(this.listEl, 'dragover', e => { if (e.dataTransfer.types.includes('text/x2paths')) e.preventDefault(); });
    on(root.querySelector('.pane-body'), 'dragover', e => e.preventDefault());
    on(root.querySelector('.pane-body'), 'drop', async e => {
      const raw = e.dataTransfer.getData('text/x2paths') || (e.dataTransfer.files?.length ? JSON.stringify([...e.dataTransfer.files].map(f => f.path).filter(Boolean)) : null);
      if (!raw) return;
      const paths = JSON.parse(raw);
      if (!paths.length) return;
      e.preventDefault();
      e.stopPropagation();
      const move = e.shiftKey;
      app.dropTransfer(paths, this.cwd(), move);
    });
    // click on active-chip mini header
    on($('.mini-head', root), 'click', () => app.toggleMini(this));
  }
  panelVisible() { return this.root.id === 'pane-L' ? true : !pref('singlePane'); }

  activate() {
    this.app.active = this;
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p === this.root));
    this.app.previewPane.target(this);
    this.app.refreshAddr();    // address bar reflects active tab
    this.app.updateBookmarkStar();
    if (pref('showPreview')) this.app.previewPane.draw(this, this.view.focusedEntry());
  }
  cwd() { return this.activeTab?.path || 'C:\\'; }

  // ---- tabs -------------------------------------------------------------
  async addTab(path = this.cwd(), activate = true, hist) {
    const h = Array.isArray(hist) && hist.length ? hist.slice() : [path];
    const t = { id: 't' + Date.now() + '_' + paneSeq++, path, hist: h, hi: h.length - 1, locked: false };
    this.tabs.push(t);
    if (activate) { await this.activateTab(t); }
    else this.drawTabs();
    return t;
  }
  async activateTab(t) {
    this.activeTab = t;
    this.drawTabs();
    await this.refresh();
    this.app.refreshNavState();
    this.app.savePaneStateSoon();
  }
  closeTab(t) {
    if (this.tabs.length === 1) { this.navigateByPath(parentOf(this.cwd()) || 'C:\\'); return; }
    const i = this.tabs.indexOf(t);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    if (this.activeTab === t) {
      this.activeTab = this.tabs[Math.max(0, i - 1)];
      this.activateTab(this.activeTab);
    }
    this.drawTabs();
    this.app.refreshNavState();
    this.app.savePaneStateSoon();
  }
  async reopenTab() {
    const last = S.recentTabs?.[this.id];
    if (last && last.path) { await this.addTab(last.path, true); }
  }
  saveTabState() {
    const rec = { path: this.activeTab?.path, hist: this.activeTab?.hist?.slice(-40), hi: this.activeTab?.hi };
    S.recentTabs = S.recentTabs || {}; S.recentTabs[this.id] = rec; persist();
  }
  drawTabs() {
    this.tabsEl.replaceChildren();
    for (const t of this.tabs) {
      const tabEl = el('div', 'tab' + (t === this.activeTab ? ' on' : ''));
      if (t.tagColor) tabEl.appendChild(Object.assign(el('i', 'tag-dot'), { style: `background:${t.tagColor}` }));
      if (t.locked) { const pin = el('span', 'pin'); pin.appendChild(icon('pin', 11)); tabEl.appendChild(pin); }
      tabEl.appendChild(el('span', 'nm', t.customName || baseName(t.path) || t.path));
      const x = el('span', 'x');
      x.title = 'Close tab (Ctrl+F4)';
      x.appendChild(icon('close', 11));
      on(x, 'click', ev => { ev.stopPropagation(); this.closeTab(t); });
      tabEl.appendChild(x);
      tabEl.title = t.locked ? t.path + ' (locked)' : t.path;
      on(tabEl, 'mousedown', async ev => {
        if (ev.button !== 0) return;
        if (ev.target === x) return;
        await this.activateTab(t);
      });
      // middle-click closes the tab (Explorer parity)
      on(tabEl, 'auxclick', ev => { if (ev.button === 1) { ev.preventDefault(); this.closeTab(t); } });
      // drag a tab to reorder it
      tabEl.draggable = true;
      on(tabEl, 'dragstart', ev => { ev.dataTransfer.setData('text/x2tab', t.id); ev.dataTransfer.effectAllowed = 'move'; });
      on(tabEl, 'dragover', ev => { if (ev.dataTransfer.types.includes('text/x2tab')) ev.preventDefault(); });
      on(tabEl, 'drop', ev => {
        const id = ev.dataTransfer?.getData('text/x2tab');
        if (!id) return;
        ev.preventDefault(); ev.stopPropagation();
        const from = this.tabs.findIndex(z => z.id === id);
        if (from < 0) return;
        const rect = tabEl.getBoundingClientRect();
        let to = this.tabs.indexOf(t) + (ev.clientX > rect.left + rect.width / 2 ? 1 : 0);
        const [moved] = this.tabs.splice(from, 1);
        if (from < to) to--;
        this.tabs.splice(to, 0, moved);
        this.drawTabs();
        this.app.savePaneStateSoon();
      });
      on(tabEl, 'contextmenu', ev => this.app.tabCtx(ev, t));
      on(tabEl, 'dblclick', ev => { ev.preventDefault(); this.renameTab(ev, t); });
      this.tabsEl.appendChild(tabEl);
    }
  }
  renameTab(ev, t) {
    // inline rename of tab (does not affect folder)
    const tabEl = ev.currentTarget;
    const nm = $('.nm', tabEl);
    const inp = el('input', 'rename-input'); inp.value = nm.textContent;
    nm.replaceWith(inp); inp.focus(); inp.select();
    const fin = () => { inp.value && (t.customName = inp.value); this.drawTabs(); };
    on(inp, 'keydown', e2 => { if (e2.key === 'Enter') fin(); if (e2.key === 'Escape') this.drawTabs(); });
    on(inp, 'blur', fin);
  }

  // ---- navigation ---------------------------------------------------------
  async navigateByPath(p, { updateHistory = true, fromHist = false } = {}) {
    let path = (p || '').trim();
    if (!path) return;
    if (path.startsWith('>')) return this.app.runAddressCommand(path.slice(1));
    path = path.replace(/"/g, '');
    if (/^[a-zA-Z]:$/.test(path)) path += '\\';
    const t = this.activeTab;
    if (!t) { await this.addTab(path, true); return; }
    const exists = await this.app.dirExists(path);
    if (!exists) { this.app.toast('Folder not found: ' + path, 'err'); return; }
    if (t.locked && !fromHist) { await this.app.openInNewTab(path); return; }
    // archive navigation
    if (this.app.isArchivePath(path)) { await this.app.openArchiveTab(this, path); return; }
    const same = path.toLowerCase() === (t.path || '').toLowerCase();
    t.path = path;
    S.lastCwd = path;
    if (updateHistory && !same) {
      t.hist = t.hist.slice(0, t.hi + 1);
      t.hist.push(path);
      if (t.hist.length > 60) { t.hist.shift(); }
      t.hi = t.hist.length - 1;
    }
    await this.refresh();
    this.app.refreshAddr(); this.app.addRecent(path);
    this.app.refreshNavState();
    if (pref('mirrorBrowse') && !this.app.navigatingMirror) {
      this.app.navigatingMirror = true;
      try { await this.app.otherOf(this).navigateByPath(path, { updateHistory: true }); } finally { this.app.navigatingMirror = false; }
    }
    this.app.updateBookmarkStar();
    this.saveTabState();
  }

  // ---- history (per pane tab, OneCommander style) ------------------------
  historyStack() {
    const t = this.activeTab;
    if (!t || !t.hist?.length) return { stack: [], pos: -1 };
    return { stack: t.hist.slice(), pos: t.hi };
  }
  backTarget() { const t = this.activeTab; return t && t.hi > 0 ? t.hist[t.hi - 1] : null; }
  fwdTarget() { const t = this.activeTab; return t && t.hi < t.hist.length - 1 ? t.hist[t.hi + 1] : null; }
  upTarget() { const p = parentOf(this.cwd()); return p && p !== this.cwd() ? p : null; }
  back() {
    const t = this.activeTab; if (!t || t.hi <= 0) return;
    t.hi--;
    this.navigateByPath(t.hist[t.hi], { updateHistory: false, fromHist: true });
  }
  fwd() {
    const t = this.activeTab; if (!t || t.hi >= t.hist.length - 1) return;
    t.hi++;
    this.navigateByPath(t.hist[t.hi], { updateHistory: false, fromHist: true });
  }
  up() {
    const parent = this.upTarget();
    if (parent) this.navigateByPath(parent);
  }
  /** Structured lists for the back/forward dropdown menus. */
  backMenu() {
    const t = this.activeTab; if (!t) return { groups: [] };
    const items = [];
    for (let i = t.hi - 1; i >= 0; i--) {
      const p = t.hist[i];
      items.push({ label: baseName(p) || p, hint: p, icon: 'clock', run: () => { t.hi = i; this.navigateByPath(p, { updateHistory: false, fromHist: true }); } });
    }
    return { title: 'Back history', groups: [{ items }] };
  }
  fwdMenu() {
    const t = this.activeTab; if (!t) return { groups: [] };
    const items = [];
    for (let i = t.hi + 1; i < t.hist.length; i++) {
      const p = t.hist[i];
      items.push({ label: baseName(p) || p, hint: p, icon: 'clock', run: () => { t.hi = i; this.navigateByPath(p, { updateHistory: false, fromHist: true }); } });
    }
    return { title: 'Forward history', groups: [{ items }] };
  }
  recentLocations(n = 12) {
    const seen = new Set();
    const out = [];
    for (const r of (S.recent || [])) {
      const key = r.path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r.path);
      if (out.length >= n) break;
    }
    return out;
  }

  // ---- data --------------------------------------------------------------
  async refresh() {
    const t = this.activeTab; if (!t) return;
    const entries = await this.app.listDir(t.path);
    this.view.viewMode = pref('viewMode');
    this.view.apply(entries);
    this.drawFoot();
    await this.drawTree();
    this.app.refreshNavState();
    if (pref('showPreview')) this.app.previewPane.draw(this, this.view.focusedEntry());
  }
  async refreshKeepSel() {
    const sel = new Set(this.view.sel);
    const foc = this.view.focused;
    await this.refresh();
    // re-select surviving
    sel.forEach(k => { if (this.view.view.some(e => this.view.keyAt(this.view.idxOf(k)) === k)) { } });
    this.view.sel = new Set(this.view.view.map(k => k).filter ? [...sel].filter(k => this.view.view.some(e => keyOfEntryLocal(e) === k)) : []);
    this.view.focused = foc;
    this.view.render(); this.drawFoot();
  }
  drawFoot() {
    const foot = $('.pane-foot', this.root);
    const n = this.view.entries.length;
    const total = this.view.entries.reduce((a, e) => a + (e.isDir ? 0 : e.size), 0);
    const sel = this.view.selected();
    const selSize = sel.reduce((a, e) => a + (e.isDir ? 0 : e.size), 0);
    foot.innerHTML = '';
    foot.appendChild(el('span', '', `${n} items · ${fmtSize(total)}`));
    if (sel.length) foot.appendChild(el('span', '', `⋮ ${sel.length} selected · ${fmtSize(selSize)}`));
    const f = this.view.filterText;
    if (f) foot.appendChild(el('span', '', `filter: ${f}`));
    const free = this.app.driveFreeOf(this.cwd());
    if (free != null) foot.appendChild(el('span', 'grow', ''));
    else foot.appendChild(el('span', 'grow', ''));
    if (free != null) foot.appendChild(el('span', '', `${this.cwd().slice(0, 2)}: free ${fmtSize(free)}`));
  }
  async drawTree() {
    if (!pref('showTree') || !this.tree) return;
    try {
      await this.tree.updateSel(this.cwd());
      if (pref('treeFollowsPane') !== false) await this.tree.expandTo(this.cwd());
    } catch { /* tree is a convenience, never block navigation */ }
  }
  async updateTreeSel(p) { await this.tree?.updateSel(p); }
  async expandTo(p) { await this.tree?.expandTo(p); }
}

function keyOfEntryLocal(e) { return e.name.toLowerCase() + (e.isDir ? '/' : ''); }
