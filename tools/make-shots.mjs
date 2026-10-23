#!/usr/bin/env node
// Xplorer² Modern — README screenshot studio.
//
// Boots the real Electron app, fills a curated demo folder with generated
// artwork, drives genuine UI states over CDP and writes cropped, retina-sharp
// PNGs to docs/screenshots/. Nothing here mocks the renderer: every pixel is
// the running application.
//
//   node tools/make-shots.mjs            # all scenes
//   node tools/make-shots.mjs --only=hero
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9341;
const OUT = path.join(ROOT, 'docs', 'screenshots');
const DEMO = path.join(os.tmpdir(), 'x2m-demo');
const VW = 1600;               // CSS viewport
const VH = 1000;
const DSF = 1.5;               // crisp, but ~2 MB for the whole gallery
const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).toLowerCase();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- tiny PNG writer
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Deterministic abstract "artwork" used as preview/thumbnail fodder. */
function artwork(w, h, [c0, c1, c2, glow], seed) {
  const px = Buffer.alloc(w * h * 4);
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const blobs = Array.from({ length: 4 }, () => ({
    x: rnd(), y: rnd(), r: 0.18 + rnd() * 0.3, k: 0.6 + rnd() * 0.9, g: rnd()
  }));
  const mix = (a, b, t) => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t
  ];
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1);
      let col = mix(c0, c1, v * 0.9 + u * 0.1);
      // diagonal sheen
      const sheen = Math.max(0, 1 - Math.abs((u * 0.7 + v * 0.55) - 0.62) * 2.4);
      col = mix(col, c2, sheen * 0.22);
      for (const b of blobs) {
        const dx = (u - b.x) * 1.35, dy = v - b.y;
        const d = Math.sqrt(dx * dx + dy * dy) / b.r;
        if (d < 2.6) {
          const f = Math.exp(-d * d * b.k) * (0.42 + b.g * 0.38);
          col = mix(col, glow, Math.min(0.95, f));
        }
      }
      // soft vignette + faint scanline texture
      const vg = 1 - 0.55 * Math.max(0, (Math.hypot(u - 0.5, v - 0.5) - 0.28) * 1.5);
      const grain = ((x * 7919 + y * 104729 + seed) % 13) / 13 - 0.5;
      const i = (y * w + x) * 4;
      px[i] = Math.max(0, Math.min(255, Math.round(col[0] * vg + grain * 4)));
      px[i + 1] = Math.max(0, Math.min(255, Math.round(col[1] * vg + grain * 4)));
      px[i + 2] = Math.max(0, Math.min(255, Math.round(col[2] * vg + grain * 4)));
      px[i + 3] = 255;
    }
  }
  return png(w, h, px);
}

const PALETTES = {
  aurora: [[6, 12, 24], [10, 44, 66], [70, 220, 190], [90, 240, 200]],
  sunset: [[26, 10, 28], [88, 26, 44], [250, 170, 92], [255, 190, 120]],
  mesh: [[12, 10, 34], [40, 18, 84], [180, 70, 255], [120, 140, 255]],
  ember: [[18, 8, 8], [70, 20, 14], [255, 120, 60], [255, 200, 120]],
  ocean: [[4, 14, 22], [8, 40, 58], [80, 200, 255], [140, 220, 255]],
  mono: [[16, 18, 22], [34, 38, 46], [220, 228, 236], [255, 255, 255]]
};

