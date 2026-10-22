// Xplorer² Modern — Electron main process
// Clean-room implementation of the xplorer2 Ultimate feature contract.
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Menu, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');
const zlib = require('zlib');

protocol.registerSchemesAsPrivileged([
  { scheme: 'x2file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

// ---------------------------------------------------------------- settings
const settingsPath = () => {
  // Portable mode: x2m-portable.flag beside the exe (or package folder) keeps settings local.
  const flagPath = path.join(path.dirname(process.execPath), app.isPackaged ? '' : path.join(__dirname, '..'), 'x2m-portable.flag');
  const portable = fs.existsSync(flagPath.replace(/\\+$/, '') + '') && fs.existsSync(path.join(path.dirname(process.execPath), 'x2m-portable.flag'));
  if (portable) return path.join(path.dirname(process.execPath), 'x2modern.json');
  return path.join(app.getPath('userData'), 'settings.json');
};

let settings = null;
async function loadSettings() {
  try {
    settings = JSON.parse(await fsp.readFile(settingsPath(), 'utf8'));
  } catch { settings = null; }
  if (!settings || typeof settings !== 'object') settings = {};
  if (!settings.version) settings.version = 1;
  for (const k of ['bookmarks', 'recent', 'folderGroups', 'toolbar', 'tags']) {
    if (!Array.isArray(settings[k])) settings[k] = [];
  }
  if (!settings.prefs || typeof settings.prefs !== 'object') settings.prefs = {};
  if (!settings.tagsByPath || typeof settings.tagsByPath !== 'object') settings.tagsByPath = {};
  if (!settings.tabs || typeof settings.tabs !== 'object') settings.tabs = {};
  return settings;
}
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const p = settingsPath();
    fsp.writeFile(p, JSON.stringify(settings, null, 2)).catch(() => {});
  }, 150);
}

// ---------------------------------------------------------------- helpers
const win = () => BrowserWindow.getAllWindows()[0];

// ---------------------------------------------- single instance + --open
// The "open folders with this app" verbs launch `"exe" --open "<folder>"`;
// a second process must hand the path to the running instance and quit.
const argvOpenPath = (() => {
  const i = process.argv.indexOf('--open');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else app.on('second-instance', (e, argv) => {
  const i = argv.indexOf('--open');
  const p = i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  const w = win();
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.focus();
  if (p) { try { w.webContents.send('app:openPath', p); } catch { /* renderer not ready */ } }
});

function isUnder(root, target) {
  root = path.resolve(root).toLowerCase();
  target = path.resolve(target).toLowerCase();
  return target === root || target.startsWith(root + path.sep);
}

function parseFilter(f) {
  if (!f || !f.trim()) return null;
  const src = f.trim().replace(/[.+^${}()[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*').replace(/\?/g, '.');
  try { return new RegExp('^' + src + '$', 'i'); } catch { return null; }
}
function matchAny(name, filterRe) {
  if (!filterRe) return true;
  return name.split(/[,; ]+/).some(p => { const re = parseFilter(p); return re ? re.test(name) : false; });
}

const TEXT_EXTS = new Set(['txt','md','log','json','xml','yml','yaml','ini','csv','tsv','js','ts','jsx','tsx','css','scss','html','htm','py','rb','php','java','c','cpp','h','cs','go','rs','sh','bat','cmd','ps1','sql','svg','conf','cfg','env','srt','gitignore','editorconfig','properties','toml']);
const IMG_EXTS = new Set(['png','jpg','jpeg','gif','bmp','webp','svg','ico','avif']);
const VID_EXTS = new Set(['mp4','mkv','webm','mov','avi','m4v','ogv']);
const AUD_EXTS = new Set(['mp3','wav','ogg','flac','m4a','aac','opus']);
const PDF_EXT = 'pdf';

class Cancelled extends Error { constructor() { super('cancelled'); this.cancelled = true; } }
const jobs = new Map(); // id -> { cancelled: bool }
function makeJob(id) { const j = { cancelled: false }; jobs.set(id, j); return j; }
function jobCancelled(x) { const j = (x && typeof x === 'object') ? x : jobs.get(x); return !j || j.cancelled; }
function endJob(id) { jobs.delete(id); }

// safe recursive list
async function listDir(dir) {
  try {
    const dh = await fsp.opendir(dir);
    const out = [];
    for await (const de of dh) out.push({ name: de.name, isDir: de.isDirectory(), isLink: de.isSymbolicLink() });
    return out;
  } catch (e) {
    // Fallback for shell-namespace-ish errors
    return [];
  }
}

async function fullStat(dir, name) {
  const p = path.join(dir, name);
  try {
    const s = await fsp.stat(p); // follow links
    return { path: p, name, ...(s), mimeType: null };
  } catch {
    try {
      const s = await fsp.lstat(p);
      return { path: p, name, ...s, brokenLink: true };
    } catch {
      return { path: p, name, error: 'stat' };
    }
  }
}

function mimeOf(ext) {
  ext = (ext || '').toLowerCase();
  if (IMG_EXTS.has(ext)) return 'image/' + ({ jpg: 'jpeg', jpeg: 'jpeg', tif: 'tiff', tiff: 'tiff', svg: 'svg+xml' }[ext] || ext);
  if (VID_EXTS.has(ext)) return 'video/' + (ext === 'mkv' ? 'x-matroska' : ext);
  if (AUD_EXTS.has(ext)) return 'audio/' + ext;
  if (ext === PDF_EXT) return 'application/pdf';
  return 'application/octet-stream';
}

// ---------------------------------------------------------------- drives
// Fast, subprocess-free probe: fs.statfsSync per drive letter. The previous
// implementation shelled out to WMIC (removed from recent Windows 11 builds)
// and, as a fallback, PowerShell's Get-PSDrive with a non-existent `Caption`
// column — both produced an empty drive bar, and the execSync call blocked the
// main process for seconds during boot. Volume label and drive type are
// cosmetic, so they are enriched in the background and land in the cache for
// the renderer's next poll.
let driveCache = null;
let driveEnriching = false;

function probeDrivesFast() {
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const root = String.fromCharCode(c) + ':\\';
    try {
      const s = fs.statfsSync(root);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      if (total <= 0 && free <= 0) continue;
      out.push({ path: root, label: '', free, total, type: 3 });
    } catch { /* absent or not ready */ }
  }
  return out;
}

function enrichDrives(list) {
  return new Promise(resolve => {
    const ps = 'Get-CimInstance Win32_LogicalDisk | ForEach-Object { "$($_.DeviceID)|$($_.VolumeName)|$($_.DriveType)" }';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      const child2 = cp.execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { timeout: 8000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
          if (!err && stdout) {
            for (const line of stdout.split(/\r?\n/)) {
              const m = line.match(/^([A-Za-z]:)\|([^|]*)\|(\d+)/);
              if (!m) continue;
              const d = list.find(x => x.path.toLowerCase() === (m[1] + '\\').toLowerCase());
              if (d) { d.label = m[2] || ''; d.type = +m[3] || 3; }
            }
          }
          finish();
        });
      child2.on('error', finish);
      setTimeout(finish, 9000).unref?.();
    } catch { finish(); }
  });
}

async function getDrives() {
  const fast = probeDrivesFast();
  if (!driveCache) driveCache = fast;
  else {
    for (const d of fast) {
      const cur = driveCache.find(x => x.path.toLowerCase() === d.path.toLowerCase());
      if (cur) { cur.free = d.free; cur.total = d.total; }
      else driveCache.push(d);
    }
    driveCache = driveCache.filter(d => fast.some(f => f.path.toLowerCase() === d.path.toLowerCase()));
  }
  if (!driveEnriching) {
    driveEnriching = true;
    enrichDrives(driveCache).finally(() => { driveEnriching = false; });
  }
  return driveCache.map(d => ({ ...d }));
}

// ---------------------------------------------------------------- copy/move/delete
async function copyOne(src, dst, opts, progress) {
  // dst: full target file path
  await fsp.copyFile(src, dst, opts.overwrite ? 0 : fs.constants.COPYFILE_EXCL);
}

async function walkFiles(root, filterRe, job) {
  const out = [];
  async function rec(dir) {
    if (jobCancelled(job)) throw new Cancelled();
    const entries = await listDir(dir).catch(() => []);
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDir) await rec(p);
      else if (matchAny(e.name, filterRe)) out.push({ src: p, name: e.name, dir });
    }
  }
  await rec(root);
  return out;
}

