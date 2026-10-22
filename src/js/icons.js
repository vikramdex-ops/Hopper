// Xplorer² Modern — one icon system for the whole app.
// Inline SVG (24×24 grid, 1.75px stroke, currentColor) renders crisply at every
// DPI, inherits the theme colour, and replaces the mixed emoji glyphs so the
// ribbon, menus, tree, panels and file rows finally share a single language.
import { catFor } from './filetypes.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const P = {
  // ---- navigation / chrome
  'arrow-left': 'M19 12H5m6 6-6-6 6-6',
  'arrow-right': 'M5 12h14m-6-6 6 6-6 6',
  'arrow-up': 'M12 19V5m-6 6 6-6 6 6',
  'chevron-down': 'm6 9 6 6 6-6',
  'chevron-right': 'm9 6 6 6-6 6',
  'chevron-left': 'm15 6-6 6 6 6',
  'refresh': 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6',
  'minimize': 'M5 12h14',
  'maximize': 'M5 5h14v14H5z',
  'restore': 'M9 9h10v10H9zM5 15V5h10',
  'close': 'M6 6l12 12M18 6 6 18',
  'more': 'M6 12h.01M12 12h.01M18 12h.01',
  'copy': 'M10 8h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM5 15V5a1 1 0 0 1 1-1h9',
  'check': 'M20 6 9 17l-5-5',
  'star': 'm12 3 2.72 5.86 6.28.71-4.7 4.32 1.3 6.11L12 17.8 6.4 20l1.3-6.11L3 9.57l6.28-.71Z',
  'star-filled': 'm12 3 2.72 5.86 6.28.71-4.7 4.32 1.3 6.11L12 17.8 6.4 20l1.3-6.11L3 9.57l6.28-.71Z',
  'mirror': 'M12 3v18M8 7 3 12l5 5M16 7l5 5-5 5',
  'search': 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-3.6-3.6',
  'filter': 'M3 5h18l-7 8.2V20l-4 1v-7.8Z',
  'settings': 'M12 15.4a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8Z M19.4 14.6a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.87-1.2l-.06.06A2 2 0 1 1 4.28 16.9l.06-.06a1.7 1.7 0 0 0-1.2-2.87H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.87l-.06-.06A2 2 0 1 1 7.1 4.2l.06.06a1.7 1.7 0 0 0 2.87-1.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.87 1.2l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0 1.2 2.87H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  'command': 'M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3Z',
  'keyboard': 'M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1ZM7 10h.01M11 10h.01M15 10h.01M8 14h8',
  'pin': 'M9 3h6v5l2.5 3.5H6.5L9 8ZM12 11.5V21',
  'lock': 'M6 10h12v10H6ZM9 10V7a3 3 0 0 1 6 0v3',
  'unlock': 'M6 10h12v10H6ZM9 10V7a3 3 0 0 1 5.6-1.5',
  'eye': 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  'external-link': 'M14 4h6v6M20 4 11 13M9 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-4',
  'info': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v6M12 7.5h.01',
  'alert': 'M12 3 2.5 21h19ZM12 9v5M12 17.5h.01',
  'home': 'M3 10.8 12 3l9 7.8V20a1 1 0 0 1-1 1h-5v-6.5H9V21H4a1 1 0 0 1-1-1Z',
  'dot': 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  'circle-slash': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM5.6 5.6l12.8 12.8',
  'check-circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8.5 12.2l2.6 2.6 4.6-5.2',
  'clock': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.5V12l3 1.8',

  // ---- commands
  'folder-plus': 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM12 11v6M9 14h6',
  'scissors': 'M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM6.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM20 4 8.5 15.2M14.6 14.2 20 20M8.4 8.5 12 12',
  'trash': 'M3 6h18M8 6V4h8v2M6.5 6l.9 13.2a2 2 0 0 0 2 1.8h5.2a2 2 0 0 0 2-1.8L17.5 6M10 10.5v7M14 10.5v7',
  'pencil': 'M12 20h9M16.4 3.6a2.1 2.1 0 0 1 3 3L7.5 18.5 3 20l1.5-4.5Z',
  'layout-grid': 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  'layout-list': 'M4 6h16M4 12h16M4 18h16',
  'panel-right': 'M3 5h18v14H3zM15 5v14',
  'panel-left': 'M3 5h18v14H3zM9 5v14',
  'panel-bottom': 'M3 5h18v14H3zM3 15h18',
  'tree': 'M21 12h-8M21 6H8M21 18h-8M3 6v4c0 1.1.9 2 2 2h3M3 10v6c0 1.1.9 2 2 2h3',
  'layers': 'M12 3 3 7.6l9 4.6 9-4.6ZM3 12.2l9 4.6 9-4.6M3 16.8l9 4.6 9-4.6',
  'git-compare': 'M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM6.5 9v4.5a3 3 0 0 0 3 3h4M17.5 15V9.5a3 3 0 0 0-3-3H9',
  'plus': 'M12 5v14M5 12h14',
  'plus-square': 'M4 4h16v16H4zM12 8v8M8 12h8',
  'pie': 'M21 12a9 9 0 1 1-9-9v9ZM12 3a9 9 0 0 1 9 9h-9Z',
  'sliders': 'M4 6h16M4 12h16M4 18h16M9 3.5v5M15 9.5v5M7 15.5v5',
  'save': 'M5 3h11l3 3v15H5ZM8 3v6h8V3M8 21v-7h8v7',
  'hash': 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  'tag': 'M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9ZM7.5 8.5h.01',
  'book': 'M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2ZM8 3v18',
  'hard-drive': 'M3 7h18v10H3zM7 13h.01M11 13h.01M16 13h3',
  'terminal': 'M4 5h16v14H4ZM8 9l2.5 2.5L8 14M13 15h4',
  'split': 'M12 3v18M7 8 3.5 12 7 16M17 8l3.5 4-3.5 4',
  'merge': 'M12 3v18M7 8l5-4.5M17 8l-5-4.5M7 16l5 4.5M17 16l-5 4.5',
  'list-checks': 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  'wand': 'M15 4V2M15 10V8M12 6h2M18 6h2M4 20 14.5 9.5M13 5l6 6',
  'folder-tree': 'M3 4h5v16H3ZM12 8h9M12 16h9M8 12h4a2 2 0 0 0 2-2V8M8 12h6v4h-6',
  'route': 'M6 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM9 16h4a3 3 0 0 0 3-3V8',

  // ---- file types
  'folder': 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  'folder-open': 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1M3 10h18l-1.7 9a2 2 0 0 1-2 1.6H5.7a2 2 0 0 1-2-1.6Z',
  'file': 'M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5ZM13.5 3v5.5H19',
  'file-text': 'M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5ZM13.5 3v5.5H19M8.5 13h7M8.5 17h5',
  'file-image': 'M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5ZM13.5 3v5.5H19M9.5 12.5a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4ZM6.5 18l4-4 2.5 2.5 2-2 2.5 3',
  'file-video': 'M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5ZM13.5 3v5.5H19M10 11.5l4.5 2.5L10 16.5Z',
  'file-audio': 'M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5ZM13.5 3v5.5H19M9 17v-5l5-1v5M9 17a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM14 16a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z',
  'file-archive': 'M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5ZM13.5 3v5.5H19M11 3v3M11 8v2M11 12v3M10 17h2',
  'file-code': 'M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5ZM13.5 3v5.5H19M10 13l-2 2 2 2M14 13l2 2-2 2',
  'file-pdf': 'M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5ZM13.5 3v5.5H19M8.5 17v-4h1.6a1.4 1.4 0 0 1 0 2.8H8.5M13 17v-4h1.6a2 2 0 0 1 0 4Z',
  'file-html': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.2 9h17.6M3.2 15h17.6M12 3c-4 5-4 13 0 18M12 3c4 5 4 13 0 18',
  'file-app': 'M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3M6.5 6.5h11v11h-11ZM12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  'link': 'M10.5 13.5a4 4 0 0 0 5.7 0l2-2a4 4 0 0 0-5.7-5.7l-1 1M13.5 10.5a4 4 0 0 0-5.7 0l-2 2a4 4 0 0 0 5.7 5.7l1-1',
  'broken-link': 'M10.5 13.5a4 4 0 0 0 5.7 0M13.5 10.5a4 4 0 0 0-5.7 0M4 4l3 3M20 20l-3-3M17 4l3 3M7 20l-3-3',
  'unknown': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.7.3-1 1-1 1.7v.3M12 17.4h.01'
};

