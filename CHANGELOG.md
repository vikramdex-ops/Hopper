# Changelog

All notable changes to Xplorer² Modern are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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
