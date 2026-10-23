# Changelog

All notable changes to Xplorer² Modern are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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
- README, changelog, shipping checklist, MIT licence.
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
