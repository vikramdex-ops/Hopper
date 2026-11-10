# Changelog

All notable changes to Hopper (formerly Xplorer² Modern) are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [2.3.0] — 2026-11-10

### Added
- **Progress window** for copy, move, delete, zip and extract: percentage, items done, current
  file, speed and time left, with Pause, Cancel and Hide. A name conflict is asked in the same
  window. The Transfers panel now stays closed unless you open it (Ctrl+J); Settings → Files has
  a switch to go back to the panel.
- **One pane / two panes** switch at the top right of the window, next to the window buttons.
  The choice is remembered.
- **Network** in the sidebar: computers found on the office network and your saved network
  places. Opening a computer lists its shared folders; "Add a network place" takes a
  `\\server` or `\\server\share` address. Hopper asks for a user name and password itself
  when a server needs them.
- **New** menu lists the document types the installed programs offer (Word, Excel, PowerPoint
  and others) and creates them from each program's own blank template.

### Fixed
- Searching again from a results page looked in the indexed folders instead of the folder you
  were in, so refining a search (for example `dll` to `*.dll`) could find nothing. A search from
  Home now covers every local disk.
- In Hopper's Open dialog a single click did nothing on a folder but selected a file. One click
  now highlights either, and a double click opens either.
- Folders on shares that do not send change notices are now re-checked every few seconds, so a
  file made by another program appears without a manual refresh.

### Changed
- The default Zoho Cliq endpoint points at the office's Hopper Bot.

## [2.2.0] — 2026-11-10

### Added
- **Dexterity Share sets itself up.** Hopper can now run the share server itself, so no
  separate server software has to be installed. The admin opens *Set up Dexterity Share on
  this PC…* and completes three steps: use this PC, download the tunnel program (checked
  against its published checksum), paste a GitHub token that has only the *gist* permission.
  A *Test from the internet* button confirms that clients can download.
- Client links are **self-contained**: each link carries what the download page needs to find
  the server, so nothing has to be configured on the page.
- **Bandwidth limit** for client downloads, with a separate limit for office hours, shared
  equally between downloads.
- **Disk guard**: a link is refused when it would leave the store below the free-space reserve
  (5 GB by default).
- **Download notices**: a toast and an Activity entry when a client downloads a link.
- A finished archive or PDF already on the store's drive is linked **instantly** instead of
  being copied.
- **Project folder generator**: the "Dexterity project" template asks for job number, name,
  project type, 3D platform, disciplines, sub-projects, areas and review gates, shows the
  exact folder tree before creating it, and never overwrites what exists. A second template
  makes a dated issue / submission pack. Templates are editable in Settings.
- **Sidebar**: every drive shows "free of total" under its bar, and the sidebar collapses to a
  narrow rail (button, View menu or Ctrl+Shift+B).

### Fixed
- An "Object has been destroyed" error that could appear while Hopper was closing.

## [2.1.0] — 2026-11-10

### Added
- **Dexterity Share**: create a download link for a client from any selection. Files stay on
  the office server and are reachable only through that link; expiry of 1, 3, 7, 14, 30, 60 or
  90 days, optional password and download limit, a branded download page, ready-made e-mail
  text that states the expiry date, and a "My client links" list to extend or revoke.
  Needs the server part installed once by IT (docs/DEXTERITY-SHARE-IT.md).
- **Person panel**: click a colleague to message them, send files, send a *folder link* that
  opens the same server folder in their Hopper, or ask them for files.
- **Announcements**: office-wide notices with a banner and acknowledgement, kept for PCs that
  were switched off.
- **Path Copy** menu: Name, Path, Parent Folder Path, UNC Path, UNC Parent Folder Path,
  Internet Path and Samba Path, with settings for quoting and the Ctrl+Shift+C default.
- **Viewers**: PDF with continuous scroll and Ctrl+wheel zoom; Excel workbooks; Word documents;
  the preview saved inside DWG drawings; MicroStation V7 drawings (.dgn, .i01…) drawn by Hopper
  with zoom, pan and levels; stored details for SmartSketch .sha files. No design software
  needed. A full-window document viewer.
- Hopper's own **Properties** window (size on disk, contents, attributes, path forms, access),
  **Open with** list and **folder / file picker**.

### Changed
- **Only the office admin** can create the office key or edit office settings. Other PCs join
  from the shared config, a pasted key, or an invite the admin sends over the network.