/**
 * Build an inline SVG icon element.
 * @param {string} name key in the icon set (falls back to `unknown`)
 * @param {number} size px size (default 16)
 * @param {string} cls extra classes
 */
export function icon(name, size = 16, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', name.endsWith('filled') ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', ('i i-' + name + ' ' + cls).trim());
  // inline size beats stylesheet defaults, so the size passed here is the size rendered
  svg.style.width = size + 'px';
  svg.style.height = size + 'px';
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', P[name] || P.unknown);
  svg.appendChild(p);
  return svg;
}

/** Same as icon() but as markup, for template strings. */
export function iconHTML(name, size = 16, cls = '') {
  const fill = name.endsWith('filled') ? 'currentColor' : 'none';
  return `<svg class="i i-${name} ${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" style="width:${size}px;height:${size}px" fill="${fill}" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${P[name] || P.unknown}"/></svg>`;
}

/** Icon name for a file-system entry (categories shared with the list view). */
export function iconNameFor(entry) {
  if (!entry) return 'file';
  if (entry.isDir) return 'folder';
  if (entry.brokenLink) return 'broken-link';
  const map = {
    img: 'file-image', vid: 'file-video', aud: 'file-audio', arch: 'file-archive',
    code: 'file-code', pdf: 'file-pdf', html: 'file-html', exed: 'file-app',
    link: 'link', tex: 'file-text'
  };
  return map[catFor(entry)] || 'file';
}

/**
 * Hydrate declarative icon slots: <span data-icon="folder"></span>.
 * Safe to call repeatedly; existing SVGs are left alone.
 */
export function hydrateIcons(root = document) {
  for (const slot of root.querySelectorAll('[data-icon]')) {
    const name = slot.getAttribute('data-icon');
    if (!name) continue;
    if (slot.querySelector('svg.i')) continue;
    const size = Number(slot.getAttribute('data-icon-size')) || 16;
    slot.replaceChildren(icon(name, size));
  }
}
