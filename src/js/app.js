// Xplorer² Modern — app bootstrap & glue (clean-room)
console.log('[x2m] app.js module loading, x2 present:', typeof window.x2);
import { el, $, $$, on, fmtSize, fmtDate, esc, iconFor, baseName, parentOf, sleep, isARCHIVE, isIMAGE, isTEXT, fuzzyScore, fuzzyHl, toast } from './util.js';
import { S, loadStore, pref, persist, flush, defaults } from './store.js';
import { Pane } from './pane.js';
import { Tree } from './tree.js';
import { PreviewPane, Scrap } from './panels.js';
import { DEFAULT_COLUMNS, COLUMN_DEFS } from './views.js';
import * as T from './tools.js';
import { pathCopyModes, copyPathsAsync, setDefaultModeId, defaultModeId } from './pathcopy.js';
import { icon, hydrateIcons } from './icons.js';
import { renderMenu, moveHot, setHot, openMenu, closeMenu } from './popup.js';
import { typeLabel } from './filetypes.js';

const X = id => window.x2[id];

class App {
  constructor() {
    this.prefs = Object.assign(defaults(), S.prefs);
    this.active = null;
    this.mirrorBusy = false;
    this.clipboard = null; // {mode:'copy'|'cut', paths:[]}
    this.drives = [];
    this.scrap = new Scrap(this);
    this.searchRootMemory = [];
    this.previewPane = new PreviewPane(this, $('#preview'));
    this.previewHighlight = null;
  }
  async boot() {
    await loadStore();
    this.prefs = Object.assign(defaults(), S.prefs);
    Object.entries(this.prefs).forEach(([k, v]) => pref(k, v)); // commit loaded prefs
    this.reloadTheme();
    hydrateIcons(document);
    this.paneL = new Pane(this, $('#pane-L'), 'L');
    this.paneR = new Pane(this, $('#pane-R'), 'R');
    $('#pane-L').classList.add('active');
    this.active = this.paneL;
    this.drives = [];
    await this.buildDrivebar();
    for (const pane of [this.paneL, this.paneR]) {
      pane.view.viewMode = pref('viewMode');
      pane.view.buildHead();
      const home = await X('home')().catch(() => null);
      const rec = S.savedLayout?.[pane.id]?.[0];
      const saved = typeof rec === 'string' ? rec : rec?.path;
      const cands = [saved, home, 'C:\\'].filter(Boolean);
      let start = cands[0];
      for (const c of cands) {
        try { const st = await X('stat')(c); if (st?.isDirectory) { start = c; break; } } catch { }
      }
      await pane.addTab(start, true, typeof rec === 'object' ? rec?.hist : null);
      await pane.refresh();
    }
    this.applyLayout();
    this.active.activate();
    this.refreshAddr();
    this.refreshNavState();
    this.syncToggleState();
    // restore tree visibility
    for (const pane of [this.paneL, this.paneR]) {
      if (pref('showTree')) { pane.treeEl.classList.remove('hidden'); pane.tree = new Tree(this, pane, pane.treeEl); pane.tree.load().catch(() => { }); }
      if (pref('showPreview')) { this.previewPane.show(this.active.view.focusedEntry()); }
    }
    // install shared chrome bindings (ribbon, address bar, bookmark, mirror, status)
    this.wireChrome();
    this.wireSharedChromeBindings();
    this.wireKeys();
    this.refreshMirror();
    // drive probe is instant (statfs); re-poll once so background-enriched
    // volume labels/types repaint the bar and the status line
    this.refreshDrivesSoon().catch(() => { });
    setTimeout(() => this.refreshDrivesSoon().catch(() => { }), 3500);
    console.log('[x2m] ready');
  }
  applyLayout() {
    if (pref('stackPanes')) $('#panes').classList.add('stack');
    if (!pref('singlePane')) { $('#pane-R').style.display = ''; $('#split-v').style.display = ''; $('#split-p').style.display = ''; }
    else { $('#split-v').style.display = 'none'; $('#pane-R').style.display = 'none'; }
    if (pref('showTree')) { $$('.tree').forEach(t => t.classList.remove('hidden')); }
    if (pref('showPreview')) { $('#preview').classList.remove('hidden'); $('#split-p').classList.remove('hidden'); }
  }
  reloadTheme() {
    document.documentElement.dataset.theme = this.prefs.theme === 'light' ? 'light' : 'dark';
    document.documentElement.style.setProperty('--accent', this.prefs.accent || '');
  }

  // ---------------- drives
  async refreshDrivesSoon() {
    clearTimeout(this._dt); clearTimeout(this.dt2);
    // NB: awaiting first then calling .catch?.() yields undefined (arrays have no
    // .catch), which silently kept this.drives empty forever.
    try { this.drives = await X('drives')(); } catch { /* keep the last known list */ }
    if (this.drives?.length) this.buildDrivebar();
    const cwd = this.active.cwd();
    const drv = this.drives.find(d => cwd.toLowerCase().startsWith(d.path.slice(0, 2).toLowerCase()));
    this.freeOfDrive = drv?.free;
    $('#st-drive', document).textContent = drv ? `${drv.path} free ${fmtSize(drv.free)} of ${fmtSize(drv.total)}` : '';
    this.dt2 = setTimeout(() => this.refreshDrivesSoon(), 30000);
  }
  driveFreeOf(cwd) {
    const drv = this.drives.find(d => (cwd || '').toLowerCase().startsWith(d.path.slice(0, 2).toLowerCase()));
    return drv ? drv.free : null;
  }
  async buildDrivebar() {
    const bar = $('#drivebar');
    bar.replaceChildren();
    for (const d of this.drives) {
      const c = el('div', 'drive-chip');
      const pct = d.total ? 1 - d.free / d.total : 0;
      const ic = el('span', 'ic');
      ic.appendChild(icon('hard-drive', 13));
      const label = el('b', '', d.path.replace(/\\$/, ''));
      const free = el('span', '', fmtSize(d.free) + ' free');
      const barEl = el('div', 'bar');
      const fill = el('i');
      fill.style.width = Math.round(pct * 100) + '%';
      fill.style.background = pct > 0.9 ? 'var(--bad)' : 'var(--accent)';
      barEl.appendChild(fill);
      c.append(ic, label, free, barEl);
      c.title = `${d.path}\n${d.total ? fmtSize(d.total) + ' total · ' : ''}${fmtSize(d.free)} free\n${d.type <= 3 ? 'fixed disk' : d.type === 4 ? 'network drive' : 'removable'}`;
      on(c, 'click', () => this.nav(this.active, d.path));
      on(c, 'contextmenu', ev => this.driveCtx(ev, d));
      bar.appendChild(c);
    }
  }

  // ---------------- navigation actions
  async nav(pane, p) {
    if (this.active !== pane) pane.activate();
    await pane.navigateByPath(p);
    // tree refresh
    await pane.drawTree?.();
    this.otherOf(pane).drawTree?.();
  }
  otherOf(p) { return p === this.paneL ? this.paneR : this.paneL; }
  addRecent(path) {
    const r = S.recent.filter(p => p.path.toLowerCase() !== path.toLowerCase());
    r.unshift({ path, at: Date.now() });
    S.recent = r.slice(0, 30);
    persist();
  }
  async dirExists(p) {
    try {
      const st = await X('stat')(p);
      return !!st;
    } catch { /* fallthrough */ }
    const st = await X('stat')(p).catch(() => null);
    return !!(st && st.isDirectory());
  }
  fsExists(p) { return this.dirExists(p); }
  async listDir(p) {
    if (!p.endsWith('\\') && /^[a-zA-Z]:$/.test(p)) p += '\\';
    const es = await X('listDir')(p).catch(() => []);
    // attach attrs lazily
    for (const e of es) {
      e.path = p.replace(/\\$/, '') + '\\' + e.name;
      e.isDir && (e.attrText = 'd');
      void e;
    }
    return es;
  }
  async readText(p, limit) { try { return await X('readText')(p, limit); } catch (e) { return { error: String(e), text: '', encoding: '', size: 0, truncated: false }; } }
  async hexOf(p) { try { return await X('hexPreview')(p); } catch { return null; } }

