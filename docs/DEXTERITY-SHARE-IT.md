# Dexterity Share — setup and operations

Dexterity Share lets staff send files to external clients with a download link, instead of
uploading them to WeTransfer-style sites. The client opens a Dexterity-branded page and downloads
**directly from one office PC**. Staff instructions: [DEXTERITY-SHARE.md](DEXTERITY-SHARE.md).

> **[checked]** = read from the vendor's documentation or measured against the real service on
> 10 November 2026. **[not tested]** = written from documentation, not yet run for real; see
> section 9.

## 1. Setup: three steps, about five minutes

Do this **once, on the PC that will serve the files** — a PC that stays switched on and signed in
to Windows (it can be the PC of whoever looks after Hopper). You must be an office admin in Hopper.

Open Hopper → `Ctrl+K` → **Set up Dexterity Share on this PC…** (also under *Settings → Office →
Dexterity Share → Set up…*).

**Step 1 — Use this PC as the share server.** Press **Use this PC**. Hopper creates the store
folder `PublicShares` beside `office.json` on the office server, switches itself to start with
Windows and to stay in the tray, and starts serving.

**Step 2 — Get the tunnel program.** Press **Download**. Hopper fetches Cloudflare's `cloudflared`
(about 55 MB) from its official GitHub release and compares it with the SHA-256 checksum GitHub
publishes for that file **[checked: release assets carry a `digest` field; 2026.10.7 does]**. A
file that does not match is deleted. (No internet access to GitHub from this PC? Download
`cloudflared-windows-amd64.exe` elsewhere and use **I already have it…**.)
Within a minute the bottom line turns green: *Online at ….trycloudflare.com*.

**Step 3 — Connect the pointer.** The free tunnel gets a new address whenever this PC restarts.
Hopper keeps the current address in a small note (a "gist") on the office's GitHub account, so
links already e-mailed keep working. It needs a token that may edit gists and nothing else:

1. Sign in to github.com as the office account (`vikramdex-ops`).
2. Click your picture (top right) → **Settings**.
3. Bottom of the left column → **Developer settings**.
4. **Personal access tokens** → **Tokens (classic)**.
5. **Generate new token** → **Generate new token (classic)**.
6. *Note*: `Dexterity Share pointer`. *Expiration*: **No expiration** (or a date you will remember
   to renew — when it expires, new addresses stop being published).
7. Tick **only** the box **gist** ("Create gists"). Leave every other box empty.
8. **Generate token**, copy the `ghp_…` text, paste it into Hopper, press **Connect**.

Hopper checks the token, creates one unlisted gist, publishes the first signed address and ticks
the step. Then press **Test from the internet**: Hopper makes a tiny test link, fetches it back
through the public address and deletes it. Green means clients can download. Done.

What ends up where:

| What | Where | Secret? |
|---|---|---|
| The GitHub token | This PC only, encrypted by Windows (`%APPDATA%\Hopper\share\pointer-token.bin`) | Yes — never in `office.json`, never in the repository |
| The key that signs the address | This PC only (`%APPDATA%\Hopper\share\state\pointer-key.pem`) | Yes |
| Gist id + key fingerprint | `office.json` (`publicShare.pointer`), and inside every client link | No |
| The current tunnel address | The gist, and `_server.json` in the store | No |

**Moving to another PC:** run the three steps on the new PC (same token or a new one). It gets a
new signing key, so links made before the move stop finding the server; re-send those still needed
(*My client links → Copy link* gives the new form). To avoid that, copy
`%APPDATA%\Hopper\share\state\` to the new PC before step 3.

## 2. How it works

```
 Staff PC (Hopper)                 Share-server PC (Hopper in the tray)                 Internet
 ─────────────────                 ────────────────────────────────────                 ────────
 "Create client link"
   │ copies (or links) the files over the LAN
   ▼
 \\server\…\_Hopper\PublicShares\<id>\     ◄── the store: one folder per link
        data\0 …        (the files)
        manifest.json   (title, expiry, checksums; written last)
                              │ read by
                              ▼
                 share server inside Hopper, on 127.0.0.1:47880 only
                              │
                 cloudflared ── outbound connection ──► Cloudflare ◄── client's browser
                              │
                 current address, signed ──► gist on GitHub ◄── read by the client page

 Client's link:  https://…/share/#<link id>.<gist id>.<key fingerprint>
                 GitHub Pages serves the page; everything after # stays in the browser.
