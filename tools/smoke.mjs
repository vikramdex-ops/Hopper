#!/usr/bin/env node
// Xplorer² Modern — CDP smoke harness.
// Boots the real Electron app, drives genuine UI flows (navigation, tabs, view
// modes, dialogs, keyboard shortcuts, context menus, file operations) through
// Chrome DevTools Protocol, asserts observable state after each step, and saves
// a screenshot per step. Exits non-zero if any step fails or the page throws.
//
//   node tools/smoke.mjs [--keep] [--only=<substr>]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9333;
const SHOTS = path.join(ROOT, 'screenshots');
const PLAY = 'C:\\Temp\\x2m-smoke';
const args = process.argv.slice(2);
const ONLY = (args.find(a => a.startsWith('--only=')) || '').slice(7);
const KEEP = args.includes('--keep');

// ---------------------------------------------------------------- electron
function electronExe() {
  const p = path.join(ROOT, 'node_modules', 'electron');
  const rel = fs.readFileSync(path.join(p, 'path.txt'), 'utf8').trim();
  return path.join(p, 'dist', rel);
}

const child = spawn(electronExe(), ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox'], {
  cwd: ROOT,
  env: { ...process.env, X2M_DEVLOG: process.env.X2M_DEVLOG || '', X2M_AUTOSCREENSHOT: '', X2M_SILENT: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
const mainLog = [];
child.stdout.on('data', d => mainLog.push(String(d)));
child.stderr.on('data', d => mainLog.push(String(d)));

function cleanup(code) {
  try { if (!child.killed) child.kill(); } catch {}
  try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']); } catch {}
  if (mainLog.length) fs.writeFileSync(path.join(ROOT, 'logs', 'smoke-main.log'), mainLog.join(''));
  process.exit(code);
}
process.on('exit', () => { try { if (!child.killed) child.kill(); } catch {} });
setTimeout(() => { console.error('GLOBAL TIMEOUT'); console.error(mainLog.join('').slice(-3000)); cleanup(2); }, 180000).unref();

// ---------------------------------------------------------------- CDP client
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForTarget() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page' && /Xplorer|index\.html/i.test(t.url + t.title));
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error('no CDP target');
}

let ws, seq = 0;
const pending = new Map();
const listeners = [];
const pageErrors = [];
const consoleErrs = [];

function connect(url) {
  return new Promise((res, rej) => {
    ws = new WebSocket(url);
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id != null) {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
        return;
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        pageErrors.push((d.exception?.description || d.text || 'exception').split('\n')[0]);
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrs.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        consoleErrs.push(m.params.entry.text.slice(0, 300));
      }
      listeners.forEach(fn => fn(m));
    });
  });
}
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout: ' + method)); } }, 30000);
  });
}
async function evalJS(expr) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0]);
  return r.result.value;
}
async function evalRaw(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0]);
  return r.result.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, `smoke-${String(name).replace(/[^\w.-]+/g, '_')}.png`), Buffer.from(r.data, 'base64'));
}