  // ---------------- files ops (used by ctx menu & drag & drop)
  async dropTransfer(paths, dst, move) {
    if (!paths.length) return;
    const entries = paths.map(p => ({ src: p, name: baseName(p), rel: baseName(p) }));
    await this.doTransferRaw(entries, dst, { move: !!move, overwrite: true, filter: '' });
  }
  async doTransfer(entries, dst, opts, jobInfo) {
    // entries: view entries (isDir info)
    const flat = [];
    for (const en of entries) {
      if (en.isDir) {
        let kids = [];
        try { kids = await this.childPaths(en.path); } catch { kids = []; }
        void kids;
      }
      flat.push({ src: en.path, name: en.name, rel: en.name });
    }
    await this.doTransferRaw(flat, dst, opts, jobInfo);
  }
  // ---- small helpers other panels/dialogs call back into ----------------
  toast(msg, kind = '', ms) { return toast(msg, kind, ms); }
  async pickDir(title) {
    try {
      const r = await X('pick')('directory', title ? { title } : {});
      return (r && !r.canceled && r.filePaths && r.filePaths[0]) || null;
    } catch { return null; }
  }
  async deleteEntries(paths, permanent = false) {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return;
    await this.doDelete(list, permanent);
  }
  async transferEls(entries, dst, opts = {}) {
    const list = (entries || []).filter(e => e && (e.src || e.path))
      .map(e => ({ src: e.src || e.path, name: e.name || baseName(e.src || e.path), rel: e.rel || e.name || baseName(e.src || e.path) }));
    if (!list.length || !dst) return;
    await this.doTransferRaw(list, String(dst).replace(/\\$/, ''), { move: false, overwrite: false, filter: '', skipOlder: false, ...opts });
  }
  async doTransferRaw(entries, dst, opts, jobInfo) {
    const jobId = this.newJobId();
    const title = (opts.move ? 'Moving' : 'Copying') + (jobInfo?.title ? '' : '');
    const d = T.dlg(title || (opts.move ? 'Moving' : 'Copying'), {}, { width: 560 });
    const st = el('div', 'prog-row', `starting…`);
    const pbar = el('div', 'prog'); const bi = el('i'); pbar.appendChild(bi);
    const log = el('div', 'cmdout', ''); log.hidden = true;
    d.body.appendChild(st); d.body.appendChild(pbar); d.body.appendChild(log);
    const cancelJob = el('button', 'btn danger', 'Cancel');
    let cancelled = false;
    on(cancelJob, 'click', () => { cancelled = true; d._close(); this.toast('Transfer cancelled', 'ok'); });
    d.foot.appendChild(cancelJob);
    const progSub = (done, total, bytes, en) => {
      if (total) { bi.style.width = Math.round(done / total * 100) + '%'; }
      st.textContent = `${done}/${total}${en ? ' · ' + en.name : ''}`;
    };
    try {
      // respect text filter on names
      let list = entries;
      if (opts.filter) {
        const parts = opts.filter.split(/[;,]+/).map(s => s.trim()).filter(Boolean).map(f => new RegExp(f.replace(/[.+^${}()|[\]\\]/g, m => '\\' + m).replace(/\*/g, '.*').replace(/\?/g, '.'), 'i'));
        list = entries.filter(e => parts.some(rx => rx.test(e.name)));
      }
      const dstx = dst.endsWith('\\') ? dst : dst + '\\';
      const r = await X('transfer')(list, dstx, {
        move: opts.move, overwrite: opts.overwrite, skipOlder: opts.skipOlder, skipNewer: opts.skipNewer,
        renameConflicts: opts.renameConflicts, continueOnError: opts.continueOnError != null ? opts.continueOnError : true
      }, jobId);
      void r;
      if (!r?.errors?.length) {
        st.textContent = 'done';
        bi.style.width = '100%';
        setTimeout(() => d._close(), 400);
        this.toast(`${opts.move ? 'Moved' : 'Copied'} ${list.length} item(s)`, 'ok');
      } else {
        log.hidden = false; log.textContent = r.errors.join('\n');
        st.textContent = r.done + ' copied, ' + r.errors.length + ' error(s)';
      }
    } catch (err) {
      st.textContent = 'error: ' + (err.message || err);
    }
    await this.active.refreshKeepSel?.();
    await this.otherOf(this.active).refreshKeepSel?.();
    await this.refreshTreeKeep();
  }
  async childPaths(dir) {
    const es = await this.listDir(dir);
    return es.map(e => dir + '\\' + e.name);
  }
  async refreshTreeKeep() {
    for (const pane of [this.paneL, this.paneR]) { try { pane.tree?.refresh?.(pane.cwd()); } catch { } }
  }
  async doDelete(paths, permanent = false) {
    if (pref('confirmDelete')) {
      const r = await this.msg({
        title: 'Delete', message: `Delete ${paths.length} item(s)\n${permanent ? 'permanently' : 'to recycle bin'}?`,
        buttons: ['Delete', 'Cancel'], cancelId: 1
      });
      if (r.response !== 0) return;
    }
    await T.runJob2('Deleting', 'delete', async c => {
      const r = await X('deletePaths')(paths, permanent, c.job('del'));
      if (r?.errors?.length) { this.toast(r.errors[0], 'err'); }
    });
    await this.active.refresh(); await this.otherOf(this.active).refresh();
    await this.refreshTreeKeep();
  }
  async msg(o) { const r = await X('msgBox')(o); if (this.REDUX_fail) throw new Error(); return r; }
  async msg2(o) { return X('msgBox')(o); }
  newJobId() { return 'j' + Math.floor(Math.random() * 1e9); }
  onJobProgress(id, fn) {
    const h = (jobId, ...a) => { if (jobId === id) fn(...a); };
    return window.x2.onProgress(h) || (() => { });
  }
  pickDirAct(cb) { return (async () => { const p = await this.pickDir('Pick folder'); if (p) cb(p); })(); }

  // ---------------- open logic
  async openEntry(e) {
    const ext = e.name.split('.').pop().toLowerCase();
    if (e.isDir) return this.nav(this.active, e.path);
    if (pref('zipMode') === 'browse' && isARCHIVE({ name: e.name, isDir: false })) return this.openArchiveTab(this.active, e.path);
    await X('open')(e.path);
  }
  async openPath(p) {
    if (this.fsExists !== null) this.fsExists; // noop ref
    try { await X('open')(p); } catch (e) { this.toast(String(e), 'err'); }
  }
  runScrapItem(it) { this.openPath(it.path); }

  isArchivePath(p) { return isARCHIVE({ name: p.split('\\').pop(), isDir: false }); }

  copyPathsForEntry(entry) {
    const sel = this.active.view.selected();
    const target = typeof entry === 'string' ? entry : entry?.path;
    const paths = sel.length ? sel.map(x => x.path) : [target].filter(Boolean);
    if (!paths.length) return;
    const mode = setDefaultModeId('full');
    this.copyText(copyPathsAsync(paths, mode));
    this.toast(`Copied ${paths.length} path(s) — ${mode.label || mode.id}`);
  }
  async openInNewTab(path) {
    await this.active.addTab(path || this.active.cwd(), true);
  }

  copyPathsFromSelection() {
    const pane = this.active;
    const sel = pane.view.selected();
    if (sel.length) {
      const mode = setDefaultModeId('full');
      const txt = copyPathsAsync(sel.map(s => s.path), mode);
      this.copyText(txt);
      this.toast(`Copied ${sel.length} path(s) — ${mode.label || mode.id}`);
      return;
    }
    const mode = setDefaultModeId('full');
    const txt = copyPathsAsync([pane.cwd()], mode);
    this.copyText(txt);
    this.toast(`Copied folder path — ${mode.label || mode.id}`);
  }

  // ---------------- archives
  async openArchiveTab(pane, apath) {
    const ext = apath.split('.').pop().toLowerCase();
    const r = await X('listArchive')(apath, ext);
    if (r.error) { this.toast(r.error, 'err'); pref('zipMode', 'open'); return this.openPath(apath); }
    let list = r.entries || [];
    // navigate subpath support via tab.ctx: root archive + subfolder within archive
    const tab = pane.activeTab;
    tab.archive = { path: apath, ext };
    tab.listPath = null;
    pane.activeTab.path = apath;
    const entries = list.map(e => mkArchiveEntry(e, apath));
    pane.view.apply(entries);
    pane.view.entries = entries;
    this.toast(`Archive "${baseName(apath)}" — read-only (Enter on file extracts & previews/opens)`);
    void r;
  }
  async extractSingle(archive, name, targetDir) {
    // naive: extracts all matching prefix
    const r = await this.x2Extract(archive.path, archive.ext, targetDir + '\\', [name]);
    return r;
  }
  async x2Extract(a, ext, dst, names) {
    return X('extractArchive')(a, ext, dst, names, this.newJobId());
  }