```

- **Why a tunnel at all?** The office sits behind its router; nobody outside can connect *to* a PC
  inside. The tunnel program connects *out* to Cloudflare and keeps that connection open; client
  requests come down it. **No port is opened on the router or the Windows firewall.** GitHub
  Pages can only host the page (public, static files) — not the client's files.
- **Why the pointer?** The free "quick" tunnel has a random address that changes on every restart
  **[checked]**. The link carries the gist id, so the page can always look the current address
  up. No per-office configuration lives on the page host.

## 3. Security in plain words

- A person on the internet can reach only the share server, only through the tunnel, and it
  answers only: describe link `<id>`, check a password, send file `n` of link `<id>`, health check.
  A link id is 128 random bits. Nothing lists links, folders or files.
- File paths are built from the validated id and a file *number* only. `..`, encoded slashes and
  75 similar tricks were tested: all "not found".
- No response contains the PC's name, user names, paths or addresses. Clients see Cloudflare's
  addresses, never the office's.
- Passwords are stored as salted scrypt hashes; wrong guesses are limited (8 per client per
  10 minutes, 40 per link per hour).
- **The gist cannot be used to redirect clients.** The address in it is signed with a key that
  never leaves the share-server PC, and each link carries that key's fingerprint. Someone who
  stole the GitHub token could break the pointer (clients would see "can't reach our file
  server") but could not point clients at another server. The token itself can only create and
  edit gists of that account.
- Revoking a link stops it within seconds, also mid-download. Expired links are deleted a day later.
- Accept knowingly: anyone holding a link (and its password) can download; every office PC that
  can write to `_Hopper` can read the store; traffic passes through Cloudflare.

## 4. Day to day

- **The PC must stay on, signed in, with Hopper in the tray.** Sleep, sign-out, shutdown or
  quitting Hopper take every link offline until it is back. Set Windows power options to never
  sleep. Clients see a clear "temporarily unreachable" page that retries by itself.
- **Status:** the wizard's bottom line; *My client links* (online dot, downloads running, sent
  today, free space, which PC); `_server.json` in the store.
- **After a restart** the tunnel has a new address. Hopper publishes it within about a minute;
  the page may read GitHub's cached copy for up to five minutes **[checked: gist file host sends
  `max-age=300`; the gist API `max-age=60`, 60 requests/hour per client IP, both allow any
  origin]** and falls back to the API when the cached address is dead. A download running at the
  moment of a restart fails; the client retries.
- **Speed** is the office upload speed, shared with everyone. *Advanced* in the wizard: a total
  upload limit in Mbit/s and a lower one for office hours (Mon–Sat, times adjustable); several
  downloads share the limit equally. Default: no limit.
- **Disk:** new links are refused when the server drive would drop below 5 GB free (*Advanced* →
  *Keep free on the server*); the Create dialog says so and what to do.
- **Instant links:** a single finished file (zip, 7z, rar, pdf…) that already lives on the same
  server drive as the store is *linked* into the store, not copied — no waiting, no second copy
  **[checked: hard links work on the office share]**. A link shares its bytes with the original, so
  the server records size and modified time and **refuses** the download ("changed after
  sharing") if the original is later edited in place. Editing programs that save by replacing the
  file leave the shared copy as it was.
- **Logs:** `%APPDATA%\Hopper\share\logs\` (`share.log` per request, `supervisor.log`,
  `hopper-share.log`), 10 MB each, five kept. No passwords, tokens or full link ids.

### Troubleshooting

| What you see | What to do |
|---|---|
| Step 1: "cannot write to the store folder" | The server share is not connected on this PC, or you have no write access to `_Hopper`. |
| Step 1: "Port 47880 is already in use" | Another copy (the standalone service?) is running. Stop it, or change the port under Advanced. |
| Step 2: "does not match the checksum" | The download was damaged or tampered with; it was deleted. Try again later. |
| Bottom line stays "Connecting…" | This PC cannot reach Cloudflare: allow outbound port 7844 (TCP and UDP) **[checked]**; check the internet. |
| Step 3: "GitHub does not accept this token" | Mistyped, expired or deleted. Generate a new one. |
| Step 3: "not allowed to edit gists" | The token was made without the **gist** box. Generate a new one with only that box. |
| Step 3: "may not edit the pointer gist" | The token belongs to a different GitHub account than the one that made the gist. Use that account, or clear `publicShare.pointer` in `office.json` and connect again (old links then need re-sending). |
| Client: "We can't reach our file server" | Is the PC on and Hopper running? Wizard bottom line green? If the tunnel is up but the pointer has an error, step 3 shows it. |
| Client: "This file was changed after it was shared" | An instantly linked original was edited. Create a new link. |

## 5. Advanced: a fixed address instead of the quick tunnel

Cloudflare describes quick tunnels as "for testing and development", with "no uptime guarantee"
and at most 200 requests in flight **[checked]**. If that becomes a problem, *Advanced → Address*:

- **My Cloudflare tunnel (own domain):** needs a domain on a free Cloudflare account
  ("you must add a website to Cloudflare" **[checked]**). Create a tunnel in the dashboard, route
  a hostname to `http://127.0.0.1:47880`, paste the tunnel token and the address. Hopper runs
  cloudflared with the token in its environment, never on the command line.