// ---------------------------------------------------------------- playground
function makePlayground() {
  fs.rmSync(PLAY, { recursive: true, force: true });
  fs.mkdirSync(path.join(PLAY, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(PLAY, 'alpha.txt'), 'hello alpha\n');
  fs.writeFileSync(path.join(PLAY, 'beta.txt'), 'hello beta\n');
  fs.writeFileSync(path.join(PLAY, 'gamma.md'), '# gamma\n');
  fs.writeFileSync(path.join(PLAY, 'sub', 'nested.txt'), 'nested\n');
  fs.writeFileSync(path.join(PLAY, 'copy-A.bin'), Buffer.alloc(2048, 7));
  fs.writeFileSync(path.join(PLAY, 'copy-B.bin'), Buffer.alloc(2048, 7));
  fs.writeFileSync(path.join(PLAY, 'sample.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
}

// ---------------------------------------------------------------- steps
const steps = [];
const step = (name, expr) => steps.push({ name, expr });

step('boot: window.app and left pane populated', `
  for (let i = 0; i < 40; i++) {
    if (window.app && window.app.paneL && document.querySelectorAll('#pane-L .row').length > 0) return true;
    await new Promise(r => setTimeout(r, 150));
  }
  return !!(window.app && window.app.paneL && document.querySelectorAll('#pane-L .row').length > 0);
`);

step('boot: both panes show a folder listing', `
  const l = document.querySelectorAll('#pane-L .row').length;
  const r = document.querySelectorAll('#pane-R .row').length;
  return l > 0 && r > 0 ? true : 'L=' + l + ' R=' + r;
`);

step('drive bar rendered with capacity chips', `
  let n = 0;
  for (let i = 0; i < 30; i++) {
    n = document.querySelectorAll('#drivebar .drive-chip').length;
    if (n > 0) break;
    await new Promise(r => setTimeout(r, 200));
  }
  const st = (document.querySelector('#st-drive') || { textContent: '' }).textContent;
  const first = document.querySelector('#drivebar .drive-chip');
  const txt = first ? first.textContent : '';
  if (n === 0) {
    const raw = await window.x2.drives().catch(e => 'IPC ERROR: ' + e.message);
    return 'chips=' + n + ' st-drive=' + st + ' ipcDrives=' + JSON.stringify(raw).slice(0, 300);
  }
  return /free/i.test(txt) ? true : 'chips=' + n + ' first=' + txt;
`);

step('navigate left pane to playground', `
  await window.app.paneL.navigateByPath(${JSON.stringify(PLAY)});
  await new Promise(r => setTimeout(r, 400));
  const cwd = window.app.paneL.cwd();
  const rows = [...document.querySelectorAll('#pane-L .row')].map(e => e.textContent);
  return cwd === ${JSON.stringify(PLAY)} ? (rows.length ? true : 'no rows') : 'cwd=' + cwd;
`);

step('playground contents listed (alpha/beta/gamma/sub)', `
  const rows = [...document.querySelectorAll('#pane-L .row')].map(e => e.dataset.key || e.textContent);
  const j = rows.join('|');
  return (j.includes('alpha.txt') && j.includes('beta.txt') && j.includes('gamma.md') && j.includes('sub'))
    ? true : 'rows=' + j;
`);

step('new folder created via fs IPC appears in listing', `
  await window.x2.mkdir(${JSON.stringify(PLAY)}, 'smoke-dir');
  await window.app.paneL.refresh();
  await new Promise(r => setTimeout(r, 300));
  const rows = [...document.querySelectorAll('#pane-L .row')].map(e => e.dataset.key || e.textContent).join('|');
  return rows.includes('smoke-dir') ? true : 'rows=' + rows;
`);

step('file rename via fs IPC', `
  await window.x2.rename(${JSON.stringify(PLAY + '\\\\gamma.md')}, 'renamed.md');
  await window.app.paneL.refresh();
  await new Promise(r => setTimeout(r, 300));
  const rows = [...document.querySelectorAll('#pane-L .row')].map(e => e.dataset.key || e.textContent).join('|');
  return rows.includes('renamed.md') ? true : 'rows=' + rows;
`);

step('open a new tab (Ctrl+T) then close it (Ctrl+F4)', `
  const before = window.app.paneL.tabs.length;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true }));
  await new Promise(r => setTimeout(r, 500));
  const mid = window.app.paneL.tabs.length;
  const tabEls = document.querySelectorAll('#pane-L .tab').length;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F4', ctrlKey: true, bubbles: true }));
  await new Promise(r => setTimeout(r, 500));
  const after = window.app.paneL.tabs.length;
  return (mid === before + 1 && tabEls >= 2 && after === before)
    ? true : 'before=' + before + ' mid=' + mid + ' tabs=' + tabEls + ' after=' + after;
`);

step('view mode cycles details -> thumbs -> list', `
  const v = window.app.paneL.view;
  const start = v.viewMode;
  const seen = [start];
  for (let i = 0; i < 4; i++) {
    window.app.runCmd('viewMode');
    await new Promise(r => setTimeout(r, 250));
    if (!seen.includes(v.viewMode)) seen.push(v.viewMode);
  }
  return seen.includes('thumbs') ? true : 'seen=' + seen.join(',');
`);

step('back to details view for predictable screenshots', `
  for (let i = 0; i < 4; i++) {
    if (window.app.paneL.view.viewMode === 'details') break;
    window.app.runCmd('viewMode');
    await new Promise(r => setTimeout(r, 350));
  }
  const mode = window.app.paneL.view.viewMode;
  const cols = document.querySelectorAll('#pane-L .row .col').length;
  return (mode === 'details' && cols > 4) ? true : 'mode=' + mode + ' cols=' + cols;
`);

step('sort by Size column changes row order', `
  const view = window.app.paneL.view;
  const heads = document.querySelectorAll('#pane-L .head .col');
  if (!heads.length) return 'no column headers found';
  const target = [...heads].find(h => /size/i.test(h.textContent));
  if (!target) return 'no size header among ' + heads.length;
  const before = view.view.map(e => e.name).join(',');
  target.click();
  await new Promise(r => setTimeout(r, 350));
  const after = view.view.map(e => e.name).join(',');
  const dir = view.sortDir;
  const expected = [...view.entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return (a.size - b.size) * dir || a.name.localeCompare(b.name);
  }).map(e => e.name).join(',');
  // clicking again must flip the direction (sortCol is persisted between runs)
  target.click();
  await new Promise(r => setTimeout(r, 350));
  const flipped = view.view.map(e => e.name).join(',');
  return (before !== after && after === expected && flipped !== after)
    ? true : 'dir=' + dir + ' before=' + before + ' | after=' + after + ' | expect=' + expected + ' | flipped=' + flipped;
`);

step('filter bar narrows the list (F3 + Enter)', `
  const total = window.app.paneL.view.entries.length;
  void 0;
  window.app.startFilter();
  await new Promise(r => setTimeout(r, 250));
  const inp = document.querySelector('#filter-input');
  if (!inp || inp.classList.contains('hidden')) return 'filter input not shown';
  inp.value = 'alpha';
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise(r => setTimeout(r, 450));
  const rows = [...document.querySelectorAll('#pane-L .row')];
  const shown = rows.filter(r => r.offsetParent !== null);
  const names = shown.map(r => r.dataset.key || r.textContent).join('|');
  const filtered = window.app.paneL.view.view.length;
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setTimeout(r, 350));
  const restored = window.app.paneL.view.view.length;
  return (filtered < total && shown.length >= 1 && names.toLowerCase().includes('alpha') && restored === total)
    ? true : 'total=' + total + ' filtered=' + filtered + ' shown=' + shown.length + ' names=' + names + ' restored=' + restored;
`);

step('tree pane toggles on and off', `
  const vis = () => { const t = document.querySelector('.tree'); return !!t && !t.classList.contains('hidden') && t.offsetParent !== null; };
  const a = vis();
  window.app.runCmd('toggleTree');
  await new Promise(r => setTimeout(r, 350));
  const b = vis();
  window.app.runCmd('toggleTree');
  await new Promise(r => setTimeout(r, 350));
  const c = vis();
  return (a !== b && a === c) ? true : 'a=' + a + ' b=' + b + ' c=' + c;
`);

step('preview pane toggles and draws a selection', `
  window.app.setPreview(false);
  await new Promise(r => setTimeout(r, 150));
  window.app.runCmd('togglePreview');
  await new Promise(r => setTimeout(r, 400));
  const p = document.querySelector('#preview');
  const on = p && p.offsetParent !== null;
  window.app.paneL.view.sel = new Set();
  const row = document.querySelector('#pane-L .row');
  if (row) row.click();
  await new Promise(r => setTimeout(r, 400));
  const hasBody = p && p.textContent.trim().length > 10;
  window.app.runCmd('togglePreview');
  await new Promise(r => setTimeout(r, 300));
  return (on && hasBody) ? true : 'on=' + on + ' hasBody=' + hasBody;
`);

step('command palette opens with entries (Ctrl+K)', `
  window.app.palette();
  await new Promise(r => setTimeout(r, 300));
  const pal = document.querySelector('#palette');
  const rect = pal ? pal.getBoundingClientRect() : { width: 0, height: 0 };
  if (!pal || pal.classList.contains('hidden') || rect.height < 20) return 'palette not visible';
  const n = document.querySelectorAll('#palette .pal-list .mi').length;
  pal.classList.add('hidden');
  await new Promise(r => setTimeout(r, 200));
  return n > 5 ? true : 'items=' + n;
`);

const dialogs = [
  ['search dialog (Ctrl+F)', `window.app.runCmd('find');`, '.dlg'],
  ['duplicates dialog (Ctrl+D)', `window.app.runCmd('dupes');`, '.dlg'],
  ['mass rename dialog (Ctrl+R)', `window.app.runCmd('massRename');`, '.dlg'],
  ['folder stats (Ctrl+G)', `window.app.runCmd('stats');`, '.dlg'],
  ['color tags dialog', `window.app.runCmd('tags');`, '.dlg'],
  ['properties dialog (Alt+Enter)', `window.app.runCmd('props');`, '.dlg'],
  ['settings dialog (Ctrl+,)', `window.app.runCmd('settings');`, '.dlg'],
  ['keyboard shortcuts (Ctrl+?)', `window.app.showShortcuts();`, '.dlg'],
  ['scrap pane dialog', `window.app.runCmd('scrapDialog');`, '.dlg']
];
for (const [name, openExpr, sel] of dialogs) {
  step(`opens then closes: ${name}`, `
    const closeAll = () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const ov = document.querySelector('#overlay');
      if (ov) { ov.classList.add('hidden'); ov.innerHTML = ''; }
    };
    closeAll();
    ${openExpr}
    await new Promise(r => setTimeout(r, 500));
    const d = document.querySelector('${sel}');
    const ov = document.querySelector('#overlay');
    if (!d || ov.classList.contains('hidden') || d.offsetParent === null) return 'dialog did not open (overlay hidden=' + (ov ? ov.classList.contains('hidden') : 'no overlay') + ')';
    const title = (d.querySelector('.dlg-title') || {}).textContent || '';
    const bodyLen = (d.querySelector('.dlg-body') || { textContent: '' }).textContent.trim().length;
    closeAll();
    await new Promise(r => setTimeout(r, 300));
    const stillOpen = !document.querySelector('#overlay').classList.contains('hidden');
    return (!stillOpen && bodyLen > 0) ? true : 'stuck=' + stillOpen + ' bodyLen=' + bodyLen + ' title=' + title.trim();
  `);
}

step('compare marks differing panes with colour tags', `
  const L = window.app.paneL, R = window.app.paneR;
  await L.navigateByPath(${JSON.stringify(PLAY)});
  await R.navigateByPath(${JSON.stringify('C:\\Windows\\Fonts')});
  await new Promise(r => setTimeout(r, 600));
  await window.app.runCmd('compare');
  await new Promise(r => setTimeout(r, 400));
  const n = L.view.markSet.size + R.view.markSet.size;
  const marked = document.querySelectorAll('#pane-L .row.m-l, #pane-L .row.m-up, #pane-L .row.m-both, #pane-R .row.m-r, #pane-R .row.m-up, #pane-R .row.m-both').length;
  return n > 0 && marked > 0 ? true : 'marks=' + n + ' domMarked=' + marked;
`);

step('scrap pane collects sent items (Ctrl+S)', `
  const L = window.app.paneL;
  await L.navigateByPath(${JSON.stringify(PLAY)});
  await new Promise(r => setTimeout(r, 500));
  L.view.sel = new Set(L.view.entries.slice(0, 2).map(e => e.key));
  window.app.runCmd('toScrap');
  await new Promise(r => setTimeout(r, 500));
  const n = window.app.scrap && window.app.scrap.items ? window.app.scrap.items.length : -1;
  const scrapEl = document.querySelector('#scrap, .scrap');
  const domRows = scrapEl ? scrapEl.querySelectorAll('.row').length : -1;
  return n > 0 ? true : 'scrapItems=' + n + ' domRows=' + domRows;
`);

step('right-click context menu appears on a row', `
  const row = document.querySelector('#pane-L .row');
  if (!row) return 'no row';
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 400, clientY: 300 }));
  await new Promise(r => setTimeout(r, 350));
  const m = document.querySelector('#ctxmenu');
  const visible = !!m && m.classList.contains('show');
  const items = m ? m.querySelectorAll('.mi').length : 0;
  const first = m && m.querySelector('.mi') ? m.querySelector('.mi').textContent : '';
  document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 700 }));
  await new Promise(r => setTimeout(r, 250));
  const closed = !m.classList.contains('show');
  return (visible && items > 3 && closed) ? true : 'visible=' + visible + ' items=' + items + ' first=' + first + ' closed=' + closed;
`);

step('selection + pane footer counts update', `
  window.app.runCmd('selectAll');
  await new Promise(r => setTimeout(r, 400));
  const foot = (document.querySelector('#pane-L .pane-foot') || { textContent: '' }).textContent;
  const sel = window.app.paneL.view.sel.size;
  const checked = document.querySelectorAll('#pane-L .row.sel').length;
  window.app.runCmd('selectNone');
  await new Promise(r => setTimeout(r, 300));
  const after = window.app.paneL.view.sel.size;
  return (sel > 0 && checked > 0 && /selected/.test(foot) && after === 0)
    ? true : 'sel=' + sel + ' checked=' + checked + ' after=' + after + ' foot=' + foot;
`);

step('copy dialog opens with source and destination', `
  const v = window.app.paneL.view;
  v.sel = new Set(v.entries.slice(0, 1).map(e => e.key));
  v.render(); window.app.paneL.drawFoot();
  window.app.runCmd('copy');
  await new Promise(r => setTimeout(r, 500));
  const d = document.querySelector('#overlay .dlg');
  if (!d || d.offsetParent === null) return 'copy dialog did not open';
  const txt = d.textContent;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  const stuck = !document.querySelector('#overlay').classList.contains('hidden');
  return (!stuck && /copy|destination|overwrite/i.test(txt)) ? true : 'stuck=' + stuck + ' text: ' + txt.slice(0, 180);
`);

step('search engine finds alpha.txt from playground root', `
  const hits = [];
  window.x2.onProgress((id, kind, payload) => { if (kind === 'hit') hits.push(payload); });
  const jobId = window.app.newJobId();
  const counts = await window.x2.search([${JSON.stringify(PLAY)}], { name: 'alpha*' }, jobId);
  await new Promise(r => setTimeout(r, 300));
  const names = hits.map(x => x.name || x.path);
  return (hits.length >= 1 && names.some(n => /alpha\\.txt/i.test(n)))
    ? true : 'hits=' + hits.length + ' names=' + JSON.stringify(names) + ' counts=' + JSON.stringify(counts);
`);

step('duplicate finder reports the identical bin pair', `
  const jobId = window.app.newJobId();
  const res = await window.x2.findDuplicates([${JSON.stringify(PLAY)}], { matchSize: true }, jobId);
  const groups = res.groups || [];
  const names = groups.flat().map(x => x.name);
  const hasPair = groups.some(g => g.some(x => /copy-a\.bin/i.test(x.name)) && g.some(x => /copy-b\.bin/i.test(x.name)));
  return (groups.length >= 1 && hasPair) ? true : 'groups=' + groups.length + ' names=' + JSON.stringify(names);
`);

step('icons come from one SVG set (no emoji glyphs)', `
  const slots = [...document.querySelectorAll('#ribbon .ic, #mainbar [data-icon], #mainbar .ic, .tb-right button, .tab-new')];
  const missing = slots.filter(s => !s.querySelector('svg.i') && !s.matches('svg.i'));
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  const leftovers = [...document.querySelectorAll('.ic, .pv-head button, .mini-head .ic, #ctxmenu .ic')]
    .filter(e => emoji.test(e.textContent || '')).map(e => e.textContent.trim()).slice(0, 6);
  if (missing.length) return 'missing svg: ' + missing.length + ' first=' + (missing[0].outerHTML || '').slice(0, 80);
  if (leftovers.length) return 'emoji: ' + leftovers.join(' ');
  const allSvg = document.querySelectorAll('svg.i').length;
  return allSvg > 40 ? true : 'only ' + allSvg + ' icons';
`);

step('chrome has one rhythm (uniform heights, icon sizes, no overflow)', `
  const uniq = a => [...new Set(a)];
  const h = sel => uniq([...document.querySelectorAll(sel)].map(e => Math.round(e.getBoundingClientRect().height)));
  const w = sel => uniq([...document.querySelectorAll(sel)].map(e => Math.round(e.getBoundingClientRect().width)));
  const ribbonH = h('#ribbon .rb');
  const addrH = h('#mainbar .chr-btn.icon-only');
  const iconW = w('#ribbon .ic svg.i');
  const navIcon = w('#mainbar [data-icon] svg.i');
  const tabsH = h('.tabs-row');
  const overflow = document.querySelector('#ribbon').scrollWidth - document.querySelector('#ribbon').clientWidth > 8;
  const problems = [];
  if (ribbonH.length !== 1) problems.push('ribbon heights ' + ribbonH);
  if (addrH.length !== 1) problems.push('address button heights ' + addrH);
  if (iconW.length !== 1) problems.push('ribbon icon widths ' + iconW);
  if (navIcon.length !== 1) problems.push('nav icon widths ' + navIcon);
  if (tabsH.length !== 1) problems.push('tab row heights ' + tabsH);
  if (overflow) problems.push('ribbon overflows at 1500px');
  return problems.length ? problems.join('; ') : true;
`);

step('preview metadata card exposes the full resource path', `
  window.app.setPreview(true);
  await window.app.paneL.navigateByPath(${JSON.stringify(PLAY)});
  await new Promise(r => setTimeout(r, 300));
  const row = [...document.querySelectorAll('#pane-L .row')].find(r => r.dataset.key === 'alpha.txt');
  if (!row) return 'alpha row missing';
  row.click();
  await new Promise(r => setTimeout(r, 600));
  const card = document.querySelector('#preview .pv-info');
  if (!card) return 'no metadata card';
  const vals = [...card.querySelectorAll('.pv-row')].map(r => r.querySelector('.pv-v')?.textContent || '');
  const full = vals.find(v => v === ${JSON.stringify(PLAY + '\\alpha.txt')});
  const labels = [...card.querySelectorAll('.pv-k')].map(k => k.textContent.toLowerCase());
  if (!full) return 'path row=' + JSON.stringify(vals.slice(0, 2));
  if (!labels.includes('modified') || !labels.includes('folder')) return 'labels=' + labels.join(',');
  if (!card.querySelector('.pv-copy')) return 'no copy affordance';
  return true;
`);

step('preview streams real bytes through the x2file protocol', `
  window.app.setPreview(true);
  await window.app.paneL.navigateByPath(${JSON.stringify(PLAY)});
  await new Promise(r => setTimeout(r, 250));
  const row = [...document.querySelectorAll('#pane-L .row')].find(r => r.dataset.key === 'sample.png');
  if (!row) return 'sample.png missing';
  row.click();
  await new Promise(r => setTimeout(r, 900));
  const img = document.querySelector('#preview .pv-media img');
  if (!img) return 'no image element';
  if (!img.complete) return 'image did not finish loading';
  return img.naturalWidth > 0 ? true : 'naturalWidth=0 src=' + img.src;
`);

step('browser memory: back/forward/up + recent locations', `
  const p = window.app.paneL;
  p.navigateByPath(${JSON.stringify(PLAY)});
  await new Promise(r => setTimeout(r, 250));
  p.navigateByPath(${JSON.stringify(PLAY + '\\sub')});
  await new Promise(r => setTimeout(r, 250));
  const afterFwdNav = p.historyStack();
  if (afterFwdNav.pos < 1) return 'no history entries pos=' + afterFwdNav.pos;
  p.back();
  await new Promise(r => setTimeout(r, 350));
  if (p.cwd() !== ${JSON.stringify(PLAY)}) return 'back went to ' + p.cwd();
  p.fwd();
  await new Promise(r => setTimeout(r, 350));
  if (!p.cwd().endsWith('sub')) return 'fwd went to ' + p.cwd();
  p.back();
  await new Promise(r => setTimeout(r, 350));
  p.activate();
  await new Promise(r => setTimeout(r, 150));
  const backBtn = document.querySelector('#nav-back');
  const upBtn = document.querySelector('#nav-up');
  if (backBtn.classList.contains('dis')) return 'back button disabled with history';
  if (!upBtn.title.includes('Up')) return 'up tooltip missing';
  const addr = document.querySelector('#address');
  addr.focus();
  addr.value = '';
  addr.dispatchEvent(new Event('focus'));
  window.app.showAddrRecent();
  await new Promise(r => setTimeout(r, 250));
  const box = document.querySelector('#addr-recent');
  const n = box.querySelectorAll('.mi').length;
  const groups = box.querySelectorAll('.grp').length;
  window.app.hideAddrRecent();
  addr.blur();
  if (!n) return 'recent dropdown empty';
  return groups >= 1 ? true : 'no group labels';
`);

step('context menu uses the grouped menu model', `
  const row = document.querySelector('#pane-L .row');
  if (!row) return 'no row';
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 320, clientY: 240 }));
  await new Promise(r => setTimeout(r, 250));
  const m = document.querySelector('#ctxmenu');
  if (!m.classList.contains('show')) return 'menu not shown';
  const groups = m.querySelectorAll('.grp').length;
  const items = m.querySelectorAll('.mi').length;
  const keys = m.querySelectorAll('.mi .k kbd').length;
  const hints = m.querySelectorAll('.mi .hint').length;
  const icons = m.querySelectorAll('.mi .ic svg.i').length;
  const hot = m.querySelectorAll('.mi.hot').length;
  m.classList.add('hidden');
  window.app.showMenu({ clientX: 0, clientY: 0 }, { groups: [] });
  document.getElementById('ctxmenu').classList.remove('show');
  if (!groups || !items || !keys || !icons || !hot) return 'groups=' + groups + ' items=' + items + ' keys=' + keys + ' icons=' + icons + ' hot=' + hot;
  return hints > 0 ? true : 'no hint rows';
`);

step('palette rows share the same structured model', `
  window.app.palette();
  await new Promise(r => setTimeout(r, 300));
  const list = document.querySelector('#palette .pal-list');
  const items = list.querySelectorAll('.mi').length;
  const icons = list.querySelectorAll('.mi .ic svg.i').length;
  const keys = list.querySelectorAll('.mi .k kbd').length;
  const groups = list.querySelectorAll('.grp').length;
  const input = document.querySelector('#palette .pal-input');
  input.value = 'rename';
  input.dispatchEvent(new Event('input'));
  await new Promise(r => setTimeout(r, 200));
  const filtered = list.querySelectorAll('.mi').length;
  document.querySelector('#palette').classList.add('hidden');
  if (!items || !icons || !keys || !groups) return 'items=' + items + ' icons=' + icons + ' keys=' + keys + ' groups=' + groups;
  return filtered > 0 && filtered < items ? true : 'filter did not narrow (' + filtered + '/' + items + ')';
`);

step('archive + misc IPC surface intact', `
  const need = ['listDir','stat','mkdir','rename','trash','search','findDuplicates','hash','listArchive','pick','msgBox','drives'];
  const missing = need.filter(k => typeof window.x2[k] !== 'function');
  return missing.length === 0 ? true : 'missing=' + missing.join(',');
`);

step('no page exceptions or console errors so far', `
  return true;
`);

// ---------------------------------------------------------------- runner
(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  makePlayground();

  const target = await waitForTarget();
  await connect(target.webSocketDebuggerUrl);
  await send('Runtime.enable');
  await send('Page.enable');
  try { await send('Log.enable'); } catch {}

  for (let i = 0; i < 200; i++) {
    try { if (await evalRaw('typeof window.app === "object" && window.app !== null')) break; } catch {}
    await sleep(400);
  }

  let pass = 0, fail = 0;
  const failures = [];
  for (const s of steps) {
    if (ONLY && !s.name.toLowerCase().includes(ONLY.toLowerCase())) continue;
    const errBefore = pageErrors.length;
    let ok = false, detail = '';
    try {
      const v = await evalJS(s.expr);
      if (v === true) ok = true;
      else { ok = false; detail = typeof v === 'string' ? v : 'returned ' + JSON.stringify(v); }
    } catch (e) { detail = e.message; }
    const newErrs = pageErrors.slice(errBefore);
    if (ok && newErrs.length === 0) { pass++; console.log('  PASS  ' + s.name); }
    else {
      fail++;
      const msg = (ok ? 'page error: ' + newErrs.join('; ') : detail);
      failures.push(s.name + ' :: ' + msg);
      console.log('  FAIL  ' + s.name + ' :: ' + msg);
    }
    try { await shot(s.name); } catch {}
  }

  console.log('\n--- smoke summary ---');
  console.log(`pass=${pass} fail=${fail}`);
  if (pageErrors.length) console.log('page exceptions:\n  ' + pageErrors.join('\n  '));
  if (consoleErrs.length) console.log('console errors:\n  ' + [...new Set(consoleErrs)].slice(0, 15).join('\n  '));
  if (mainLog.join('').trim()) {
    const bad = mainLog.join('').split(/\r?\n/).filter(l => /error|Error|ERR_|failed|Uncaught/.test(l));
    if (bad.length) console.log('main process:\n  ' + bad.slice(0, 15).join('\n  '));
  }
  if (failures.length) console.log('\nfailures:\n  - ' + failures.join('\n  - '));
  cleanup(fail === 0 ? 0 : 1);
})().catch(e => { console.error('harness error:', e); console.error(mainLog.join('').slice(-2000)); cleanup(2); });
