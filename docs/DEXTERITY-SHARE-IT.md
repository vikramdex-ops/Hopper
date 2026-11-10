# Dexterity Share — installation and operations guide for IT

Dexterity Share lets staff send files to external clients with a download link, instead of
uploading them to WeTransfer-style sites. Staff create the link in Hopper; the client opens a
Dexterity-branded page and downloads **directly from the office's own server**.

This guide is for whoever installs and looks after the server part. Staff instructions are in
[DEXTERITY-SHARE.md](DEXTERITY-SHARE.md).

> Statements about Cloudflare, Tailscale and GitHub marked **[checked]** were read from the
> vendors' documentation on 10 November 2026. Anything marked **[not tested here]** was written
> from the documentation and has not been run against the real service — see section 13.

## 1. How it works

```
 Staff PC (Hopper)                    Always-on office server                        Internet
 ─────────────────                    ───────────────────────                        ────────
 "Create client link"
   │  copies files over the LAN (SMB)
   ▼
 \\server\...\_Hopper\PublicShares\<id>\      ◄── the "store": one folder per link
        data\0, data\1 …  (the files)
        manifest.json     (title, expiry, checksums; written last)
                                │ read only by
                                ▼
                      share server (node server.mjs)
                      listens on 127.0.0.1:47880 ONLY
                                │
                      cloudflared (tunnel) ── outbound connection ──► Cloudflare ◄── client's browser
                                                                           ▲
 Client receives an e-mail with                                            │ downloads the file
 https://…/share/#<id>  ──► GitHub Pages serves the page (HTML/JS only) ───┘
                            the page asks the share server for link <id>
```

Three separate parts:

| Part | Where it runs | What it holds |
|---|---|---|
| **The page** (`site/share/`) | GitHub Pages | Static HTML/CSS/JS. No files, no link ids, no secrets. |
| **The store** | A folder on the office file server | The shared files, one folder per link. |
| **The share server + tunnel** (`server/dexterity-share/`) | The always-on office machine | Serves a file only to someone who presents its link id. |

Hopper never talks to the share server to create a link: it only writes files into the store over
the office network. The share server never accepts uploads: it only reads the store.

## 2. Is the tunnel really necessary?

Yes — something of that kind is, and the tunnel is the safest form of it.

- The office server sits behind the office router (NAT). A client in another city or country
  cannot open a connection *to* it; from outside, the server has no address.
- **GitHub Pages can host the page but not the files.** Pages serves a public repository: files put
  there would be public, permanent, limited in size, and no longer "on our server".
- The only alternative to a tunnel is **port forwarding** on the router (opening an inbound port to
  the server) plus a static IP or dynamic DNS and your own TLS certificate. That exposes the
  office's address and a listening port to every scanner on the internet. We do not recommend it.

With a tunnel, the server makes an **outbound** connection to Cloudflare and keeps it open.
Clients connect to Cloudflare; Cloudflare passes each request down that already-open connection.
**No inbound port is opened on the router or on the server's firewall.** If the tunnel program
stops, the server is simply unreachable from outside again.

## 3. Security model in plain words

**What a person on the internet can reach**

- Only the share server program, and only through the tunnel.
- The share server answers exactly four kinds of request: "describe link `<id>`", "check this
  password for link `<id>`", "send file number `n` of link `<id>`", and a health check.
- A link id is 128 random bits (26 characters). It cannot be guessed, and there is no request
  that lists links, folders or files. A wrong or malformed id gets the same "not found" answer as
  anything else.

**What cannot be reached or learnt**

- The file server's other folders, the LAN, other PCs, SMB — none of it. The share server reads
  one folder (the store) and builds file paths only from the validated id and a file *number*;
  nothing typed by a client is ever used as a file name. `..`, encoded slashes and similar tricks
  were tested (section 13) and return "not found".
- The server's name, Windows user names, internal paths or IP addresses: no response or error
  message contains them. The office's public IP is not revealed either — clients only ever see
  Cloudflare's addresses.
- The password of a protected link: only a salted scrypt hash is stored. Wrong guesses are
  limited to 8 per client per 10 minutes and 40 per link per hour.

**What stays true even if something goes wrong**

