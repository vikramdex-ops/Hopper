// Shared utilities
import { catFor, isIMAGE, isVIDEO, isAUDIO, isARCHIVE, isTEXT, isPDF, typeLabel, iconNameFor } from './filetypes.js';
export { catFor, isIMAGE, isVIDEO, isAUDIO, isARCHIVE, isTEXT, isPDF, typeLabel };
export const iconFor = iconNameFor; // legacy name -> icon key in icons.js

export const el = (tag, cls, text) => {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text != null) d.textContent = text;
  return d;
};
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const on = (t, ev, fn) => t.addEventListener(ev, fn);
export function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

export function fmtSize(n) {
  if (n == null || isNaN(n)) return '';
  if (n < 999) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1, v = n;
  do { v /= 1024; i++; } while (v >= 999 && i < u.length - 1);
  return v.toFixed(1) + ' ' + u[i];
}
export function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fmtTime(ms) { const d = new Date(ms); return fmtDate(ms).slice(11); }
export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }


export function uniqueCombos(paths) {
  // normalize for compare: lowercase, trailing slash trimmed
  return paths.map(p => p.toLowerCase().replace(/[\\\/]+$/, ''));
}

export function wildcardToRe(f) {
  f = (f || '').trim();
  if (!f) return null;
  if (f.startsWith('*') && !f.includes('/') && f.length > 1) {
    // fuzzy contains: *term*
    const inner = f.replace(/^\*|\*$/g, '');
    try { return new RegExp(inner.replace(/[.+^${}()[\]\\]/g, '\\$&'), 'i'), { fuzzy: true }; } catch { return null; }
  }
  const src = f.replace(/[.+^${}()[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  try { return new RegExp('^' + src + '$', 'i'); } catch { return null; }
}
export function splitMultiFilter(f) {
  return (f || '').split(/[,;]+/).map(s => s.trim()).filter(Boolean);
}
export function matchFilter(name, f) {
  const parts = splitMultiFilter(f);
  if (!parts.length) return true;
  return parts.some(p => { const re = wildcardToRe(p); return re && re.test(name); });
}

export class Job {
  constructor(id) { this.id = id; this.cancelled = false; }
}
let jobSeq = 1;
export function newJobId() { return 'j' + (jobSeq++); }

export function toast(msg, kind = '', ms = 3500) {
  const t = el('div', 'toast ' + kind, msg);
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, ms);
}

export function keyOfEntry(e) { return e.name.toLowerCase() + (e.isDir ? '/' : ''); }

// sortable comparator factory
export function cmpBy(col, dir, sizes) {
  return (a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let r = 0;
    switch (col) {
      case 'name': r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }); break;
      case 'ext': { r = (a.name.split('.').pop() || '').localeCompare(b.name.split('.').pop() || '', undefined, { numeric: true, sensitivity: 'base' }); break; }
      case 'size': r = (sizes?.get(a.path)?.size ?? a.size) - (sizes?.get(b.path)?.size ?? b.size); break;
      case 'mtimeMs': r = a.mtimeMs - b.mtimeMs; break;
      case 'ctimeMs': r = a.ctimeMs - b.ctimeMs; break;
      case 'type': r = (catFor(a) + '/' + a.name.split('.').pop()).localeCompare(catFor(b) + '/' + b.name.split('.').pop()); break;
      case 'attr': { r = attrsOf(a.text).localeCompare(attrsOf(b.text)); break; }
      default: r = (a[col] || 0) - (b[col] || 0); r = a[col]?.localeCompare?.(b[col]) ?? r;
    }
    return dir * (r || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  };
}
export function attrsOf(t) { return (t || ['d','a','r','h','s']).map((c, i) => t[i] ? c : '').join(''); }


export function parentOf(p) {
  if (p && p.match(/^[a-zA-Z]:\\?$/)) return null;
  const n = p.replace(/[\\/]+$/, '');
  const i = n.lastIndexOf('\\');
  return i <= 2 && /^[a-zA-Z]:/.test(n) ? n.slice(0, 3) : n.slice(0, i);
}
export function baseName(p) { return p.split('\\').filter(Boolean).pop() || p; }

export function fuzzyScore(text, q) {
  text = text.toLowerCase(); q = q.toLowerCase();
  let ti = 0, score = 0, last = -1;
  for (const c of q) {
    ti = text.indexOf(c, last + 1);
    if (ti < 0) return -1;
    score += (ti === last + 1 ? 3 : 1) + (ti === 0 ? 2 : 0);
    last = ti;
  }
  return score - text.length * 0.01;
}
export function fuzzyHl(text, q) {
  if (!q) return esc(text);
  let out = ''; let ti = 0; const tl = text.toLowerCase(); const ql = q.toLowerCase();
  let qi = 0;
  while (qi < ql.length) {
    const i = tl.indexOf(ql[qi], ti);
    if (i < 0) return esc(text);
    out += esc(text.slice(ti, i)) + '<i class="fuzzy-hl">' + esc(text[i]) + '</i>';
    ti = i + 1; qi++;
  }
  return out + esc(text.slice(ti));
}
