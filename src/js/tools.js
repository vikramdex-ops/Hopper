// Dialogs + tool implementations
import { el, $, $$, on, fmtSize, fmtDate, esc, sleep, iconFor, fmtTime, keyOfEntry } from './util.js';
import { pref, S, persist } from './store.js';
import { icon } from './icons.js';
import { openMenu, closeMenu } from './popup.js';

export function dlg(title, win, opts = {}) {
  const ov = $('#overlay');
  ov.classList.remove('hidden');
  const d = el('div', 'dlg');
  if (opts.width) d.style.width = opts.width + 'px';
  const head = el('div', 'dlg-head');
  const titleEl = el('span', 'dlg-title');
  const ic = el('span', 'ic');
  ic.appendChild(icon(opts.icon || 'settings', 15));
  titleEl.append(ic, document.createTextNode(title));
  head.appendChild(titleEl);
  const x = el('button', 'dlg-x');
  x.title = 'Close (Esc)';
  x.appendChild(icon('close', 14));
  on(x, 'click', close);
  head.appendChild(x);
  d.appendChild(head);
  const body = el('div', 'dlg-body');
  d.appendChild(body);
  const foot = el('div', 'dlg-foot');
  d.appendChild(foot);
  ov.replaceChildren(d);
  function close() {
    ov.classList.add('hidden');
    ov.replaceChildren();
    document.removeEventListener('keydown', escClose);
  }
  const escClose = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', escClose, { once: false });
  win._close = close;
  win.body = body; win.foot = foot; win.el = d;
  return win;
}

export function btn(label, cls, fn, foot, opts = {}) {
  const b = el('button', 'chr-btn ' + (cls || ''));
  if (opts.icon) { const s = el('span', 'ic'); s.appendChild(icon(opts.icon, 14)); b.appendChild(s); }
  b.appendChild(el('span', 'lbl', label));
  if (fn) on(b, 'click', fn);
  if (foot) foot.appendChild(b);
  return b;
}

/** Structured menu item (see popup.js for the model). */
export function menuItem(item) {
  const row = el('div', 'mi');
  row.innerHTML = `<span class="lbl">${esc(item.label)}</span>`;
  if (item.key) row.appendChild(el('span', 'k', item.key));
  if (item.disabled) row.classList.add('dis');
  if (item.run) on(row, 'click', () => { hideMenu(); item.run(); });
  return row;
}

/** Show a popup: accepts the structured {groups:[…]} model or the legacy array. */
export function showMenu(spec, pos) { return openMenu(spec, pos); }
export function hideMenu() { closeMenu(); }

// -------------------------------------------------------- progress
export async function runJob(title, runFn, footLabel = 'Cancel') {
  const d = dlg(title, {}, { width: 640 });
  const st = el('div', 'prog-row');
  st.innerHTML = `<span>waiting…</span><span class="grow" style="flex:1"></span>`;
  const prog = el('div', 'prog'); const pbar = el('i'); prog.appendChild(pbar);
  d.body.appendChild(st); d.body.appendChild(prog);
  const log = el('div', 'cmdout'); log.hidden = true;
  d.body.appendChild(log);
  const cancel = btn(footLabel, 'danger', () => { if (currentJobId) window.x2.cancelSearch(currentJobId); jobCancelledFlag.cancelled = true; forceCancelled = true; }, d.foot);
  let currentJobId = '', forceCancelled = false;
  const jobCancelledFlag = { cancelled: false };
  const ctrl = {
    setProgress: (i, n) => { if (n > 0) { prog.style.width = Math.round(i / n * 100) + '%'; st.firstChild.textContent = `${i} / ${n}`; } },
    setLabel: t => { st.children[0].textContent = t; },
    setBar: p => { pbar.style.width = Math.round(p * 100) + '%'; },
    job(id) { currentJobId = id; return id; },
    get cancelled() { return forceCancelled || jobCancelledFlag.cancelled; },
    cancel() { jobCancelledFlag.cancelled = true; }
  };
  window.x2.onProgress((jobId, ...args) => {
    if (jobId !== currentJobId) return;
    const [a, b, c, d2] = args;
    if (a === 'hit') {
      log.hidden = false;
      log.textContent += fmtHit(c);
      ctrl.setBar(1);
      st.children[0].textContent = log.childElementCount + ' hits…';
    } else if (a === 'err') {
      log.hidden = false; log.textContent += 'error ' + c;
    } else {
      // generic progress from fs ops: (done, total, extra)
      if (typeof a === 'number' && typeof b === 'number' && b) { ctrl.setBar(a / b); st.children[0].textContent = `${a}/${b}${c ? ' · ' + fmtSize(c) : ''}`; }
      else ctrl.setLabel(String(a));
    }
  });
  function fmtHit(hit) {
    return `${hit.path}\n  hit: ${hit.hit}\n  …${(hit.context || '').slice(0, 140)}\n`;
  }
  try {
    const r = await runFn(ctrl);
    pbar.style.width = '100%';
    st.children[0].textContent = 'done';
    if (!log.hidden) { btn('Close', 'primary', d._close, d.foot); keepOpen = true; }
    else { setTimeout(d._close, 350); }
    void keepOpen; var keepOpen;
  } catch (e) {
    st.children[0].textContent = 'error: ' + (e.message || e);
    btn('Close', 'primary', d._close, d.foot);
  } finally { void 0; }
  void cancel;
  return d;
}

