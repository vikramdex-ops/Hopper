# REA reverse-engineering findings — "xplorer2 Ultimate 6 4 0 Portable 2026 Latest"

**Analyst:** Buffy (Codebuff) · **Date:** 2026-10-21 · **Tooling:** REA workflow (`npx rea-agents` — installed REA CLI v6.7.0) + PowerShell VersionInfo, PE headers, 7-Zip, innounp‑2, ASCII string forensics, vendor-document comparison.

---

## 1. Executive verdict

The supplied attachment **does not contain the xplorer² application**. It is a two-part bundle from an untrusted distribution site:

| File | SHA-256 (prefix) | True identity |
|---|---|---|
| `xplorer2 Ultimate 6 4 0  Portable 2026 Latest.exe` (2.0 MB) | `D49F97715C2F87…` | **Empty Inno Setup 7.0.0.3 installer stub** — the `[Files]` list contains **zero files** |
| `.Store` (3.4 MB) | `377ABC9D367E…` | **WinRAR 6.24 (2023) self-extracting setup** (`WinRAR SFX` module, `sfxrar.pdb` by Alexander Roshal) renamed to a dot-file |

Evidence chain:

1. **PE headers.** Both files are PE32+ x86-64. `.Store` carries full `WinRAR.exe` / `InternalName: WinRAR` 6.24 version resources (© Alexander Roshal 1993‑2023). The `.exe` declares *“This installation was built with Inno Setup”* with no vendor/product metadata.
2. **Installer disassembly of setup data.** innoextract 1.9 rejects the file (`Unexpected setup loader revision: 2`), but **innounp‑2 v2.71.2** (InnoUnpacker toolset, tested statically — the installer was never executed) reads it:
   ```
   Inno Setup version detected: 7.0.0 (Unicode)
   => Signature: Inno Setup Setup Data (7.0.0.3)
   Size  Date/Time        Filename
   1645  2026-10-21       install_script.iss
   ```
   The decompiled `install_script.iss` contains an **empty `[Files]` section** — installing it would produce nothing. This is the signature of a bait/wrapper stub used by gray-market "portable" redistributions.
3. **`.Store` archive inventory.** The RAR payload inside the WinRAR SFX is the full **WinRAR 6.24 installer**: `WinRAR.exe`, `Rar.exe`, `UnRAR.exe`, `RarExt.dll` shell extension, SFX modules, `RarExtPackage.msix`, etc. — 28 files, **no xplorer² component**. Its strings confirm onlyRAR/WinRAR functionality (`IDS_EXTRACTING`, `CMT; WinRAR`, WinRAR EULA text).
4. **No xplorer² PE, INI, CHM, license or plugin artifact exists anywhere in either container** (string sweep of both binaries found no `xplorer`/`zabkat` references except in the wrapper’s filename).

Consequence: there is **no proprietary code to reverse-engineer in the attachment**, and nothing was executed. The genuine vendor page (*zabkat.com*, ©2002-2026) warns that the authentic installer is **digitally signed** and urges users to avoid untrusted sources — this attachment is exactly the case they warn about. Recommended action: **safely delete both files** and, if the real app is wanted, get the signed 21-day trial from `zabkat.com/x2down.htm` (version 6.4.0.0, 23 Aug 2026 — matching the folder name).

## 2. What was analyzed instead — the real product spec

Since the binary was unobtainable from the attachment, the full behavior specification of **xplorer² Ultimate 6.4** was reconstructed from the vendor’s official sources (zabkat.com fact sheet, tour chapters, online manual `x2h_*.htm`, Ultimate-vs-Professional comparison, v6.4 announcements) and documented as the exact feature contract for the rebuild. Highlights of the contract (full list in the build plan):

- **Dual-pane with independent folder tabs** (lock, groups, reopen), Miller columns, per-pane views.
- **Views:** details/list/thumbnails(+zoom Ctrl+wheel), column sets, sort/groups, programmable columns (~350 shell properties), enhanceable color tags & rules, visual/hyperfilters.
- **Search (Omni-finder):** wildcard/regex/fuzzy names, text-inside-files with encoding sniffing, size/date/attr/property Boolean filters, subfolder recursion, archive search, refine previous results; Ultimate adds indexed Windows Search, NTFS-MFT fast name search and Everything integration.
- **Scrap containers & mini-scrap:** cross-folder virtual collections (Ctrl+S), flat-tree browsing, save/reload.
- **Maintenance:** duplicate finder (name/date/size/property/content; faster in Ultimate), fuzzy grouping, folder stats + largest items + pie chart, empty-folder sweep, compare/sync panes (F9 marks unique/newer), mirror browsing, one-way backup rules (overwrite-if-newer / skip / rename conflicts).
- **File ops:** robust copy/move (pause/resume, filters, overwrite rule sets, error log, F5 dialog / Ctrl+F5 quick last-options), mass rename (regex, case, counters, token/property templates with preview), timestamps/attributes, split & merge, hardlink/junction/symlink paste-special, shredding, structure-only paste, multi-target paste.
- **Preview system:** quick preview (text/images/HTML/office/media), draft vs native handlers, hex/plain-text fallback, tail watch of logs, editor² inline text editor, details pane, peek popups, paired image compare.
- **Commands & automation:** `$`-token commandline templates, DOS execution with capture, UI macros, fully customizable keymap/toolbars/skins, layouts, ribbon-or-menu UI.
- **Ultimate-only:** portable operation (INI beside executable, no registry), Windows-Search-indexed + MFT name search, WCX packer plugins, faster duplicate detector; 6.4 adds cloud-status columns/overlays for OneDrive, Dropbox, Box, Proton, iCloud (overlay mode for Google Drive, pCloud, Mega), FTP/SFTP/WebDAV/webfolders via shell integrations, MTP device browsing, shell extension/preview-handler ecosystem.
- **Documented shortcuts:** Tab, Shift+Tab, Ctrl+E, Ctrl+T, Alt+arrows, Backspace, Ctrl+D, Ctrl+F, F1-F12 set, Ctrl+S (to scrap), Ctrl+P, Alt+S sticky selection, Alt+K columns, Ctrl+wheel zoom, Shift+Del, F9 compare, etc.

## 3. Rebuild decision

Per the "recreate the feature set with a modern Electron GUI" directive, the original Windows/C++ app was **not** and cannot be extracted (nothing to extract). The deliverable is a **ground-up, clean-room Electron implementation** ("Xplorer2 Modern") implementing the documented Ultimate feature contract with a redesigned UI. It contains no code or assets from either vendor; all functionality is reimplemented from behavioral documentation.
