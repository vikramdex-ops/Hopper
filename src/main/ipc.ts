// Main-process IPC. Only OS-integration lives here: windows, dialogs, shell, clipboard,
// drag-out, recycle bin, settings. File work goes to the engine over a MessagePort.
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme, shell, systemPreferences } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, promises as fsp } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { release } from 'node:os'
import { applyTheme, ctx, pushOfficeToUtilities } from './ctx'
import { clearThumbCache } from './protocol'
import { checkForUpdates, installUpdate, updaterState } from './updater'
import defmgr from './defmgr'
import { lockOffice, officeMeta, officeUser, revokeOffice, saveOffice } from './officeops'
import { registerNetworkIpc } from './network'
import { canRunAsAdmin, shortcutBaseName, shortcutName } from '@shared/shellops'
import type { OfficeConfig, Settings } from '@shared/types'

const h = (name: string, fn: (...args: any[]) => unknown) => ipcMain.handle(name, (_e, ...args) => fn(...args))

let identity: any
async function whoAmI() {
  if (identity) return identity
  try {
    identity = await ctx.shell.call('user', {}, 8000)
  } catch {
    identity = { user: process.env.USERNAME ?? 'user', displayName: process.env.USERNAME ?? 'user', host: process.env.COMPUTERNAME ?? '', domain: process.env.USERDOMAIN ?? '' }
  }
  return identity
}

let folderAssoc: any
function assoc() {
  folderAssoc ??= new defmgr.FolderAssociation({
    exePath: app.getPath('exe'),
    isPackaged: app.isPackaged,
    getBackup: () => (ctx.settings.data as any).folderAssocBackup,
    setBackup: (b: any) => ctx.settings.set({ folderAssocBackup: b } as any)
  })
  return folderAssoc
}