- If the GitHub account or the page were tampered with, an attacker could change what the page
  shows, but could not reach files without their link ids, and link ids are never sent to GitHub
  (they travel in the `#fragment`, which browsers do not send to the page's host).
- If the quick-tunnel "pointer" token (section 8) were stolen, an attacker could not redirect
  clients: the pointer is signed with a key that never leaves the server, and the page ignores an
  unsigned or altered pointer.
- Expired links stop working at their expiry time; their files are deleted 24 hours later.
  Revoking a link in Hopper stops it within seconds, including a download already in progress.

**What you should know and accept**

- Anyone who has the link (and the password, if set) can download. Treat links like the files.
- Every office PC that can write to the store folder can create links and can read other
  people's shared files there. Keep the `_Hopper` folder office-only, as it already is.
- Downloads pass through Cloudflare's network (TLS from the client to Cloudflare, and an encrypted
  tunnel from Cloudflare to the server). Cloudflare can technically see the traffic, as with any
  site that uses Cloudflare.

## 4. Choose how clients reach the server

| | **A. Named tunnel + your own domain** (recommended) | **B. Quick tunnel** (free, pilot only) | **C. Tailscale Funnel** (free alternative) |
|---|---|---|---|
| Address | Fixed, yours: `https://files.yourdomain.com` | Random `https://<words>.trycloudflare.com`, **changes on every restart** | Fixed: `https://<machine>.<tailnet>.ts.net` |
| Needs | A Cloudflare account (free) and a domain whose DNS is on Cloudflare **[checked]** | Nothing: no account, no domain **[checked]** | A Tailscale account; MagicDNS and HTTPS enabled **[checked]** |
| Cost | The domain only (roughly ₹800–1,500 a year for a `.com`/`.in`; price not checked) | Free | Free plan available ("available for all plans" **[checked]**; plan terms for business use not checked) |
| Reliability | Cloudflare's regular tunnel service | "No uptime guarantee", "for testing and development", max 200 requests in flight **[checked]** | "Subject to non-configurable bandwidth limits" **[checked]** — unknown speed for large files |
| Extra moving part | None | The **pointer** (section 8) so e-mailed links survive address changes | None (use `tunnel.mode: "external"`) |

**Recommendation: option A.** This is a client-facing service; Cloudflare itself describes quick
tunnels as for testing, without any uptime promise, and may change or limit them at any time.
A dedicated cheap domain (it does not have to be the company's main domain, and the company's
e-mail and website DNS are not touched) removes the weakest link. It also lets the page itself
live at an address like `https://share.yourdomain.com` instead of `vikramdex-ops.github.io`
(section 9). Use option B to try the system out for a week before buying anything.

A note on Cloudflare's terms: their free-plan *CDN* terms reserve the right to limit accounts
that serve "a disproportionate percentage of pictures, audio files, or other large files"
**[checked; the clause is about the CDN and does not mention Tunnel]**. An office sending some
engineering deliverables is an ordinary use, but nobody can promise how Cloudflare will apply its
terms; if large transfers become heavy and regular, a paid plan removes the question.

## 5. Prerequisites

- An always-on machine that can read the store folder. Best: the file server itself (the store is
  then a local disk path). Windows Server / Windows 10 or 11, or Linux.
- **Node.js 20 LTS or newer** on that machine (`node --version`). Nothing else is installed with
  npm: the server is two plain files.
- **cloudflared** (for options A and B): download the Windows installer or Linux package from
  Cloudflare's downloads page and install it.
- Outbound internet from that machine: **port 7844 TCP and UDP** to Cloudflare
  (`region1.v2.argotunnel.com`, `region2.v2.argotunnel.com`) for the tunnel; port 443 for
  cloudflared's optional update checks and, in option B, for GitHub's API **[checked]**.
- The machine's clock set correctly (expiry times depend on it).

## 6. Install on Windows

1. **Create the store.** In the folder that holds Hopper's `office.json` (normally
   `…\office-share\_Hopper\`), create `PublicShares`. Office staff need *Modify* on it
   (they inherit it if `_Hopper` already allows them to write).
2. **Copy the program.** Copy the repository folder `server/dexterity-share/` to a local folder on
   the server that staff cannot write to, e.g. `D:\DexterityShare\` (not inside the shared folder).
3. **Configure.** Copy `config.example.json` to `config.json` and edit:
   - `server.store`: the **local** path of the store on this machine,
     e.g. `D:\\Shares\\office-share\\_Hopper\\PublicShares` (JSON needs `\\`).
   - `server.allowedOrigins`: the origin of the page — `https://vikramdex-ops.github.io`, or your
     own page address if you use one. No path, no trailing slash.
   - `tunnel`: see section 7 (named) or 8 (quick).
4. **Check.** In a terminal in that folder: `node supervisor.mjs --check`. Every line should say
   `ok`.