// ---------------------------------------------------------------- demo folder
function writeDemo() {
  fs.rmSync(DEMO, { recursive: true, force: true });
  const dirs = ['Design', 'Design-export', 'Sources', 'Docs', 'Assets'];
  for (const d of dirs) fs.mkdirSync(path.join(DEMO, d), { recursive: true });

  const art = [
    ['Design', 'aurora-study.png', 'aurora', 1500, 1000, 11],
    ['Design', 'sunset-grid.png', 'sunset', 1500, 1000, 27],
    ['Design', 'mesh-poster.png', 'mesh', 1000, 1400, 43],
    ['Design', 'ember-field.png', 'ember', 1500, 1000, 59],
    ['Design', 'hero-01.png', 'ocean', 1200, 800, 67],
    ['Design', 'hero-02.png', 'aurora', 1200, 800, 73],
    ['Design', 'cover-sheet.png', 'mono', 1000, 1000, 79],
    ['Design', 'icon-sheet.png', 'mesh', 800, 800, 83],
    ['Design', 'storyboard.png', 'ember', 1400, 900, 89],
    ['Design', 'wireframe.png', 'mono', 1400, 900, 97],
    ['Design', 'artboard-a1.png', 'ocean', 900, 1200, 101],
    ['Design', 'artboard-a2.png', 'sunset', 900, 1200, 103],
    ['Design', 'plate-01.png', 'aurora', 900, 600, 107],
    ['Design', 'plate-02.png', 'ember', 900, 600, 109],
    ['Design', 'plate-03.png', 'mesh', 900, 600, 113],
    ['Design', 'plate-04.png', 'ocean', 900, 600, 127],
    ['Design', 'texture-01.png', 'ember', 800, 800, 131],
    ['Design', 'texture-02.png', 'aurora', 800, 800, 137],
    ['Assets', 'ocean-texture.png', 'ocean', 1600, 900, 71],
    ['Assets', 'mono-type-specimen.png', 'mono', 1400, 900, 93],
    ['Assets', 'og-image.png', 'mesh', 1200, 630, 139],
    ['Assets', 'favicon.png', 'aurora', 256, 256, 149],
    ['Assets', 'logo-mono.png', 'mono', 512, 512, 151],
    ['Assets', 'texture-grain.png', 'ember', 800, 800, 157],
    ['Assets', 'preview-small.png', 'sunset', 640, 400, 163]
  ];
  for (const [dir, name, key, w, h, seed] of art) {
    fs.writeFileSync(path.join(DEMO, dir, name), artwork(w, h, PALETTES[key], seed));
  }
  // same-name/same-content pair for the duplicate finder, and a size-different twin
  fs.copyFileSync(path.join(DEMO, 'Design', 'aurora-study.png'), path.join(DEMO, 'Design', 'aurora-study copy.png'));
  fs.copyFileSync(path.join(DEMO, 'Design', 'aurora-study.png'), path.join(DEMO, 'Design-export', 'aurora-study.png'));
  fs.writeFileSync(path.join(DEMO, 'Design-export', 'sunset-grid.png'), artwork(1500, 1000, PALETTES.sunset, 99));
  fs.copyFileSync(path.join(DEMO, 'Design', 'mesh-poster.png'), path.join(DEMO, 'Design-export', 'mesh-poster.png'));
  fs.writeFileSync(path.join(DEMO, 'Design-export', 'icon-notes.md'), '# export notes\n\n- 2x raster fallbacks\n- safe margins 48 px\n');
  fs.copyFileSync(path.join(ROOT, 'assets', 'icon.png'), path.join(DEMO, 'Assets', 'app-icon.png'));

  const text = (p, s) => fs.writeFileSync(path.join(DEMO, p), s);
  // pad a text file to a plausible on-disk size so the Size column looks real
  const pad = (rel, head, bytes, line = '- reference line for layout review') => {
    let s = head.trimEnd() + '\n';
    let i = 0;
    while (Buffer.byteLength(s) < bytes) s += `${line} ${++i}\n`;
    text(rel, s);
  };

  pad('Design/palette.md', '# Palette study\n\n- Aurora teal   #4ce0c0\n- Deep slate    #0b1220\n- Signal amber  #ffb45c\n\nContrast pairs are checked at AAA for body copy.', 3200);
  pad('Design/grid-notes.md', '# Grid notes\n\n12 columns, 24 px gutters, 8 px baseline.\nSidebar collapses below 1120 px.', 1800);
  pad('Design/type-scale.md', '# Type scale\n\n- display 48 / 1.05\n- title 28 / 1.2\n- body 14 / 1.55\n- caption 11 / 1.4', 2400);
  pad('Design/export-brief.md', '# Export brief\n\nPNG for transparency, JPG for photography, SVG for marks.\nRetina at 2x, never upscale.', 5200);
  pad('Design/motion-spec.md', '# Motion spec\n\n- enter 240 ms cubic-bezier(.2,.8,.2,1)\n- exit 160 ms ease-in\n- respect prefers-reduced-motion', 4100);
  pad('Design/ux-notes.md', '# UX notes\n\nSelection must survive a refresh. Keyboard first, pointer second.', 6100);
  pad('Design/voice.md', '# Voice\n\nShort sentences. Concrete nouns. No exclamation marks.', 1500);
  text('Design/colour-tokens.json', JSON.stringify({
    bg: '#0b1220', surface: '#131b2a', line: '#22304a', text: '#e7edf5',
    dim: '#96a3b8', accent: '#4ce0c0', amber: '#ffb45c', danger: '#ff6b6b'
  }, null, 2));

  pad('Sources/index.js', "import { mount } from './renderer.js';\nimport { createRouter } from './router.js';\n\nconst root = document.querySelector('#app');\nconst router = createRouter({ history: true });\nmount(root, { router, theme: 'dark', density: 'comfortable' });", 2600);
  pad('Sources/renderer.js', "export function mount(root, options) {\n  root.dataset.theme = options.theme;\n  root.dataset.density = options.density;\n  return { root, options };\n}", 3400);
  pad('Sources/router.js', "export function createRouter({ history = false } = {}) {\n  const routes = new Map();\n  return {\n    add(path, view) { routes.set(path, view); return this; },\n    resolve(path) { return routes.get(path) || null; },\n    history\n  };\n}", 2100);
  pad('Sources/api.js', "const BASE = '/api';\n\nexport const get = (path, init) => fetch(BASE + path, init).then(r => r.json());\nexport const post = (path, body) => get(path, { method: 'POST', body: JSON.stringify(body) });", 4800);
  pad('Sources/store.js', "const state = new Map();\nexport const get = (k, d) => (state.has(k) ? state.get(k) : d);\nexport const set = (k, v) => state.set(k, v);", 3900);
  pad('Sources/utils.js', "export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));\nexport const pad = (n, w = 2) => String(n).padStart(w, '0');", 1500);
  pad('Sources/format.js', "export const bytes = n => ['B', 'KB', 'MB', 'GB'][Math.min(3, Math.floor(Math.log(n) / Math.log(1024)))];", 2900);
  pad('Sources/theme.css', ':root {\n  --bg: #0b1220;\n  --surface: #131b2a;\n  --text: #e7edf5;\n  --accent: #4ce0c0;\n}\n\nbody { background: var(--bg); color: var(--text); }', 7200);
  pad('Sources/layout.css', '.shell { display: grid; grid-template-columns: 240px 1fr; min-height: 100vh; }', 8100);
  text('Sources/index.html', '<!DOCTYPE html>\n<html lang="en" data-theme="dark">\n<head><meta charset="utf-8"><title>Design drop</title><link rel="stylesheet" href="theme.css"></head>\n<body><div id="app"></div><script type="module" src="index.js"></script></body>\n</html>\n');
  text('Sources/vite.config.js', "import { defineConfig } from 'vite';\nexport default defineConfig({ base: './', build: { outDir: 'dist' } });\n");
  text('Sources/package.json', JSON.stringify({ name: 'design-site', version: '1.2.0', type: 'module', scripts: { dev: 'vite', build: 'vite build' } }, null, 2));
  text('Sources/config.json', JSON.stringify({ density: 'comfortable', preview: true, telemetry: false }, null, 2));
  pad('Sources/README.md', '# design-site\n\nLanding page for the design drop. `npm run dev` and open the printed URL.', 1200);
  pad('Sources/notes.txt', 'scratch pad\n-----------\nmove the hero copy above the fold', 9400);
  pad('Sources/build.log', '[00] chunk assets/4f81ac.js  12.4 kB\n[01] chunk assets/9d02be.js  8.1 kB', 18400, '[build] transformed module -> dist/assets');
  pad('Sources/package-lock.json', '{ "name": "design-site", "lockfileVersion": 3 }', 42600);
  text('Sources/tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true }, include: ['src'] }, null, 2));
  text('Sources/.eslintrc.json', JSON.stringify({ env: { browser: true, es2022: true }, extends: ['eslint:recommended'] }, null, 2));

  pad('Docs/shipping.md', '# Shipping\n\n1. bump version\n2. run checks\n3. tag vX.Y.Z', 2600);
  pad('Docs/keyboard.md', '| Keys | Action |\n| --- | --- |\n| Ctrl+K | palette |\n| Ctrl+P | copy path |\n| F9 | compare panes |', 3300);
  pad('Docs/changelog.md', '# 1.2.0\n\n- default file manager\n- theme toggle\n- silent auto-update', 5100);
  pad('Docs/review-notes.md', '# Review notes\n\n- tighten the ribbon spacing\n- tab titles should ellipsis at 14 chars\n- preview card needs a copy button per row', 1800);
  pad('Docs/brand.md', '# Brand\n\nThe mark is two panes and a chevron. Never outline it below 24 px.', 4200);
  pad('Docs/licensing.md', '# Licensing\n\nMIT for code, CC-BY for artwork plates.', 2200);

  text('Assets/mark.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f1622"/><rect x="12" y="16" width="18" height="32" rx="3" fill="#e7edf5"/><rect x="34" y="16" width="18" height="32" rx="3" fill="#4ce0c0" opacity=".5"/></svg>\n');
  text('Assets/wordmark.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 48"><text x="0" y="32" font-family="Segoe UI, sans-serif" font-size="28" fill="#e7edf5">Design drop</text></svg>\n');
  text('Assets/icons.json', JSON.stringify({ folder: 'folder', file: 'file-text', image: 'image', video: 'film' }, null, 2));
  pad('Assets/font-license.txt', 'Inter — SIL Open Font License 1.1', 3600, 'reserved font name clause');
  text('README.md', '# Design drop\n\nArtwork plates, a palette study and the landing-page sources.\nEverything here is placeholder content for the README screenshots.\n');
  text('Design-export/README.txt', 'Exported plates. Same names, print-ready sizes.\n');
}

// ---------------------------------------------------------------- electron + CDP
function electronExe() {
  const p = path.join(ROOT, 'node_modules', 'electron');
  return path.join(p, 'dist', fs.readFileSync(path.join(p, 'path.txt'), 'utf8').trim());
}

const child = spawn(electronExe(), ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox'], {
  cwd: ROOT,
  env: { ...process.env, X2M_SILENT: '1', X2M_DEVLOG: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
const mainLog = [];
child.stdout.on('data', d => mainLog.push(String(d)));
child.stderr.on('data', d => mainLog.push(String(d)));

let ws, seq = 0;
const pending = new Map();
const pageErrors = [];

function cleanup(code) {
  try { if (!child.killed) child.kill(); } catch {}
  try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']); } catch {}
  if (code !== 0) {
    fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'logs', 'shots.log'), mainLog.join(''));
  }
  process.exit(code);
}
setTimeout(() => { console.error('GLOBAL TIMEOUT'); console.error(mainLog.join('').slice(-2000)); cleanup(2); }, 240000).unref();

async function waitTarget() {
  for (let i = 0; i < 160; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page' && /index\.html/i.test(t.url));
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error('no CDP target');
}
function connect(url) {
  return new Promise((res, rej) => {
    ws = new WebSocket(url);
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id != null) {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
        return;
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        pageErrors.push((d.exception?.description || d.text || 'exception').split('\n')[0]);
      }
    });
  });
}
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
  });
}
async function js(expr) {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true,
    returnByValue: true
  });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0]);
  return r.result.value;
}
async function capture(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(`  saved  ${name}.png  (${kb} KB)`);
}

