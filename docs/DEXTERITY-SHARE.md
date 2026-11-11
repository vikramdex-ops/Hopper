# Dexterity Share — sending files to a client

Use Dexterity Share when a deliverable is too big for e-mail. Hopper puts the files on our own
office server and gives you a link; the client opens it in any browser, anywhere, and downloads.
Nothing is uploaded to WeTransfer or similar sites.

(It needs a one-time, three-step setup on one office PC that stays on:
[DEXTERITY-SHARE-IT.md](DEXTERITY-SHARE-IT.md).)

## Send

1. In Hopper, select the files, a folder or a zip.
2. Choose **Create client link**.
3. Fill in:
   - **Title** — the client sees this as the heading, e.g. *J999 Lot 07 isometrics, rev B*.
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

## Send from a browser, without Hopper

You can also make a client link from a web page, for example on a laptop at site or at home.
The page takes **one finished .zip, .rar or .7z file**. Zip the files first if there are several
(in Hopper: `Ctrl+Alt+Z`).

### Sign in once on each browser

There is no password to remember. Hopper makes a personal sign-in link for you:

1. In Hopper, open **My client links**.
2. Press **Use in a browser**, then **Make a sign-in link**.
3. Open the link once in the browser you want to use: press **Open in browser**, or copy the link
   and paste it into that browser's address bar.
4. **Bookmark the page.** The browser now remembers you. The bookmark itself does not contain the
   sign-in, and the link is removed from the address bar as soon as the page opens.

The sign-in link is shown only once. It works like a password: **do not send it to anyone.**
Anyone who has it can make links in your name until you switch it off. Make a new link for each
browser you want to use.

If you do not see **Use in a browser**, the office admin has switched the page off.

### Make a link

1. Drop the file on the page, or click to choose it. The page shows the largest size allowed
   (5 GB unless the admin changed it).
2. **Link works for (days)**: 1, 3, 7, 14, 30, 60 or 90. The date it ends is shown underneath.
3. **Password** (optional): at least 6 characters, or press **Generate**.
4. **Note to the client** (optional): shown on the download page and in the e-mail text.
5. **Title** (optional): the heading the client sees. If you leave it empty, the file name is used.
6. **Create link.**

The file is sent in pieces. You can **Pause** and **Resume**, or **Cancel** (what was sent is
deleted). If the connection drops, the page tries again by itself. If you close the page, choose
the same file again later and the page offers to **Continue upload**. You can have two unfinished
uploads at a time. An upload left untouched for a day is removed from the server.

When the upload ends, the server checks the file. It must really be the kind of archive its name
says; a renamed file is refused and deleted. Then you get:

- the **client link**, with **Copy link** and **Copy e-mail text**,
- the **password**, if you set one. It is shown only now: copy it and send it separately.

### Your links

The right side (below, on a phone) lists your links, including those you made in Hopper:

- how many times each was downloaded, and when it expires,
- **Copy** the link again,
- **Renew** adds 1 to 90 days,
- **Switch off** stops the link at once. The client can no longer download.

The page shows how many times a link was downloaded, not who downloaded it.

### Switch a browser off

Lost a laptop, or used a shared PC? In Hopper, **My client links → Use in a browser** lists every
browser you signed in, with the PC the link was made on, the date and when it was last used.
Press **Switch off** next to one: that browser is signed out within seconds. On the page itself,
**Sign out on this browser** makes the browser forget you; to be sure nobody can use that
sign-in again, also switch it off in Hopper.

## What the client sees

A Dexterity Share page. A blue panel says how many files are ready ("5 files are ready for
you."), with your name, the title, your message and when the link expires. Beside it are the
files with their sizes and one button: **Download**, or **Download all** for several files. On a
phone the panel sits above the files. If the link has a password, the page asks for it first. If the office server is briefly unreachable (power or
internet), the page says so and retries by itself; the link is not lost.

**You are told when the client downloads.** Hopper shows "Your client downloaded Lot 07
(17 Nov, 14:02)" within a couple of minutes of each completed download, and lists it under Activity.

## Good to know

- A single finished file (zip, 7z, rar, PDF…) that is already on the office server is shared
  **instantly**, without copying. Do not edit that file afterwards: if it changes, the client is
  told "this file was changed after it was shared" and you create a new link.
- If the server is nearly full, Hopper refuses new links and says so. Revoke links you no longer
  need under **My client links**.
- Links work only while the office share-server PC is on. If a client reports "can't reach our file
  server", check the dot in **My client links** and tell whoever looks after Hopper.

- Anyone who has the link can download until it expires. For confidential lots, set a password
  and a short expiry.
- Download speed is our office upload speed. For multi-GB lots, zip with compression and tell the
  client it may take a while; an interrupted download can be resumed from the browser's
  downloads list.
- The original files are not touched or moved; the server holds a copy until the link expires.
- If a client says the link does not work: check **My client links** (expired? revoked? server
  online?), then ask IT.