- **My own address:** any other way that delivers HTTPS requests to `127.0.0.1:47880` on this PC
  (for example Tailscale Funnel: fixed `*.ts.net` name, ports 443/8443/10000 only, "non-configurable
  bandwidth limits" **[checked]**).

With step 3 connected, links keep the same form and keep working when you switch modes: the
signed pointer simply names the new address.

## 6. For a server nobody logs into: the standalone service

Hopper-hosted sharing needs a signed-in Windows session. For a headless server use the same code
as a service: `server/dexterity-share/` (two plain Node files; Node 20+).

1. Copy the folder to the server, copy `config.example.json` to `config.json`; set `server.store`
   (local path of `PublicShares`), `server.allowedOrigins` (`https://vikramdex-ops.github.io`),
   and `"pointer": { "gist": { "id": "<gist id>", "tokenFile": "pointer-token.txt" } }`.
2. `node supervisor.mjs --check`, then `install-windows.ps1` from an elevated PowerShell
   (scheduled task at start-up, account *Local Service*) **[not tested]**, or
   `dexterity-share.service` on Linux **[not tested]**.
3. The link fingerprint must match this server's key: after the first start, put the gist id and
   the fingerprint of `state\pointer-public.json` into `office.json` → `publicShare.pointer`
   (simplest: run the Hopper wizard once on a PC, then copy its
   `%APPDATA%\Hopper\share\state\` folder to the server's `state\`).

Do not run both on the same store at once.

## 7. The page and old links

Links made before the pointer was connected have the short form `…/share/#<id>` and need
`site/share/config.json` to name the server (`base`, or `pointers`). New links
(`#<id>.<gist>.<fingerprint>`) need nothing: `config.json` may be absent. Both forms keep working.

Links show `vikramdex-ops.github.io` — a personal account name. A GitHub organisation or a custom
domain for Pages changes that; set the new page address in *Settings → Office*.

## 8. Limits to be honest about

- Availability is that of one PC, its Windows session, the office power and internet, and
  Cloudflare's free quick-tunnel service, which promises nothing.
- Speed is the office upload speed.
- No virus scanning; no record of who downloaded beyond the client address in the log.
- The GitHub token (classic, scope `gist`) can edit *all* gists of that account. Use the office
  account, not a personal one with gists that matter.

## 9. What was tested, and what was not

Automated, on the development PC (store on the office share):

- **Server (37 checks):** as before — downloads, resume, 5 GB sizes, limits, passwords, expiry,
  revoke, hostile paths, headers, clean-up, restart — plus the bandwidth limit (measured), instant
  links and the "changed" refusal, the disk guard, and download notices.
- **Supervisor and gist pointer (20 checks)** against stand-ins for cloudflared and GitHub.
- **Client page in Microsoft Edge (20 checks):** all states, real downloads, self-contained links
  (gist file, gist API, swapped key, wrong fingerprint, unsigned pointer).
- **Setup wizard in the real app (private build):** every step, wrong tokens, bad checksum,
  self-test, quit.

Checked against the real services: GitHub's gist endpoints (CORS and cache headers), the
cloudflared release metadata (checksum field), hard links on the office share.

**Not yet run for real:** an actual cloudflared tunnel (its real output, a download through
Cloudflare, sustained large transfers and measured speed), a real GitHub token and gist, Windows
`safeStorage` in a packaged install, start-with-Windows in a packaged install, the standalone
service scripts, Linux, browsers other than Edge. Do the wizard's **Test from the internet**, then
download a real link on a phone using mobile data, before telling staff to use it.