- Hopper no longer hands anything to Windows Explorer: "Show more options" and "Show in
  Explorer" are gone, and folders always open inside Hopper.
- The last tab of a pane can't be closed. Home is a start page (recent folders, pinned, Inbox,
  people, low-disk warnings); Home, Inbox and Activity stay pinned at the top of the sidebar.
- Clicking a person no longer opens Share with whatever row happened to be focused.

### Fixed
- Scanned PDF pages that lost most of their content in the preview.
- Dialogs that could not send their inputs to the helper process, and Esc not closing a dialog
  whose default button was disabled.

## [2.0.0] — 2026-11-05

A ground-up rebuild, renamed **Hopper**. Windows 10/11 only.

### Added
- **LAN sharing with `@mentions`**: pick colleagues or groups, add a note, send. Direct
  PC-to-PC transfer over TLS with the office key (up to 4 streams, resumable, SHA-256
  verified); offline recipients get it through the server inbox and receive it when Hopper
  starts. Inbox view, presence in the sidebar, drop files on a person to send.
- **Zoho Cliq notifications** through an office bot (see docs/CLIQ-SETUP.md).
- **Archives**: bundled multithreaded 7-Zip; one-key *Zip here*; presets (store, balanced,
  7z ultra, 20 MB email parts, password, RAR via WinRAR); browse archives as folders, add and
  delete inside them; smart extract, extract each, extract and delete.
- **Transfer queue**: background copy/move/zip/extract/share with bytes, speed, ETA,
  pause/resume/cancel, one conflict prompt with *apply to all*, optional checksum verify,
  retries on flaky shares, instant same-drive moves.
- **Explorer integration**: the Windows clipboard both ways, drag out to Explorer/Outlook/Cliq,
  the full Windows context menu (*Show more options*), Properties, Open with, Recycle Bin view
  and restore, real Windows file icons and shell thumbnails (PDF, DWG, Office when handlers
  are installed).
- **Undo history** for copy, move, rename, new and delete (`Ctrl+Z`).
- **Quick destinations** for Copy to / Move to, pinned and recent.
- **Office tools**: lot / transmittal packager (naming-convention check, transmittal .xlsx +
  .pdf, zip), PDF toolkit (merge, split, extract, rotate, reorder), folder templates,
  revision-aware view driven by the shared office rules.
- **Search**: background name index with instant results, content search, duplicate finder
  by content, compare and sync panes.
- **Workspaces**, live-updating folders, Activity view, Home page, command palette with
  *Go to folder*.
- New **Fluent / Windows 11** design: Mica on Windows 11, light and dark, sidebar, breadcrumbs
  with folder drop-downs, Preview & Details pane, Quick Look, image viewer.
- Shared **office config** on the server: office key, server inbox, Cliq bot, groups, folder
  templates, naming conventions, revision rules.

### Changed
- New architecture: TypeScript, Svelte 5, an engine and a LAN utility process with direct
  MessagePorts, and a native helper (HopperShell, .NET Framework 4.8) for listing, clipboard,
  shell menu and Recycle Bin. Heavy libraries load on first use.
- Sandboxed renderer with no Node access; navigation and new windows are blocked.
- Settings are written atomically with a backup.

### Fixed (from the 1.3 review)
- Copying or moving folders, recycle-bin delete, the file context menu, double drops and drops
  from Explorer, settings that reset on save, the editor truncating files over 2 MB, mass
  rename defaulting to numbers, *New file* overwriting an existing file, `*.jpg` filters,
  selection leaking between folders, shift-click ranges, the search name filter, ZIP files
  over 4 GB, zip-slip on extract, full-file reads on the main process, and the remote-content
  window that could reach the app's API.

## [1.3.0] — 2026-10-23

### Added
- **Image viewer** (`Ctrl+I`, IrfanView-style): wheel zoom at cursor, fit /
  actual-size, 10–1600% with live percentage, drag-pan, 90° rotate both ways,
  flip, filmstrip of sibling images, slideshow, fullscreen and an Info panel with
  real EXIF (camera, lens, exposure, ISO, dimensions) read in the main process.
  Arrow navigation keeps the pane selection in sync.
- **Quick Look overlay** (`Space`): instant preview of the focused file using the
  same rich renderer, arrow keys to walk the folder, quick actions, `Escape` to
  close.
