// Path Copy Copy-style path-copy module.
// One catalog of modes; each mode turns a path into text. The active default is
// persisted, and the address bar / shortcuts / context menu all render from
// the same list.
import { parentOf } from './util.js';
import { S, pref } from './store.js';

const SEP = '\\';

/** @typedef {{id:string,label:string,hint?:string,example?:string,fn:(p:string,name:string,isDir:boolean,parent:string)=>string}} PathCopyMode */

const baseName = p => String(p || '').split(SEP).filter(Boolean).pop() || String(p || '');
const trimRoot = p => String(p || '').replace(/[\\/]+$/, '');
const isDriveRoot = p => /^[a-zA-Z]:$/.test(trimRoot(p));

function relativeTo(from, target) {
  const a = trimRoot(from).toLowerCase().split(SEP).filter(Boolean);
  const b = trimRoot(target).toLowerCase().split(SEP).filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === 0) return target;
  const ups = a.slice(i).map(() => '..');
  const down = trimRoot(target).split(SEP).filter(Boolean).slice(i);
  return [...ups, ...down].join(SEP) || '.';
}

function fileUrl(p) {
  if (!p) return '';
  let u = String(p).split(SEP).join('/');
  // file:///C:/folder → file:///C:/folder
  return 'file:///' + encodeURI(u.replace(/^\/+/, ''));
}

/** @type {PathCopyMode[]} */
export const pathCopyModes = [
  {
    id: 'path', label: 'Full path', hint: 'Ctrl+P', example: 'C:\\Users\\me\\file.txt',
    fn: p => p
  },
  {
    id: 'name', label: 'Name only', hint: '', example: 'file.txt',
    fn: (p, n) => n
  },
  {
    id: 'parent', label: 'Parent folder path', hint: '', example: 'C:\\Users\\me',
    fn: (p, n, isDir, parent) => parent || p
  },
  {
    id: 'parentName', label: 'Parent folder name', hint: '', example: 'me',
    fn: (p, n, isDir, parent) => baseName(parent || '')
  },
  {
    id: 'unixPath', label: 'Unix-style path', hint: '', example: 'C:/Users/me/file.txt',
    fn: p => String(p).split(SEP).join('/')
  },
  {
    id: 'lowerPath', label: 'Lowercase path', hint: '', example: 'c:\\users\\me\\file.txt',
    fn: p => String(p).toLowerCase()
  },
  {
    id: 'quotedPath', label: 'Quoted path', hint: '', example: '"C:\\Users\\me\\file.txt"',
    fn: p => '"' + p + '"'
  },
  {
    id: 'quotedIfSpace', label: 'Quoted only if it has spaces', hint: '', example: '"C:\\My Folder\\a.txt"',
    fn: p => (String(p).includes(' ') ? '"' + p + '"' : p)
  },
  {
    id: 'cmdEscaped', label: 'CMD-escaped', hint: '', example: '"C:\\Users\\me\\file.txt"',
    fn: p => '"' + String(p).replace(/"/g, '""') + '"'
  },
  {
    id: 'psEscaped', label: 'PowerShell-escaped', hint: '', example: "'C:\\Users\\me\\file.txt'",
    fn: p => "'" + String(p).replace(/'/g, "''") + "'"
  },
  {
    id: 'csharp', label: 'C# verbatim string', hint: '', example: '@"C:\\Users\\me\\file.txt"',
    fn: p => '@"' + p + '"'
  },
  {
    id: 'url', label: 'File URL', hint: '', example: 'file:///C:/Users/me/file.txt',
    fn: p => fileUrl(p)
  },
  {
    id: 'relative', label: 'Relative to current folder', hint: '', example: 'sub\\file.txt',
    fn: p => relativeTo(S.lastCwd || '', p)
  },
  {
    id: 'lines', label: 'One path segment per line', hint: '', example: 'C:\\\nUsers\nme',
    fn: p => String(p).split(SEP).filter(Boolean).join('\n')
  }
];

/** Aliases kept for older call sites / saved settings. */
const ALIAS = { full: 'path', fullpath: 'path', short: 'name', win: 'path', posix: 'unixPath' };

const findMode = id => {
  const key = String(id || '').toLowerCase();
  return pathCopyModes.find(m => m.id.toLowerCase() === key) || pathCopyModes.find(m => m.id === ALIAS[key]);
};

export function defaultModeId() {
  return S.prefs?.pathCopyDefault || 'path';
}

/** Persist a new default and return the mode object (callers read `.label`). */
export function setDefaultModeId(id) {
  const mode = findMode(id) || pathCopyModes[0];
  pref('pathCopyDefault', mode.id);
  return mode;
}

function renderLines(paths, mode, delimiter = '\n') {
  const list = (paths || []).map(entry => {
    const p = typeof entry === 'string' ? entry : (entry.path || '');
    const name = (entry && entry.name) || baseName(p);
    const isDir = !!(entry && entry.isDir);
    const parent = parentOf(p) || '';
    try { return mode.fn(p, name, isDir, parent); } catch { return p; }
  });
  return list.join(delimiter);
}

/**
 * Format + copy paths. Accepts either a mode object (preferred) or an options
 * bag: { modeId, delimiter }.
 */
export async function copyPathsAsync(paths, opts = {}) {
  const mode = opts && typeof opts.fn === 'function' ? opts : (findMode(opts.modeId) || findMode(defaultModeId()) || pathCopyModes[0]);
  const text = renderLines(paths, mode, opts.delimiter || '\n');
  try { await window.x2.copyText(text); } catch { /* clipboard unavailable */ }
  return text;
}

/** Synchronous form, for callers that already handle their own clipboard. */
export function copyPaths(paths, opts = {}) {
  const mode = opts && typeof opts.fn === 'function' ? opts : (findMode(opts.modeId) || pathCopyModes[0]);
  return renderLines(paths, mode, opts.delimiter || '\n');
}

export function describeMode(mode) {
  return `${mode.label}${mode.example ? ` — ${mode.example}` : ''}`;
}

export default { pathCopyModes, defaultModeId, setDefaultModeId, copyPathsAsync, copyPaths };