async function transfer(entries, dstRoot, opts, job, progress) {
  // entries: [{src,name,rel}] rel = relative subpath needed to preserve hierarchy
  let done = 0, bytes = 0;
  const errors = [];
  let totalEntries = entries.length;
  for (const en of entries) {
    if (jobCancelled(job)) break;
    try {
      const dst = path.join(dstRoot, en.rel || en.name);
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      let st = { size: 0 };
      try { st = await fsp.stat(en.src); } catch {}
      // Overwrite rule
      if (!opts.overwrite) {
        try {
          const ds = await fsp.stat(dst);
          if (opts.skipOlder && ds.mtimeMs >= st.mtimeMs) { done++; progress?.(done, totalEntries, bytes, en); continue; }
          if (opts.skipNewer && ds.mtimeMs <= st.mtimeMs) { done++; progress?.(done, totalEntries, bytes, en); continue; }
          if (!opts.overwrite) {
            // rename conflict
            if (opts.renameConflicts) {
              const dir = path.dirname(dst), ext = path.extname(dst), base = path.basename(dst, ext);
              let i = 1, cand = dst;
              const suffix = () => ` [${i}]`;
              cand = path.join(dir, base + suffix() + ext);
              while (fs.existsSync(cand)) { i++; cand = path.join(dir, base + suffix() + ext); }
              await copyOne(en.src, cand, opts);
              done++; progress?.(done, totalEntries, bytes, en); continue;
            }
          }
        } catch { /* dst doesn't exist */ }
      }
      await copyOne(en.src, dst, opts);
      if (opts.move && !opts.keepStruct) {
        try { await fsp.rm(en.src, { force: true }); } catch (e) { errors.push(`${en.src}: ${e.code || e.message}`); }
      }
      bytes += st.size || 0;
    } catch (e) {
      errors.push(`${en.src}: ${e.code || e.message}`);
      if (!opts.continueOnError) break;
    }
    done++;
    progress?.(done, totalEntries, bytes, en);
  }
  return { done, bytes, errors };
}

// ---------------------------------------------------------------- delete
async function deleteEntries(paths, permanent, job, progress) {
  const errors = [];
  let done = 0;
  for (const p of paths) {
    if (jobCancelled(job)) break;
    try {
      if (permanent) {
        await fsp.rm(p, { recursive: true, force: true });
      } else {
        // send to recycle bin via PowerShell VisualBasic
        const script =
          'Add-Type -AssemblyName Microsoft.VisualBasic\n' +
          `& { param($p) [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin') }\n` +
          `try { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${p.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin') } catch { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${p.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin') }`;
        await new Promise((res, rej) => {
          cp.exec('powershell -NoProfile -STA -Command -', { stdin: 'pipe', timeout: 20000 }, (err) => err ? rej(err) : res());
        }).input?.();
        // Simpler: run per-item
        await new Promise((res, rej) => {
          const proc = cp.exec(`powershell -NoProfile -Command "Add-Type -AssemblyName Microsoft.VisualBasic; try { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${p.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin') } catch { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${p.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin') }"`,
            { timeout: 30000 }, (err) => { err ? rej(err) : res(); });
        });
      }
    } catch (e) { errors.push(`${p}: ${e.code || e.message}`); if (String(e.message).includes('canceled')) break; }
    done++; progress?.(done, paths.length, p);
  }
  return { done, errors };
}

