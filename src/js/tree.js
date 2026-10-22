// Folder tree per pane — lazy children, follows pane, drop target.
import { el, $, $$, on, parentOf, iconFor } from './util.js';
import { icon } from './icons.js';
import { pref } from './store.js';

export class Tree {
  constructor(app, pane, rootEl) {
    this.app = app; this.pane = pane; this.root = rootEl;
    this.nodes = new Map(); // path -> {el, nodeEl, childrenEl, loaded, expanded}
    this.roots = [];
    on(rootEl, 'click', e => this._click(e));
    on(rootEl, 'contextmenu', e => this.app.treeCtx(e, this));
    on(rootEl, 'dragover', e => { const nd = this._nodeOf(e.target); if (nd) { e.preventDefault(); nd.el.classList.add('drop-target'); } });
    on(rootEl, 'dragleave', e => { const nd = this._nodeOf(e.target); if (nd) nd.el.classList.remove('drop-target'); });
    on(rootEl, 'drop', e => {
      const nd = this._nodeOf(e.target);
      if (!nd) return;
      nd.el.classList.remove('drop-target');
      const raw = e.dataTransfer.getData('text/x2paths') || (e.dataTransfer.files?.length ? JSON.stringify([...e.dataTransfer.files].map(f => f.path).filter(Boolean)) : null);
      if (!raw) return;
      e.preventDefault();
      const paths = JSON.parse(raw);
      const move = e.shiftKey;
      if (paths.length) this.app.dropTransfer(paths, nd.path, move);
    });
  }
  async load() {
    this.clear();
    if (!this.app.drives?.length) {
      try { this.app.drives = await window.x2.drives(); this.app.buildDrivebar?.(); } catch { /* drives unavailable */ }
    }
    this._renderRoots(this.app.drives || []);
    const cwd = this.pane.cwd();
    await this.expandTo(cwd);
    await this.updateSel(cwd);
  }
  clear() {
    this.root.innerHTML = '';
    this.nodes = new Map();
  }
  mkNode(path, label, iconName, parentEl, isDir) {
    const n = { path, label, loaded: !isDir ? true : false, expanded: false, isDir };
    n.el = el('div', 'tree-node');
    n.el.dataset.path = path;
    const tw = el('span', 'tw' + (isDir ? '' : ' empty'));
    if (isDir) tw.appendChild(icon('chevron-right', 12));
    n.el.appendChild(tw);
    const icEl = el('span', 'ic');
    icEl.appendChild(icon(iconName || 'folder', 14));
    n.el.appendChild(icEl);
    n.el.appendChild(el('span', 'nm', label));
    parentEl.appendChild(n.el);
    if (isDir) {
      n.ch = el('div');
      n.ch.style.marginLeft = '14px';
      n.ch.hidden = true;
      parentEl.appendChild(n.ch);
    }
    this.nodes.set(path, n);
    return n;
  }
  _renderRoots(drives) {
    const c = el('div');
    this.root.appendChild(c);
    for (const d of drives) {
      const n = this.mkNode(d.path, d.label ? d.label : d.path, iconFor({ isDir: true }), c, true);
      n.drive = d;
    }
    // Recycle bin etc
    this.mkNode('::{645FF040-5081-101B-9F08-00AA002F954E}', 'Recycle Bin', 'trash', c, false);
  }
  _nodeOf(t) {
    const el2 = t.closest('.tree-node');
    return el2 && this.nodes.get(el2.dataset.path);
  }
  async _click(e) {
    const nd = this._nodeOf(e.target);
    if (!nd) return;
    const tw = e.target.closest('.tw');
    void tw;
    if (nd.isDir) {
      if (e.target.classList.contains('tw')) {
        if (nd.expanded) this.collapse(nd);
        else await this.expand(nd);
      } else {
        await this.app.nav(this.pane, nd.path);
        if (!nd.expanded) await this.expand(nd);
      }
    } else {
      this.app.toast('Nothing to open here yet');
    }
  }
  async expand(nd) {
    if (nd.loaded) { nd.ch.hidden = false; nd.expanded = true; this._tw(nd, true); return; }
    const entries = await this.app.listDir(nd.path);
    nd.loaded = true;
    nd.ch.innerHTML = '';
    for (const d of entries.filter(x => x.isDir)) {
      const cnd = this.mkNode(nd.path + '\\' + d.name, d.name, iconFor({ isDir: true }), nd.ch, true);
      void cnd;
    }
    nd.ch.hidden = false;
    nd.expanded = true;
    this._tw(nd, true);
  }
  _tw(nd, open) {
    const tw = nd?.el?.querySelector('.tw');
    if (tw) tw.classList.toggle('open', !!open);
  }
  collapse(nd) { if (nd?.ch) { nd.ch.hidden = true; nd.expanded = false; this._tw(nd, false); } }
  async expandTo(p) {
    // expand ancestors of p
    let cur = p;
    const chain = [];
    while (cur) { chain.unshift(cur); const up = parentOf(cur); if (!up || up === cur) break; cur = up; }
    for (const c of chain) {
      const nd = this.nodes.get(c);
      if (nd) await this.expand(nd);
    }
  }
  async updateSel(selPath) {
    $$('.tree-node.sel', this.root).forEach(n => n.classList.remove('sel'));
    const nd = this.nodes.get(selPath);
    if (nd) { nd.el.classList.add('sel'); nd.el.scrollIntoView({ block: 'nearest' }); }
  }
  refresh(nodePath) {
    const nd = this.nodes.get(nodePath);
    if (nd) { for (const k of [...this.nodes.keys()]) { if (k.startsWith(nodePath + '\\')) { const cn = this.nodes.get(k); cn?.el?.remove(); cn?.ch?.remove(); this.nodes.delete(k); } } nd.loaded = false; if (nd.expanded) { nd.expanded = false; this.expand(nd); } }
  }
}