- **Rich preview renderer** shared by the pane, Quick Look and the viewer: rendered
  markdown, sandboxed HTML, CSV/TSV tables, JSON/XML/YAML colouring, font specimens
  for font files, archive entry listings, and a hex/metadata fallback for binaries.
- **Explorer parity**: middle-click a folder to open it in a new tab (a file opens
  with its default app), middle-click a tab to close it, drag tabs to reorder,
  `Ctrl+W` closes a tab, `Alt+D` / `Ctrl+L` focus the address bar. All documented
  in the shortcut sheet and the command palette.
- Wider file-type taxonomy (more image, video, audio, font and source extensions)
  feeding the Type column, icons, previews and filters.

### Changed
- **Single custom title bar** on Windows/Linux (`frame: false`): one app name, one
  set of window buttons, drag anywhere, double-click to maximise, Windows-style red
  close hover. macOS keeps the native traffic lights inset over the same bar.
  The maximise/restore glyph now follows real main-process window state (snap,
  Win+Up, zoom), not a guess.
- Smoke suite grew to 52 steps covering the viewer, Quick Look and the new mouse /
  keyboard parity; the README gallery gained an eleventh scene (the image viewer)
  and all shots now show the new title bar.

## [1.2.0] — 2026-10-23

### Added
- **Default file manager** (Windows, per-user): registers folders and drives for
  the current account only, snapshots the previous default first, reverts safely.
- **Light / dark theme toggle** in the ribbon and settings, persisted per profile.
- **Silent auto-update** via `electron-updater` with published metadata.
- Screenshot studio (`npm run shots`) driving the real app over CDP.

## [1.1.0] — 2026-10-22

### Added
- **Unified icon system**: all chrome, menus, tree, list, preview and dialogs now
  use one inline-SVG set (`src/js/icons.js`, 77 icons) instead of mixed emoji.
- **Browser memory per pane**: back / forward / up buttons with disabled states,
  right-click history dropdowns, history persisted with the pane layout, and a
  recent-locations dropdown in the address bar (history, recent folders, bookmarks).
- **Preview metadata card** that always shows the full resource path, parent folder,
  kind, size in bytes, modified/created/accessed timestamps and attributes, each row
  copyable, plus copy/reveal/editor/lock actions in the pane header.
- **One structured popup model** (`src/js/popup.js`) used by context menus *and* the
  command palette: groups, separators, icons, hints, hot/toggled state and a real
  keyboard-hint column with `<kbd>` chips and arrow/Enter/Esc navigation.
- Command palette rebuilt with grouped commands, icons, hints and live filtering.
- Tab context menu (duplicate, rename, lock, close others, copy path).
- `Archive selection…` now really creates ZIP files (built-in ZIP writer).
- Missing IPC handlers: window controls, terminal-here, captured commands,
  timestamp/attribute writes, open-with.
- README, changelog, shipping checklist.
- GitHub Actions CI (static checks) and a matrix installer workflow that publishes
  Windows NSIS/portable, macOS dmg/zip and Linux AppImage/deb to Releases.
- Dependency-free icon generator (`tools/make-icon.mjs`) producing PNG + ICO.

### Changed
- Stylesheet rebuilt as an organised design system (tokens → primitives → chrome →
  panels → menus), removing duplicated blocks and aligning heights, radii and states.
- Buttons, address bar, drive chips, tabs, status bar and preview header all share
  the same button/input/toggle treatment.
- Path-copy module rewritten; it was syntactically broken and the mode list was not
  iterable. All 14 modes now work and the default is persisted.
- Preview media URLs go through a fixed `x2file:///p/<path>` handler, so images,
  video, audio and PDFs actually stream (including range requests).
- File-type detection lives in one module (`src/js/filetypes.js`) shared by the icon
  mapper, Type column, previews and filters.

### Fixed
- Boot-time module syntax error that prevented the renderer from loading.
- Preview close button called a non-existent method; ribbon toggle states now sync.
- Duplicate `copyPaths*` methods, inverted context-menu `disabled` flag, invalid
  `open with` IPC name, archive ZIP call passing a callback instead of a job id.
- Window minimise/maximise/close buttons now work through IPC.
- `process.env` usage in the renderer removed.

## [1.0.0] — 2026-10-21

Initial internal build: dual panes, tabs, tree, list/thumbnail views, scrap panes,
search, duplicates, compare, dialogs, settings and the smoke harness.