// ---------------------------------------------------------------- tree size
async function treeStat(dir, job, cache) {
  // returns {size, files, dirs}
  if (cache?.has(dir)) return cache.get(dir);
  const res = { size: 0, files: 0, dirs: 1 };
  cache?.set(dir, res);
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return res; }
  for (const e of entries) {
    if (jobCancelled(job)) break;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await treeStat(p, job, cache);
      res.size += sub.size; res.files += sub.files; res.dirs += sub.dirs;
    } else if (e.isFile()) {
      try { res.size += (await fsp.stat(p)).size; res.files++; } catch {}
    }
  }
  return res;
}

// ---------------------------------------------------------------- search
async function searchFS(root, opts, job, onFile, onProgress) {
  // opts: {filter,text,textFlags, maxSize,minSize, newerThan,olderThan, recursive, regex, ff}
  const filterRe = parseFilter(opts.filter || '');
  // name-only searches pass no `text`; building a regex from undefined threw and
  // the outer catch turned it into a bogus "cancelled" result.
  const re = opts.text ? (opts.regex
    ? (() => { try { return new RegExp(opts.text, opts.textFlags || 'i'); } catch { return null; } })()
    : new RegExp(opts.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.textFlags || 'i')) : null;
  const rootDec = path.resolve(root);
  let scanned = 0;

  async function rec(dir) {
    if (jobCancelled(job)) throw new Cancelled();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (jobCancelled(job)) throw new Cancelled();
      const p = path.join(dir, e.name);
      if (e.isDirectory() && opts.recursive) {
        await rec(p);
        continue;
      }
      if (!e.isFile()) continue;
      scanned++;
      try {
        const st = await fsp.stat(p);
        if (opts.minSize && st.size < opts.minSize) continue;
        if (opts.maxSize && st.size > opts.maxSize) continue;
        if (opts.newerThan && st.mtimeMs < new Date(opts.newerThan).getTime()) continue;
        if (opts.olderThan && st.mtimeMs > new Date(opts.olderThan).getTime()) continue;
        if (!matchAny(e.name, filterRe)) { onProgress?.(scanned); continue; }
        if (opts.text) {
          if (!re) { onProgress?.(scanned); continue; }
          // content search for text-ish files
          const ext = path.extname(e.name).slice(1).toLowerCase();
          const maybeText = TEXT_EXTS.has(ext) || st.size < (opts.textMaxSize || 15 * 1024 * 1024) && (TEXT_EXTS.has(ext) || /^(txt|log|json|xml|html|ini|csv|md|yml|yaml|bat|cmd|ps1|py|js|css)$/i.test(ext) || st.size < 2 * 1024 * 1024);
          if (!maybeText) { onProgress?.(scanned); continue; }
          const buf = await fsp.readFile(p);
          // detect UTF-16 BOMs
          let text;
          if (buf[0] === 0xFF && buf[1] === 0xFE) text = buf.toString('utf16le');
          else if (buf[0] === 0xFE && buf[1] === 0xFF) { text = ''; for (let i = 0; i < buf.length - 1; i += 2) text += String.fromCharCode(buf.readUInt16BE(i)); }
          else text = buf.toString('utf8');
          const m = text.match(re);
          if (!m) { onProgress?.(scanned); continue; }
          onFile({ path: p, name: e.name, size: st.size, mtimeMs: st.mtimeMs, hit: m[0], context: text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60).replace(/\s+/g, ' ') });
        } else {
          onFile({ path: p, name: e.name, size: st.size, mtimeMs: st.mtimeMs });
        }
        onProgress?.(scanned);
      } catch { /* skip */ }
      if (jobCancelled(job)) throw new Cancelled();
    }
  }
  await rec(rootDec);
  return scanned;
}

// ---------------------------------------------------------------- duplicates
async function findDuplicates(roots, opts, job, progress) {
  // opts: {matchName, matchSize, matchDate, contentHash}
  const groups = new Map();
  const files = [];
  let scanned = 0;
  for (const root of roots) {
    await (async function rec(dir) {
      if (jobCancelled(job)) throw new Cancelled();
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) { await rec(path.join(dir, e.name)); continue; }
        if (!e.isFile()) continue;
        const p = path.join(dir, e.name);
        scanned++;
        progress?.(scanned, 0);
        let st = {};
        try { st = await fsp.stat(p); } catch { continue; }
        files.push({ path: p, name: e.name, size: st.size, mtimeMs: st.mtimeMs });
      }
    })(path.resolve(root));
  }
  const sameBy = new Map();
  const keyOf = f => opts.matchName ? f.name.toLowerCase() : '';
  if (opts.contentHash) {
    // group by size first
    const bySize = new Map();
    for (const f of files) {
      const a = bySize.get(f.size) || [];
      a.push(f); bySize.set(f.size, a);
    }
    for (const [size, arr] of bySize) {
      if (arr.length < 2) { if (opts.matchSize) { const k = 'S' + size; const g = sameBy.get(k) || []; g.push(...arr); sameBy.set(k, g); } continue; }
      // hash each
      for (const f of arr) {
        if (jobCancelled(job)) throw new Cancelled();
        progress?.(0, 1);
        const buf = await fsp.readFile(f.path).catch(() => null);
        if (!buf) continue;
        f.hash = crypto.createHash('md5').update(buf).digest('hex');
        const k = 'H' + f.hash;
        const g = sameBy.get(k) || []; g.push(f); sameBy.set(k, g);
      }
    }
  } else {
    for (const f of files) {
      if (jobCancelled(job)) break;
      let keys = [];
      if (opts.matchSize && !opts.matchName && !opts.matchDate) keys.push('S' + f.size);
      else {
        let k = '';
        if (opts.matchName) k += f.name.toLowerCase();
        if (opts.matchDate) k += '|D' + Math.round(f.mtimeMs / 1000);
        if (opts.matchSize || opts.contentHash) k += '|S' + f.size;
        keys.push(k);
      }
      for (const k of keys) {
        if (k) { const g = sameBy.get(k) || []; g.push(f); sameBy.set(k, g); }
      }
    }
  }
  // final groups with >1
  let idx = 0;
  for (const [k, arr] of sameBy) {
    if (arr.length > 1 && (opts.contentHash ? true : true)) {
      groups.set(idx++, arr.map(f => ({ path: f.path, name: f.name, size: f.size, mtimeMs: f.mtimeMs, hash: f.hash })));
    }
  }
  return { scanned, groups: Array.from(groups.values()) };
}