5. **Install as a start-up task.** In an **elevated** PowerShell in that folder:
   `powershell -ExecutionPolicy Bypass -File .\install-windows.ps1`
   This registers a scheduled task "Dexterity Share" that runs at start-up without anyone logged
   on, as the built-in low-privilege account *Local Service*, restarts itself if it stops, and
   grants that account the folders it needs. **[not tested here — the script was syntax-checked
   only; registering tasks was outside what could be run on the development PC.]**
6. **Tell Hopper.** On any PC: *Settings → Office → Dexterity Share*: switch it on, leave the
   store empty (default: `PublicShares` beside `office.json`) or enter its network path, set the
   page address, save to server.

If the store is on another machine (a NAS that cannot run Node), run the service on any always-on
Windows PC and give `server.store` as a UNC path. *Local Service* cannot open network shares, so
install with `-RunAs System` only if the share allows the computer account, or create a dedicated
Windows account with rights to the share and set it as the task's user in Task Scheduler (enter
its password there yourself).

### Linux

Copy the folder to `/opt/dexterity-share`, create a user `dxshare` with read/write on the store,
create `config.json` (set `tunnel.cloudflared` to `cloudflared`), run
`node supervisor.mjs --check`, then install `dexterity-share.service` (in the same folder) as
described in its header. **[not tested here — the code is plain Node and was tested on Windows.]**

## 7. Option A: named tunnel with your own domain

1. Register a domain (any registrar) and add it to a free Cloudflare account, following
   Cloudflare's steps to switch its nameservers. "Before you publish an application through your
   tunnel, you must add a website to Cloudflare." **[checked]**
2. In the Cloudflare dashboard: **Networking → Tunnels → Create a tunnel**, name it
   (e.g. `dexterity-share`). The dashboard shows an install command containing the **tunnel
   token** **[checked]**.
3. In the tunnel's **Routes** tab: **Add route → Published application**; subdomain `files`,
   your domain, service URL `http://127.0.0.1:47880` **[checked; menu names as of Nov 2026]**.
4. Choose one way to run cloudflared:
   - **Simplest:** run the dashboard's install command once. cloudflared installs itself as its own
     Windows service. In `config.json` set
     `"tunnel": { "mode": "external", "publicBase": "https://files.yourdomain.com" }`.
   - **Or supervised:** save the token alone in `tunnel-token.txt` beside `config.json` and set
     `"tunnel": { "mode": "named", "tokenFile": "tunnel-token.txt", "publicBase": "https://files.yourdomain.com" }`.
     The supervisor starts cloudflared itself and passes the token in the `TUNNEL_TOKEN`
     environment variable **[checked: the variable exists]**, never on the command line.
5. In the repository, set `site/share/config.json` to
   `{ "base": "https://files.yourdomain.com", "pointers": [], "pointerKey": null, "allowedHosts": [] }`
   and publish the site. No pointer is needed.

## 8. Option B: quick tunnel and the pointer

`"tunnel": { "mode": "quick" }` makes the supervisor run
`cloudflared tunnel --url http://127.0.0.1:47880` **[checked]**. cloudflared prints a random
`https://….trycloudflare.com` address; the supervisor reads it, checks from the outside that it
really reaches our server, and then publishes it so that links already e-mailed keep working.

**The pointer.** The client page cannot know a random address in advance, so the supervisor writes
a small file `pointer.json` (`{ "base": "https://….trycloudflare.com", "updated": …, "sig": … }`)
to a GitHub repository, and the page reads it. Design choices:

- **A separate, public repository that contains nothing else** (e.g. `dexterity-share-pointer`),
  not the Hopper repository. The server holds a token that can write to it; that token must not
  be able to touch the repository that ships Hopper to every office PC.
- **A fine-grained personal access token** limited to that one repository with
  *Contents: Read and write* **[permission name not re-checked today]**. Saved in
  `pointer-token.txt` beside `config.json`; the install script restricts that file to
  administrators and the service account. Create the token yourself in GitHub's settings.
- **Signed.** On first start the supervisor creates a key pair (`state\pointer-key.pem`, private,
  never leaves the server). `node supervisor.mjs --check` prints the public key; paste it into
  `site/share/config.json` as `pointerKey`. The page then accepts only pointers signed by the
  server, and only addresses ending in `.trycloudflare.com`.
