// Image viewer (IrfanView-style) and the Space-bar Quick Look overlay.
// Both share preview.js, so any type that previews in the pane previews here.
import { el, $, on, fmtSize, fmtDate, baseName, iconFor } from './util.js';
import { icon } from './icons.js';
import { isIMAGE, typeLabel } from './filetypes.js';
import { previewUrl, renderPreview } from './preview.js';

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 16;

/* ============================================================================
   Image viewer
   ============================================================================ */
export class ImageViewer {
  constructor(app) {
    this.app = app;
    this.root = $('#viewer');
    this.stage = $('#vw-stage');
    this.img = $('#vw-img');
    this.nameEl = $('#vw-name');
    this.subEl = $('#vw-sub');
    this.zoomEl = $('#vw-zoomlabel');
    this.hudLeft = $('#vw-hud-left');
    this.hudRight = $('#vw-hud-right');
    this.infoEl = $('#vw-info');
    this.filmEl = $('#vw-film');
    this.emptyEl = $('#vw-empty');

    this.items = [];
    this.index = 0;
    this.item = null;
    this.natW = 0;
    this.natH = 0;
    this.scale = 1;
    this.panX = 0;
    this.panY = 0;
    this.rot = 0;
    this.flip = false;
    this.fitMode = true;
    this.infoOpen = false;
    this.slideTimer = null;
    this.drag = null;
    this.token = 0;
    this.infoToken = 0;

    this.wire();
  }

