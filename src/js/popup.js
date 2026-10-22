// One structured popup model for context menus AND the command palette.
// Everything is described as groups of items; the renderer turns that into the
// same rows (icon · label · hint · keyboard column), keyboard-navigable, with
// the same visual treatment everywhere.
import { el, esc, on } from './util.js';
import { icon } from './icons.js';

/**
 * @typedef {Object} MenuItem
 * @property {string}  label
 * @property {Function} [run]
 * @property {string}  [icon]     icon key from icons.js
 * @property {string}  [key]      keyboard hint, e.g. "Ctrl+F5"
 * @property {string}  [hint]     secondary line (what the command does)
 * @property {boolean} [checked]  hot/toggled state
 * @property {boolean} [disabled]
 * @property {boolean} [header]   non-interactive row
 * @property {boolean} [sep]
 */

const keyTokens = k => String(k || '').split('+').map(s => s.trim()).filter(Boolean);

export function normalizeMenu(spec) {
  if (!spec) return { groups: [] };
  if (Array.isArray(spec)) {
    // Legacy array form: ['label', run, key, disabled] and ['sep']
    const groups = [{ items: [] }];
    for (const raw of spec) {
      if (!raw) continue;
      if (raw[0] === 'sep' || raw.sep) { if (groups.at(-1).items.length) groups.push({ items: [] }); continue; }
      if (raw[0] == null) continue;
      const item = { label: String(raw[0]), run: raw[1] || null, key: raw[2] || '', disabled: raw[3] === true, icon: raw[4] };
      if (!item.run) item.header = true;
      if (/^select |^choose /i.test(item.label)) item.header = true;
      groups.at(-1).items.push(item);
    }
    return { groups: groups.filter(g => g.items.length) };
  }
  const groups = (spec.groups || []).map(g => ({
    label: g.label || '',
    items: (g.items || []).filter(Boolean).map(it => ({ ...it, header: it.header || (!it.run && !it.sep) }))
  })).filter(g => g.items.length);
  return { title: spec.title || '', groups };
}

function keyChip(k) {
  const wrap = el('span', 'k');
  for (const t of keyTokens(k)) wrap.appendChild(el('kbd', '', t));
  return wrap;
}

/**
 * Render menu rows into a container.
 * @param {HTMLElement} container
 * @param {Object|Array} spec
 * @param {{onPick?:Function, query?:string, highlight?:Function}} opts
 */
export function renderMenu(container, spec, opts = {}) {
  const model = normalizeMenu(spec);
  container.replaceChildren();
  let idx = 0;
  model.groups.forEach((g, gi) => {
    if (gi > 0) container.appendChild(el('div', 'sep'));
    if (g.label) container.appendChild(el('div', 'grp', g.label));
    for (const it of g.items) {
      if (it.sep) { container.appendChild(el('div', 'sep')); continue; }
      if (it.header) { container.appendChild(el('div', 'grp mi-header', it.label)); continue; }
      const row = el('div', 'mi' + (it.disabled ? ' dis' : '') + (it.checked ? ' on' : ''));
      row.dataset.idx = String(idx++);
      row.setAttribute('role', 'menuitem');
      row.setAttribute('tabindex', '-1');
      if (it.checked) row.setAttribute('aria-checked', 'true');
      const ic = el('span', 'ic');
      if (it.icon) ic.appendChild(icon(it.icon, 14));
      else if (it.checked) ic.appendChild(icon('check', 14));
      row.appendChild(ic);
      const lbl = el('span', 'lbl');
      const label = opts.highlight ? opts.highlight(it.label) : esc(it.label);
      lbl.innerHTML = label;
      row.appendChild(lbl);
      if (it.hint) row.appendChild(el('span', 'hint', it.hint));
      if (it.key) row.appendChild(keyChip(it.key));
      if (it.disabled) { row.setAttribute('aria-disabled', 'true'); }
      else {
        on(row, 'click', ev => {
          ev.stopPropagation();
          closeMenu();
          opts.onPick ? opts.onPick(it) : it.run?.();
        });
        on(row, 'mouseenter', () => setHot(container, row));
      }
      container.appendChild(row);
    }
  });
  return model;
}

export function rows(container) {
  return [...container.querySelectorAll('.mi:not(.dis):not(.mi-header)')];
}

export function setHot(container, row) {
  for (const r of container.querySelectorAll('.mi.hot')) r.classList.remove('hot');
  if (!row) return;
  row.classList.add('hot');
  row.scrollIntoView({ block: 'nearest' });
}

export function moveHot(container, delta) {
  const list = rows(container);
  if (!list.length) return;
  let i = list.findIndex(r => r.classList.contains('hot'));
  if (i < 0) i = delta > 0 ? -1 : 0;
  i = (i + delta + list.length) % list.length;
  setHot(container, list[i]);
}

export function activateHot(container) {
  const hot = container.querySelector('.mi.hot:not(.dis)');
  if (hot) { hot.click(); return true; }
  return false;
}

let menuCleanup = null;

/** Open a popup menu at viewport coordinates. */
export function openMenu(spec, pos = {}) {
  const m = document.getElementById('ctxmenu');
  if (!m) return;
  closeMenu();
  const model = normalizeMenu(spec);
  renderMenu(m, model);
  if (model.title) m.prepend(el('div', 'menu-title', model.title));
  m.classList.add('show');
  m.style.left = '0px';
  m.style.top = '0px';
  const rect = m.getBoundingClientRect();
  const pad = 6;
  let x = pos.clientX ?? pos.x ?? 0;
  let y = pos.clientY ?? pos.y ?? 0;
  if (x + rect.width + pad > innerWidth) x = Math.max(pad, innerWidth - rect.width - pad);
  if (y + rect.height + pad > innerHeight) y = Math.max(pad, innerHeight - rect.height - pad);
  m.style.left = Math.round(x) + 'px';
  m.style.top = Math.round(y) + 'px';
  moveHot(m, 1);

  const onDown = ev => { if (!m.contains(ev.target)) closeMenu(); };
  const onKey = ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); closeMenu(); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); moveHot(m, 1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); moveHot(m, -1); }
    else if (ev.key === 'Enter') { if (activateHot(m)) ev.preventDefault(); }
    else if (ev.key === 'Home') { ev.preventDefault(); setHot(m, rows(m)[0]); }
    else if (ev.key === 'End') { ev.preventDefault(); setHot(m, rows(m).at(-1)); }
  };
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  const onScroll = () => closeMenu();
  window.addEventListener('blur', onScroll);
  menuCleanup = () => {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', onScroll);
    menuCleanup = null;
  };
  return m;
}

export function closeMenu() {
  const m = document.getElementById('ctxmenu');
  if (m) {
    m.classList.remove('show');
    m.replaceChildren();
  }
  menuCleanup?.();
}