- **Two ways to read it**, in `site/share/config.json`:
  ```json
  { "base": "",
    "pointers": ["https://raw.githubusercontent.com/OWNER/dexterity-share-pointer/main/pointer.json",
                 "https://api.github.com/repos/OWNER/dexterity-share-pointer/contents/pointer.json"],
    "pointerKey": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
    "allowedHosts": ["*.trycloudflare.com"] }
  ```
  The first is GitHub's file CDN: no rate limit worth mentioning, but it may serve a copy a few
  minutes old (about five; not re-checked today). The second is GitHub's API: always current, but
  limited to 60 anonymous requests per hour per client IP address **[checked]**. The page uses the
  first; only if the address it gets does not answer does it ask both again, freshly.
- **While the pointer is stale** (the minutes after an address change) or the server is down, the
  client sees "We can't reach our file server right now", and the page retries by itself every
  5–60 seconds. Nothing is lost; the link works again as soon as the new address is published.

What quick tunnels cost you, honestly: every restart of the server, of cloudflared, or of the
office internet connection gives a **new address**. Downloads in progress at that moment fail
and the client's browser cannot resume them on the old address (the page's own "download and
verify" mode can — it looks the address up again). Cloudflare gives no uptime promise for quick
tunnels and limits them to 200 requests in flight **[checked]**.

## 9. The page address clients see