  // ---------------------------------------------------------------- wiring
  wire() {
    this.root.querySelectorAll('[data-vw]').forEach(b => {
      on(b, 'click', () => this.action(b.dataset.vw));
    });
    on(this.zoomEl, 'click', () => this.actualSize());

    on(this.stage, 'wheel', e => {
      if (this.root.classList.contains('hidden')) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.14 : 1 / 1.14;
      this.zoomAt(factor, e.clientX, e.clientY);
    }, { passive: false });

    on(this.stage, 'pointerdown', e => {
      if (e.button !== 0 || !this.item) return;
      this.drag = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY, moved: false };
      this.stage.setPointerCapture?.(e.pointerId);
      this.stage.classList.add('dragging');
    });
    on(this.stage, 'pointermove', e => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
      this.panX = this.drag.px + dx;
      this.panY = this.drag.py + dy;
      this.apply();
    });
    const endDrag = () => { this.drag = null; this.stage.classList.remove('dragging'); };
    on(this.stage, 'pointerup', endDrag);
    on(this.stage, 'pointercancel', endDrag);
    on(this.stage, 'dblclick', () => {
      if (!this.item) return;
      this.fitMode ? this.actualSize() : this.applyFit();
    });

    on(this.img, 'load', () => {
      this.natW = this.img.naturalWidth;
      this.natH = this.img.naturalHeight;
      this.img.style.width = this.natW + 'px';
      this.img.style.height = this.natH + 'px';
      this.img.style.visibility = '';
      this.applyFit();
      this.updateHud();
    });
    on(this.img, 'error', () => {
      this.img.style.visibility = 'hidden';
      this.emptyEl.classList.remove('hidden');
      this.emptyEl.textContent = 'This image could not be decoded. Use Open with… to view it in another application.';
    });

    document.addEventListener('keydown', e => {
      if (this.root.classList.contains('hidden')) return;
      if (this.handleKey(e)) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }

  handleKey(e) {
    const k = e.key;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return false;
    switch (k) {
      case 'Escape': this.close(); return true;
      case 'ArrowRight': case 'PageDown': case 'ArrowDown': this.step(1); return true;
      case 'ArrowLeft': case 'PageUp': case 'ArrowUp': this.step(-1); return true;
      case 'Home': this.goto(0); return true;
      case 'End': this.goto(this.items.length - 1); return true;
      case '+': case '=': this.zoomAt(1.25); return true;
      case '-': case '_': this.zoomAt(1 / 1.25); return true;
      case '0': this.applyFit(); return true;
      case '1': this.actualSize(); return true;
      case '[': this.rotate(-90); return true;
      case ']': this.rotate(90); return true;
      case 'h': case 'H': this.flipImage(); return true;
      case 'i': case 'I': this.toggleInfo(); return true;
      case ' ': this.toggleSlideshow(); return true;
      case 'F11': this.toggleFullscreen(); return true;
      default: return false;
    }
  }

  action(name) {
    switch (name) {
      case 'prev': this.step(-1); break;
      case 'next': this.step(1); break;
      case 'zoom-in': this.zoomAt(1.25); break;
      case 'zoom-out': this.zoomAt(1 / 1.25); break;
      case 'fit': this.applyFit(); break;
      case 'one': this.actualSize(); break;
      case 'rotate-l': this.rotate(-90); break;
      case 'rotate-r': this.rotate(90); break;
      case 'flip': this.flipImage(); break;
      case 'slideshow': this.toggleSlideshow(); break;
      case 'info': this.toggleInfo(); break;
      case 'fullscreen': this.toggleFullscreen(); break;
      case 'close': this.close(); break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- state
  isOpen() { return !this.root.classList.contains('hidden'); }

  open(path) {
    const pane = this.app.active;
    const list = (pane?.view?.view || []).filter(e => !e.isDir && isIMAGE(e));
    if (!list.some(e => e.path === path)) {
      const known = (pane?.view?.entries || []).find(e => e.path === path);
      list.push(known || { name: baseName(path), path, size: 0, mtimeMs: 0 });
    }
    this.items = list;
    this.index = Math.max(0, list.findIndex(e => e.path === path));
    this.root.classList.remove('hidden');
    this.stage.classList.remove('dragging');
    this.render();
  }

  render() {
    const item = this.items[this.index];
    if (!item) return this.close();
    this.item = item;
    this.token++;
    this.natW = 0; this.natH = 0;
    this.scale = 1; this.panX = 0; this.panY = 0; this.rot = 0; this.flip = false;
    this.fitMode = true;
    this.nameEl.textContent = item.name;
    this.nameEl.title = item.path;
    this.subEl.textContent = `${typeLabel(item)} · ${fmtSize(item.size)} · ${item.path}`;
    this.subEl.title = item.path;
    this.zoomEl.textContent = 'fit';
    this.img.style.visibility = 'hidden';
    this.emptyEl.classList.add('hidden');
    this.img.src = previewUrl(item.path);
    this.img.alt = item.name;
    this.drawFilm();
    this.preload();
    this.updateHud();
    if (this.infoOpen) this.drawInfo();
  }

  preload() {
    for (const d of [1, -1, 2]) {
      const it = this.items[(this.index + d + this.items.length) % this.items.length];
      if (it && it !== this.item) { const im = new Image(); im.src = previewUrl(it.path); }
    }
  }

  step(dir) {
    if (!this.items.length) return;
    this.index = (this.index + dir + this.items.length) % this.items.length;
    this.render();
  }

  goto(i) {
    if (!this.items.length) return;
    this.index = clamp(i, 0, this.items.length - 1);
    this.render();
  }

  // ---------------------------------------------------------------- zoom
  apply() {
    this.img.style.transform = `translate(${this.panX}px, ${this.panY}px) rotate(${this.rot}deg) scale(${this.scale}) scaleX(${this.flip ? -1 : 1})`;
    this.updateZoomLabel();
    this.updateHud();
  }

  fitScale() {
    if (!this.natW || !this.natH) return 1;
    const swapped = Math.abs(this.rot % 180) === 90;
    const w = swapped ? this.natH : this.natW;
    const h = swapped ? this.natW : this.natH;
    const r = this.stage.getBoundingClientRect();
    if (!r.width || !r.height) return 1;
    return Math.min((r.width - 28) / w, (r.height - 28) / h, 1);
  }

  applyFit() {
    this.fitMode = true;
    this.scale = this.fitScale() || 1;
    this.panX = 0;
    this.panY = 0;
    this.apply();
  }

  actualSize() {
    this.fitMode = false;
    this.scale = 1;
    this.panX = 0;
    this.panY = 0;
    this.apply();
  }

  zoomAt(factor, cx, cy) {
    if (!this.item || !this.natW) return;
    const r = this.stage.getBoundingClientRect();
    const px = cx == null ? r.left + r.width / 2 : cx;
    const py = cy == null ? r.top + r.height / 2 : cy;
    const ox = px - (r.left + r.width / 2);
    const oy = py - (r.top + r.height / 2);
    const next = clamp(this.scale * factor, ZOOM_MIN, ZOOM_MAX);
    if (next === this.scale) return;
    const ratio = next / this.scale;
    this.panX = ox - (ox - this.panX) * ratio;
    this.panY = oy - (oy - this.panY) * ratio;
    this.scale = next;
    this.fitMode = false;
    this.apply();
  }

  rotate(deg) {
    if (!this.item) return;
    this.rot = (this.rot + deg + 360) % 360;
    if (this.fitMode) this.applyFit(); else this.apply();
  }

  flipImage() {
    if (!this.item) return;
    this.flip = !this.flip;
    this.apply();
  }

  updateZoomLabel() {
    this.zoomEl.textContent = this.fitMode ? 'fit' : Math.round(this.scale * 100) + '%';
  }

  updateHud() {
    const dims = this.natW ? `${this.natW} × ${this.natH}` : '';
    const total = this.items.length;
    this.hudLeft.textContent = [
      dims,
      this.item ? fmtSize(this.item.size) : '',
      this.fitMode ? 'fit to window' : Math.round(this.scale * 100) + '%',
      this.rot ? this.rot + '°' : ''
    ].filter(Boolean).join('  ·  ');
    this.hudRight.textContent = total > 1 ? `${this.index + 1} / ${total}` : '';
    const prev = this.root.querySelector('[data-vw="prev"]');
    const next = this.root.querySelector('[data-vw="next"]');
    if (prev) prev.disabled = total < 2;
    if (next) next.disabled = total < 2;
  }

  // ---------------------------------------------------------------- filmstrip
  drawFilm() {
    this.filmEl.replaceChildren();
    if (this.items.length < 2) return;
    const start = Math.max(0, this.index - 40);
    const end = Math.min(this.items.length, start + 120);
    for (let i = start; i < end; i++) {
      const it = this.items[i];
      const im = el('img', 'th' + (i === this.index ? ' on' : ''));
      im.src = previewUrl(it.path);
      im.loading = 'lazy';
      im.alt = it.name;
      im.title = it.name;
      on(im, 'click', () => this.goto(i));
      this.filmEl.appendChild(im);
    }
    const active = this.filmEl.querySelector('.th.on');
    active?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  // ---------------------------------------------------------------- info
  toggleInfo() {
    this.infoOpen = !this.infoOpen;
    this.infoEl.classList.toggle('hidden', !this.infoOpen);
    const b = this.root.querySelector('[data-vw="info"]');
    b?.classList.toggle('on', this.infoOpen);
    if (this.infoOpen) this.drawInfo();
  }

  async drawInfo() {
    const item = this.item;
    if (!item) return;
    const token = ++this.infoToken;
    this.infoEl.innerHTML = '<h4>Image information</h4><div class="vw-row"><span>Reading</span><span>…</span></div>';
    const info = await window.x2.imageInfo(item.path).catch(() => null);
    if (token !== this.infoToken || item !== this.item) return;
    const rows = [];
    const add = (k, v) => { if (v != null && v !== '') rows.push([k, String(v)]); };
    add('Path', item.path);
    add('Folder', item.path.slice(0, item.path.lastIndexOf('\\')) || item.path);
    if (info?.width) add('Dimensions', `${info.width} × ${info.height}  (${(info.width * info.height / 1e6).toFixed(1)} MP)`);
    add('Format', info?.format || '');
    add('Size', `${fmtSize(item.size)}${item.size ? ` (${Number(item.size).toLocaleString()} bytes)` : ''}`);
    add('Modified', fmtDate(item.mtimeMs || info?.mtimeMs || 0));
    const ex = info?.exif || {};
    const camera = [ex.make, ex.model].filter(Boolean).join(' ');
    if (camera) add('Camera', camera);
    if (ex.lens) add('Lens', ex.lens);
    if (ex.exposure) add('Exposure', ex.exposure);
    if (ex.fNumber) add('Aperture', ex.fNumber);
    if (ex.iso) add('ISO', ex.iso);
    if (ex.focalLength) add('Focal length', ex.focalLength);
    if (ex.dateTaken) add('Taken', ex.dateTaken);
    if (ex.software) add('Software', ex.software);
    if (ex.orientation) add('Orientation', ex.orientation);
    const html = rows.map(([k, v]) => `<div class="vw-row"><span>${escapeHtml(k)}</span><span>${escapeHtml(v)}</span></div>`).join('');
    this.infoEl.innerHTML = '<h4>Image information</h4>' + html + '<hr><div class="vw-row"><span>Tip</span><span>Wheel zooms · drag pans · [ ] rotate</span></div>';
  }

  // ---------------------------------------------------------------- slideshow
  toggleSlideshow() {
    if (this.slideTimer) { this.stopSlideshow(); return; }
    if (this.items.length < 2) return;
    this.slideTimer = setInterval(() => this.step(1), 3000);
    const b = this.root.querySelector('[data-vw="slideshow"]');
    b?.classList.add('on');
    b?.replaceChildren(icon('pause', 16));
    b?.setAttribute('title', 'Pause slideshow (Space)');
  }

  stopSlideshow() {
    if (this.slideTimer) clearInterval(this.slideTimer);
    this.slideTimer = null;
    const b = this.root.querySelector('[data-vw="slideshow"]');
    b?.classList.remove('on');
    b?.replaceChildren(icon('play', 16));
    b?.setAttribute('title', 'Slideshow (Space)');
  }

  async toggleFullscreen() {
    await window.x2.winCmd('fullscreen');
    const b = this.root.querySelector('[data-vw="fullscreen"]');
    b?.classList.toggle('on');
  }

  onWindowState(state) {
    const b = this.root.querySelector('[data-vw="fullscreen"]');
    if (!b) return;
    b.classList.toggle('on', !!state.fullscreen);
    b.replaceChildren(icon(state.fullscreen ? 'compress' : 'expand', 16));
  }

  close() {
    this.stopSlideshow();
    this.infoOpen = false;
    this.infoEl.classList.add('hidden');
    this.root.classList.add('hidden');
    this.img.removeAttribute('src');
    this.img.style.visibility = 'hidden';
    this.filmEl.replaceChildren();
    if (this.app.windowState?.fullscreen) window.x2.winCmd('fullscreen');
    this.app.active?.view?.root?.focus();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ============================================================================
   Quick Look — Space opens a large preview of the focused item
   ============================================================================ */
export class QuickLook {
  constructor(app) {
    this.app = app;
    this.root = $('#quicklook');
    this.body = $('#ql-body');
    this.nameEl = $('#ql-name');
    this.subEl = $('#ql-sub');
    this.icoEl = $('#ql-ico');
    this.item = null;
    this.token = 0;

    on($('#ql-close', this.root), 'click', () => this.close());
    on($('#ql-open', this.root), 'click', () => this.openExternal());
    on($('#ql-reveal', this.root), 'click', () => {
      if (this.item) window.x2.showInExplorer(this.item.path);
    });
    on(this.root, 'mousedown', e => { if (e.target === this.root) this.close(); });

    document.addEventListener('keydown', e => {
      if (!this.isOpen()) return;
      if (this.handleKey(e)) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }

  isOpen() { return !this.root.classList.contains('hidden'); }

  handleKey(e) {
    const k = e.key;
    if (k === 'Escape' || k === ' ') { this.close(); return true; }
    if (k === 'ArrowDown' || k === 'ArrowRight' || k === 'PageDown') { this.step(1); return true; }
    if (k === 'ArrowUp' || k === 'ArrowLeft' || k === 'PageUp') { this.step(-1); return true; }
    if (k === 'Enter') { this.openExternal(); return true; }
    return false;
  }

  toggle(entry) {
    if (this.isOpen()) this.close();
    else if (entry) this.open(entry);
  }

  async open(entry) {
    if (!entry) return;
    this.item = entry;
    const token = ++this.token;
    this.nameEl.textContent = entry.name;
    this.nameEl.title = entry.path;
    this.subEl.textContent = `${typeLabel(entry)} · ${fmtSize(entry.size)}${entry.isDir ? '' : ' · ' + entry.path}`;
    this.subEl.title = entry.path;
    this.icoEl.replaceChildren(icon(iconFor(entry), 16));
    this.root.classList.remove('hidden');
    this.body.replaceChildren(el('div', 'pv-note', 'Loading preview…'));
    await renderPreview(this.body, entry, this.app, { large: true, zoom: true });
    if (token !== this.token) return;
  }

  async step(dir) {
    const pane = this.app.active;
    const list = pane?.view?.view || [];
    if (!list.length) return;
    const current = list.findIndex(e => e.path === this.item?.path);
    const next = clamp(current + dir, 0, list.length - 1);
    if (next === current) return;
    const entry = list[next];
    const key = entry.name.toLowerCase() + (entry.isDir ? '/' : '');
    pane.view.sel = new Set([key]);
    pane.view.focused = key;
    pane.view.render();
    pane.drawFoot();
    const rowH = pane.view.rowH();
    const y0 = next * rowH;
    if (y0 < pane.view.root.scrollTop) pane.view.root.scrollTop = Math.max(0, y0 - 20);
    else if (y0 + rowH > pane.view.root.scrollTop + pane.view.root.clientHeight) pane.view.root.scrollTop = y0 - pane.view.root.clientHeight + rowH + 20;
    await this.open(entry);
  }

  openExternal() {
    if (!this.item) return;
    this.app.openEntry(this.item);
    this.close();
  }

  close() {
    this.root.classList.add('hidden');
    this.body.replaceChildren();
    this.item = null;
    this.app.active?.view?.root?.focus();
  }
}
