// @ts-nocheck
// Per-user "open folders with this app" registration.
//
// Windows has no supported API for replacing File Explorer as the default file
// manager, so this does what every alternative file manager does: it registers
// per-user shell verbs under HKCU\Software\Classes for real filesystem folders
// (Directory) and drives (Drive), plus an optional background verb, snapshots
// whatever was there before, and can restore it exactly.
//
// Deliberately NOT touched:
//   - Folder (special/virtual folders: This PC, Recycle Bin, Control Panel)
//   - Explorer's Win+E handling and the common file dialogs
//   - any UserChoice hash (those are protected by Windows on purpose)
//
// Everything here is per-user (no elevation) and never claims to be a
// Windows-wide "default"; the UI reports exactly what is registered.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERB = 'Hopper';
const APP_NAME = 'Hopper';

function reg(args, timeout = 8000) {
  return new Promise(resolve => {
    execFile('reg.exe', args, { windowsHide: true, timeout, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => resolve({
        code: error && typeof error.code === 'number' ? error.code : 0,
        out: String(stdout || '') + String(stderr || '')
      }));
  });
}

/** Does the key itself exist? */
async function keyExists(key) {
  const r = await reg(['query', key]);
  return r.code === 0;
}

let qseq = 0;

/**
 * Read a key's default value. Uses `reg export` (UTF-16LE file) instead of
 * `reg query`, because reg.exe prints piped output in the console's ANSI/OEM
 * code page, which mangles any non-ASCII character in paths or labels — that
 * would break exact ownership comparisons for installs under e.g. C:\Users\José.
 * Returns { exists, value } where `exists` means the default value is present.
 */
async function query(key) {
  const file = path.join(os.tmpdir(), `hopper-q${process.pid}-${qseq++}.reg`);
  const r = await reg(['export', key, file, '/y'], 10000);
  if (r.code !== 0) { try { fs.unlinkSync(file); } catch { /* best effort */ } return { exists: false, value: null }; }
  let text = '';
  try { text = fs.readFileSync(file, 'utf16le'); }
  catch { return { exists: false, value: null }; }
  finally { try { fs.unlinkSync(file); } catch { /* best effort */ } }
  for (const line of text.split(/\r?\n/)) {
    // `@="data"` with \" and \\ escapes (verified against reg export output)
    const m = line.match(/^@="((?:[^"\\]|\\.)*)"\s*$/);
    if (m) return { exists: true, value: m[1].replace(/\\([\\"])/g, '$1') };
  }
  return { exists: false, value: null };
}

/**
 * Write a value via `reg add` (never `reg import`): writing through reg.exe is
 * reliable on locked-down machines where regedit's import engine silently
 * no-ops, and it needs no temp .reg file or encoding steps.
 */
async function setValue(key, data, name = null) {
  const args = ['add', key];
  if (name) args.push('/v', name); else args.push('/ve');
  args.push('/t', 'REG_SZ', '/d', String(data), '/f');
  const r = await reg(args);
  return { ok: r.code === 0 || /The operation completed successfully/i.test(r.out), out: r.out };
}

async function mustSet(key, data, name = null) {
  const r = await setValue(key, data, name);
  if (!r.ok) throw new Error(r.out.trim() || `registry write failed: ${key}`);
}

async function deleteKey(key) {
  const r = await reg(['delete', key, '/f']);
  return r.code === 0 || /unable to find/i.test(r.out);
}

async function deleteValue(key) {
  const r = await reg(['delete', key, '/ve', '/f']);
  return r.code === 0 || /unable to find/i.test(r.out);
}

/** Ask the shell to re-read associations (SHChangeNotify via PowerShell, best effort). */
function notifyShell() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  const script = 'Add-Type -Name N -Namespace W -MemberDefinition \'[DllImport("shell32.dll")] public static extern void SHChangeNotify(int f, int u, IntPtr a, IntPtr b);\'; [W.N]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)';
  return new Promise(resolve => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20000 },
      err => resolve(!err));
  });
}

class FolderAssociation {
  /**
   * @param {{exePath:string, isPackaged:boolean, getBackup:()=>any, setBackup:(b:any)=>void}} opts
   */
  constructor(opts) {
    this.exePath = opts.exePath;
    this.isPackaged = !!opts.isPackaged;
    this.getBackup = opts.getBackup;
    this.setBackup = opts.setBackup;
    // Overridable so the test harness can point at sandbox keys.
    const base = opts.registryBase || {
      directory: 'HKCU\\Software\\Classes\\Directory',
      drive: 'HKCU\\Software\\Classes\\Drive',
      background: 'HKCU\\Software\\Classes\\Directory\\Background'
    };
    this.keys = {
      directory: `${base.directory}\\shell`,
      drive: `${base.drive}\\shell`,
      background: `${base.background}\\shell`
    };
  }

  expectedCommand(arg = '%1') {
    return `"${this.exePath}" --open "${arg}"`;
  }

  verbKey(base) { return `${base}\\${VERB}`; }
  verbCommandKey(base) { return `${base}\\${VERB}\\command`; }