Links look like `https://vikramdex-ops.github.io/Hopper/share/#<id>`. That is a personal GitHub
account name in a link sent to clients. To show a company address instead, with a domain from
option A: in the repository's *Settings → Pages* set a custom domain such as
`share.yourdomain.com` (GitHub's instructions; a CNAME record in Cloudflare DNS, set to "DNS
only"), then set Hopper's page address to `https://share.yourdomain.com/share/` and add
`https://share.yourdomain.com` to `server.allowedOrigins`. Note that a custom domain applies to
the whole Pages site (the Hopper landing page moves with it). **[not tested here]**

## 10. Firewall

- **Inbound: nothing.** Do not add a port-forward on the router. Do not add an inbound Windows
  Firewall rule for port 47880 — the server listens on 127.0.0.1 and refuses connections from
  the LAN (tested).
- **Outbound:** allow the server to reach Cloudflare on 7844 TCP+UDP (section 5). If only TCP is
  possible, add `"protocol": "http2"` to the `tunnel` section **[checked: valid values are auto,
  http2, quic]**.

## 11. Test it

1. `node supervisor.mjs --check` → all `ok`.
2. After starting: `logs\supervisor.log` contains `public-address-verified` (the supervisor
   fetched its own health check through the public address) and, in option B, `pointer-published`.
3. The store contains `_server.json` with the public address and `"healthy": true`.
   Hopper's *My client links* shows "Share server online".
4. In Hopper, create a link to a small file; open it on a phone using **mobile data** (not office
   Wi-Fi) and download. Then revoke it in Hopper and reload the page: "no longer available".
5. Try a large file (several hundred MB) from outside and note the speed — it is your office
   **upload** speed, shared with everything else the office is doing.

## 12. Operate

- **Logs:** `logs\share.log` (one JSON line per request: time, client address, method, shortened
  link id, status, bytes, duration — never passwords, tokens or full link ids) and
  `logs\supervisor.log`. Each rotates at 10 MB, five old files kept.
- **Statistics:** each link's `stats.json` (opens, downloads, bytes). Hopper shows them.
- **Clean-up:** hourly. Deletes links 24 hours after expiry, revoked links, and half-created
  links older than a day. It only ever deletes folders in the store whose name is a valid link
  id **and** that contain a share marker file; anything else in that folder is never touched.
- **Update:** replace `server.mjs` and `supervisor.mjs` with the new versions, then restart the
  task (*Task Scheduler → Dexterity Share → End, Run*). Keep `config.json`, `state\` and `logs\`.
  Restarting waits up to 10 seconds for running downloads; unfinished ones can be resumed.
- **Back-up:** `config.json` and `state\` (the signing key and token key). The store holds copies
  of files that exist elsewhere; it needs no back-up.
- **Uninstall:** `uninstall-windows.ps1` (elevated). Delete the program folder; delete the store
  when no link is needed any more; delete the tunnel in the Cloudflare dashboard and the pointer
  repository and token on GitHub.
- **Tuning** (`server` section of `config.json`): `maxConcurrentDownloads` (24),
  `maxDownloadsPerIp` (6), `idleTimeoutSeconds` (300: a download that makes no progress for five
  minutes is dropped and can be resumed), `graceHours` (24), `tokenTtlHours` (12: how long a
  password unlock lasts). If you use something other than Cloudflare in front, set
  `clientIpHeader` to `""`.

### Troubleshooting

| Symptom | Check |
|---|---|
| Client sees "We can't reach our file server" | Is the task running? `logs\supervisor.log`: look for `tunnel-exited`, `public-check-failed`, `server-exited`. Is the office internet up? Option B: was the pointer published (`pointer-failed` shows GitHub's answer)? |
| `cloudflared not found` in the log | Set `tunnel.cloudflared` to the full path of `cloudflared.exe`. |
| Task starts and stops at once | Run `node supervisor.mjs` in a terminal to see the message. Usually `config.json` (bad JSON, single `\`), or the store path. |
| Works in a terminal but not as the task | The task's account cannot read the store or write `state\`/`logs\`: re-run the installer, or see section 6 for stores on another machine. |
| Hopper says "The share server has not reported in yet" | The service cannot write `_server.json` into the store (permissions), or Hopper's store path points somewhere else than `server.store`. |
| Page says "This service is not set up yet" | `site/share/config.json` has neither `base` nor `pointers`. |
| Browser console shows a CORS error | `server.allowedOrigins` does not contain the page's exact origin (scheme + host, no path). |
| Port 47880 in use | Another copy is running (the old task?), or change `server.port` (and the tunnel's service URL in option A). |
| Downloads are slow | That is the office upload speed. Zip with compression, send outside office hours, or raise the uplink. |

## 13. What was tested, and what was not

Tested on the development PC (Windows 10, Node 26, store on the office share), all automated:

- **Server end-to-end (33 checks, `tests/e2e/pubshare.mjs`):** links created exactly as Hopper
  creates them; full download with SHA-256 match; resume with `Range`/`If-Range`; a 5 GB file
  (sizes and ranges beyond 2 and 4 GB); 300 files in one link; parallel downloads and the
  per-client and global limits; passwords, wrong-password lockouts, parallel guessing; expiry,
  extending, revoking during a download; 75 hostile paths (`..`, encoded slashes, long, upper-case
  and non-ASCII ids, raw NUL bytes) — all "not found", nothing outside the store readable;
  wrong HTTP methods; CORS from the page and from other sites; response headers; Unicode and
  very long file names; clean-up deleting only what it should; a stalled client; the server
  killed mid-download and restarted, then the download resumed; loopback-only listening.
- **Supervisor (12 checks) against a stand-in for cloudflared** that prints the same lines:
  reading the address, outside verification, signed pointer publishing to a mock GitHub API,
  a new address after the tunnel dies, restart after failed checks, restart of a crashed server,
  retry when GitHub is down, named and external modes, clean stop.
- **Client page in Microsoft Edge (18 checks):** every state on desktop and phone sizes, light
  and dark; real downloads compared by checksum; the verified download surviving a server outage;
  password flow; pointer acceptance and rejection; hostile text; the content-security policy.

**Not tested, by decision (no tunnel was opened and nothing was installed or pushed from the
development PC):**

- The real `cloudflared` program: its actual output format, quick-tunnel creation and limits,
  named-tunnel routing, behaviour of long multi-GB downloads through Cloudflare, and resume
  through Cloudflare.
- The real GitHub API and token (the pointer was published to a local mock), and how long
  `raw.githubusercontent.com` really caches.
- `install-windows.ps1` / `uninstall-windows.ps1` and the *Local Service* account's permissions;
  Linux and systemd; Tailscale Funnel.
- The page served from the real GitHub Pages address, and browsers other than Edge (Firefox,
  Safari, mobile browsers) — the code avoids anything browser-specific on the normal download
  path, but they were not run.
- The clean-up's refusal to follow a folder *junction* placed in the store (could not be created
  on the network share used for testing; the code skips links and compares real paths).

Do the section 11 tests on the real server before telling staff to use it.

## 14. Limits to be honest about

- **Speed** is the office's upload speed. A 1 GB file over a 20 Mbit/s uplink takes about seven
  minutes at best, and slows everyone else's uploads meanwhile.
- **Availability** is the office's: a power cut, an internet outage or a server restart makes
  links unreachable until it is over. Clients see a clear "temporarily unreachable" page that
  retries by itself; expiry dates do not pause.
- **Quick tunnels** (option B) add their own outages and address changes (section 8).
- **No virus scanning** is done on shared files, and there is no audit of who downloaded beyond
  the IP address in the log.
- One server process handles everything. It is designed for an office's volume (dozens of
  downloads at once), not for public distribution.