// ---------------------------------------------------------------- scenes
const P = {
  demo: DEMO,
  design: path.join(DEMO, 'Design'),
  export: path.join(DEMO, 'Design-export'),
  sources: path.join(DEMO, 'Sources'),
  docs: path.join(DEMO, 'Docs'),
  assets: path.join(DEMO, 'Assets')
};

const PRELUDE = `
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const L = window.app.paneL, R = window.app.paneR;
  const treeOf = p => p.root.querySelector('.tree');
  function clearUI() {
    document.querySelectorAll('#palette').forEach(e => e.classList.add('hidden'));
    const cm = document.querySelector('#ctxmenu');
    if (cm) { cm.classList.remove('show'); cm.innerHTML = ''; cm.style.display = ''; }
    const ov = document.querySelector('#overlay');
    if (ov) { ov.classList.add('hidden'); ov.innerHTML = ''; }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.querySelectorAll('#toasts *, .toast').forEach(t => t.remove());
  }
  async function wantTree(on) {
    for (let i = 0; i < 5; i++) {
      const t = treeOf(L);
      const vis = t && !t.classList.contains('hidden');
      if (vis === on) { if (on) await L.drawTree(); return; }
      window.app.runCmd('toggleTree');
      await sleep(350);
    }
  }
  async function wantPreview(on) {
    for (let i = 0; i < 4; i++) {
      const p = document.querySelector('#preview');
      if ((p && p.offsetParent !== null) === on) return;
      window.app.setPreview(on);
      await sleep(350);
    }
  }
  async function mode(name) {
    for (let i = 0; i < 4; i++) {
      if (L.view.viewMode === name && R.view.viewMode === name) return;
      window.app.runCmd('viewMode');
      await sleep(450);
    }
  }
  async function resetPane(p, dir) {
    if (p.miniEl && !p.miniEl.classList.contains('hidden')) { window.app.toggleMini(p); await sleep(200); }
    const t = await p.addTab(dir, true);
    for (const other of p.tabs.filter(x => x !== t)) p.closeTab(other);
    p.tabs = [t]; p.drawTabs();
    p.view.clearSel();
    p.view.focused = null;
    p.view.markSet.clear();
    await p.refresh();
    await sleep(300);
  }
  async function reset(dirL, dirR) {
    clearUI();
    await resetPane(L, dirL);
    await resetPane(R, dirR || dirL);
    L.activate();
    await sleep(150);
  }
  const ke = e => e.name.toLowerCase() + (e.isDir ? '/' : '');
  async function selectMany(entries) {
    L.view.sel = new Set(entries.map(ke));
    L.view.focused = entries.length ? ke(entries[0]) : null;
    L.view.render(); L.drawFoot();
    await sleep(250);
    return entries.length;
  }
  async function select(re) {
    const row = [...document.querySelectorAll('#pane-L .row')].find(r => re.test(r.dataset.key || ''));
    if (!row) throw new Error('missing row ' + re);
    row.click();
    await sleep(300);
    return row.dataset.key;
  }
  async function waitImage() {
    for (let i = 0; i < 30; i++) {
      const img = document.querySelector('#preview .pv-media img');
      if (img && img.complete && img.naturalWidth > 0) return;
      await sleep(200);
    }
  }
  async function theme(name) {
    for (let i = 0; i < 3; i++) {
      if (document.documentElement.dataset.theme === name) return;
      window.app.runCmd('themeToggle');
      await sleep(400);
    }
  }
`;