  /** What is registered right now, and who effectively opens a folder today. */
  async status() {
    if (process.platform !== 'win32') {
      return { supported: false, state: 'unsupported', label: 'Windows only' };
    }
    const [dirVerb, dirDef, dirOpen, drvVerb, drvDef, effective] = await Promise.all([
      query(this.verbCommandKey(this.keys.directory)),
      query(this.keys.directory),
      query(`${this.keys.directory}\\open\\command`),
      query(this.verbCommandKey(this.keys.drive)),
      query(this.keys.drive),
      query('HKCR\\Directory\\shell\\open\\command')
    ]);

    const ours = this.expectedCommand();
    const dirOk = dirVerb.exists && dirVerb.value === ours && dirDef.value === VERB;
    const drvOk = drvVerb.exists && drvVerb.value === ours && drvDef.value === VERB;
    const openOwned = !dirOpen.exists || dirOpen.value === ours;
    const active = dirOk && drvOk && openOwned;

    let owner = 'windows';
    const eff = (effective.value || '').toLowerCase();
    if (!eff) owner = 'unknown';
    else if (eff === ours.toLowerCase()) owner = 'us';
    else if (eff.includes('explorer.exe')) owner = 'windows';
    else owner = 'other';

    const state = active ? 'set' : (owner === 'other' ? 'other' : 'not-set');
    return {
      supported: true,
      state,
      label: state === 'set'
        ? 'Folders and drives open in Hopper'
        : state === 'other'
          ? 'Another app currently opens folders'
          : 'Windows Explorer opens folders',
      parts: { directory: dirOk, drive: drvOk, background: !!(await query(this.verbCommandKey(this.keys.background))).exists },
      effectiveCommand: effective.value || '',
      owner,
      backup: !!this.getBackup(),
      packaged: this.isPackaged,
      exe: this.exePath
    };
  }

  /** Register verbs, remember what was there, point folder/drive "open" at us. */
  async apply() {
    if (process.platform !== 'win32') throw new Error('Only Windows supports folder registration');
    if (!this.isPackaged) throw new Error('Run the installed build — a dev build cannot own folders');

    // Snapshot the original values once, so revert restores the true original
    // even across repeated toggles.
    if (!this.getBackup()) {
      const snapshot = [];
      for (const key of [this.keys.directory, this.keys.drive]) {
        for (const sub of ['', '\\open\\command']) {
          const full = `${key}${sub}`;
          const q = await query(full);
          // Remember whether the `open` verb key itself existed, so revert can
          // remove the whole subtree we created instead of leaving an empty
          // command key behind that wins over the machine default.
          const parent = sub ? `${key}\\open` : null;
          const parentExisted = parent ? await keyExists(parent) : undefined;
          snapshot.push({ key: full, existed: q.exists, data: q.value, parentKey: parent, parentExisted });
        }
      }
      this.setBackup({ at: Date.now(), exe: this.exePath, items: snapshot });
    }

    const cmdDir = this.expectedCommand('%1');
    const cmdBg = this.expectedCommand('%V');
    const icon = this.exePath;
    const menu = `Open in ${APP_NAME}`;

    for (const [base, arg] of [
      [this.keys.directory, cmdDir],
      [this.keys.drive, cmdDir],
      [this.keys.background, cmdBg]
    ]) {
      await mustSet(this.verbKey(base), menu);
      await mustSet(this.verbKey(base), menu, 'MUIVerb');
      await mustSet(this.verbKey(base), icon, 'Icon');
      await mustSet(this.verbCommandKey(base), arg);
    }

    // Make our verb the default and also own the conventional "open" verb,
    // since some launchers ask for `open` explicitly.
    for (const base of [this.keys.directory, this.keys.drive]) {
      await mustSet(base, VERB);
      await mustSet(`${base}\\open\\command`, cmdDir);
    }

    // ShellExecute("Hopper.exe") discovery.
    const appPathKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${path.basename(this.exePath)}`;
    await mustSet(appPathKey, this.exePath);
    await mustSet(appPathKey, path.dirname(this.exePath), 'Path');

    await notifyShell();
    return this.status();
  }

  /** Restore the snapshot, but only where the value still points at us. */
  async revert() {
    if (process.platform !== 'win32') throw new Error('Only Windows supports folder registration');
    if (!this.isPackaged) throw new Error('Run the installed build — a dev build cannot own folders');
    const snapshot = this.getBackup();
    const ours = [this.expectedCommand('%1'), this.expectedCommand('%V')];
    // We may have written either a command string or the verb name itself
    // (the `shell` default value is the verb id, not a command).
    const isOursValue = v => ours.includes(v) || v === VERB;
    const skipped = [];

    if (snapshot?.items) {
      for (const item of snapshot.items) {
        const cur = await query(item.key);
        const isOurs = cur.exists && isOursValue(cur.value);
        if (cur.exists && !isOurs) {
          // Someone changed it after us — do not clobber their choice.
          skipped.push({ key: item.key, data: cur.value });
          continue;
        }
        if (!item.existed) {
          await deleteValue(item.key);
          if (item.parentKey && item.parentExisted === false) await deleteKey(item.parentKey);
        } else {
          await mustSet(item.key, item.data || '');
        }
      }
    }

    for (const base of [this.keys.directory, this.keys.drive, this.keys.background]) {
      await deleteKey(this.verbKey(base));
    }
    // If our `open` override survived (no snapshot), removing it reveals the
    // machine-wide default again.
    for (const base of [this.keys.directory, this.keys.drive]) {
      const open = await query(`${base}\\open\\command`);
      if (open.exists && ours.includes(open.value)) await deleteKey(`${base}\\open`);
      const def = await query(base);
      if (def.exists && def.value === VERB) await deleteValue(base);
    }

    this.setBackup(null);
    await notifyShell();
    const st = await this.status();
    st.skipped = skipped;
    return st;
  }

  /** Restore a snapshot even when it is not ours (used by tests/uninstall). */
  async restoreBackupOnly() {
    const snapshot = this.getBackup();
    if (!snapshot?.items) return false;
    for (const item of snapshot.items) {
      if (!item.existed) await deleteValue(item.key);
      else await mustSet(item.key, item.data || '');
    }
    this.setBackup(null);
    await notifyShell();
    return true;
  }
}

export default { FolderAssociation, VERB, APP_NAME, query, keyExists, setValue, notifyShell };