// ---------------------------------------------------------------- zip support (built-in)
function readZipCentral(buf) {
  // find EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.utf8Slice ? buf.utf8Slice(off + 46, off + 46 + nameLen) : buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    entries.push({ name, isDir: name.endsWith('/'), size: usize, csize, method, lho });
    off += 46 + nameLen + extraLen + commLen;
  }
  return entries;
}

function zipExtractMember(buf, en) {
  const nameLen = buf.readUInt16LE(en.lho + 26);
  const extraLen = buf.readUInt16LE(en.lho + 28);
  const dataOff = en.lho + 30 + nameLen + extraLen;
  const raw = buf.slice(dataOff, dataOff + en.csize);
  if (en.method === 0) return raw;
  return zlib.inflateRawSync(raw);
}

function findTool(exeNames) {
  for (const n of exeNames) {
    try {
      cp.execSync(`where ${n}`, { encoding: 'utf8', timeout: 3000 });
      return n;
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------- archive listing via 7z/rar
function externalArchiveTool() {
  const candidates = [
    'C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    'C:\\Program Files\\WinRAR\\WinRAR.exe', 'C:\\Program Files\\WinRAR\\Rar.exe',
    'C:\\Program Files\\WinRAR\\UnRAR.exe'
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return findTool(['7z', '7z.exe', 'WinRAR.exe', 'UnRAR.exe']);
}

function listArchive(fp, ext) {
  if (ext === 'zip') {
    const buf = fs.readFileSync(fp);
    const entries = readZipCentral(buf);
    if (entries) return { native: true, buf, entries: entries.map(e => ({ name: e.name, isDir: e.isDir, size: e.size })) };
  }
  const tool = externalArchiveTool();
  if (!tool) return { error: 'no archive tool' };
  try {
    if (/7z(\.exe)?$/i.test(tool)) {
      // list with -ba -slt
      const out = cp.execFileSync(tool, ['l', '-ba', '-slt', fp], { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
      const entries = [];
      let cur = {};
      for (const l of out.split(/\r?\n/)) {
        const m = l.match(/^(.+?)\s*=\s*(.*)$/);
        if (m) cur[m[1]] = m[2];
        else if (!l.trim()) {
          if (cur.Path) entries.push({ name: cur.Path, isDir: cur.Folder === '+' || cur.Folder === 'Y', size: cur.Folder === '+' ? 0 : +cur.Size || 0 });
          cur = {};
        }
      }
      if (cur.Path) entries.push({ name: cur.Path, isDir: cur.Folder === '+' || cur.Folder === 'Y', size: cur.Folder === '+' ? 0 : +cur.Size || 0 });
      return { entries };
    } else {
      // WinRAR/UnRAR: technical listing — one block per entry with
      // "Name:", "Size:" and "Type:" fields (File / Directory).
      const exe = tool.replace(/WinRAR\.exe$/i, 'Rar.exe');
      const out = cp.execFileSync(exe, ['lt', fp], { encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
      const entries = [];
      let cur = {};
      const flush = () => {
        if (cur.Name) {
          const isDir = /dir/i.test(cur.Type || '');
          entries.push({ name: cur.Name, isDir, size: isDir ? 0 : +cur.Size || 0 });
        }
        cur = {};
      };
      for (const l of out.split(/\r?\n/)) {
        const m = l.match(/^\s*(Name|Size|Type)\s*:\s*(.*)$/);
        if (m) cur[m[1]] = m[2].trim();
        else if (!l.trim()) flush();
      }
      flush();
      return { entries };
    }
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

function extractArchive(fp, ext, destDir, entriesFilter, job) {
  if (ext === 'zip') {
    const buf = fs.readFileSync(fp);
    const entries = readZipCentral(buf);
    if (!entries) return { error: 'bad zip' };
    const list = entries.filter(e => !e.isDir && (!entriesFilter || entriesFilter.some(f => e.name === f)));
    let done = 0;
    for (const e of list) {
      if (job && jobCancelled(job.jobId)) break;
      try {
        const target = path.join(destDir, e.name);
        await0(target, zipExtractMember(buf, e));
      } catch (err) { /* file may have bad name */ }
      done++;
      job?.progress?.(done, list.length);
    }
    return { done };
  }
  const tool = externalArchiveTool();
  if (!tool) return { error: 'no archive tool' };
  if (/7z(\.exe)?$/i.test(tool)) {
    try {
      cp.execFileSync(tool, ['x', '-y', `-o${destDir}`, fp, ...(entriesFilter || []).length ? [...entriesFilter] : []], { timeout: 120000, windowsHide: true });
      return { done: (entriesFilter || []).length || -1 };
    } catch (e) { return { error: String(e.message || e) }; }
  }
  return { error: 'extraction unsupported with current tool' };
}
async function await0(target, data) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, data);
}

// ---------------------------------------------------------------- checksums / text read
function readText(fp, limit = 2 * 1024 * 1024) {
  const fd = fs.openSync(fp, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, limit);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    let encoding = 'utf8', text;
    if (buf[0] === 0xFF && buf[1] === 0xFE) { encoding = 'utf16le'; text = buf.toString('utf16le'); }
    else if (n > 0 && buf[0] === 0xFE && buf[1] === 0xFF) { encoding = 'utf16be'; const chars = []; for (let i = 0; i < n - 1; i += 2) chars.push(buf.readUInt16BE(i)); text = String.fromCharCode(...chars); }
    else text = buf.toString('utf8', hasUtf8Bom(buf) ? 3 : 0);
    return { text, encoding, truncated: size > n, size };
  } finally { fs.closeSync(fd); }
}
function hasUtf8Bom(buf) { return buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF; }

// ---------------------------------------------------------------- shell context items
async function openWith(fp) {
  const r = shell.openItem ? shell.openItem(fp) : shell.openPath(fp);
  return r || true;
}

// ---------------------------------------------------------------- zip writer
// Minimal store/deflate ZIP writer so "Archive selection…" works without any
// external archiver being installed.
const CRC_TABLE = (() => {
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function dosStamp(ms) {
  const d = new Date(ms || Date.now());
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}
function zipCreate(items, outFile, job, progress) {
  const files = [];
  const collect = (src, name) => {
    let st;
    try { st = fs.lstatSync(src); } catch { return; }
    if (st.isDirectory()) {
      for (const child of fs.readdirSync(src)) collect(path.join(src, child), name + '/' + child);
    } else files.push({ src, name: name.split(path.sep).join('/'), mtimeMs: st.mtimeMs });
  };
  for (const it of items || []) collect(it.src, it.name || path.basename(it.src));
  const parts = [];
  const central = [];
  let offset = 0;
  files.forEach((f, i) => {
    if (jobCancelled(job)) throw new Cancelled();
    const data = fs.readFileSync(f.src);
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const nameBuf = Buffer.from(f.name, 'utf8');
    const { time, date } = dosStamp(f.mtimeMs);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + body.length;
    if (progress) progress(i + 1, files.length);
  });
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(outFile, Buffer.concat([...parts, ...central, eocd]));
  return { ok: true, files: files.length, bytes: offset + cdSize + 22 };
}

// ---------------------------------------------------------------- IPC glue
function makeProgressSender(evt, jobId) {
  let last = 0;
  return (a, b, c, d) => {
    const now = Date.now();
    if (now - last < 80 && !(a === -1)) return;
    last = now;
    try { evt.sender.send('t2f', jobId, a, b, c, d); } catch {}
  };
}

// ---------------------------------------------- folder association (defmgr)
const { FolderAssociation } = require('./defmgr');
// Kept OUT of settings.json: the renderer rewrites that file wholesale, so a
// main-owned key there would be silently dropped on the next persist.
const defmgrStateFile = () => path.join(path.dirname(settingsPath()), 'folder-association.json');
let defmgrStateCache; // undefined = not read yet, null = no snapshot
function getDefmgrBackup() {
  if (defmgrStateCache === undefined) {
    try { defmgrStateCache = JSON.parse(fs.readFileSync(defmgrStateFile(), 'utf8')); } catch { defmgrStateCache = null; }
  }
  return defmgrStateCache;
}
function setDefmgrBackup(b) {
  defmgrStateCache = b;
  try { if (b) fs.writeFileSync(defmgrStateFile(), JSON.stringify(b, null, 2)); else fs.unlinkSync(defmgrStateFile()); } catch { /* best effort */ }
}
let defmgrInst = null;
function folderMgr() {
  if (!defmgrInst) defmgrInst = new FolderAssociation({
    exePath: process.execPath,
    isPackaged: app.isPackaged,
    getBackup: getDefmgrBackup,
    setBackup: setDefmgrBackup
  });
  return defmgrInst;
}
const guardOp = fn => Promise.resolve().then(fn).catch(e => ({ error: String((e && e.message) || e) }));

// ------------------------------------------------------------------ updates
let updaterInst; // undefined = not built yet, null = unavailable
let lastCheckManual = false;
function pushUpdate(state, extra = {}) {
  try { win()?.webContents.send('x2:update', { state, current: app.getVersion(), manual: lastCheckManual, ...extra }); } catch { /* window gone */ }
}
function getUpdater() {
  if (updaterInst !== undefined) return updaterInst;
  updaterInst = null;
  if (app.isPackaged) {
    try {
      const u = require('electron-updater').autoUpdater;
      u.autoDownload = true;          // silent background download
      u.autoInstallOnAppQuit = true;  // silent install when the app closes
      if (process.platform === 'win32') {
        // Our releases are unsigned — never reject a download over Authenticode
        // (build.win.verifyUpdateCodeSignature=false also omits publisherName).
        u.verifyUpdateCodeSignature = () => Promise.resolve(null);
      }
      u.on('checking-for-update', () => pushUpdate('checking'));
      u.on('update-available', i => pushUpdate('available', { version: i && i.version }));
      u.on('update-not-available', () => pushUpdate('not-available'));
      u.on('download-progress', p => pushUpdate('downloading', { percent: Math.round((p && p.percent) || 0) }));
      u.on('update-downloaded', i => pushUpdate('ready', { version: i && i.version }));
      u.on('error', err => pushUpdate('error', { message: String((err && err.message) || err) }));
      updaterInst = u;
    } catch (e) { console.warn('[x2m] updater unavailable:', e && e.message); }
  }
  return updaterInst;
}
function checkForUpdates(manual) {
  lastCheckManual = !!manual;
  const current = app.getVersion();
  const u = getUpdater();
  if (!u) {
    return {
      state: app.isPackaged ? 'error' : 'dev', current,
      message: app.isPackaged ? 'Updater unavailable' : 'Updates run in the installed build'
    };
  }
  try { u.checkForUpdates().catch(() => { /* surfaced via the error event */ }); }
  catch (e) { return { state: 'error', current, message: String((e && e.message) || e) }; }
  return { state: 'checking', current };
}

function registerIpc() {
  ipcMain.handle('sys:home', () => app.getPath('home'));

  ipcMain.handle('settings:get', () => settings);
  ipcMain.on('settings:set', (e, s) => { settings = s; saveSettings(); });
  ipcMain.on('settings:flush', () => { clearTimeout(saveTimer); fsp.writeFile(settingsPath(), JSON.stringify(settings, null, 2)).catch(() => {}); });

  // default file manager (per-user folder/drive association)
  ipcMain.handle('defmgr:status', () => guardOp(() => folderMgr().status()));
  ipcMain.handle('defmgr:apply', () => guardOp(() => folderMgr().apply()));
  ipcMain.handle('defmgr:revert', () => guardOp(() => folderMgr().revert()));

  // silent updates
  ipcMain.handle('update:check', () => checkForUpdates(true));
  ipcMain.handle('update:install', () => {
    const u = getUpdater();
    if (!u) return false;
    setTimeout(() => { try { u.quitAndInstall(true, true); } catch (e) { pushUpdate('error', { message: String((e && e.message) || e) }); } }, 300);
    return true;
  });

  ipcMain.handle('drives:get', () => getDrives());

  ipcMain.handle('dir:list', async (e, dir) => {
    const entries = [];
    try {
      const dh = await fsp.opendir(dir);
      for await (const de of dh) {
        try {
          const st = await fsp.lstat(path.join(dir, de.name));
          entries.push({ name: de.name, isDir: de.isDirectory(), isLink: de.isSymbolicLink(), size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, atimeMs: st.atimeMs, birthtimeMs: st.birthtimeMs });
        } catch {
          entries.push({ name: de.name, isDir: de.isDirectory(), isLink: de.isSymbolicLink(), error: true, size: 0, mtimeMs: 0, ctimeMs: 0, atimeMs: 0, birthtimeMs: 0 });
        }
      }
    } catch { /* unreadable */ }
    return entries;
  });

  ipcMain.handle('fs:stat', async (e, p) => {
    try {
      const st = await fsp.stat(p);
      return { path: p, isDir: st.isDirectory(), isFile: st.isFile(), size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, atimeMs: st.atimeMs, birthtimeMs: st.birthtimeMs };
    } catch { return null; }
  });
  ipcMain.handle('fs:parent', (e, p) => path.dirname(p));
  ipcMain.handle('fs:join', (e, a, b) => path.join(a, b || ''));

  ipcMain.handle('fs:mkdir', async (e, dir, name) => {
    const p = path.join(dir, name);
    await fsp.mkdir(p, { recursive: true });
    return p;
  });
  ipcMain.handle('fs:touch', async (e, dir, name) => {
    const p = path.join(dir, name);
    await fsp.writeFile(p, '');
    return p;
  });
  ipcMain.handle('fs:rename', async (e, oldP, newP) => {
    const target = path.isAbsolute(newP) ? newP : path.join(path.dirname(oldP), newP);
    try {
      await fsp.rename(oldP, target);
    } catch (err) {
      // EXDEV (rename across volumes) or locked target: copy then remove
      if (err && err.code === 'EXDEV') {
        const st = await fsp.lstat(oldP);
        if (st.isDirectory()) { await fsp.cp(oldP, target, { recursive: true, force: true }); await fsp.rm(oldP, { recursive: true, force: true }); }
        else { await fsp.copyFile(oldP, target); await fsp.unlink(oldP); }
      } else throw err;
    }
    return target;
  });
  ipcMain.handle('fs:trash', async (e, paths) => {
    const r = shell.trashItem ? await Promise.all(paths.map(p => shell.trashItem(p).catch(() => false))) : paths.map(() => false);
    const ok = r.filter(Boolean).length;
    return { ok, fail: r.length - ok };
  });
  ipcMain.handle('fs:delete', (e, paths, permanent, jobId) => {
    const job = makeJob(jobId);
    return deleteEntries(paths, permanent, job, makeProgressSender(e, jobId)).then(r => { endJob(jobId); return r; });
  });

  ipcMain.handle('fs:transfer', (e, entries, dst, opts, jobId) => {
    const job = makeJob(jobId);
    return transfer(entries, dst, opts || {}, job, makeProgressSender(e, jobId)).then(r => { endJob(jobId); return r; });
  });

  ipcMain.handle('fs:readText', (e, fp, limit) => { try { return readText(fp, limit); } catch (err) { return { error: String(err) }; } });
  ipcMain.handle('fs:writeText', async (e, fp, text) => { await fsp.writeFile(fp, text, 'utf8'); return true; });
  ipcMain.handle('fs:hex', (e, fp) => {
    try {
      const fd = fs.openSync(fp, 'r');
      const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 65536));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      return buf.toString('hex').match(/.{1,2}/g);
    } catch { return null; }
  });
  ipcMain.handle('fs:hash', async (e, fp, algo) => {
    const h = crypto.createHash(algo || 'md5');
    await new Promise((res, rej) => {
      const s = fs.createReadStream(fp);
      s.on('data', d => h.update(d));
      s.on('end', res);
      s.on('error', rej);
    });
    return h.digest('hex');
  });

  ipcMain.handle('fs:treeStat', (e, dir, jobId) => {
    const job = makeJob(jobId);
    return treeStat(dir, job).then(r => { endJob(jobId); return r; });
  })

  ipcMain.handle('search:run', (e, roots, opts, jobId) => {
    const job = makeJob(jobId);
    const onFile = (hit) => { try { e.sender.send('t2f', jobId, 'hit', hit); } catch {} };
    return Promise.all(roots.map(r => searchFS(r, opts || {}, job, onFile, makeProgressSender(e, sessionId(jobId)))))
      .then(n => { endJob(jobId); return n; })
      .catch(err => { endJob(jobId); return { cancelled: true, scanned: err.scanned || 0 }; });
  });
  ipcMain.on('search:cancel', (e, jobId) => { const j = jobs.get(jobId); if (j) j.cancelled = true; });

  ipcMain.handle('dupes:run', (e, roots, opts, jobId) => {
    const job = makeJob(jobId);
    return findDuplicates(roots, opts || {}, job, makeProgressSender(e, sessionId(jobId)))
      .then(r => { endJob(jobId); return r; });
  });

  ipcMain.handle('archive:list', (e, fp, ext) => listArchive(fp, ext));
  ipcMain.handle('archive:extract', (e, fp, ext, destDir, entries, jobId) => {
    const job = makeJob(jobId);
    return new Promise(res => {
      const r = extractArchive(fp, ext, destDir, entries, { jobId, progress: makeProgressSender(e, jobId) });
      endJob(jobId); res(r);
    });
  });

  ipcMain.handle('fs:links', async (e, kind, srcPath, dstPath) => {
    try {
      if (kind === 'hard') await fsp.link(srcPath, dstPath);
      else if (kind === 'junction') await fsp.symlink(srcPath, dstPath, 'junction');
      else if (kind === 'symlink') await fsp.symlink(srcPath, dstPath, 'file');
      else if (kind === 'softdir') await fsp.symlink(srcPath, dstPath, 'dir');
      return { ok: true };
    } catch (err) { return { ok: false, error: String(err.message || err) }; }
  });

  ipcMain.handle('fs:split', async (e, fp, chunkMB, outDir, jobId) => {
    const chunk = Math.max(16, chunkMB) * 1024 * 1024;
    const rd = fs.createReadStream(fp, { highWaterMark: chunk });
    let part = 1;
    const base = path.basename(fp);
    const sep = '__';
    const done = await new Promise((res, rej) => {
      rd.on('data', c => {
        fs.writeFileSync(path.join(outDir, `${base}${sep}${String(part).padStart(3, '0')}`), c);
        part++;
        if (jobCancelled(jobId)) { rd.destroy(); rej(new Cancelled()); }
      });
      rd.on('end', () => res(part - 1));
      rd.on('error', rej);
    });
    return { parts: done };
  });
  ipcMain.handle('fs:merge', async (e, parts, outFile, jobId) => {
    const ws = fs.createWriteStream(outFile);
    await new Promise((res, rej) => {
      let i = 0;
      const next = () => {
        if (jobCancelled(jobId)) { ws.destroy(); rej(new Cancelled()); return; }
        if (i >= parts.length) { ws.end(res); return; }
        const rs = fs.createReadStream(parts[i++]);
        rs.pipe(ws, { end: false });
        rs.on('end', next);
        rs.on('error', rej);
      };
      next();
    });
    return { ok: true };
  });

  ipcMain.handle('shell:open', async (e, fp) => { const r = await shell.openPath(fp); return r || true; });
  ipcMain.handle('shell:openInApp', (e, fp, appPath, args) => {
    const cmd = [appPath, [fp]].flat();
    try {
      cp.spawn(appPath, [...(args || []), fp], { detached: true, stdio: 'ignore' }).unref();
      return true;
    } catch { return false; }
  });
  ipcMain.handle('shell:showInExplorer', (e, fp) => { shell.showItemInFolder(fp); return true; });
  ipcMain.handle('shell:copy', (e, text) => { clipboard.writeText(text); return true; });
  ipcMain.handle('shell:run', (e, dir, cmd) => {
    try {
      cp.spawn(cmd.match(/^(.+?)(?:\.exe)?$/)?.[1] || cmd, [], { cwd: dir, shell: true, detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
      // For robustness we run a cmd window
    } catch (err) { return { ok: false, res: String(err) }; }
  });
  ipcMain.handle('shell:runCapture', (e, cmd, dir) => new Promise(resolve => {
    cp.exec(cmd, { cwd: dir || os.homedir(), shell: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  }));
  ipcMain.handle('shell:runTerminal', (e, dir) => {
    try {
      if (process.platform === 'win32') {
        // Prefer Windows Terminal when present, fall back to a plain console.
        cp.spawn('wt.exe', ['-d', dir], { detached: true, stdio: 'ignore' }).on('error', () => {
          cp.spawn(process.env.ComSpec || 'cmd.exe', [], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: false }).unref();
        }).unref();
      } else if (process.platform === 'darwin') {
        cp.spawn('open', ['-a', 'Terminal', dir], { detached: true, stdio: 'ignore' }).unref();
      } else {
        cp.spawn(process.env.SHELL || 'x-terminal-emulator', [], { cwd: dir, detached: true, stdio: 'ignore' }).unref();
      }
      return { ok: true };
    } catch (err) { return { ok: false, error: String(err.message || err) }; }
  });
  ipcMain.handle('fs:setTimes', async (e, fp, mtimeMs, atimeMs) => {
    const m = new Date(mtimeMs || Date.now());
    const a = new Date(atimeMs || mtimeMs || Date.now());
    await fsp.utimes(fp, a, m);
    return true;
  });
  ipcMain.handle('fs:setAttr', async (e, fp, spec) => {
    if (process.platform !== 'win32') return { ok: false, error: 'attributes are Windows-only' };
    return new Promise(resolve => {
      cp.exec(`attrib ${String(spec || '').split(/\s+/).filter(t => /^[+-][RHSA]$/i.test(t)).join(' ')} "${fp}"`,
        { windowsHide: true }, err => resolve(err ? { ok: false, error: String(err.message) } : { ok: true }));
    });
  });
  ipcMain.handle('archive:zipCreate', (e, items, outFile, jobId) => {
    const job = makeJob(jobId);
    const progress = makeProgressSender(e, jobId);
    return Promise.resolve()
      .then(() => zipCreate(items, outFile, job, progress))
      .then(r => { endJob(jobId); return r; })
      .catch(err => { endJob(jobId); return { ok: false, error: String(err.message || err) }; });
  });
  ipcMain.handle('win:cmd', (e, cmd) => {
    const w = win();
    if (!w) return false;
    if (cmd === 'minimize') w.minimize();
    else if (cmd === 'maximize') w.isMaximized() ? w.unmaximize() : w.maximize();
    else if (cmd === 'close') w.close();
    return true;
  });
  ipcMain.handle('sys:openDev', () => { win()?.webContents.openDevTools(); });

  ipcMain.handle('dialog:pick', async (e, kind, opts) => {
    const w = win();
    if (kind === 'directory') {
      const r = await dialog.showOpenDialog(w, { properties: ['openDirectory', 'multiSelections'], ...(opts || {}) });
      return r;
    }
    if (kind === 'file') {
      const r = await dialog.showOpenDialog(w, { properties: ['openFile', 'multiSelections'], ...(opts || {}) });
      return r;
    }
    if (kind === 'save') {
      const r = await dialog.showSaveDialog(w, opts || {});
      return r;
    }
    return null;
  });
  ipcMain.handle('dialog:msg', async (e, opts) => {
    const w = win();
    return dialog.showMessageBox(w, opts);
  });
}

function sessionId(id) { return id; }

/**
 * Ensure the SplashHost tray icon context menu runs in the foreground app
 * process rather than the isolated tray helper. Electron on Windows spawns a
 * separate process for AppUserModelID/BPFID entries; without this, setting the
 * AppUserModelID on the tray icon here does nothing because the user process
 * never receives the callback. The tray helper does nothing useful with
 * notifications, so we just force it into our process.
 */
function unifySplashHostProcess() {
  try {
    const t = require('electron'). Tray;
    const m = t.toString().match(/function Tray\(([\s\S]*?)\)/);
    if (!m || typeof app.setAppUserModelId !== 'function') return;
    app.setAppUserModelId('com.vikramdex.xplorer2');
  } catch (e) { /* best-effort only */ }
}
unifySplashHostProcess();

// ---------------------------------------------------------------- window + protocol
function createWindow() {
  const w = new BrowserWindow({
    width: 1500, height: 950, minWidth: 1000, minHeight: 600,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  });
  Menu.setApplicationMenu(null);
  w.webContents.on('console-message', (e, lvl, msg, line, src) => {
    if (process.env.X2M_DEVLOG) console.log(`[rc:${lvl}] ${msg} (${src}:${line})`);
  });
  w.webContents.on('preload-error', (e, p, err) => console.log('[preload-error]', p, err));
  w.webContents.on('did-fail-load', (e, code, desc, uv) => console.log('[did-fail-load]', code, desc, uv));
  w.loadFile(path.join(__dirname, '../src/index.html'));

  // a cold start via a folder verb (`--open "<folder>"`) navigates once booted
  if (argvOpenPath) {
    w.webContents.once('did-finish-load', () => {
      try { w.webContents.send('app:openPath', argvOpenPath); } catch { /* ignore */ }
    });
  }

  if (process.env.X2M_AUTOSCREENSHOT) {
    w.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await w.webContents.capturePage();
          fs.writeFileSync(process.env.X2M_AUTOSCREENSHOT, img.toPNG());
          console.log('[x2m] screenshot saved', process.env.X2M_AUTOSCREENSHOT);
          app.exit(0);
        } catch (e) { console.error('[x2m] screenshot failed', e); app.exit(1); }
      }, parseInt(process.env.X2M_SCREENSHOT_DELAY || '2500', 10));
    });
  }
  return w;
}

// x2file protocol for previews
function handleProtocol() {
  protocol.handle('x2file', (req) => {
    try {
      const u = new URL(req.url);
      // urls are built as x2file:///p/<encodeURIComponent(fullPath)>
      let rel = u.pathname.replace(/^\/+/, '');
      if (rel.startsWith('p/')) rel = rel.slice(2);
      let fp = decodeURIComponent(rel);
      if (u.searchParams.get('p')) fp = u.searchParams.get('p');
      if (process.platform === 'win32') fp = fp.replace(/^\//, '');
      let rangeHeader = null;
      // For media streaming
      if (req.headers.get('range')) rangeHeader = req.headers.get('range');
      const st = fs.statSync(fp);
      if (rangeHeader) {
        const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
        const start = m && m[1] ? parseInt(m[1]) : 0;
        const end = m && m[2] ? Math.min(parseInt(m[2]), st.size - 1) : st.size - 1;
        const buf = Buffer.alloc(end - start + 1);
        const fd = fs.openSync(fp, 'r');
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        return new Response(buf, {
          status: 206,
          headers: {
            'Content-Type': mimeOf(path.extname(fp).slice(1)),
            'Content-Range': `bytes ${start}-${end}/${st.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': buf.length
          }
        });
      }
      const mime = mimeOf(path.extname(fp).slice(1));
      const data = fs.readFileSync(fp);
      return new Response(data, {
        headers: { 'Content-Type': mime, 'Content-Length': String(data.byteLength), 'Cache-Control': 'no-cache' }
      });
    } catch (e) {
      return new Response('no', { status: 404 });
    }
  });
}

app.whenReady().then(async () => {
  if (!gotLock) return;
  // Windows taskbar grouping / toast identity must match the installer appId.
  if (process.platform === 'win32') app.setAppUserModelId('com.vikramdex.xplorer2');
  await loadSettings();
  handleProtocol();
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  // silent background update check, disabled by prefs.autoUpdate === false
  setTimeout(() => {
    try { if (settings?.prefs?.autoUpdate !== false) checkForUpdates(false); } catch { /* ignore */ }
  }, 8000);
});
app.on('window-all-closed', () => { clearTimeout(saveTimer); app.quit(); });
app.on('before-quit', () => { clearTimeout(saveTimer); try { fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2)); } catch {} });
