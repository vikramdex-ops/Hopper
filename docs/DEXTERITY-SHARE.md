# Dexterity Share — sending files to a client

Use Dexterity Share when a deliverable is too big for e-mail. Hopper puts the files on our own
office server and gives you a link; the client opens it in any browser, anywhere, and downloads.
Nothing is uploaded to WeTransfer or similar sites.

(It needs a one-time setup by IT: [DEXTERITY-SHARE-IT.md](DEXTERITY-SHARE-IT.md).)

## Send

1. In Hopper, select the files, a folder or a zip.
2. Choose **Create client link**.
3. Fill in:
   - **Title** — the client sees this as the heading, e.g. *P12513 Lot 07 isometrics, rev B*.
   - **Message** (optional) — shown on the page and included in the e-mail text.
   - **Link expires after** — 1, 3, 7, 14, 30, 60 or 90 days. After that the link stops working
     and the copy on the server is deleted a day later.
   - **Download limit** (optional) — e.g. *Once*.
   - **Password** (optional) — press **Generate** for a strong one.
   - **Zip into one file** — on by default for several files, always on for folders. One zip is
     one download for the client.
4. **Create link.** Hopper zips (if asked), copies to the server and checksums. Large lots take a
   while; you can close the window and carry on — the job is in the transfer queue.
5. When it is ready:
   - **Copy link**, or
   - **Copy e-mail text** — subject and body with what you sent, the size, the link and the
     sentence "This link expires on Tuesday 17 November 2026 (7 days from today)", or
   - **Open in mail app** to start a new message with that text.

**If you set a password, send it separately** — by phone, SMS or chat, not in the same e-mail.
Hopper does not keep the password: note it before you close the window. If it is lost, revoke the
link and create a new one.

## Follow up

**My client links** lists what you sent:

- whether the client has opened the page and downloaded (and when),
- days left; **Extend** adds days — also to a link that expired less than a day ago,
- **Copy link** / **Copy e-mail** again,
- **Revoke** — the link stops working within seconds, even mid-download, and the files are
  removed from the server. Use it if you sent the wrong files or the wrong person got the link.

The dot at the top shows whether the share server is online. If it is not, clients cannot download
at the moment: tell IT.

## What the client sees

A Dexterity Share page with your name, the title and message, the file list with sizes, and when
the link expires. One button downloads. If the office server is briefly unreachable (power or
internet), the page says so and retries by itself; the link is not lost.

## Good to know

- Anyone who has the link can download until it expires. For confidential lots, set a password
  and a short expiry.
- Download speed is our office upload speed. For multi-GB lots, zip with compression and tell the
  client it may take a while; an interrupted download can be resumed from the browser's
  downloads list.
- The original files are not touched or moved; the server holds a copy until the link expires.
- If a client says the link does not work: check **My client links** (expired? revoked? server
  online?), then ask IT.