export function registerIpc() {
  registerNetworkIpc()
  // --- app / window -------------------------------------------------------
  h('app:info', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    packaged: app.isPackaged,
    portable: ctx.settings.portable,
    home: app.getPath('home'),
    desktop: app.getPath('desktop'),
    documents: app.getPath('documents'),
    downloads: app.getPath('downloads'),
    pictures: app.getPath('pictures'),
    userData: app.getPath('userData'),
    identity: await whoAmI(),
    dark: nativeTheme.shouldUseDarkColors,
    accent: (() => { try { return '#' + systemPreferences.getAccentColor().slice(0, 6) } catch { return '#0067c0' } })(),
    win11: Number(release().split('.')[2] ?? 0) >= 22000,
    loginItem: app.getLoginItemSettings().openAtLogin
  }))
  h('win:minimize', () => ctx.win?.minimize())
  h('win:toggleMaximize', () => (ctx.win?.isMaximized() ? ctx.win.unmaximize() : ctx.win?.maximize()))
  h('win:close', () => ctx.win?.close())
  h('win:isMaximized', () => !!ctx.win?.isMaximized())
  h('win:fullscreen', (on: boolean) => ctx.win?.setFullScreen(on))
  h('win:devtools', () => ctx.win?.webContents.toggleDevTools())
  h('app:quit', () => {
    ctx.quitting = true
    app.quit()
  })
  h('app:setLogin', (on: boolean) => app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] }))
  h('app:relaunch', () => {
    ctx.quitting = true
    app.relaunch()
    app.quit()
  })

  // --- settings / office --------------------------------------------------
  h('settings:get', () => ctx.settings.data)
  h('settings:set', (patch: Partial<Settings>) => {
    const themeChanged = patch.theme && patch.theme !== ctx.settings.data.theme
    const lanChanged = ['officeKeyOverride', 'lan', 'profile', 'inboxDir', 'parallelSmallFiles', 'verifyCopies', 'archivePresets', 'defaultPreset'].some((k) => k in patch)
    ctx.settings.set(patch)
    if (themeChanged) applyTheme()
    if (lanChanged) pushOfficeToUtilities()
    return true
  })
  h('office:get', async () => ({ config: ctx.office.data, path: ctx.office.loadedFrom, error: ctx.office.error, meta: officeMeta(officeUser(await whoAmI())) }))
  h('office:load', async (path: string) => {
    ctx.settings.set({ officeConfigPath: path })
    await ctx.office.load(path)
    pushOfficeToUtilities()
    return { config: ctx.office.data, path: ctx.office.loadedFrom || path, error: ctx.office.error, meta: officeMeta(officeUser(await whoAmI())) }
  })
  h('office:save', async (cfg: OfficeConfig, opts?: { moveTo?: string }) => {
    // admins only; enforced here, not just in the UI
    const r = await saveOffice(officeUser(await whoAmI()), cfg, opts)
    pushOfficeToUtilities()
    return r
  })
  /** Mark the office as set up by this PC; other PCs lock their Office page on their next poll. */
  h('office:lock', async () => {
    const user = officeUser(await whoAmI())
    await lockOffice(user)
    pushOfficeToUtilities()
    return { config: ctx.office.data, path: ctx.office.loadedFrom, error: ctx.office.error, meta: officeMeta(user) }
  })
  /** Undo the setup: every PC gets the full Office page back, to set the office up elsewhere. */
  h('office:revoke', async () => {
    const user = officeUser(await whoAmI())
    await revokeOffice(user)
    pushOfficeToUtilities()
    return { config: ctx.office.data, path: ctx.office.loadedFrom, error: ctx.office.error, meta: officeMeta(user) }
  })

  // --- dialogs ------------------------------------------------------------
  h('dialog:folder', async (title?: string, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(ctx.win!, { title, defaultPath, properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  h('dialog:files', async (title?: string, filters?: Electron.FileFilter[]) => {
    const r = await dialog.showOpenDialog(ctx.win!, { title, filters, properties: ['openFile', 'multiSelections'] })
    return r.canceled ? [] : r.filePaths
  })
  h('dialog:save', async (title: string, defaultPath: string, filters?: Electron.FileFilter[]) => {
    const r = await dialog.showSaveDialog(ctx.win!, { title, defaultPath, filters })
    return r.canceled ? null : r.filePath
  })

  // --- shell --------------------------------------------------------------
  h('shell:open', async (p: string) => {
    const err = await shell.openPath(p)
    if (err) throw new Error(err)
    return true
  })
  h('shell:openExternal', (url: string) => (/^(https?|mailto):/i.test(url) ? shell.openExternal(url) : false))
  h('shell:shellNew', () => ctx.shell.call('shellNew', {}, 20000))
  h('shell:openWithList', (p: string) => ctx.shell.call('openWithList', { path: p }, 15000))
  h('shell:openWithInvoke', (p: string, name: string) => ctx.shell.call('openWithInvoke', { path: p, name }, 30000))
  h('shell:openWithApp', (exe: string, p: string) => {
    execFile(exe, [p], { windowsHide: false }).unref()
    return true
  })
  // "More options": the real Windows context menu (native/ShellMenu.cs). It stays open until the user picks or
  // clicks away, so there is no practical time limit.
  h('shell:menu', (paths: string[], folder?: string, extended?: boolean) =>
    ctx.shell.call('shellMenu', { paths: Array.isArray(paths) ? paths.filter((p) => typeof p === 'string').slice(0, 500) : [], folder: typeof folder === 'string' ? folder : '', extended: extended === true }, 0)
  )
  h('shell:createShortcut', async (paths: string[]) => {
    const done: string[] = []
    const failed: { path: string; message: string }[] = []
    for (const p of Array.isArray(paths) ? paths : []) {
      try {
        const dir = dirname(p.replace(/[\\/]+$/, '')) || p
        // a drive root's shortcut goes on the desktop, as Explorer does
        const where = /^[a-z]:\\?$/i.test(p) ? app.getPath('desktop') : dir
        const lnk = join(where, shortcutName(shortcutBaseName(p), (n) => existsSync(join(where, n))))
        if (!shell.writeShortcutLink(lnk, 'create', { target: p, cwd: dir })) throw new Error("Windows couldn't write the shortcut")
        done.push(lnk)
      } catch (e: any) {
        failed.push({ path: p, message: String(e?.message ?? e) })
      }
    }
    return { done, failed }
  })
  /** A .lnk's target and whether it is a folder; null when it can't be read or the target is gone. */
  h('shell:readShortcut', async (p: string) => {
    try {
      const target = shell.readShortcutLink(p).target
      if (!target) return null
      const st = await fsp.stat(target)
      return { target, dir: st.isDirectory() }
    } catch {
      return null
    }
  })
  h('shell:runAsAdmin', (p: string) =>
    new Promise<{ ok: boolean; cancelled?: boolean; error?: string }>((resolve) => {
      if (typeof p !== 'string' || !canRunAsAdmin(extname(p))) return resolve({ ok: false, error: 'This file type cannot run as administrator' })
      // The path travels in an environment variable, never inside the command text. Windows file names
      // cannot contain a double quote, so quoting it for the child's command line is safe.
      const script = [
        "$ProgressPreference = 'SilentlyContinue'",
        '$p = $env:HOPPER_TARGET; $d = Split-Path -LiteralPath $p; $x = [IO.Path]::GetExtension($p).ToLowerInvariant()',
        'try {',
        "  if ($x -eq '.ps1') { Start-Process -FilePath powershell.exe -Verb RunAs -WorkingDirectory $d -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('\"' + $p + '\"')) }",
        "  elseif ($x -eq '.msi') { Start-Process -FilePath msiexec.exe -Verb RunAs -ArgumentList @('/i',('\"' + $p + '\"')) }",
        '  else { Start-Process -FilePath $p -Verb RunAs -WorkingDirectory $d }',
        '} catch { $c = $_.Exception.InnerException; if ($c -and $c.NativeErrorCode -eq 1223) { exit 2 }; [Console]::Out.WriteLine($_.Exception.Message); exit 1 }'
      ].join('\n')
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 10 * 60000, env: { ...process.env, HOPPER_TARGET: p } },
        (err: any, stdout) => {
          if (!err) return resolve({ ok: true })
          if (err.code === 2) return resolve({ ok: false, cancelled: true })
          resolve({ ok: false, error: String(stdout || err.message).trim().split(/\r?\n/)[0] })
        }
      )
    })
  )
  h('shell:props', (paths: string[]) => ctx.shell.call('props', { paths }, 60000))
  h('shell:setAttrs', (paths: string[], set: number, clear: number) => ctx.shell.call('setAttrs', { paths, set, clear }, 60000))
  h('shell:cluster', (p: string) => ctx.shell.call('cluster', { path: p }, 8000))
  h('shell:shares', () => ctx.shell.call('shares', {}, 8000))
  h('shell:print', (paths: string[]) =>
    Promise.all(
      paths.map(
        (p) =>
          new Promise<boolean>((resolve) => {
            // The shell "print" verb hands the file to its registered app (Acrobat, Word…).
            execFile(
              'powershell.exe',
              // The path travels in an environment variable: with -Command, PowerShell 5.1 parses trailing
              // arguments as part of the command text, so a file name could otherwise run as code.
              ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:HOPPER_TARGET -Verb Print'],
              { windowsHide: true, timeout: 60000, env: { ...process.env, HOPPER_TARGET: p } },
              (err) => resolve(!err)
            )
          })
      )
    )
  )
  h('shell:terminal', (cwd: string) => {
    execFile('wt.exe', ['-d', cwd], { windowsHide: false }, (err) => {
      if (err) execFile('cmd.exe', ['/c', 'start', 'powershell.exe', '-NoExit', '-Command', `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'`], { cwd })
    })
    return true
  })
  h('shell:trash', async (paths: string[]) => {
    const done: string[] = []
    const failed: { path: string; message: string }[] = []
    for (const p of paths) {
      try {
        await shell.trashItem(p)
        done.push(p)
      } catch (e: any) {
        failed.push({ path: p, message: String(e?.message ?? e) })
      }
    }
    return { done, failed }
  })
  h('shell:restore', (paths: string[]) => ctx.shell.call('recycleRestore', { paths }, 60000))
  h('shell:recycleList', () => ctx.shell.call('recycleList', {}, 60000))
  h('shell:drives', () => ctx.shell.call('drives', {}, 8000))
  // Windows Firewall: is there an enabled inbound allow rule for this exe? Reading rules needs no
  // administrator rights; adding one does (one UAC prompt). Re-allowing replaces our rule instead of
  // stacking duplicates.
  const FW_RULE = 'Hopper LAN sharing'
  const firewallStatus = () =>
    new Promise<{ allowed: boolean; disabled: boolean; checked: boolean }>((resolve) => {
      execFile('netsh.exe', ['advfirewall', 'firewall', 'show', 'rule', `name=${FW_RULE}`, 'verbose'], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
        const out = String(stdout || '')
        // "No rules match" exits non-zero; anything else unreadable counts as not checked
        if (err && !out.trim()) return resolve({ allowed: false, disabled: false, checked: false })
        const exe = app.getPath('exe').toLowerCase()
        const blocks = out.split(/\r?\n\s*\r?\n/).filter((b) => b.toLowerCase().includes(exe))
        // labels are localised; "Enabled: No" is only recognised on English Windows, otherwise trust the rule
        const enabled = blocks.filter((b) => !/^\s*Enabled:\s*No\s*$/im.test(b))
        resolve({ allowed: enabled.length > 0, disabled: blocks.length > 0 && !enabled.length, checked: true })
      })
    })
  h('shell:firewallStatus', firewallStatus)
  h('shell:firewall', async () => {
    const exe = app.getPath('exe')
    const del = `advfirewall firewall delete rule name="${FW_RULE}" program="${exe}"`
    const add = `advfirewall firewall add rule name="${FW_RULE}" dir=in action=allow program="${exe}" enable=yes profile=private,domain`
    const cmd = `netsh ${del} >nul 2>&1 & netsh ${add}`
    await new Promise<void>((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', `Start-Process cmd.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '/c ${cmd.replace(/'/g, "''")}'`],
        { windowsHide: true },
        () => resolve()
      )
    })
    // the elevated process's exit code doesn't come back through Start-Process; read the result instead
    return (await firewallStatus()).allowed
  })

  // --- clipboard (Explorer-compatible) -------------------------------------
  h('clip:writeFiles', (paths: string[], cut: boolean) => ctx.shell.call('clipWrite', { paths, cut }, 10000))
  h('clip:read', () => ctx.shell.call('clipRead', {}, 10000))
  h('clip:writeText', (text: string) => clipboard.writeText(text))

  // --- drag out to Explorer, desktop, Outlook, Cliq -----------------------
  ipcMain.on('drag:start', async (e, paths: string[]) => {
    if (!paths?.length) return
    let icon: Electron.NativeImage
    try {
      icon = await app.getFileIcon(paths[0], { size: 'normal' })
    } catch {
      icon = nativeImage.createEmpty()
    }
    e.sender.startDrag({ file: paths[0], files: paths, icon })
  })

  // --- misc ---------------------------------------------------------------
  h('thumbs:clear', () => clearThumbCache())
  h('update:check', () => checkForUpdates())
  h('update:install', () => installUpdate())
  h('update:state', () => updaterState())
  h('defmgr:status', () => assoc().status())
  h('defmgr:apply', () => assoc().apply())
  h('defmgr:revert', () => assoc().revert())
  h('fs:ensureDir', async (p: string) => {
    await fsp.mkdir(p, { recursive: true })
    return true
  })
  h('fs:parent', (p: string) => dirname(p))
  h('win:focused', () => BrowserWindow.getFocusedWindow() === ctx.win)
}