const scenes = [
  {
    name: '01-hero-workspace',
    setup: `
      await theme('dark');
      await reset(${JSON.stringify(P.design)}, ${JSON.stringify(P.sources)});
      await L.addTab(${JSON.stringify(P.docs)}, false);
      await mode('details');
      await wantTree(false);
      await wantPreview(false);
      L.view.sortCol = 'name'; L.view.sortDir = 1; L.view.sort(); L.view.render(); L.drawFoot();
      L.activate();
      await sleep(800);
    `
  },
  {
    name: '02-preview-pane',
    setup: `
      await theme('dark');
      await reset(${JSON.stringify(P.design)}, ${JSON.stringify(P.sources)});
      await mode('details');
      await wantTree(false);
      await wantPreview(true);
      await select(/sunset-grid\\.png$/);
      await waitImage();
      await sleep(600);
    `
  },
  {
    name: '03-command-palette',
    setup: `
      await theme('dark');
      await reset(${JSON.stringify(P.design)}, ${JSON.stringify(P.sources)});
      await mode('details');
      await wantTree(false);
      await wantPreview(false);
      window.app.palette();
      await sleep(300);
      const inp = document.querySelector('#palette .pal-input');
      inp.value = 'copy';
      inp.dispatchEvent(new Event('input'));
      await sleep(500);
    `
  },
  {
    name: '04-context-menu',
    setup: `
      await theme('dark');
      await reset(${JSON.stringify(P.design)}, ${JSON.stringify(P.sources)});
      await mode('details');
      await wantTree(true);
      await wantPreview(false);
      const row = [...document.querySelectorAll('#pane-L .row')].find(r => /aurora-study\\.png$/.test(r.dataset.key));
      if (row) {
        const b = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, button: 2, cancelable: true,
          clientX: Math.round(b.left + 240), clientY: Math.round(b.top + 14)
        }));
      }
      await sleep(600);
    `
  },
  {
    name: '05-compare-panes',
    setup: `
      await theme('dark');
      await reset(${JSON.stringify(P.design)}, ${JSON.stringify(P.export)});
      await mode('details');
      await wantTree(false);
      await wantPreview(false);
      await sleep(300);
      await window.app.runCmd('compare');
      await sleep(800);
    `
  },
  {
    name: '06-duplicate-finder',
    setup: `
      await theme('dark');
      await reset(${JSON.stringify(P.demo)}, ${JSON.stringify(P.sources)});
      await mode('details');
      await wantTree(false);
      await wantPreview(false);
      await window.app.runCmd('dupes');
      await sleep(600);
      const d = document.querySelector('#overlay .dlg');
      if (d) {
        const find = [...d.querySelectorAll('button')].find(b => /find duplicates/i.test(b.textContent));
        if (find) find.click();
        for (let i = 0; i < 40; i++) {
          if (document.querySelectorAll('#du-tb tr').length > 1) break;
          await sleep(250);
        }
      }
      await sleep(600);
    `
  },
  {
    name: '07-scrap-pane',
    setup: `
      await theme('dark');
      await reset(${JSON.stringify(P.design)}, ${JSON.stringify(P.assets)});
      await mode('details');
      await wantTree(false);
      await wantPreview(false);
      L.activate();
      window.app.scrap.clear();
      await selectMany(L.view.entries.slice(0, 5));
      window.app.runCmd('toScrap');
      await sleep(500);
      if (L.miniEl.classList.contains('hidden')) window.app.toggleMini(L);
      window.app.scrap.redrawMinis();
      await sleep(400);
      document.querySelectorAll('#toasts *').forEach(t => t.remove());
      await sleep(250);
    `
  },
  {
    name: '08-light-theme',
    setup: `
      await theme('light');
      await reset(${JSON.stringify(P.design)}, ${JSON.stringify(P.sources)});
      await mode('details');
      await wantTree(false);
      await wantPreview(true);
      await select(/mesh-poster\\.png$/);
      await waitImage();
      await sleep(700);
    `
  },
  {
    name: '09-copy-dialog',
    setup: `
      await theme('dark');
      await reset(${JSON.stringify(P.design)}, ${JSON.stringify(P.export)});
      await mode('details');
      await wantTree(false);
      await wantPreview(false);
      await selectMany(L.view.entries.filter(e => /aurora|palette/i.test(e.name)));
      await window.app.runCmd('copy');
      await sleep(900);
    `
  },
  {
    name: '10-settings',
    setup: `
      await theme('dark');
      await reset(${JSON.stringify(P.demo)}, ${JSON.stringify(P.sources)});
      await mode('details');
      await wantTree(false);
      await wantPreview(false);
      await window.app.runCmd('settings');
      await sleep(1200);
    `
  }
];

// ---------------------------------------------------------------- run
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('building demo content in', DEMO);
  writeDemo();

  const target = await waitTarget();
  await connect(target.webSocketDebuggerUrl);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: VW, height: VH, deviceScaleFactor: DSF, mobile: false
  });

  for (let i = 0; i < 240; i++) {
    try { if (await js('return typeof window.app === "object" && window.app !== null')) break; } catch {}
    await sleep(300);
  }

  let failed = 0;
  for (const scene of scenes) {
    if (only && !scene.name.includes(only)) continue;
    try {
      await js(PRELUDE + scene.setup + '\nreturn true;');
      await sleep(450);
      await capture(scene.name);
    } catch (e) {
      failed++;
      console.error(`  FAIL   ${scene.name}: ${e.message}`);
    }
  }
  try { await js(PRELUDE + "clearUI(); await mode('details'); await wantPreview(false); await theme('dark'); return true;"); } catch {}
  if (pageErrors.length) console.error('page exceptions:\n  ' + pageErrors.slice(0, 6).join('\n  '));
  cleanup(failed ? 1 : 0);
})().catch(e => { console.error('studio error:', e); console.error(mainLog.join('').slice(-2000)); cleanup(2); });