  // ---------------- address bar
  wireChrome() {
    const addr = $('#address');
    on(addr, 'keydown', e => {
      const recent = $('#addr-recent');
      const recentOpen = recent && !recent.classList.contains('hidden');
      if (recentOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        moveHot(recent, e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (recentOpen && e.key === 'Enter' && recent.querySelector('.mi.hot')) {
        e.preventDefault();
        recent.querySelector('.mi.hot').click();
        return;
      }
      if (recentOpen && e.key === 'Escape') {
        e.preventDefault();
        this.hideAddrRecent();
        return;
      }
      if (e.key === 'Enter') {
        const v = addr.value.trim();
        if (v.startsWith('>')) { this.runAddressCommand(v.slice(1).trim()); return; }
        this.nav(this.active, v);
        this.hideAddrRecent();
        addr.blur();
      } else if (e.key === 'Escape') { this.refreshAddr(); this.hideAddrRecent(); addr.blur(); }
      else if (e.key === 'Tab') {
        e.preventDefault();
        const nxt = this.completionList?.[(this.completionSel ?? -1) + 1];
        if (nxt) { this.showCompletion(nxt); this.applyCompletion(nxt, null); $('#address').value = $('#address').value.replace(/\\$/, nxt.isDir ? '\\' : ''); this.showCompletions(); }
      }
    });
    on(addr, 'input', () => {
      if (addr.value.trim()) { this.hideAddrRecent(); this.showCompletions(); }
      else { this.hideCompletions(); this.showAddrRecent(); }
    });
    on(addr, 'blur', () => setTimeout(() => { this.hideCompletions(); this.hideAddrRecent(); }, 180));
    on(addr, 'focus', () => { if (!addr.value.trim()) this.showAddrRecent(); });
    const navBtn = (id, fn, menuFn) => {
      const b = $(id);
      if (!b) return;
      on(b, 'click', fn);
      on(b, 'contextmenu', ev => {
        ev.preventDefault();
        const model = menuFn();
        if (!model.groups?.some(g => g.items.length)) return this.toast('No history yet');
        const r = b.getBoundingClientRect();
        openMenu(model, { clientX: r.left, clientY: r.bottom + 4 });
      });
    };
    navBtn('#nav-back', () => this.active.back(), () => this.active.backMenu());
    navBtn('#nav-fwd', () => this.active.fwd(), () => this.active.fwdMenu());
    navBtn('#nav-up', () => this.active.up(), () => {
      const up = this.active.upTarget();
      return { title: 'Up', groups: [{ items: up ? [{ label: baseName(up) || up, hint: up, icon: 'folder-open', run: () => this.active.up() }] : [] }] };
    });
    on($('#nav-copy-path'), 'click', () => this.copyPathsFromSelection());
    on($('#nav-copy-mode'), 'click', ev => { ev.stopPropagation(); this.copyPathModeMenu(); });
    on($('#nav-copy-path'), 'auxclick', ev => { if (ev.button === 1) { ev.preventDefault(); this.copyPathModeMenu(); } });
    on($('#filter-input'), 'keydown', async e => {
      if (e.key === 'Enter') {
        const p = this.active;
        p.view.filterText = $('#filter-input').value;
        await p.view.sort(); p.view.render(); p.drawFoot(); this.updateStatusFilter();
      }
      if (e.key === 'Escape') { this.clearFilter(); }
    });
    on($('#mirror-toggle'), 'click', () => { pref('mirrorBrowse', !pref('mirrorBrowse')); this.refreshMirror(); });
    on($('#win-min'), 'click', () => this.minWin());
    on($('#win-max'), 'click', () => this.maxWin());
    on($('#win-close'), 'click', () => this.closeWin());
    ['#split-v', '#split-p'].forEach(id => {
      const sp = $(id);
      on(sp, 'mousedown', e => {
        e.preventDefault();
        const isPreview = id === '#split-p';
        const startX = e.clientX, startY = e.clientY;
        const p = isPreview ? $('#preview') : (pref('stackPanes') ? null : $('#pane-L'));
        const ps = isPreview ? $('#pane-R') : null;
        const w0 = p ? p.getBoundingClientRect().width : 0;
        const t0 = p ? p.getBoundingClientRect().height : 0;
        const rw0 = ps ? ps.getBoundingClientRect().width : 0;
        const mm = ev => {
          if (isPreview) { const nw = Math.max(220, rw0 - (ev.clientX - startX)); $('#preview').style.width = nw + 'px'; }
          else if (pref('stackPanes')) { const nh = Math.max(120, t0 + (ev.clientY - startY)); $('#pane-L').style.height = nh + 'px'; $('#pane-R').style.height = `calc(100% - ${nh + 6}px)`; }
          else { const nw = Math.max(200, w0 + ev.clientX - startX); $('#pane-L').style.flex = 'none'; $('#pane-L').style.width = nw + 'px'; }
          $$('#panes .list').forEach(l => l._k ||= (l.dispatchEvent(new Event('scroll')), 1));
        };
        const mu = () => { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); sp.classList.remove('drag'); };
        document.addEventListener('mousemove', mm);
        document.addEventListener('mouseup', mu);
        sp.classList.add('drag');
      });
    });
    // ribbon commands
    $$('#ribbon [data-cmd]').forEach(b => on(b, 'click', () => this.runCmd(b.dataset.cmd)));
  }
  wireSharedChromeBindings() {
    on($('#btn-bookmark'), 'click', () => this.bookmarkCurrent());
    on($('#btn-bookmark'), 'contextmenu', ev => { ev.preventDefault(); this.showBookmarkMenu({ clientX: ev.clientX, clientY: ev.clientY }); });
    on($('#address'), 'auxclick', ev => { if (ev.button === 1) { ev.preventDefault(); this.copyPathsFromSelection(); } });
    on($('#filter-input'), 'keydown', async e => {
      if (e.key === 'Enter') {
        const p = this.active;
        p.view.filterText = $('#filter-input').value;
        await p.view.sort(); p.view.render(); p.drawFoot(); this.updateStatusFilter();
      }
      if (e.key === 'Escape') this.clearFilter();
    });
  }
  minWin() { window.x2.winCmd?.('minimize'); }
  maxWin() { window.x2.winCmd?.('maximize'); }
  closeWin() { flush(); window.x2.winCmd?.('close') || window.close(); }
  showCompletions() {
    const v = $('#address').value;
    if (!v || v.startsWith('>')) return this.hideCompletions();
    const cwd = v.includes('\\') ? v.replace(/\\[^\\]*$/, '') || '\\' : this.active.cwd();
    const last = v.split('\\').pop() || '';
    const dir = cwd.endsWith('\\') || /^[A-Za-z]:$/.test(cwd) ? (cwd.endsWith('\\') ? cwd : cwd + '\\') : cwd;
    window.x2.listDir(dir).then(entries => {
      const cands = (entries || []).filter(e => e.name?.toLowerCase().startsWith(last.toLowerCase())).slice(0, 200);
      this.completionList = cands;
      this.completionSel = null;
      const box = $('#completions');
      box.innerHTML = '';
      box.classList.remove('hidden');
      for (const c of cands) {
        const it = el('div', 'it');
        const ic = el('span', 'ic');
        ic.appendChild(icon(iconFor(c), 14));
        it.appendChild(ic);
        it.appendChild(el('span', 'nm', c.name));
        it.appendChild(el('span', 'k', c.isDir ? 'folder' : 'file'));
        on(it, 'mousedown', ev => { ev.preventDefault(); this.applyCompletion(c, cwd); });
        it.onmouseenter = () => { this.completionSel = cands.indexOf(c); $$('#completions .it').forEach(x => x.classList.remove('sel')); it.classList.add('sel'); };
        box.appendChild(it);
      }
      this.showCompletion(cands[0]);
    }).catch(() => this.hideCompletions());
  }
  showCompletion(c) {
    if (!c) return;
    this.completionSel = this.completionList?.indexOf(c) ?? -1;
    $$('#completions .it').forEach((x, i) => x.classList.toggle('sel', i === this.completionSel));
  }
  applyCompletion(c, cwd) {
    const cur = $('#address').value;
    const stem = cur.includes('\\') ? cur.slice(0, cur.lastIndexOf('\\') + 1) : '';
    $('#address').value = stem + c.name + (c.isDir ? '\\' : '');
    this.hideCompletions();
  }
  hideCompletions() { $('#completions').classList.add('hidden'); }
  refreshAddr() {
    if (document.activeElement === $('#address')) { this.refreshNavState(); return; }
    const p = this.active?.cwd() || '';
    $('#address').value = p;
    this.refreshNavState();
  }

  // ---------------- browser memory: nav state + recent-locations drop-down
  refreshNavState() {
    const pane = this.active;
    if (!pane) return;
    const setBtn = (id, target, label) => {
      const b = $(id);
      if (!b) return;
      b.classList.toggle('dis', !target);
      b.disabled = !target;
      b.title = target ? `${label}\n${target}\nRight-click for history` : `No ${label.toLowerCase()}`;
    };
    setBtn('#nav-back', pane.backTarget?.(), 'Back');
    setBtn('#nav-fwd', pane.fwdTarget?.(), 'Forward');
    setBtn('#nav-up', pane.upTarget?.(), 'Up');
    const h = pane.historyStack?.();
    if (h && h.stack?.length) $('#nav-back').setAttribute('data-depth', String(h.pos));
  }
  /** Recent locations + bookmarks + this pane's history, in one structured popup. */
  addrRecentModel() {
    const pane = this.active;
    const here = (pane.cwd() || '').toLowerCase();
    const seen = new Set();
    const loc = (p, iconName) => ({
      label: baseName(p) || p,
      hint: p,
      icon: iconName,
      checked: p.toLowerCase() === here,
      run: () => { this.nav(pane, p); this.hideAddrRecent(); $('#address').blur(); }
    });
    const groups = [];
    const hist = pane.historyStack?.();
    const histItems = [];
    if (hist?.stack?.length) {
      for (let i = hist.stack.length - 1; i >= 0 && histItems.length < 8; i--) {
        const p = hist.stack[i];
        if (p.toLowerCase() === here || seen.has(p.toLowerCase())) continue;
        seen.add(p.toLowerCase());
        histItems.push(loc(p, 'clock'));
      }
    }
    if (histItems.length) groups.push({ label: 'This tab\'s history', items: histItems });
    const recentItems = [];
    for (const r of (S.recent || [])) {
      const p = r.path;
      if (!p || seen.has(p.toLowerCase())) continue;
      seen.add(p.toLowerCase());
      recentItems.push(loc(p, 'route'));
      if (recentItems.length >= 8) break;
    }
    if (recentItems.length) groups.push({ label: 'Recent locations', items: recentItems });
    const bmItems = (S.bookmarks || []).filter(b => b.path).map(b => {
      seen.add(b.path.toLowerCase());
      return { label: b.name || baseName(b.path), hint: b.path, icon: 'star', run: () => { this.nav(pane, b.path); this.hideAddrRecent(); $('#address').blur(); } };
    });
    if (bmItems.length) groups.push({ label: 'Bookmarks', items: bmItems });
    return { groups };
  }
  showAddrRecent() {
    const box = $('#addr-recent');
    if (!box) return;
    const model = this.addrRecentModel();
    if (!model.groups.length) { box.classList.add('hidden'); return; }
    renderMenu(box, model, { onPick: it => it.run?.() });
    box.classList.remove('hidden');
    moveHot(box, 1);
  }
  hideAddrRecent() { $('#addr-recent')?.classList.add('hidden'); }
  updateStatusFilter() {
    const f = this.active.view.filterText;
    $('#st-filter').classList.toggle('hidden', !f);
    $('#st-filter').textContent = f ? 'filter ' + f : '';
  }
  clearFilter() {
    $('#filter-input').value = '';
    $('#filter-input').classList.add('hidden');
    this.active.view.filterText = '';
    this.active.view.sort(); this.active.view.render();
    this.active.drawFoot?.(); this.updateStatusFilter();
  }
  refreshMirror() {
    $('#mirror-toggle').classList.toggle('on', !!pref('mirrorBrowse'));
    $('#st-mirror').classList.toggle('hidden', !pref('mirrorBrowse'));
  }
  updateBookmarkStar() {
    const p = (this.active?.cwd() || '').toLowerCase();
    const has = this.hasBookmark(p);
    const b = $('#btn-bookmark');
    if (!b) return;
    b.classList.toggle('on', has);
    b.replaceChildren(icon(has ? 'star-filled' : 'star', 15));
    b.title = has ? 'Remove bookmark (Ctrl+Q) · right-click for all bookmarks' : 'Bookmark this location (Ctrl+Q) · right-click for all bookmarks';
  }
  hasBookmark(p) { return (S.bookmarks || []).some(b => (b.path || b).toLowerCase() === p); }
  tagsFor(p) { const v = S.tagsByPath?.[p.toLowerCase()]; return v ? { color: '#' + v.replace(/^#/, '') } : null; }
  bookmarkCurrent() {
    const p = this.active.cwd();
    if (this.hasBookmark(p.toLowerCase())) {
      S.bookmarks = S.bookmarks.filter(b => (b.path || b).toLowerCase() !== p.toLowerCase());
      this.toast('Bookmark removed', 'ok');
    } else {
      S.bookmarks.push({ path: p, name: baseName(p) || p });
      this.toast('Bookmarked', 'ok');
    }
    persist(); this.updateBookmarkStar();
  }
  copyPaths(paths) {
    if (!paths?.length) return;
    this.copyText(paths.join('\n'));
    this.toast(`Copied ${paths.length} path(s)`, 'ok');
  }
  copyText(t) { X('copyText')(t); }

  // ---------------- context menus (one structured model, see popup.js)
  openCtx(ev, pane, rowEl) {
    const entry = rowEl ? pane.view.view[+rowEl.dataset.idx] : null;
    const sel = pane.view.selected();
    ev.preventDefault();
    const p = entry?.path;
    const groups = [];
    if (entry) {
      const multi = sel.length > 1;
      groups.push({
        label: multi ? `${sel.length} items selected` : typeLabel(entry),
        items: [
          { label: multi ? `Open all ${sel.length}` : 'Open', icon: entry.isDir ? 'folder-open' : 'external-link', key: 'Enter', run: () => multi ? sel.forEach(x => this.openEntry(x)) : this.openEntry(entry) },
          { label: 'Preview', icon: 'eye', key: 'F7', run: () => this.previewPane.show(entry) },
          { label: 'Show in Explorer', icon: 'folder-open', run: () => X('showInExplorer')(p) }
        ]
      });
      groups.push({
        label: 'Transfer',
        items: [
          { label: 'Copy to buffer', icon: 'copy', key: 'F5', hint: 'Then paste with Ctrl+V', run: () => this.copyClipboard('copy', multi ? null : entry) },
          { label: 'Cut to buffer', icon: 'scissors', key: 'F6', run: () => this.copyClipboard('cut', multi ? null : entry) },
          { label: 'Copy to other pane', icon: 'arrow-right', key: 'Ctrl+F5', run: () => this.quickTransfer('copy') },
          { label: 'Move to other pane', icon: 'arrow-right', key: 'Ctrl+F6', run: () => this.quickTransfer('move') },
          { label: 'Send to scrap', icon: 'plus-square', key: 'Ctrl+S', run: () => this.scrap.add(multi ? sel : [entry]) }
        ]
      });
      groups.push({
        label: 'Organize',
        items: [
          { label: 'Rename…', icon: 'pencil', key: 'F2', disabled: multi, run: () => this.renameEntry(entry) },
          { label: 'Delete to recycle bin', icon: 'trash', key: 'Del', run: () => this.doDelete(sel.length ? sel.map(s => s.path) : [p], false) },
          { label: 'Delete permanently', icon: 'trash', key: 'Shift+Del', run: () => this.doDelete(sel.length ? sel.map(s => s.path) : [p], true) },
          ...(entry.isDir ? [
            { label: 'Calculate folder size', icon: 'pie', key: 'Ctrl+G', run: () => this.calcSize(entry) },
            { label: 'Flatten folder into scrap', icon: 'layers', key: 'Alt+Enter', run: () => this.flatten(entry) }
          ] : [
            { label: 'Archive selection…', icon: 'file-archive', run: () => this.archiveEntry(sel.length ? sel : [entry]) },
            { label: 'Split file…', icon: 'split', run: () => T.splitDialog(this) },
            { label: 'Open with…', icon: 'external-link', run: () => this.openWithList(entry) }
          ])
        ]
      });
      groups.push({
        label: 'Tools',
        items: [
          { label: 'Timestamps & attributes…', icon: 'clock', key: 'Alt+Enter', run: () => T.propsDialog(this, entry, sel) },
          { label: 'Checksum SHA-256', icon: 'hash', hint: 'Copy the digest to the clipboard', run: async () => { const h = await X('hash')(p, 'sha256'); this.copyText(h); this.toast('SHA256: ' + h.slice(0, 16) + '… copied', 'ok'); } },
          { label: 'Color tag…', icon: 'tag', run: () => T.tagsDialog(this) },
          { label: 'Make link…', icon: 'link', hint: 'Hard link, junction or symlink', run: () => this.makeLink(entry) }
        ]
      });
      groups.push({
        label: 'Path',
        items: [
          { label: 'Copy path', icon: 'copy', key: 'Ctrl+P', hint: p, run: () => this.copyPathsForEntry(entry) },
          { label: 'Copy path as…', icon: 'copy', run: () => this.showPathCopyPicker(pane) }
        ]
      });
    } else {
      const isEmpty = !pane.view.entries.length;
      groups.push({
        label: baseName(pane.cwd()) || pane.cwd(),
        items: [
          { label: 'New folder', icon: 'folder-plus', key: 'Ctrl+Shift+N', run: () => this.newEntry('dir') },
          { label: 'New file', icon: 'file', run: () => this.newEntry('file') },
          { label: 'Paste', icon: 'copy', key: 'Ctrl+V', disabled: !this.clipboard, hint: this.clipboard ? `${this.clipboard.paths.length} item(s) in buffer` : 'Buffer is empty', run: () => this.pasteClipboard() }
        ]
      });
      groups.push({
        label: 'Selection',
        items: [
          { label: 'Select all', icon: 'list-checks', key: 'Ctrl+A', disabled: isEmpty, run: () => pane.view.selectAll() },
          { label: 'Select none', icon: 'circle-slash', disabled: isEmpty, run: () => pane.view.clearSel() },
          { label: 'Invert selection', icon: 'git-compare', disabled: isEmpty, run: () => pane.view.invertSel() },
          { label: 'Filter by wildcard…', icon: 'filter', key: 'Alt+K', run: () => this.startFilter() }
        ]
      });
      groups.push({
        label: 'Folder',
        items: [
          { label: 'Folder properties…', icon: 'info', run: () => T.propsDialog(this, { name: baseName(pane.cwd()), path: pane.cwd(), isDir: true, size: 0, mtimeMs: 0, ctimeMs: 0, atimeMs: 0 }) },
          { label: 'Copy path', icon: 'copy', hint: pane.cwd(), run: () => this.copyPaths([pane.cwd()]) },
          { label: 'Open terminal here', icon: 'terminal', key: 'Ctrl+`', run: () => this.runCmd('openTerminal') }
        ]
      });
    }
    this.showMenu(ev, { groups });
  }
  tabCtx(ev, tab) {
    ev.preventDefault();
    const pane = this.active;
    this.showMenu(ev, {
      title: tab.path,
      groups: [{
        items: [
          { label: 'New tab', icon: 'plus', key: 'Ctrl+T', run: () => pane.addTab(pane.cwd(), true) },
          { label: 'Duplicate tab', icon: 'copy', run: () => pane.addTab(tab.path, true, tab.hist.slice()) },
          { label: 'Rename tab…', icon: 'pencil', hint: 'Display name only', run: () => this.renameTabDialog(tab) },
          { label: tab.locked ? 'Unlock tab' : 'Lock tab', icon: 'lock', checked: !!tab.locked, run: () => { tab.locked = !tab.locked; pane.drawTabs(); } }
        ]
      }, {
        items: [
          { label: 'Close tab', icon: 'close', key: 'Ctrl+F4', run: () => pane.closeTab(tab) },
          { label: 'Close other tabs', icon: 'close', disabled: pane.tabs.length < 2, run: () => { pane.tabs = [tab]; pane.activateTab(tab); } },
          { label: 'Copy path', icon: 'copy', run: () => this.copyPaths([tab.path]) }
        ]
      }]
    });
  }
  renameTabDialog(tab) {
    this.prompt('Tab name:', tab.customName || baseName(tab.path), v => {
      tab.customName = v || '';
      this.active.drawTabs();
    });
  }
  driveCtx(ev, d) {
    ev.preventDefault();
    const free = d.total ? `${fmtSize(d.free)} free of ${fmtSize(d.total)}` : `${fmtSize(d.free)} free`;
    this.showMenu(ev, {
      title: d.path,
      groups: [{
        items: [
          { label: 'Open', icon: 'hard-drive', hint: free, key: 'Enter', run: () => this.nav(this.active, d.path) },
          { label: 'Open in other pane', icon: 'arrow-right', run: () => this.nav(this.otherOf(this.active), d.path) },
          { label: 'Copy drive path', icon: 'copy', run: () => this.copyPaths([d.path]) },
          { label: 'Refresh capacity', icon: 'refresh', run: () => this.refreshDrivesSoon() }
        ]
      }]
    });
  }
  treeCtx(ev, tree) {
    ev.preventDefault();
    this.showMenu(ev, {
      groups: [{
        items: [
          { label: 'Collapse all', icon: 'chevron-right', run: () => tree?.nodes?.forEach?.(n => tree.collapse?.(n)) },
          { label: 'Refresh tree', icon: 'refresh', run: () => { tree?.clear?.(); tree?.load?.(); } }
        ]
      }]
    });
  }
  showMenu(ev, spec) {
    const pos = ev && ev.clientX != null ? { clientX: ev.clientX, clientY: ev.clientY } : ev;
    T.showMenu(spec, pos);
  }
  // clipboard ops
  copyClipboard(mode = 'copy', entry) {
    const sel = entry ? [entry] : this.active.view.selected();
    if (!sel.length) return;
    this.clipboard = { mode, paths: sel.map(e => e.path), isDir: sel.map(e => e.isDir) };
    this.toast(`Ready to ${mode} ${sel.length} item(s)`);
  }
  pasteClipboard() {
    if (!this.clipboard) return;
    const dst = this.active.cwd().replace(/\\$/, '');
    const entries = this.clipboard.paths.map(p => ({ src: p, name: baseName(p), rel: baseName(p) }));
    this.doTransferRaw(entries, dst, { move: this.clipboard.mode === 'cut', overwrite: false /* ask via rule below */, filter: '' }).then(() => {
      if (this.clipboard.mode === 'cut') this.clipboard = null;
    });
  }
  async quickTransfer(mode = 'copy', entry) {
    const sel = entry || this.active.view.selected();
    const dst = this.otherOf(this.active).cwd();
    const entries = (sel.length ? sel : [entry]).map(e => ({ src: e.path, name: e.name, rel: e.name }));
    await this.doTransferRaw(entries, dst.replace(/\\$/, ''), { move: mode === 'move', overwrite: true, filter: '' });
  }
  renameEntry(entry) {
    const pane = this.active;
    const row = pane.view.root.querySelector(`.row[data-key="${((entry.name.toLowerCase() + (entry.isDir ? '/' : ''))).replace(/"/g, '\\"')}"]`);
    const nm = row?.querySelector('.col[name=name]');
    if (row) {
      const inp = el('input', 'rename-input');
      inp.value = entry.name;
      const nmCell = [...row.querySelectorAll('.col')].find(c => c.dataset.c === 'name');
      nmCell.innerHTML = ''; nmCell.appendChild(inp);
      inp.focus(); inp.select();
      const commit = async () => {
        const nv = inp.value.trim();
        if (nv && nv !== entry.name) {
          try {
            const oldPath = entry.path;
            const diffIdx = oldPath.lastIndexOf('\\' + entry.name);
            const newPath = oldPath.slice(0, oldPath.lastIndexOf(entry.name)) + nv;
            await X('rename')(oldPath, newPath);
            this._lastUndo = { kind: 'rename', from: oldPath, to: newPath };
          } catch (e) { this.toast('Rename failed: ' + (e.message || e), 'err'); }
        }
        await pane.refresh();
      };
      on(inp, 'keydown', e2 => { if (e2.key === 'Enter') commit(); if (e2.key === 'Escape') pane.refresh(); });
      on(inp, 'blur', () => pane.refresh());
    } else {
      this.prompt('Rename to:', entry.name, async v => {
        if (v && v !== entry.name) {
          await X('rename')(entry.path, entry.path.replace(entry.name, v));
          pane.refresh();
        }
      });
    }
  }
  async newEntry(kind = 'dir') {
    const pane = this.active;
    const p0 = pane.cwd() + '\\' + (kind === 'dir' ? 'New folder' : 'New file.txt');
    const name = this.prompt('New ' + kind + ' name', kind === 'dir' ? 'New folder' : 'New file.txt', async v => {
      if (!v) return;
      let p = pane.cwd() + '\\' + v;
      let i = 1;
      while (await this.fsExists(p)) p = p.replace(/( \d+)?$/, ' ' + i++);
      try {
        p = kind === 'dir' ? await X('mkdir')(pane.cwd(), v) : await X('touch')(pane.cwd(), v);
        this._lastUndo = { kind: 'new', path: p };
        pane.refresh();
        this.toast('Created ' + baseName(p), 'ok');
      } catch (e) { this.toast(String(e), 'err'); }
    });
    void p0;
  }
  prompt(t, val, cb) {
    const d = T.dlg(t, {}, { width: 400 });
    d.body.innerHTML = `<div class="field" style="flex:1"><input id="pp" class="chr-input" style="width:100%" value="${esc(val || '')}"></div>`;
    T.btn('OK', 'primary', () => { cb?.($('#pp', d.el).value.trim()); d._close(); }, d.foot);
    T.btn('Cancel', '', d._close, d.foot);
    const i = $('#pp', d.el); i.focus(); i.select();
  }
  async  openWithList(entry) {
    this.prompt('Open with (app path or URL):', '', async v => {
      if (v) { try { await X('openInApp')(entry.path, v, []); this.toast('opened with ' + v, 'ok'); } catch { this.toast('failed', 'err'); } }
    });
  }
  makeLink(entry) {
    const pane = this.otherOf(this.active);
    const dstDir = pane.cwd();
    this.prompt('Link as (path in other pane):', dstDir + '\\' + entry.name, async v => {
      const kind = await new Promise(res => {
        const d = T.dlg('Link type', {}, { width: 380 });
        d.body.innerHTML = `<div class="field" style="flex:1"><label>Kind</label><select id="lk" class="chr-input"><option value="hard">hard link (same volume)</option><option value="junction" selected>directory junction</option><option value="symlink">symbolic link</option></select></div>`;
        T.btn('Create', 'primary', () => { res($('#lk', d.el).value); d._close(); }, d.foot);
        T.btn('Cancel', '', d._close, d.foot);
      });
      void kind;
      if (kind) {
        const r = await X('link')(kind, entry.path, v);
        if (r.ok) { this.toast('Link created', 'ok'); pane.refresh(); }
        else this.toast(r.error || 'failed', 'err');
      }
    });
  }
  archiveEntry(sel) {
    this.prompt('Archive as: <name>.zip', (sel.length === 1 ? sel[0].name : 'archive') + '.zip', async v => {
      if (!v) return;
      const dst = this.active.cwd() + '\\' + v;
      await this.zipCreate(sel.map(s => ({ name: s.name, src: s.path, isDir: s.isDir })), dst);
      this.active.refresh();
    });
  }
  async zipCreate(items, dst) {
    await T.runJob('Creating archive', async c => {
      c.setBar(0);
      const r = await X('zipCreate')(items, dst, c.job('zip'));
      c.setBar(1);
      if (r?.ok === false) { this.toast(r.error || 'Archive failed', 'err'); return; }
      this.toast(`Archive created — ${r?.files ?? items.length} file(s)`, 'ok');
    });
  }
  async calcSize(entry) {
    const pane = this.active;
    await T.runJob2('Folder size', 'size', async c => {
      const r = await X('treeStat')(entry.path, c.job('ts'));
      pane.view.sizes.set(entry.path, r);
      pane.view.render();
      this.toast(`${entry.name}: ${fmtSize(r.size)} · ${r.files} files · ${r.dirs} dirs`, 'ok');
    });
  }
  dirStats() { T.folderStatsDialog(this); }
  async findEmptyDirs(root) {
    const out = [];
    const walk = async (dir, depth) => {
      try {
        const es = await X('listDir')(dir);
        if (!es.filter(e => e.isDir).length && !es.filter(e => !e.isDir).length) out.push(dir);
        for (const e of es.filter(x => x.isDir)) await walk(dir + '\\' + e.name, depth + 1);
      } catch { }
    };
    await walk(root, 0);
    return out;
  }

  // ---------------- commands (toolbar & shortcuts)
  async runCmd(cmd) {
    const pane = this.active;
    const sel = pane.view.selected();
    switch (cmd) {
      case 'refresh': await pane.refresh(); break;
      case 'newFolder': this.newEntry('dir'); break;
      case 'newFile': this.newEntry('file'); break;
      case 'copy': T.copyDialog(this, 'copy'); break;
      case 'move': T.copyDialog(this, 'move'); break;
      case 'quickCopy': await this.quickTransfer('copy'); break;
      case 'quickCopyLastOpts': await this.quickTransfer('copy'); break;
      case 'moveToOtherPane': await this.quickTransfer('move'); break;
      case 'deleteBin': await this.doDelete(sel.map(s => s.path), false); break;
      case 'deletePerm': await this.doDelete(sel.map(s => s.path), true); break;
      case 'rename': sel[0] ? this.renameEntry(sel[0]) : this.toast('select something'); break;
      case 'viewMode': {
        const modes = ['details', 'list', 'thumbs'];
        const cm = modes[(modes.indexOf(pref('viewMode')) + 1) % modes.length];
        pref('viewMode', cm);
        for (const p of [this.paneL, this.paneR]) { p.view.viewMode = cm; p.view.buildHead(); await p.refresh(); }
        break;
      }
      case 'toggleTree': {
        const on = !pref('showTree');
        pref('showTree', on);
        for (const p of [this.paneL, this.paneR]) {
          if (on) { p.treeEl.classList.remove('hidden'); if (!p.tree) { p.tree = new Tree(this, p, p.treeEl); await p.tree.load(); } await p.tree.updateSel(p.cwd()); await p.tree.expandTo?.(p.cwd()); }
          else p.treeEl.classList.add('hidden');
        }
        this.syncToggleState();
        break;
      }
      case 'togglePreview': this.setPreview(!pref('showPreview')); break;
      case 'toggleMini': this.toggleMini(pane); break;
      case 'filter': this.startFilter(); break;
      case 'find': T.searchDialog(this); break;
      case 'dupes': T.dupesDialog(this, [pane.cwd()]); break;
      case 'compare': T.compare(this, 'diffs'); break;
      case 'sync': T.compare(this, 'sync'); break;
      case 'toScrap': {
        const es = sel.length ? sel : pane.view.view;
        this.scrap.add(es);
        break;
      }
      case 'scrapDialog': this.scrap.openDialog(); break;
      case 'stats': this.dirStats(); break;
      case 'props': sel[0] ? T.propsDialog(this, sel[0], sel) : T.propsDialog(this, { name: baseName(pane.cwd()), path: pane.cwd(), isDir: true, size: 0, mtimeMs: 0, ctimeMs: 0, atimeMs: 0 }); break;
      case 'tags': T.tagsDialog(this); break;
      case 'massRename': T.massRenameDialog(this); break;
      case 'split': T.splitDialog(this); break;
      case 'merge': T.mergeDialog(this); break;
      case 'settings': T.settingsDialog(this); break;
      case 'palette': this.palette(); break;
      case 'editor': this.editText(sel[0]?.path); break;
      case 'newTab': await pane.addTab(pane.cwd(), true); break;
      case 'closeTab': pane.closeTab(pane.activeTab); break;
      case 'nextPane': this.switchPane(); break;
      case 'equalPanes': { $('#pane-L').style.width = ''; $('#pane-L').style.flex = ''; $('#pane-L').style.height = ''; $('#panes').adjust = null; break; }
      case 'sticky': pref('stickySelection', !pref('stickySelection')); this.toast('Sticky selection ' + (pref('stickySelection') ? 'on' : 'off'), 'ok'); break;
      case 'stackPanes': pref('stackPanes', !pref('stackPanes')); location.reload(); break;
      case 'selectByFilter': this.prompt('Select by wildcard:', '*.jpg', v => { if (v) pane.view.selectByFilter(v); }); break;
      case 'selectByType': this.prompt('Select by extension:', 'png', v => { if (v) pane.view.selectByFilter('*.' + v); }); break;
      case 'selectNone': pane.view.clearSel(); break;
      case 'selectAll': pane.view.selectAll(); break;
      case 'invertSel': pane.view.invertSel(); break;
      case 'refreshOther': this.otherOf(pane).refresh(); break;
      case 'mergeGoogle': this.toast('Cloud status columns are shown when the provider adds them to Windows'); break;
      case 'emptyDirs': { const r = await this.findEmptyDirs(pane.cwd()); T.emptyDirsDialog(this, [pane.cwd()], r); break; }
      case 'saveScrap': this.scrap.save(); break;
      case 'clearScrap': this.scrap.clear(); break;
      case 'bookmarks': this.showBookmarkMenu(this.anchorCenter()); break;
      case 'mkdirFromFile': this.newEntry('dir'); break;
      case 'openTerminal': {
        await X('runTerminal')(pane.cwd());
        break;
      }
      default: this.toast('unknown command ' + cmd);
    }
  }
  anchorCenter() {
    const r = $('#address').getBoundingClientRect();
    return { clientX: r.left + 20, clientY: r.bottom + 4 };
  }
  /** Preview pane visibility is one switch used by the ribbon, F7 and the menu. */
  setPreview(on) {
    pref('showPreview', !!on);
    $('#preview').classList.toggle('hidden', !on);
    $('#split-p').classList.toggle('hidden', !on);
    if (on) {
      this.previewPane.target(this.active);
      this.previewPane.render(this.active.view.focusedEntry());
    }
    this.syncToggleState();
  }
  syncToggleState() {
    const tree = $('#ribbon [data-cmd="toggleTree"]');
    if (tree) tree.classList.toggle('active', !!pref('showTree'));
    const pv = $('#ribbon [data-cmd="togglePreview"]');
    if (pv) pv.classList.toggle('active', !!pref('showPreview'));
  }
  showBookmarkMenu(ev) {
    const groups = [];
    const marks = (S.bookmarks || []).filter(b => b.path);
    if (marks.length) {
      groups.push({
        label: 'Bookmarks',
        items: marks.map(b => ({
          label: b.name || baseName(b.path), hint: b.path, icon: 'star',
          checked: (this.active.cwd() || '').toLowerCase() === b.path.toLowerCase(),
          run: () => this.nav(this.active, b.path)
        }))
      });
    }
    groups.push({
      label: 'Location',
      items: [{
        label: this.hasBookmark((this.active.cwd() || '').toLowerCase()) ? 'Remove this bookmark' : 'Bookmark this folder',
        icon: this.hasBookmark((this.active.cwd() || '').toLowerCase()) ? 'star-filled' : 'star',
        key: 'Ctrl+Q', run: () => this.bookmarkCurrent()
      }]
    });
    const grps = (S.folderGroups || []);
    if (grps.length) {
      groups.push({ label: 'Folder groups', items: grps.map(g => ({ label: g.name, icon: 'book', hint: `${g.left}  ↔  ${g.right}`, run: () => this.openGroup(g) })) });
    }
    groups.push({
      label: 'Groups',
      items: [
        { label: 'Save current pair as group…', icon: 'save', key: 'Ctrl+Shift+G', run: () => this.saveGroup() },
        { label: 'Manage groups…', icon: 'settings', run: () => this.openGroupDialog() }
      ]
    });
    this.showMenu(ev, { groups });
  }
  saveGroup() {
    const name = location ? '' : null;
    this.prompt('Group name:', 'group 1', v => {
      if (!v) return;
      S.folderGroups = (S.folderGroups || []).concat([{ name: v, left: this.paneL.cwd(), right: this.paneR.cwd() }]);
      persist();
      this.toast('Saved group', 'ok');
    });
    void name;
  }
  openGroupDialog() {
    const d = T.dlg('Folder groups', {}, { width: 420 });
    d.body.innerHTML = '';
    const t = el('table', 'tbl');
    for (const g of (S.folderGroups || [])) {
      const tr = el('tr', '', `<td>${esc(g.name)}</td><td style="color:var(--text-dim)">${esc(g.left)} ↔ ${esc(g.right)}</td>`);
      on(tr, 'dblclick', () => { this.openGroup(g); d._close(); });
      t.appendChild(tr);
    }
    d.body.appendChild(t);
    T.btn('Close', '', d._close, d.foot);
  }
  openGroup(g) {
    this.nav(this.paneL, g.left);
    this.nav(this.paneR, g.right);
  }
  switchPane() { (this.active === this.paneL ? this.paneR : this.paneL).activate(); }
  toggleMini(pane) {
    pane.miniEl.classList.toggle('hidden');
    if (!pane.miniEl.classList.contains('hidden')) { this.scrap.minis.add(pane.id); this.scrap.redrawMinis(); }
    else this.scrap.minis.delete(pane.id);
  }
  startFilter() {
    const fi = $('#filter-input');
    fi.classList.remove('hidden');
    fi.focus(); fi.select();
  }
  async runAddressCommand(cmdstr) {
    // token expansion against selection
    const pane = this.active;
    const sel = pane.view.selected();
    const sub = (s, i = 0) => s
      .replace(/\$d/gi, pane.cwd())
      .replace(/\$p/gi, sel[i]?.path || '')
      .replace(/\$f/gi, sel[i]?.name || '')
      .replace(/\$n/gi, (sel.length || 0));
    const cmd = sub(cmdstr);
    this.toast('> ' + cmd);
    await T.runJob('Running: ' + cmd, async c => {
      c.setLabel(cmd);
      const out = await X('runCapture')(cmd, pane.cwd());
      const d = T.dlg('Output', {}, { width: 720, icon: 'terminal' });
      d.body.innerHTML = `<div class="cmdout">${esc((out?.stdout || '') + (out?.stderr || ''))}</div>`;
      T.btn('Close', 'primary', d._close, d.foot);
    });
  }
  async editText(path) {
    if (!path) return;
    await T.editorDialog(this, path);
  }
  /** Command palette: same structured rows and keyboard model as context menus. */
  palette() {
    const pal = $('#palette');
    pal.classList.remove('hidden');
    const inp = $('.pal-input', pal);
    const list = $('.pal-list', pal);
    const all = this.commandList();
    inp.value = '';
    inp.focus();
    const close = () => { pal.classList.add('hidden'); };
    const render = q => {
      const groups = [];
      for (const g of this.commandGroups()) {
        const items = g.items
          .filter(c => !q || fuzzyScore(c.label, q) >= 0 || (c.hint && c.hint.toLowerCase().includes(q.toLowerCase())))
          .map(c => ({
            label: c.label, icon: c.icon, key: c.key, hint: c.hint, checked: c.checked,
            run: () => { close(); c.run(); }
          }));
        if (items.length) groups.push({ label: g.label, items });
      }
      const model = { groups };
      if (!groups.length) {
        list.replaceChildren(el('div', 'pal-empty', `No command matches “${q}”`));
        return;
      }
      renderMenu(list, model, { highlight: label => fuzzyHl(label, q), onPick: it => it.run?.() });
      moveHot(list, 1);
    };
    render('');
    inp.oninput = () => render(inp.value.trim());
    inp.onkeydown = e => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'Enter') { e.preventDefault(); activatePalette(list); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); moveHot(list, 1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveHot(list, -1); return; }
      if (e.key === 'Tab') { e.preventDefault(); moveHot(list, e.shiftKey ? -1 : 1); }
    };
    pal.onmousedown = ev => { if (ev.target === pal) close(); };
    $('#pal-close').onclick = close;
    function activatePalette(container) {
      const hot = container.querySelector('.mi.hot:not(.dis)') || container.querySelector('.mi:not(.dis):not(.mi-header)');
      hot?.click();
    }
  }
  copyPathModeMenu() {
    this.showMenu(this.anchorCenter(), {
      title: 'Path copy format',
      groups: [{
        items: pathCopyModes.map(m => ({
          label: m.label, icon: 'copy', key: m.hot, hint: m.example || m.hint,
          checked: defaultModeId() === m.id,
          run: () => { setDefaultModeId(m.id); this.toast('Path copy mode → ' + m.label, 'ok'); }
        }))
      }]
    });
  }
  showPathCopyPicker(pane) {
    this.showMenu(this.anchorCenter(), {
      title: 'Copy path as',
      groups: [{
        items: pathCopyModes.map(m => ({
          label: m.label, icon: 'copy', key: m.hot, hint: m.example || m.hint,
          run: () => { setDefaultModeId(m.id); this.doPathCopy(pane, m); }
        }))
      }]
    });
  }
  doPathCopy(pane, mode) {
    const sel = pane.view.selected();
    const paths = sel.length ? sel.map(s => s.path) : [pane.cwd()];
    this.copyText(copyPathsAsync(paths, mode));
    this.toast(`Copied ${paths.length} path(s) — ${mode.label || mode.id}`);
  }

  /** Single source of truth for the palette, shortcuts sheet and context hints. */
  commandGroups() {
    const pane = this.active;
    return [
      {
        label: 'File & edit', items: [
          { label: 'New folder', icon: 'folder-plus', key: 'Ctrl+Shift+N', run: () => this.runCmd('newFolder') },
          { label: 'New file', icon: 'file', run: () => this.runCmd('newFile') },
          { label: 'Rename', icon: 'pencil', key: 'F2', run: () => this.runCmd('rename') },
          { label: 'Delete to recycle bin', icon: 'trash', key: 'Del', run: () => this.runCmd('deleteBin') },
          { label: 'Delete permanently', icon: 'trash', key: 'Shift+Del', run: () => this.runCmd('deletePerm') },
          { label: 'Properties & timestamps', icon: 'info', key: 'Alt+Enter', run: () => this.runCmd('props') },
          { label: 'Text editor', icon: 'file-text', key: 'Ctrl+E', run: () => this.runCmd('editor') },
          { label: 'Mass rename…', icon: 'wand', key: 'Ctrl+R', run: () => T.massRenameDialog(this) }
        ]
      },
      {
        label: 'Transfer', items: [
          { label: 'Copy…', icon: 'copy', key: 'F5', hint: 'Choose destination and overwrite rule', run: () => T.copyDialog(this, 'copy') },
          { label: 'Move…', icon: 'scissors', hint: 'Choose destination and overwrite rule', run: () => T.copyDialog(this, 'move') },
          { label: 'Copy to other pane', icon: 'arrow-right', key: 'Ctrl+F5', run: () => this.quickTransfer('copy') },
          { label: 'Move to other pane', icon: 'arrow-right', key: 'Ctrl+F6', run: () => this.quickTransfer('move') },
          { label: 'Send selection to scrap', icon: 'plus-square', key: 'Ctrl+S', run: () => this.runCmd('toScrap') },
          { label: 'Scrap pane…', icon: 'panel-right', key: 'Ctrl+Alt+S', run: () => this.runCmd('scrapDialog') },
          { label: 'Save scrap as CSV…', icon: 'save', run: () => this.runCmd('saveScrap') }
        ]
      },
      {
        label: 'Navigate', items: [
          { label: 'Back', icon: 'arrow-left', key: 'Alt+←', run: () => pane.back() },
          { label: 'Forward', icon: 'arrow-right', key: 'Alt+→', run: () => pane.fwd() },
          { label: 'Up one level', icon: 'arrow-up', key: 'Backspace', run: () => pane.up() },
          { label: 'New tab', icon: 'plus', key: 'Ctrl+T', run: () => this.runCmd('newTab') },
          { label: 'Close tab', icon: 'close', key: 'Ctrl+F4', run: () => this.runCmd('closeTab') },
          { label: 'Switch pane', icon: 'git-compare', key: 'Tab', run: () => this.switchPane() },
          { label: 'Copy path', icon: 'copy', key: 'Ctrl+P', run: () => this.copyPathsFromSelection() },
          { label: 'Copy path as…', icon: 'copy', run: () => this.showPathCopyPicker(pane) },
          { label: 'Bookmark this folder', icon: 'star', key: 'Ctrl+Q', run: () => this.bookmarkCurrent() },
          { label: 'Bookmarks & groups…', icon: 'book', run: () => this.showBookmarkMenu(this.anchorCenter()) }
        ]
      },
      {
        label: 'Find & compare', items: [
          { label: 'Find files…', icon: 'search', key: 'Ctrl+F', run: () => T.searchDialog(this) },
          { label: 'Find duplicates…', icon: 'layers', key: 'Ctrl+D', run: () => T.dupesDialog(this) },
          { label: 'Compare panes', icon: 'git-compare', key: 'F9', run: () => T.compare(this, 'diffs') },
          { label: 'Sync differences', icon: 'refresh', key: 'Ctrl+F9', run: () => this.runCmd('sync') },
          { label: 'Filter this folder', icon: 'filter', key: 'F3', run: () => this.startFilter() },
          { label: 'Select by type…', icon: 'list-checks', key: 'Alt+K', run: () => this.runCmd('selectByType') },
          { label: 'Empty folders…', icon: 'folder', run: () => this.runCmd('emptyDirs') }
        ]
      },
      {
        label: 'Tools', items: [
          { label: 'Folder sizes & pie', icon: 'pie', key: 'Ctrl+G', run: () => this.runCmd('stats') },
          { label: 'Split file…', icon: 'split', key: 'Ctrl+Alt+K', run: () => this.runCmd('split') },
          { label: 'Merge parts…', icon: 'merge', key: 'Ctrl+Alt+M', run: () => this.runCmd('merge') },
          { label: 'Archive selection…', icon: 'file-archive', run: () => this.archiveEntry(this.active.view.selected()) },
          { label: 'Color tags…', icon: 'tag', key: 'Ctrl+Alt+L', run: () => this.runCmd('tags') },
          { label: 'Terminal here', icon: 'terminal', key: 'Ctrl+`', run: () => this.runCmd('openTerminal') },
          { label: 'Run command…', icon: 'command', hint: 'Type > in the address bar', run: () => { $('#address').value = '> '; $('#address').focus(); } }
        ]
      },
      {
        label: 'View & app', items: [
          { label: 'Cycle view mode (details / list / thumbs)', icon: 'layout-grid', run: () => this.runCmd('viewMode') },
          { label: 'Toggle folder tree', icon: 'tree', key: 'Ctrl+T', checked: !!pref('showTree'), run: () => this.runCmd('toggleTree') },
          { label: 'Toggle preview pane', icon: 'panel-right', key: 'Ctrl+Alt+Z', checked: !!pref('showPreview'), run: () => this.runCmd('togglePreview') },
          { label: 'Toggle mini-scrap', icon: 'plus-square', key: 'Ctrl+M', run: () => this.runCmd('toggleMini') },
          { label: 'Stack panes vertically', icon: 'panel-bottom', key: 'Ctrl+Shift+E', checked: !!pref('stackPanes'), run: () => this.runCmd('stackPanes') },
          { label: 'Equal panes', icon: 'git-compare', key: 'Ctrl+E', run: () => this.runCmd('equalPanes') },
          { label: 'Sticky selection', icon: 'list-checks', key: 'Alt+S', checked: !!pref('stickySelection'), run: () => this.runCmd('sticky') },
          { label: 'Settings…', icon: 'settings', key: 'Ctrl+,', run: () => T.settingsDialog(this) },
          { label: 'Keyboard shortcuts', icon: 'keyboard', key: 'Ctrl+?', run: () => this.showShortcuts() }
        ]
      }
    ];
  }
  commandList() { return this.commandGroups().flatMap(g => g.items.map(it => ({ ...it, group: g.label }))); }
  showShortcuts() {
    const d = T.dlg('Keyboard shortcuts', {}, { width: 680, icon: 'keyboard' });
    const wrap = el('div', 'shortcut-groups');
    for (const g of this.commandGroups()) {
      const section = el('div', 'shortcut-group');
      section.appendChild(el('div', 'grp', g.label));
      const t = el('table', 'tbl');
      const tb = el('tbody');
      for (const c of g.items) {
        const tr = el('tr');
        const kd = el('td', 'shortcut-key');
        for (const tok of String(c.key || '').split('+').filter(Boolean)) kd.appendChild(el('kbd', '', tok));
        tr.appendChild(kd);
        const td = el('td');
        const ic = el('span', 'ic-cell');
        ic.appendChild(icon(c.icon || 'dot', 13));
        td.append(ic, document.createTextNode(c.label));
        tr.appendChild(td);
        if (c.run) on(tr, 'dblclick', () => { c.run(); d._close(); });
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      section.appendChild(t);
      wrap.appendChild(section);
    }
    d.body.appendChild(wrap);
    T.btn('Close', '', d._close, d.foot);
  }
  wireKeys() {
    document.addEventListener('keydown', e => {
      const tag = document.activeElement?.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
      const pane = this.active;
      // Address bar has its own handling; let it be
      if (inField && e.key !== 'Escape') return;
      const k = e.key;
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !inField) { e.preventDefault(); this.switchPane(); return; }
      if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !inField) { e.preventDefault(); $('#address').focus(); return; }
      if (e.key === 'Backspace' && !inField) { e.preventDefault(); pane.up(); return; }
      if (e.altKey && (k === 'ArrowLeft' || k === 'ArrowRight')) { e.preventDefault(); k === 'ArrowLeft' ? pane.back() : pane.fwd(); return; }
      // F-keys
      const F = { F1: 'f1', F2: 'rename', F3: 'f3', F4: 'closeTab', F5: 'copy', F7: 'preview', F9: 'compare', F10: 'f10', F12: 'props' };
      if (F[k] && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        switch (F[k]) {
          case 'f1': $('#address').focus(); break;
          case 'rename': this.runCmd('rename'); break;
          case 'f3': this.startFilter(); break;
          case 'closeTab': pane.closeTab(pane.activeTab); break;
          case 'copy': T.copyDialog(this, 'copy'); break;
          case 'preview': this.setPreview(true); break;
          case 'compare': this.runCmd('compare'); break;
          case 'props': this.runCmd('props'); break;
          default: this.toast('no binding for ' + k);
        }
        return;
      }
      if (e.ctrlKey && k === 'F5') { e.preventDefault(); this.quickTransfer('copy'); return; }
      if (e.ctrlKey && k === 'F6') { e.preventDefault(); this.quickTransfer('move'); return; }
      if (e.ctrlKey && k === 'F4') { e.preventDefault(); this.runCmd('closeTab'); return; }
      if (e.ctrlKey && k === 'F9') { e.preventDefault(); this.runCmd('sync'); return; }
      if (e.ctrlKey && k === 't' && !e.shiftKey) { e.preventDefault(); this.runCmd('newTab'); return; }
      if (e.ctrlKey && k === 'T' && e.shiftKey) { e.preventDefault(); this.runCmd('toggleTree'); return; }
      if (e.ctrlKey && k === 'f') { e.preventDefault(); this.runCmd('find'); return; }
      if (e.ctrlKey && k === 'd') { e.preventDefault(); this.runCmd('dupes'); return; }
      if (e.ctrlKey && k === 'r') { e.preventDefault(); T.massRenameDialog(this); return; }
      if (e.ctrlKey && k === 's' && !e.altKey) { e.preventDefault(); this.runCmd('toScrap'); return; }
      if (e.ctrlKey && k === 'S' && e.altKey) { e.preventDefault(); this.runCmd('scrapDialog'); return; }
      if (e.ctrlKey && k === 'm') { e.preventDefault(); this.runCmd('toggleMini'); return; }
      if (e.ctrlKey && k === 'g') { e.preventDefault(); this.runCmd('stats'); return; }
      if (e.ctrlKey && k === 'p') { e.preventDefault(); this.copyPaths(pane.view.selected().map(x => x.path) || [pane.cwd()]); return; }
      if (e.ctrlKey && k === 'q') { e.preventDefault(); this.bookmarkCurrent(); return; }
      if (e.ctrlKey && k === 'e') { e.preventDefault(); this.runCmd('editor'); return; }
      if (e.ctrlKey && k === '`') { e.preventDefault(); this.runCmd('openTerminal'); return; }
      if (e.ctrlKey && e.altKey && k.toLowerCase() === 'z') { e.preventDefault(); this.runCmd('togglePreview'); return; }
      if (e.ctrlKey && e.altKey && k.toLowerCase() === 's') { e.preventDefault(); this.runCmd('scrapDialog'); return; }
      if (e.ctrlKey && e.altKey && k.toLowerCase() === 'k') { e.preventDefault(); this.runCmd('split'); return; }
      if (e.ctrlKey && e.altKey && k.toLowerCase() === 'm') { e.preventDefault(); this.runCmd('merge'); return; }
      if (e.ctrlKey && e.altKey && k.toLowerCase() === 'l') { e.preventDefault(); this.runCmd('tags'); return; }
      if (e.ctrlKey && k === 'y') { e.preventDefault(); this.runCmd('sticky'); return; }
      if (e.ctrlKey && k === 'k') { e.preventDefault(); this.palette(); return; }
      if (e.ctrlKey && k === ',') { e.preventDefault(); T.settingsDialog(this); return; }
      if (e.ctrlKey && k === '?') { e.preventDefault(); this.showShortcuts(); return; }
      if (e.altKey && k === 's') { e.preventDefault(); this.runCmd('sticky'); return; }
      if (e.altKey && k === 'k') { e.preventDefault(); this.runCmd('selectByType'); return; }
      if (e.ctrlKey && k === 'Shift') { e.preventDefault(); this.runCmd('selectAll'); e.preventDefault(); return; }
      if (e.ctrlKey && e.shiftKey && k.toLowerCase() === 'e') { e.preventDefault(); this.runCmd('stackPanes'); return; }
      if (e.ctrlKey && e.shiftKey && k.toLowerCase() === 'n') { e.preventDefault(); this.runCmd('newFolder'); return; }
      if (e.ctrlKey && e.shiftKey && k.toLowerCase() === 'g') { e.preventDefault(); this.saveGroup(); return; }
      if (e.altKey && k === 'Enter') { e.preventDefault(); const f = pane.view.focusedEntry(); if (f?.isDir) this.flatten(f); return; }
      if (k === 'Delete' && e.shiftKey) { e.preventDefault(); this.runCmd('deletePerm'); return; }
      if (k === 'Delete') { e.preventDefault(); this.runCmd('deleteBin'); return; }
      if (k === 'Insert' && e.ctrlKey) { e.preventDefault(); this.copyClipboard('copy'); return; }
      if (k === 'Insert' && e.shiftKey) { e.preventDefault(); this.pasteClipboard(); return; }
      if (e.ctrlKey && k === 'c' && !e.shiftKey) { e.preventDefault(); this.copyClipboard('copy'); return; }
      if (e.ctrlKey && k === 'x') { e.preventDefault(); this.copyClipboard('cut'); return; }
      if (e.ctrlKey && k === 'v') { e.preventDefault(); this.pasteClipboard(); return; }
      if (k === 'Enter' && !inField) {
        e.preventDefault();
        const f = pane.view.focusedEntry();
        if (f) this.openEntry(f);
        return;
      }
      if (k === 'F12') return; // devtools via default
      if (k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && !inField) {
        // typeahead is handled by list keydown; when list not focused, focus it
        if (pane.view.root !== document.activeElement) pane.view.root.focus();
      }
    });
    // wire ctrl+wheel zoom on panes (thumbs)
    window.addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  }
  async flatten(entry) {
    // Alt+Enter on a folder: browse flat into scrap
    const root = entry.path;
    this.toast('Flattening ' + entry.name + '…');
    const out = [];
    const walk = async dir => {
      const es = await this.listDir(dir);
      for (const e of es) {
        e.path = dir + '\\' + e.name;
        out.push(e);
        if (e.isDir) await walk(e.path);
      }
    };
    await walk(root);
    this.scrap.add(out);
    this.toast(`${out.length} items added to scrap`);
  }

  savePaneStateSoon() {
    if (this._spTimer) clearTimeout(this._spTimer);
    this._spTimer = setTimeout(() => {
      try {
        S.savedLayout = S.savedLayout || {};
        for (const p of [this.paneL, this.paneR]) {
          const t = p?.activeTab;
          if (!t?.path) continue;
          // history is persisted with the pane so Back/Forward survive a restart
          S.savedLayout[p.id] = [{ path: t.path, hist: t.hist.slice(-30), hi: t.hi }];
        }
        persist();
      } catch (err) { console.warn('[x2m] savePaneStateSoon', err); }
    }, 400);
  }
}

function mkArchiveEntry(e, apath) {
  return { name: e.name.replace(/\\/g, '/').split('/').filter(Boolean).pop() || e.name,
    path: apath + '::/' + e.name, isDir: e.isDir, size: e.size, mtimeMs: 0, ctimeMs: 0, atimeMs: 0, entry: e, nameFull: e.name };
}

async function boot() {
  const app = new App();
  window.app = app;
  window.addEventListener('unhandledrejection', e => console.error('[x2m unhandled]', e.reason?.stack || e.reason));
  window.addEventListener('error', e => console.error('[x2m window err]', e.message, e.filename, e.lineno));
  try { await app.boot(); console.log('[x2m] booted'); } catch (err) { console.error('[x2m] boot failed', err?.stack || err); }
}
boot();

// expose for devtools debugging
window.App = App;