// -------------------------------------------------------- copy/move
export async function copyDialog(app, mode = 'copy') {
  // mode: copy|move, F5 base behavior
  return new Promise(res => {
    const sel = app.active.view.selected().length ? app.active.view.selected() : null;
    const d = dlg(mode === 'move' ? 'Move' : 'Copy', {}, { width: 620, icon: mode === 'move' ? 'scissors' : 'copy' });
    const srcDir = app.active.cwd();
    d.body.innerHTML = `
      <div class="field"><label class="ctl" style="flex:2">Files (${sel ? sel.length : 0} selected from <b>${esc(srcDir)}</b>)</label></div>
      <div class="field"><label>Destination</label><div class="rrow" style="flex:1">
        <input id="cd-dst" class="chr-input" value="${esc(app.otherOf(app.active).cwd())}">
        <button class="chr-btn" id="cd-browse">Browse…</button>
        <button class="chr-btn" id="cd-other">Other pane</button>
        <button class="chr-btn" id="cd-tab">Active tab</button>
      </div></div>
      <div class="field"><label>Overwrite rule</label><div class="rrow" id="cd-over">
        ${overRadio('overwrite', 'Overwrite')}
        ${overRadio('skipOlder', 'Overwrite if newer (backup)', true)}
        ${overRadio('skipNewer', 'Skip if newer')}
        ${overRadio('renameConflicts', 'Rename conflicts')}
        ${overRadio('ask', 'Ask me')}
      </div></div>
      <div class="field"><label>Filter (wildcards, ; separated, optional)</label><input id="cd-filter" class="chr-input" placeholder="*.jpg;*.png"></div>
      <div class="rrow">
        <label class="chr-check" style="flex:1"><input type="checkbox" id="cd-struct" checked> Preserve folder structure</label>
        <label class="chr-check"><input type="checkbox" id="cd-errors" checked> Continue on errors</label>
        <label class="chr-check"><input type="checkbox" id="cd-log"> Save log</label>
      </div>`;
    const foot = d.foot;
    const ok = btn(mode === 'move' ? 'Move' : 'Copy', 'primary', () => go(), foot);
    btn('Cancel', '', d._close, foot);
    function overRadio(v, label, checked) { return `<label class="chr-check"><input type="radio" name="cd-over" value="${v}" ${checked ? 'checked' : ''}>${label}</label>`; }
    $('#cd-other', d.el).onclick = () => $('#cd-dst', d.el).value = app.otherOf(app.active).cwd();
    $('#cd-browse', d.el).onclick = async () => { app.pickDirAct(cur => $('#cd-dst', d.el).value = cur); };
    $('#cd-tab', d.el).onclick = async () => {
      const r = await window.x2.pick('directory', { title: 'Target' });
      if (!r.canceled && r.filePaths[0]) $('#cd-dst', d.el).value = r.filePaths[0];
    };
    async function go() {
      const entries = sel || app.active.view.view;
      const dst = $('#cd-dst', d.el).value.trim(); if (!dst) return;
      const over = document.querySelector('input[name=cd-over]:checked').value;
      if (over === 'ask') {
        // pre-scan conflicts
        const conflicts = [];
        for (const s of entries.map(e => ({ src: e.path, name: e.name, isDir: e.isDir }))) {
          const dp = dst + '\\' + s.name;
          if (await app.fsExists(dp)) conflicts.push(s.name);
        }
        if (conflicts.length) {
          const res = await window.x2.msgBox({ type: 'question', buttons: ['Overwrite', 'Skip all', 'Rename', 'Cancel'], title: 'Overwrite files?', message: `${conflicts.length} file(s) already exist at destination.\nFirst: ${conflicts[0]}` });
          if (res.response === 3) { d._close(); return; }
          if (res.response === 1) $('#cd-over input[value=skipOlder]', d.el).checked = true;
          else if (res.response === 2) $('#cd-over input[value=renameConflicts]', d.el).checked = true;
        }
      }
      const ovEl = document.querySelector('#_xinput[name=cd-over]:checked') || document.querySelector('input[name=cd-over]:checked');
      const over2 = ovEl ? ovEl.value : 'overwrite';
      d._close();
      await app.doTransfer(entries, dst, {
        move: mode === 'move',
        overwrite: over2 === 'overwrite',
        skipOlder: over2 === 'skipOlder',
        skipNewer: over2 === 'skipNewer',
        renameConflicts: over2 === 'renameConflicts',
        keepStruct: $('#cd-struct', d.el).checked,
        continueOnError: $('#cd-errors', d.el).checked,
        filter: $('#cd-filter', d.el).value
      }, { title: mode === 'move' ? 'Moving' : 'Copying' });
      const lg = $('#cd-log', d.el)?.checked;
      void lg;
    }
  });
}

