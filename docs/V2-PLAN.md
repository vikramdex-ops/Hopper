# Hopper 2.0 — build plan

Hopper is the v2 rebuild of Xplorer² Modern: an office file manager for Windows with LAN sharing,
fast archives and a transfer queue. Interview decisions are dated 2026-11-05.

## Decisions

| Area | Decision |
|---|---|
| Name | **Hopper** (renamed because xplorer² is zabkat's trademark) |
| Platform | Windows 10/11 x64 only |
| Foundation | Electron + TypeScript + Vite + Svelte 5; heavy work in background processes |
| Look | Fluent 11: Mica on Win 11 (solid fallback on Win 10), Segoe UI Variable, sidebar, breadcrumbs |
| Users | Whole Dexterity office, fewer than 20 PCs on one subnet (10.0.0.x) |
| LAN | Direct PC-to-PC transfer with fallback to a server inbox on U:; auto-accept to Inbox |
| Cliq | One office bot sends a DM to each recipient |
| Archives | Bundled 7-Zip engine; installed WinRAR for creating .rar |
| Repo | Public, renamed to Hopper, landing page on GitHub Pages |
| Delivery | One complete drop (v2.0.0) |

## Process model

```
main (thin)            window, protocols, IPC router, tray, updater, OS clipboard/drag
 ├─ renderer           Svelte UI: no Node, sandboxed, talks only to the preload API
 ├─ engine  (utility)  transfer queue, delete/undo journal, archives (7z), hashing,
 │                     folder sizes, thumbnails cache, PDF ops, packager
 ├─ indexer (utility)  search index + recursive watchers (low priority)
 └─ lan     (utility)  UDP discovery, TLS-PSK transfer server/client, server-inbox
                       fallback, Cliq bot notifier
```

The main process never reads file contents and never makes a blocking call. Each utility process
talks to the renderer through its own MessagePort, so a long copy never delays a directory listing.

## Engine contracts

- **Listing**: `opendir` streamed in batches of 500; stat runs with a concurrency of 32. Junctions
  and symlinks are resolved, and Windows attributes (hidden, system) are read through
  `fs.statSync(...).mode` plus `GetFileAttributes`, called through PowerShell-free code. Listings
  arrive in pages, and every request carries a token so a stale result can be dropped.
- **Transfers**: one queue. Each job is a list of resolved items, with progress counted in bytes.
  - A move within the same volume is a rename.
  - Small files go through `copyFile` with 4 in parallel.
  - Large files are streamed in 4 MB chunks so they can be paused or cancelled.
  - Conflict policy: ask once, then apply to all. Optional SHA-256 verify after copying.
  - Network errors are retried with back-off.
- **Undo journal**: covers copy (delete what was created), move and rename (move it back), new
  (delete it) and recycle (restore from the Recycle Bin by original path).
- **Archives**: 7z runs as a child process with `-mmt=on`. Progress comes from `-bsp1`. Supported
  actions: create with a preset, list, extract (smart), and browse inside an archive as a virtual
  folder. Creating .rar uses `Rar.exe` when WinRAR is installed.
- **Thumbnails**: `nativeImage.createThumbnailFromPath` (the Windows shell, so PDF and DWG
  thumbnails work whenever a handler is installed), cached on disk under the user's data folder
  (key = path + mtime + size), with an LRU memory cap.
- **Search index**: names only, kept in memory as packed arrays and persisted to the index folder.
  It is updated by recursive `fs.watch`. Content search runs on demand with a streaming reader.

## LAN protocol

- **Discovery**: a UDP broadcast on port 47820 every 5 s plus on change. The beacon carries
  `{id, user, displayName, host, email, port, version, status}`.
- **Transfer**: TLS 1.2 PSK on TCP port 47821. The office key is created once and stored in the
  shared office config, so unknown devices can neither push nor pull. Up to 4 streams run per
  share. The receiver writes `.hopper-part` files and resumes from their length. Each file is
  verified with SHA-256.
- **Offline fallback**: the sender writes the files to
  `U:\_HopperInbox\<user>\<date> from <sender>\` plus a `manifest.json`. The recipient's app picks
  them up and moves them into their local Inbox.
- **Notes** (2.1): a share has a `kind` — `files`, `message`, `link` (a pointer to a folder on a
  shared drive) or `request`. The last three are an offer with no files that the receiver
  completes at once; offline, they are a server-inbox drop holding only `manifest.json`.
- **Announcements** (2.1): posted by admins/announcers, pushed to online PCs over the TLS channel
  (hello role `small`, one frame, the receiver answers `ok`; retried) and kept in
  `announcements.json` next to `office.json`. Acknowledgements return the same way and are filed
  per user in `announcement-acks\`.
- **Office key** (2.1): only an admin (`office.admins`) creates it and saves the office config.
  Other PCs read it from the config, or join with a pasted key or from an admin's two-minute LAN
  invite (an unsigned datagram on the discovery port; see OFFICE-SETUP.md for the trade-off).
- **Cliq**: an office bot (an incoming webhook URL plus a zapikey) lives in the shared office config
  on U:, never in the repo. Each person's Zoho email comes from their profile.

## UI map

- **Title bar**: back, forward, up, breadcrumbs (click to jump, type to edit), search box.
- **Command bar**: New, Cut/Copy/Paste, Rename, Share, Zip, Sort, View, a "more" menu, and a
  dual-pane toggle.
- **Sidebar**:
  - Quick access (pinned)
  - Workspaces
  - Drives, with capacity
  - Network locations
  - People, with presence
  - Inbox
  - Activity
- **Panes**: tabs; details, list and grid views; virtualised rows with node reuse; revision
  grouping; column chooser.
- **Inspector** (right): preview, metadata and actions. Quick Look on Space, plus an image viewer.
- **Transfer drawer** (bottom): the queue, speed graph, conflicts and history.
- **Share composer**: a field with an `@` picker for people and groups, a message box, a "zip
  first" option and a Cliq toggle.
- **Command palette** (Ctrl+K); Settings as a full page.

## Office tools

- **Lot packager**: choose files, check names against a convention, zip, write a transmittal
  (.xlsx and .pdf), then share or drop to the server.
- **PDF toolkit** (pdf-lib, plus pdf.js for thumbnails): merge, split, extract, reorder, rotate,
  batch print.
- **Revision view**: rev token patterns and ordering live in Settings, not in code, and are shared
  through the office config. When the ordering can't be worked out, the file is flagged "order
  unknown"; Hopper never guesses.
- **Folder templates**: JSON trees stored in the office config, created in one click.

## Disk rule

Builds and dev runs keep every cache, temp and user-data folder under `<work-folder>\_Claude_Work`.
