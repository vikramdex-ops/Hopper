// Real-registry test for electron/defmgr.js, run with plain node:
//   node tools/test-defmgr.mjs
// It points the module at disposable sandbox keys (X2Test*) under
// HKCU\Software\Classes, applies, verifies every key, tampers with one value
// to prove revert refuses to clobber foreign changes, then reverts and proves
// the sandbox is byte-for-byte clean. No elevation required; nothing outside
// the X2Test* keys is written.
import { createRequire } from 'module';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { FolderAssociation } = require('../electron/defmgr.js');

if (process.platform !== 'win32') {
  console.log('SKIP: default-manager registry tests are Windows-only');
  process.exit(0);
}

// ---- tiny registry helpers (test-side, independent of the module) ----
const reg = (args) => new Promise(res =>
  execFile('reg.exe', args, { windowsHide: true }, (e, so, se) =>
    res({ code: e && typeof e.code === 'number' ? e.code : 0, out: String(so || '') + String(se || '') })));

async function q(key) {
  // Unicode-safe readback: reg export writes UTF-16LE to a file, avoiding the
  // console codepage mangling that `reg query` piped output suffers from.
  const f = path.join(os.tmpdir(), `x2t-${process.pid}-${q.seq++}.reg`);
  const r = await reg(['export', key, f, '/y']);
  if (r.code !== 0) { try { fs.unlinkSync(f); } catch {} return { exists: false, value: null }; }
  let t = '';
  try { t = fs.readFileSync(f, 'utf16le'); }
  catch { return { exists: false, value: null }; }
  finally { try { fs.unlinkSync(f); } catch {} }
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(/^@="((?:[^"\\]|\\.)*)"\s*$/);
    if (m) return { exists: true, value: m[1].replace(/\\([\\"])/g, '$1') };
  }
  return { exists: false, value: null };
}
q.seq = 0;

/** Independent ASCII cross-check straight from `reg query` piped output. */
async function qDirect(key) {
  const r = await reg(['query', key, '/ve']);
  if (r.code !== 0) return { exists: false, value: null };
  for (const line of r.out.split(/\r?\n/)) {
    const m = line.match(/^\s*(\S+)\s+REG_[A-Z]+\s+(.*)$/);
    if (m) return { exists: true, value: m[2] };
  }
  return { exists: false, value: null };
}
async function qKey(key) {
  const r = await reg(['query', key]);
  return r.code === 0;
}
const del = async (...args) => { await reg(['delete', ...args, '/f']); };
const set = (key, data) => new Promise(res => {
  // reg add needs the file-based quoting handled by execFile args array
  execFile('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', data, '/f'],
    { windowsHide: true }, () => res());
});

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

// ---- sandbox ----
const SANDBOX = {
  directory: 'HKCU\\Software\\Classes\\X2TestDirectory',
  drive: 'HKCU\\Software\\Classes\\X2TestDrive',
  background: 'HKCU\\Software\\Classes\\X2TestBackground'
};
const keys = {
  dirShell: SANDBOX.directory + '\\shell',
  drvShell: SANDBOX.drive + '\\shell',
  bgShell: SANDBOX.background + '\\shell'
};
const DIR_CMD = keys.dirShell + '\\Xplorer2Modern\\command';
const DRV_CMD = keys.drvShell + '\\Xplorer2Modern\\command';
const BG_CMD = keys.bgShell + '\\Xplorer2Modern\\command';
const DIR_OPEN = keys.dirShell + '\\open\\command';
const DRV_OPEN = keys.drvShell + '\\open\\command';

// A fake installed exe so quoting with spaces is exercised.
const FAKE_EXE = 'C:\\Program Files\\X2 Test\\Xplorer2 Modern.exe';

async function wipeSandbox() {
  for (const k of [SANDBOX.directory, SANDBOX.drive, SANDBOX.background]) await del('HKCU\\Software\\Classes\\' + k.split('\\Software\\Classes\\')[1]);
}

let backup = null;
const app = new FolderAssociation({
  exePath: FAKE_EXE,
  isPackaged: true,
  registryBase: SANDBOX,
  getBackup: () => backup,
  setBackup: b => { backup = b; }
});
const EXPECT_DIR = `"${FAKE_EXE}" --open "%1"`;
const EXPECT_BG = `"${FAKE_EXE}" --open "%V"`;

console.log('== default-file-manager registry tests ==');

// 1. clean start
await wipeSandbox();
let st = await app.status();
check('status supported on win32', st.supported === true);
check('fresh sandbox reports not set', st.state !== 'set', st.state);

// 2. apply writes every key correctly (incl. exe path with spaces + quotes)
st = await app.apply();
const dirCmd = await q(DIR_CMD);
const drvCmd = await q(DRV_CMD);
const bgCmd = await q(BG_CMD);
check('directory verb command exact', dirCmd.exists && dirCmd.value === EXPECT_DIR, JSON.stringify(dirCmd.value));
check('same via raw reg query (independent parser)', (await qDirect(DIR_CMD)).value === EXPECT_DIR, JSON.stringify((await qDirect(DIR_CMD)).value));
check('drive verb command exact', drvCmd.exists && drvCmd.value === EXPECT_DIR);
check('background verb uses %V', bgCmd.exists && bgCmd.value === EXPECT_BG, JSON.stringify(bgCmd.value));
check('directory default points at our verb', (await q(keys.dirShell)).value === 'Xplorer2Modern');
check('drive default points at our verb', (await q(keys.drvShell)).value === 'Xplorer2Modern');
check('open verb overridden for directory', (await q(DIR_OPEN)).value === EXPECT_DIR, JSON.stringify((await q(DIR_OPEN)).value));
check('open verb overridden for drive', (await q(DRV_OPEN)).value === EXPECT_DIR);
check('menu text is our label', (await q(keys.dirShell + '\\Xplorer2Modern')).value === 'Open in Xplorer² Modern');
check('backup snapshot saved', !!backup && backup.items?.length === 4, JSON.stringify(backup?.items?.length));
check('status now set with parts', st.state === 'set' && st.parts.directory && st.parts.drive, JSON.stringify(st.parts));

// 3. tampering: revert must NOT clobber a value that changed after us
await set(DIR_OPEN, 'C:\\Somewhere\\Else.exe --open "%1"');
st = await app.revert();
check('tampered value preserved on revert', (await q(DIR_OPEN)).value === 'C:\\Somewhere\\Else.exe --open "%1"');
check('revert reports the skip', Array.isArray(st.skipped) && st.skipped.some(s => s.key === DIR_OPEN), JSON.stringify(st.skipped));
check('our verb keys removed after revert', !(await qKey(DIR_CMD)) && !(await qKey(BG_CMD)));
check('backup cleared after revert', backup === null);
// restore original (empty) state for the clean re-test
await del(DIR_OPEN); await del(keys.dirShell + '\\open');

// 4. clean apply + revert restores prior state exactly
backup = null;
await app.apply();
check('re-applied', (await app.status()).state === 'set');
st = await app.revert();
check('verb key gone after clean revert', !(await qKey(DIR_CMD)));
check('open subtree removed (did not exist before)', !(await qKey(keys.dirShell + '\\open')), JSON.stringify(await q(DIR_OPEN)));
check('background verb gone', !(await qKey(BG_CMD)));
check('status not-set after revert', st.state !== 'set', st.state);
check('no leftover default value', (await q(keys.dirShell)).exists === false);

// 5. safety: dev build refuses
const devApp = new FolderAssociation({ exePath: FAKE_EXE, isPackaged: false, registryBase: SANDBOX, getBackup: () => null, setBackup: () => {} });
let devErr = null;
try { await devApp.apply(); } catch (e) { devErr = e; }
check('dev build refuses apply', !!devErr && /installed build/i.test(devErr.message), devErr && devErr.message);

// cleanup sandbox
await wipeSandbox();
const leftover = (await qKey(SANDBOX.directory)) || (await qKey(SANDBOX.drive)) || (await qKey(SANDBOX.background));
check('sandbox fully cleaned', !leftover);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