// -------------------------------------------------------- mass rename
export async function massRenameDialog(app) {
  const sel = app.active.view.selected();
  if (!sel.length) { app.toast('Select files first'); return; }
  return new Promise(res => {
    const d = dlg('Mass rename', {}, { width: 820, icon: 'wand' });
    d.body.innerHTML = `
      <div class="field"><label>Pattern</label><div class="rrow" style="flex:2"><input id="mr-p" class="chr-input" placeholder="use # counter, or leave to use replace" value="#"></div></div>
      <div class="rrow">
        <div class="field"><label>Start #</label><input id="mr-start" class="chr-input" type="number" value="1" style="width:80px"></div>
        <div class="field"><label>Step</label><input id="mr-step" class="chr-input" type="number" value="1" style="width:80px"></div>
        <div class="field"><label>Case</label><select id="mr-case" class="chr-input"><option>keep</option><option>lower</option><option>UPPER</option><option>Title</option></select></div>
      </div>
      <div class="rrow">
        <div class="field" style="flex:2"><label>Search</label><input id="mr-search" class="chr-input" placeholder="find text (regex allowed)"></div>
        <div class="field" style="flex:2"><label>Replace</label><input id="mr-replace" class="chr-input" placeholder="with… ($1 groups work)"></div>
        <label class="chr-check"><input type="checkbox" id="mr-regex"> regex</label>
        <label class="chr-check"><input type="checkbox" id="mr-useDate"> prefix with date</label>
      </div>
      <div class="scroll-tbl"><table class="tbl"><thead><tr><th>Old</th><th></th><th>New</th></tr></thead><tbody id="mr-tb"></tbody></table></div>
      <div class="row-item-count" id="mr-stat"></div>`;
    btn('Apply', 'primary', go, d.foot); btn('Cancel', '', d._close, d.foot);
    const tb = $('#mr-tb', d.el);
    function preview() {
      tb.innerHTML = '';
      let c = parseInt($('#mr-start', d.el).value || 1, 10);
      const step = parseInt($('#mr-step', d.el).value || 1, 10);
      const search = $('#mr-search', d.el).value;
      const replace = $('#mr-replace', d.el).value;
      const rx = $('#mr-regex', d.el).checked;
      const useDate2 = $('#mr-useDate', d.el).checked;
      const casE = $('#mr-case', d.el).value;
      const patt = $('#mr-p', d.el).value;
      let changes = 0;
      for (const e of sel) {
        let ext = e.isDir ? '' : (e.name.lastIndexOf('.') > 0 ? e.name.slice(e.name.lastIndexOf('.')) : '');
        let base = e.isDir ? e.name : e.name.slice(0, e.name.length - ext.length);
        let nb = base;
        if (patt && patt.includes('#')) {
          nb = patt.replace(/(#+)/, m => String(c).padStart(m.length, '0'));
          c += step;
        } else if (patt) nb = patt;
        else if (search) {
          if (rx) { try { nb = base.replace(new RegExp(search, 'g'), replace); } catch { } }
          else nb = base.split(search).join(replace);
        }
        if (useDate2) {
          const dt = new Date(e.mtimeMs || Date.now());
          const p = n => String(n).padStart(2, '0');
          nb = `${dt.getFullYear()}${p(dt.getMonth() + 1)}${p(dt.getDate())}_` + nb;
        }
        if (casE === 'lower') nb = nb.toLowerCase();
        else if (casE === 'UPPER') nb = nb.toUpperCase();
        else if (casE === 'Title') nb = nb.replace(/(^|\\W)([a-z])/g, (m, a, b) => a + b.toUpperCase());
        const old = e.name, nw = nb + ext + (e.isDir ? '' : '');
        const tr = el('tr');
        tr.innerHTML = `<td>${esc(old)}</td><td>→</td><td style="color:${old !== nw ? 'var(--accent2)' : ''}">${esc(nw)}</td>`;
        if (old !== nw) changes++;
        tb.appendChild(tr);
      }
      $('#mr-stat', d.el).textContent = `${changes} of ${sel.length} would change`;
    }
    ['input', 'change'].forEach(ev => d.body.addEventListener(ev, preview, true));
    preview();
    async function go() {
      // collect mapping {from, to}, run renames with progress
      const rows = $$('#mr-tb tr', d.el);
      const map = [];
      sel.forEach((e, i) => {
        const nw = rows[i].cells[2].textContent;
        if (nw !== e.name) map.push({ from: e.path, to: e.path.replace(/\\[^\\]+$/, '\\' + nw) });
      });
      d._close();
      await runJob('Renaming', async ctrl => {
        let i = 0;
        for (const m of map) {
          ctrl.setBar(i / Math.max(1, map.length));
          ctrl.setLabel(`renaming ${++i}/${map.length}: ` + m.to.split('\\').pop());
          try { await window.x2.rename(m.from, m.to); } catch (e) { app.toast('Failed: ' + e.message, 'err'); }
        }
      });
      await app.active.refresh(); app.active.app.toast(`${map.length} renamed`, 'ok');
    }
  });
}

// -------------------------------------------------------- timestamps/attributes dialog
export async function propsDialog(app, entry, listSel) {
  const items = listSel && listSel.length ? listSel : [entry];
  const e0 = items[0];
  const d = dlg(items.length > 1 ? `Properties — ${items.length} items` : 'Properties', {}, { width: 560, icon: 'info' });
  d.body.innerHTML = `
    <div class="rrow"><b style="flex:1">${esc(e0.name)}${items.length > 1 ? ` (+${items.length - 1})` : ''}</b><span style="color:var(--text-dim)">${fmtSize(e0.isDir ? 0 : e0.size)}</span></div>
    <div class="rrow" style="gap:14px">
      <div class="field"><label>Modified</label><div class="rrow"><input type="date" id="pr-md" class="chr-input" style="width:130px"><input type="time" id="pr-mt" class="chr-input" style="width:110px"></div></div>
      <div class="field"><label>Created</label><div class="rrow"><input type="date" id="pr-cd" class="chr-input" style="width:130px"><input type="time" id="pr-ct" class="chr-input" style="width:110px"></div></div>
    </div>
    <div class="rrow">
      <div class="field" style="flex:2"><label>Shift (days):hours:minutes</label><input id="pr-shift" class="chr-input" placeholder="+1; or -0.5"></div>
      <button class="chr-btn" id="pr-apply-shift">Shift</button>
      <button class="chr-btn" id="pr-apply-set">Set exact</button>
    </div>
    <div class="rrow">${['readonly', 'hidden', 'system', 'archive'].map(a => `<label class="chr-check"><input type="checkbox" id="pr-${a}"> ${a}</label>`).join('')}</div>
    <div class="rrow"><button class="chr-btn" id="pr-attrib">Apply attributes</button></div>
    <div class="rrow" id="pr-extra" style="font-size:11px;color:var(--text-dim);align-items:flex-start"></div>`;
  btn('Close', '', d._close, d.foot);
  const applyDate = (type) => {
    const di = $(`#pr-${type === 'modified' ? 'md' : 'cd'}`, d.el).value;
    const ti = $(`#pr-${type === 'modified' ? 'mt' : 'ct'}`, d.el).value;
    if (!di || !ti) return;
    return new Date(di + 'T' + ti).getTime();
  };
  $('#pr-apply-shift', d.el).onclick = async () => {
    let delta = 0;
    const s = $('#pr-shift', d.el).value.trim();
    if (!s) return;
    if (/^[+-]/.test(s)) {
      const days = parseFloat(s.slice(1));
      delta = days * 24 * 3600e3 * (s[0] === '-' ? 1 : 1);
      if (s[0] === '-') delta = -delta;
    }
    await runJob('Shifting timestamps', async c => {
      let i = 0;
      for (const e of items) {
        c.setBar(++i / items.length);
        try { await window.x2.setTimes(e.path, (e.mtimeMs || Date.now()) + delta, e.ctimeMs || e.mtimeMs); } catch (err) { }
      }
    });
    app.active.refresh();
  };
  $('#pr-apply-set', d.el).onclick = async () => {
    const m = applyDate('modified'), c2 = applyDate('created');
    if (!m) { app.toast('Set both date+time first', 'err'); return; }
    await runJob('Setting timestamps', async c => {
      let i = 0;
      for (const e of items) { c.setBar(++i / items.length); try { await window.x2.setTimes(e.path, m, c2 || m); } catch { } }
    });
    app.active.refresh();
  };
  $('#pr-attrib', d.el).onclick = async () => {
    const attrs = [];
    for (const a of ['R', 'H', 'S', 'A']) {
      const el2 = $(`#pr-${a.toLowerCase()}`, d.el);
      if (el2?.checked) attrs.push('+' + a); else if (el2) attrs.push('-' + a);
    }
    // Only apply explicitly checked
    const set = [];
    for (const a of ['R', 'H', 'S', 'A']) { const el2 = $(`#pr-${a.toLowerCase()}`, d.el); if (el2?.checked) set.push('+' + a); }
    const clear = [];
    for (const a of ['R', 'H', 'S', 'A']) { if (!$(`#pr-${a.toLowerCase()}`, d.el).checked) clear.push('-'); }
    // apply via attrib
    for (const e of items) {
      const ats = [];
      for (const [a, id] of [['r', 'pr-readonly'], ['h', 'pr-hidden'], ['s', 'pr-system'], ['a', 'pr-archive']]) {
        const v = $(`#${id}`, d.el);
        if (v) ats.push((v.checked ? '+' : '-') + a.toUpperCase());
      }
      try {
        const { shell } = window; void shell;
        await window.x2.runCommand(e.path.split('\\')[0] + '\\', '');
        // Use attrib through a cmd line via main shell:run with capture
        await window.x2.setAttr(e.path, ats.join(' '));
      } catch (err) { app.toast('attrib failed on ' + e.name, 'err'); }
    }
    app.active.refresh();
  };
  // extra info
  const extra = $('#pr-extra', d.el);
  extra.innerHTML = `path: <span>${esc(e0.path)}</span><br>created ${fmtDate(e0.ctimeMs)} · modified ${fmtDate(e0.mtimeMs)} · accessed ${fmtDate(e0.atimeMs)}`;
  const csRow = el('div', 'rrow'); extra.appendChild(csRow);
  const csBtn = el('button', 'chr-btn', 'Compute SHA256');
  on(csBtn, 'click', async () => {
    const h = await window.x2.hash(e0.path, 'sha256');
    csRow.innerHTML = `<span style="font-family:monospace;word-break:break-all">${esc(h)}</span>`;
  });
  csRow.appendChild(csBtn);
}

// -------------------------------------------------------- split/merge
export async function splitDialog(app) {
  const sel = app.active.view.selected().find(e => !e.isDir);
  if (!sel) { app.toast('Select a file to split'); return; }
  const d = dlg('Split file', {}, { width: 480, icon: 'split' });
  d.body.innerHTML = `
    <div class="rrow"><b style="flex:1">${esc(sel.name)} (${fmtSize(sel.size)})</b></div>
    <div class="rrow">
      <div class="field" style="flex:1"><label>Chunk size MB</label><input id="sp-mb" class="chr-input" type="number" value="10" style="width:90px"></div>
      <div class="field" style="flex:2"><label>Output folder</label><input id="sp-out" class="chr-input" style="flex:1" value="${esc(app.active.cwd())}"></div>
    </div>`;
  btn('Split', 'primary', async () => {
    const mb = +$('#sp-mb', d.el).value || 10;
    const out = $('#sp-out', d.el).value;
    d._close();
    await runJob('Splitting', async c => {
      const r = await window.x2.split(sel.path, mb, out, c.job('sp'));
      void r;
    });
    app.toast('Split done', 'ok');
    app.active.refresh();
  }, d.foot);
  btn('Cancel', '', d._close, d.foot);
}
export async function mergeDialog(app) {
  const sel = app.active.view.selected().filter(e => !e.isDir && /__\d+\.(|\d\d\d)?$/.test(e.name) || /__\d{3}$/.test(e.name.replace(/\.[^.]+$/, '')));
  if (sel.length < 2) { app.toast('Select split parts first'); return; }
  const base = sel[0].name.split('__')[0];
  const d = dlg('Merge parts', {}, { width: 420, icon: 'merge' });
  d.body.innerHTML = `<div class="rrow">Merging ${sel.length} parts of <b>${esc(base)}</b></div>`;
  btn('Merge', 'primary', async () => {
    const out = app.active.cwd() + '\\' + base.replace(/(\.[^.*$]+)$/, '') + '__merged' + (base.match(/\.[^.]+$/) || [''])[0];
    d._close();
    await runJob('Merging', async c => { await window.x2.merge(sel.map(s => s.path), out, c.job('mg')); });
    app.toast('Merged to ' + out, 'ok');
    app.active.refresh();
  }, d.foot);
  btn('Cancel', '', d._close, d.foot);
}

// -------------------------------------------------------- duplicates
export async function dupesDialog(app, presetRoots) {
  return new Promise(res => {
    const d = dlg('Duplicate finder', {}, { width: 760, icon: 'layers' });
    d.body.innerHTML = `
      <div class="rrow"><label class="fl" style="flex:1">Folders (one per line)<textarea id="du-roots" rows="3">${esc((presetRoots || [app.active.cwd()]).join('\n'))}</textarea></label></div>
      <div class="rrow">
        <label><input type="checkbox" id="du-name" checked> Same name</label>
        <label><input type="checkbox" id="du-size"> Same size</label>
        <label><input type="checkbox" id="du-date"> Same date</label>
        <label><input type="checkbox" id="du-content"> Same content (slower, more accurate)</label>
      </div>
      <div class="scroll-tbl"><table class="tbl"><thead><tr><th style="width:22px"></th><th>Group</th><th>Name</th><th>Folder</th><th>Size</th></tr></thead><tbody id="du-tb"></tbody></table></div>
      <div class="row-item-count" id="du-stat"></div>`;
    btn('Find duplicates', 'primary', find, d.foot);
    btn('Keep first in each group', 'btn0', keepFirst, d.foot);
    btn('Delete selected', 'danger', delSel, d.foot);
    btn('Close', '', d._close, d.foot);
    let groups = [];
    async function find() {
      const roots = $('#du-roots', d.el).value.split(/\n+/).map(s => s.trim()).filter(Boolean);
      const opts = { matchName: $('#du-name', d.el).checked, matchSize: $('#du-size', d.el).checked, matchDate: $('#du-date', d.el).checked, contentHash: $('#du-content', d.el).checked };
      if (opts.contentHash && !opts.matchSize) { opts.matchSize = false; }
      const jd = app.newJobId();
      const tbi = $('#du-tb', d.el); tbi.innerHTML = '';
      const statEl = $('#du-stat', d.el);
      let scanned = 0;
      const progFn = window.x2.onProgress((id, a, b) => {
        if (id !== jd) return;
        if (typeof a === 'number') scanned = a;
        statEl.textContent = `scanning… ${scanned}`;
      });
      const r = await window.x2.findDuplicates(roots, opts, jd);
      window.x2.onProgress(() => { void 0; });
      void progFn;
      groups = r.groups || [];
      render();
    }
    function render() {
      const tb = $('#du-tb', d.el); tb.innerHTML = '';
      let n = 0;
      groups.forEach((g, gi) => {
        const gh = el('tr');
        gh.innerHTML = `<td></td><td colspan="4" style="color:var(--text-dim)">Group ${gi + 1}</td>`;
        // select all but one by default
        tb.appendChild(gh);
        g.forEach((f, fi) => {
          n++;
          const tr = el('tr');
          const ckb = document.createElement('input'); ckb.type = 'checkbox';
          if (fi > 0) ckb.checked = true;
          const td0 = el('td'); td0.appendChild(ckb);
          tr.appendChild(td0);
          const td1 = el('td', '', '#');
          td1.style.color = 'var(--text-dim)';
          tr.appendChild(td1);
          tr.innerHTML += `<td>${esc(f.name)}</td><td style="color:var(--text-dim)">${esc(f.path.split('\\').slice(0, -1).join('\\'))}</td><td>${fmtSize(f.size)}</td>`;
          tr.querySelector('td input').addEventListener('change', () => void 0);
          void tr;
          tb.appendChild(tr);
        });
      });
      $('#du-stat', d.el).textContent = `${groups.length} group(s), ${n} files`;
    }
    function keepFirst() {
      // leave at least one per group
      groups.forEach(g => {
        let first = true;
        g.forEach(f => {
          if (first) { first = false; return; }
          // ensure one survivor
        });
        if (g.length) first = false;
        if (first) return;
        let kept = 0;
        g.forEach(f => {
          if (kept === 0) { kept++; return; }
          if (!f.path) return;
        });
        let first2 = true;
        g.forEach(f => {
          if (first2) { first2 = false; return; }
          // auto-mark the rest (handled by UI with input change; we trigger deletion directly)
          g.forEach(() => { });
          // mark via collection handled below
        });
      });
      // simpler: set checkboxes of all but first
      groups.forEach(g => {
        if (g.length < 2) return;
        firstkeep(g);
      });
      render();
      app.toast('Duplicates except first of each group are marked');
      function firstkeep() { }
    }
    function delSel() {
      const paths = $$('#du-tb input:checked', d.el).map(c => c.closest('tr'));
      const all = [];
      groups.forEach(g => {
        g.forEach((f, fi) => {
          const rowIdx = null;
        });
      });
      // simpler: track rows
      const rm = [];
      $$('#du-tb input:checked', d.el).forEach(inp => {
        const tr = inp.closest('tr');
        const name = tr.cells[2].textContent, folder = tr.cells[3].textContent;
        const rg = groups.flatMap(g => g).find(f => f.name === name && f.path.startsWith(folder));
        if (rg) rm.push(rg.path);
      });
      d._close();
      app.doDelete(rm, false);
    }
  });
}

// -------------------------------------------------------- search dialog
export async function searchDialog(app) {
  return new Promise(res => {
    const d = dlg('Omni-finder', {}, { width: 720, icon: 'search' });
    d.body.innerHTML = `
      <div class="rrow"><label class="fl" style="flex:1">Folders (one per line; empty = current)<textarea id="se-roots" rows="2"></textarea></label>
      <label style="display:flex;align-items:center;gap:6px;padding-top:16px"><input type="checkbox" id="se-sub" checked> include subfolders</label></div>
      <div class="rrow"><label class="fl" style="flex:2">Name (wildcard or regex)<input id="se-name" placeholder="*.png  or  re:^report_.*20\d+"></label>
      <label class="fl" style="flex:2">Contents contain <input id="se-text" placeholder="plain text, or type and pick"></label>
      <label style="padding-top:16px"><input type="checkbox" id="se-regex"> regex text</label></div>
      <div class="rrow">
        <label class="fl">Size ≥ MB <input id="se-min" style="width:80px" placeholder=""></label>
        <label class="fl">Size ≤ MB <input id="se-max" style="width:80px"></label>
        <label class="fl">Modified after <input type="date" id="se-newer" style="width:150px"></label>
        <label class="fl">Modified before <input type="date" id="se-older" style="width:150px"></label>
      </div>
      <div class="rrow"><label><input type="checkbox" id="se-empties"> find empty folders</label>
      <label class="grow" style="flex:1"></label><span id="se-live" style="color:var(--text-dim);font-size:11px"></span></div>
      <div class="scroll-tbl"><table class="tbl"><thead><tr><th>Name</th><th>Folder</th><th>Size</th><th>Modified</th></tr></thead><tbody id="se-tb"></tbody></table></div>`;
    btn('Search', 'primary', go, d.foot);
    btn('Send results to scrap', 'cb', toScrap, d.foot);
    btn('Close', '', d._close, d.foot);
    $('#se-roots', d.el).value = app.active.cwd();
    let hits = [];
    async function go() {
      const roots = $('#se-roots', d.el).value.split(/\n+/).map(s => s.trim()).filter(Boolean);
      if (!roots.length) return;
      const name = $('#se-name', d.el).value.trim();
      const isRegexName = name.startsWith('re:');
      const text = $('#se-text', d.el).value.trim();
      const minSize = (parseFloat($('#se-min', d.el).value) || 0) * 1024 * 1024;
      const maxSize = (parseFloat($('#se-max', d.el).value) || 0) * 1024 * 1024;
      const newer = $('#se-newer', d.el).value;
      const older = $('#se-older', d.el).value;
      const empties = $('#se-empties', d.el).checked;
      const tb = $('#se-tb', d.el); tb.innerHTML = '';
      hits = []; let last = 0;
      const jd = app.newJobId();
      let liveN = 0;
      const upd = (a) => {
        if (a > last) { last = a; $('#se-live', d.el).textContent = `scanned ${a}`; }
      };
      const unsub = app.onJobProgress(jd, (a, b, c, dd) => {
        if (a === 'hit' && c) {
          hits.push(c);
          const tr = el('tr'); tr.style.cursor = 'pointer';
          const pname = c.path;
          tr.innerHTML = `<td>${esc(c.name)}${c.hit ? ' <span class="fuzzy-hl">◎</span>' : ''}</td><td style="color:var(--text-dim)">${esc(pname.slice(0, pname.length - c.name.length - 1))}</td><td>${fmtSize(c.size)}</td><td>${fmtDate(c.mtimeMs)}</td>`;
          tr.title = c.context || '';
          tr.addEventListener('dblclick', () => { app.openPath(pname); });
          tb.appendChild(tr);
        } else upd(typeof a === 'number' ? a : 0);
      });
      if (empties) {
        // quick walk for empty dirs
        await runJob('Empty folders', async c => { c.setLabel('scanning'); const r = await app.findEmptyDirs(roots[0]); r.forEach(p => { hits.push({ path: p, name: p.split('\\').pop(), isDir: true, size: 0 }); const tr = el('tr'); tr.innerHTML = `<td><span class="ic-cell"></span> ${esc(p.split('\\').pop())}</td><td style="color:var(--text-dim)">${esc(p)}</td><td></td><td></td>`;
          tr.querySelector('.ic-cell')?.appendChild(icon('folder', 13)); tr.ondblclick = () => app.nav(app.active, p); tb.appendChild(tr); }); });
        return;
      }
      try {
        const r = await window.x2.search(roots, {
          filter: isRegexName ? name.slice(3) : (name || null),
          regexName: isRegexName,
          text: text || null,
          regex: $('#se-regex', d.el).checked,
          minSize, maxSize, newerThan: newer, olderThan: older,
          recursive: $('#se-sub', d.el).checked
        }, jd);
        $('#se-live', d.el).textContent = `done — ${hits.length} hits in ${roots.length} root(s)`;
      } finally { unsub(); }
    }
    async function toScrap() {
      const items = hits.map(h => ({ path: h.path, name: h.name, isDir: !!h.isDir, size: h.size || 0, mtimeMs: h.mtimeMs }));
      app.scrap.add(items);
      d._close();
    }
  });
}

// -------------------------------------------------------- compare/sync
export async function compare(app, mode = 'diffs') {
  const L = app.paneL, R = app.paneR;
  const lmap = indexBy(L.view.entries), rmap = indexBy(R.view.entries);
  L.view.markSet.clear(); R.view.markSet.clear();
  const cmpSize = true;
  const keys = new Set([...lmap.keys(), ...rmap.keys()]);
  for (const k of keys) {
    const le = lmap.get(k), re = rmap.get(k);
    if (!le) { R.view.markSet.set(k, 'm-r'); continue; }
    if (!re) { L.view.markSet.set(k, 'm-l'); continue; }
    if (le.isDir && re.isDir) continue;
    if (cmpSize && le.size !== re.size) {
      const newer = le.mtimeMs > re.mtimeMs;
      L.view.markSet.set(k, newer ? 'm-up' : 'm-both');
      R.view.markSet.set(k, newer ? 'm-both' : 'm-up');
    }
  }
  L.view.render(); R.view.render();
  const n = L.view.markSet.size + R.view.markSet.size;
  if (mode === 'sync') await syncMarked(app);
  app.toast(n ? `${n} difference(s) marked (colors in lists)` : 'Panets identical', 'ok');
}
function indexBy(entries) {
  // must match util.keyOfEntry() or the compare marks never match a rendered row
  const m = new Map();
  for (const e of entries) m.set(keyOfEntry(e), e);
  return m;
}
export async function syncMarked(app) {
  // copy marked differences right->left or left->right
  const L = app.paneL, R = app.paneR;
  const dir = await new Promise(res => {
    const d = dlg('Sync panes', {}, { width: 420, icon: 'git-compare' });
    d.body.innerHTML = `<div class="rrow">Copy differences in which direction?</div>`;
    btn('<- replace left', 'primary', () => { d._close(); res('l'); }, d.foot);
    btn('replace right ->', 'primary', () => { d._close(); res('r'); }, d.foot);
    btn('Cancel', '', () => { d._close(); res(null); }, d.foot);
  });
  if (!dir) return;
  const srcPane = dir === 'l' ? R : L;
  const dstPane = dir === 'l' ? L : R;
  const items = srcPane.view.view.filter(e => (dir === 'l' ? R.view.markSet : L.view.markSet).get(e.name.toLowerCase() + (e.isDir ? '\\' : '/')));
  if (!items.length) return;
  await app.doTransfer(items, dstPane.cwd(), { move: false, overwrite: true, skipOlder: false, filter: '' }, { title: 'Syncing' });
}

// -------------------------------------------------------- archive extract
export async function extractArchiveDialog(app, apath, ext, entries) {
  const d = dlg('Extract archive', {}, { width: 520, icon: 'file-archive' });
  d.body.innerHTML = `
    <div class="rrow"><b style="flex:1">${esc(apath)}</b></div>
    <div class="field"><label>Destination</label><div class="rrow" style="flex:1"><input id="aex-dst" class="chr-input" style="flex:1" value="${esc(app.active.cwd() || 'C:\\')}"><button class="chr-btn" id="aex-b">Browse…</button></div></div>`;
  btn('Extract', 'primary', async () => {
    const dst = $('#aex-dst', d.el).value;
    d._close();
    await runJob('Extracting', async c => {
      const r = await window.x2.extractArchive(apath, ext, dst, [], c.job('aex'));
      void r;
    });
    app.toast('Extracted to ' + dst, 'ok');
  }, d.foot);
  btn('Cancel', '', d._close, d.foot);
  $('#aex-b', d.el).onclick = () => app.pickDirAct(p => $('#aex-dst', d.el).value = p);
}

// -------------------------------------------------------- editor
export async function editorDialog(app, filePath) {
  if (!filePath) return;
  const r = await app.readText(filePath);
  if (!r) return;
  const d = dlg('editor² — ' + filePath.split('\\').pop(), {}, { width: 900, icon: 'file-text' });
  d.body.style.display = 'flex'; d.body.style.flexDirection = 'column';
  const ta = document.createElement('textarea');
  ta.className = 'chr-input';
  ta.style.cssText = 'min-height:44vh;flex:1;font-family:ui-monospace,Cascadia,monospace;font-size:12px;white-space:pre;resize:none;overflow:auto';
  ta.value = r.text;
  ta.spellcheck = false;
  d.body.appendChild(ta);
  const stat = el('div', 'row-item-count', `${r.encoding} · ${fmtSize(r.size)}${r.truncated ? ' (first 2MB loaded)' : ''}`);
  d.body.appendChild(stat);
  const save = btn('Save', 'primary', async () => {
    await window.x2.writeText(filePath, ta.value);
    app.toast('Saved ' + filePath, 'ok');
  }, d.foot);
  btn('Close', '', d._close, d.foot);
  ta.focus();
}

// -------------------------------------------------------- settings
export async function settingsDialog(app) {
  const d = dlg('Settings', {}, { width: 560, icon: 'settings' });
  const prefs = app.prefs;
  d.body.innerHTML = `
    <div class="rrow">
      <div class="field"><label>Theme</label><select id="st-theme" class="chr-input"><option value="dark">Dark</option><option value="light">Light</option></select></div>
      <div class="field"><label>Accent</label><input id="st-accent" type="color" class="chr-input" value="${prefs.accent || '#4cc2ff'}"></div>
    </div>
    <div class="field" style="flex:1"><label>Default columns (comma-sep: name,size,type,mtimeMs,ctimeMs,attr,dim)</label><input id="st-cols" class="chr-input" value="${prefs.columns?.join(',') || 'name,size,type,mtimeMs'}"></div>
    <div class="rrow">${['Confirm before delete', 'Sticky selection', 'Checkbox selection', 'Mirror browse'].map((v, i) => `<label class="chr-check"><input type="checkbox" id="st-${ ['confirm','sticky','ckb','mirror'][i] }"> ${v}</label>`).join('')}</div>
    <div class="field" style="flex:3"><label>ZIP handling</label><select id="st-zip" class="chr-input"><option value="browse">Browse into archive</option><option value="open">Open with system tool</option></select></div>
    <div class="rrow" style="flex-direction:column;gap:4px">
      <button class="chr-btn" id="st-portable">Portable mode: ${app.portable ? 'ON (settings beside exe)' : 'off (enable)'}</button>
      <button class="chr-btn" id="st-keys">Keyboard shortcuts…</button>
      <button class="chr-btn" id="st-openflag">Open settings folder</button>
    </div>`;
  $('#st-theme', d.el).value = prefs.theme || 'dark';
  btn('Save', 'primary', async () => {
    prefs.theme = $('#st-theme', d.el).value;
    prefs.accent = $('#st-accent', d.el).value;
    prefs.columns = $('#st-cols', d.el).value.split(',').map(s => s.trim()).filter(Boolean);
    prefs.confirmDelete = $('#st-confirm', d.el).checked;
    prefs.stickySelection = $('#st-sticky', d.el).checked;
    prefs.checkboxSelection = $('#st-ckb', d.el).checked;
    prefs.mirrorBrowse = $('#st-mirror', d.el).checked;
    prefs.zipMode = $('#st-zip', d.el).value;
    Object.entries(prefs).forEach(([k, v]) => pref(k, v));
    d._close();
    app.reloadTheme();
    app.toast('Settings saved', 'ok');
  }, d.foot);
  btn('Cancel', '', d._close, d.foot);
  $('#st-portable', d.el).onclick = async () => {
    await window.x2.togglePortable();
    app.toast('Reopen app for portable mode to take effect', 'ok');
  };
  $('#st-openflag', d.el).onclick = () => window.x2.openSettingsFolder();
  $('#st-keys', d.el).onclick = () => app.showShortcuts();
}

// -------------------------------------------------------- folder stats (pie)
export async function folderStatsDialog(app) {
  const dir = app.active.cwd();
  const entries = app.active.view.entries.filter(e => e.isDir);
  await runJob('Calculating sizes', async c => {
    c.setLabel('calculating…');
    const cache = new Map();
    let i = 0;
    for (const e of entries) {
      i++; c.setBar(i / Math.max(1, entries.length));
      const r = await window.x2.treeStat(e.path, c.job('ts' + i));
      app.active.view.sizes.set(e.path, r);
    }
    app.active.sort(); app.active.render(); app.active.pane.drawFoot();
  });
  // pie dialog
  const d = dlg(`Disk usage — ${dir}`, {}, { width: 640 });
  d.body.innerHTML = `<div class="rrow"><canvas id="fs-cv" width="280" height="280" style="flex:none"></canvas><div id="fs-list" style="flex:1;max-height:40vh;overflow:auto"></div></div>`;
  btn('Close', '', d._close, d.foot);
  const cv = $('#fs-cv', d.el);
  const ctx = cv.getContext('2d');
  const items = app.active.view.sizes.size ? [...app.active.view.sizes.entries()].map(([p, s]) => ({ p, s: s.size })) : app.active.view.entries.filter(e => !e.isDir).map(e => ({ p: e.path, s: e.size }));
  items.sort((a, b) => b.s - a.s);
  const total = items.reduce((a, b) => a + b.s, 0) || 1;
  let a0 = -Math.PI / 2;
  const colors = ['#4cc2ff', '#7ee0a3', '#ffb454', '#ff6b6b', '#b18cff', '#6be7e7', '#f7a0e4', '#a0f7c0', '#f7d0a0', '#c0a0f7'];
  const list = $('#fs-list', d.el);
  items.forEach((it, i) => {
    const a1 = a0 + (it.s / total) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(140, 140);
    ctx.arc(140, 140, 130, a0, a1);
    ctx.fillStyle = colors[i % colors.length]; ctx.fill();
    a0 = a1;
    const row = el('div', 'rrow', `<span style="width:12px;height:12px;border-radius:3px;background:${colors[i % colors.length]};flex:none"></span><span style="flex:1;overflow:hidden;text-overflow:ellipsis">${esc(it.p.split('\\').pop())}</span><b>${fmtSize(it.s)}</b><span style="color:var(--text-dim)">${Math.round(it.s / total * 100)}%</span>`);
    row.style.gap = '10px';
    list.appendChild(row);
  });
  const note = el('div', 'row-item-count', `Total: ${fmtSize(total)} · ${items.length} child item(s)`);
  d.body.appendChild(note);
}

// -------------------------------------------------------- tags dialog
export async function tagsDialog(app) {
  return new Promise(res => {
    const d = dlg('Color tags & rules', {}, { width: 620, icon: 'tag' });
    d.body.innerHTML = `
      <div class="field" style="flex:1"><label>Tag selected file(s) with color</label><div class="rrow" id="tg-swatches"></div></div>
      <div class="field"><label>Rule list (name · pattern · color)</label></div>
      <div class="scroll-tbl"><table class="tbl"><thead><tr><th></th><th>Pattern</th><th>Color</th><th></th></tr></thead><tbody id="tg-rules"></tbody></table></div>
      <div class="rrow"><input id="tg-newpat" class="chr-input" placeholder="new pattern e.g. *.log" style="flex:2"><input id="tg-newcol" type="color" class="chr-input" value="#ffb454" style="width:46px;height:30px"><button class="chr-btn" id="tg-add">Add rule</button></div>`;
    btn('Done', 'primary', close, d.foot);
    function close() { d._close(); app.active.refresh(); }
    const swatches = $('#tg-swatches', d.el);
    const colors = ['7ee0a3', 'ffb454', 'ff6b6b', 'b18cff', '6be7e7', 'f7a0e4'];
    const sel = app.active.view.selected();
    for (const c of colors) {
      const b = el('button', 'btn', '');
      b.style.cssText = `background:#${c};width:28px;height:24px;border-radius:6px`;
      on(b, 'click', () => {
        for (const e of sel) { S.tagsByPath[e.path.toLowerCase()] = c; }
        persist();
        app.toast(sel.length + ' items tagged #' + c, 'ok');
        app.active.refresh();
      });
      swatches.appendChild(b);
    }
    if (!sel.length) swatches.appendChild(el('span', '', ' select files first'));
    const tb = $('#tg-rules', d.el);
    function renderRules() {
      S.tags = S.tags || []; S.personalRules = S.tags;
      tb.innerHTML = '';
      (app.prefs.personalRules || []).forEach((r, i) => {
        const tr = el('tr');
        tr.innerHTML = `<td></td><td>${esc(r.pat)}</td><td><input type="color" value="#${r.col}" style="width:40px;height:26px;border:none;background:none"></td><td><button class="chr-btn icon-only sm danger" title="Remove rule"></button></td>`;
        $('button', tr).appendChild(icon('close', 12));
        $('input[type=color]', tr).onchange = (ev) => { r.col = ev.target.value.slice(1); persist(); app.active.refresh(); };
        $('button', tr).onclick = () => { app.prefs.personalRules.splice(i, 1); persist(); renderRules(); app.active.refresh(); };
        tb.appendChild(tr);
      });
    }
    renderRules();
    $('#tg-add', d.el).onclick = () => {
      const pat = $('#tg-newpat', d.el).value; const col = $('#tg-newcol', d.el).value.slice(1);
      if (!pat) return;
      app.prefs.personalRules = (app.prefs.personalRules || []).concat([{ pat, col }]);
      persist(); renderRules(); app.active.refresh();
    };
  });
}

// -------------------------------------------------------- empty folder finder
export async function emptyDirsDialog(app, roots, paths) {
  const d = dlg(`Empty folders (${paths.length})`, {}, { width: 640 });
  d.body.innerHTML = `<div class="scroll-tbl"><table class="tbl"><thead><tr><th>Folder</th><th style="width:60px"></th></tr></thead><tbody id="ed-tb"></tbody></table></div>`;
  btn('Select all', '', () => { $$('#ed-tb input', d.el).forEach(c => { c.checked = true; }); }, d.foot);
  btn('Recycle selected', 'danger', async () => {
    const ps = $$('#ed-tb input:checked', d.el).map(c => c.dataset.p);
    d._close();
    await app.doDelete(ps, false);
  }, d.foot);
  btn('Close', '', d._close, d.foot);
  const tb = $('#ed-tb', d.el);
  for (const p of paths) {
    const tr = el('tr');
    tr.innerHTML = `<td><label style="display:flex;gap:6px"><input type="checkbox" data-p="${esc(p)}">${esc(p)}</label></td>`;
    tb.appendChild(tr);
  }
}
void emptyDirsDialog && void cls0 && void 0;
function cls0() { }
