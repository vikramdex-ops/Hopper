# Setting up Hopper for an office

Hopper works on its own straight after install. Sharing between PCs, groups, templates and the
office rules need a one-time setup, done once from any PC by whoever looks after the office.

## 1. Install on every PC

Run `Hopper-<version>-win-x64.exe` on each PC. It installs per user (no admin) and updates itself
from GitHub Releases. Hopper stays in the tray when the window is closed so colleagues can keep
sending files; untick *Settings → General → Keep running in the tray* to change that.

## 2. Create the office config (once)

1. Open **Settings → Office**.
2. **Office config file**: a path every PC can read and write. The default is
   `\\10.0.0.2\office-share\_Hopper\office.json`. If it doesn't exist yet,
   Hopper creates it when you save.
3. **Office key** → **Generate**. This shared secret encrypts PC-to-PC transfers and lets Hopper
   ignore devices that aren't part of the office. Anyone with the key can send to office PCs,
   so keep the config folder office-only.
4. **Server inbox**: where shares for colleagues who are offline wait (default
   `\\10.0.0.2\office-share\_Hopper\Inbox`). Each person gets a sub-folder
   named after their Windows account.
5. **Save to server**. Every PC that points at the same config file picks it up on start, or
   immediately with **Reload**.

If a PC uses a different path for the share, set the same file under *Office config file* on
that PC.

## 3. On each PC

- **Settings → Sharing → Allow through Windows Firewall**. Hopper listens on UDP 47820
  (discovery) and TCP 47821 (transfers) on private and domain networks. Windows asks for admin
  rights once.
- **Settings → Sharing → Profile**: display name as colleagues should see it, and the Zoho
  email (used for Cliq notices).
- **Settings → General → Inbox folder**: where received files land (default `D:\Hopper Inbox`
  when D: exists, else `Downloads\Hopper Inbox`). Each share gets a folder like
  `2026-11-05 1430 from Arun Kumar`.

## 4. Optional extras (Settings → Office)

- **Zoho Cliq bot**: one bot DMs each recipient. Steps: [CLIQ-SETUP.md](CLIQ-SETUP.md).
- **Groups**: e.g. *Piping team* → `arun, priya, ravi` (Windows account names). Type `@Piping`
  in the Share dialog to send to all of them.
- **Folder templates**: one folder per line, with `{name}`, `{project}` and `{date}` tokens,
  e.g. `{name}/01_Received`.
- **Naming conventions**: a regular expression the file name (without extension) must match in
  full, e.g. `ISO-\d{4}_Rev[0-9A-Z]{1,2}`. The lot packager checks every file against the chosen
  convention before it writes anything.
- **Revision rules**: patterns that find the revision in a name (named group `rev`), and an
  optional order such as `A, B, C, 0, 1, 2`. With no order, numbers compare with numbers and
  letters with letters; a mix is reported as *order unknown* and left for a person to check.
  Hopper never guesses which revision is latest.

## How sharing behaves

- **Online colleague**: files go straight to their PC over TLS, in up to four parallel streams,
  each file checksum-verified. A dropped connection resumes where it stopped.
- **Offline colleague**: files are copied to their server inbox; when their Hopper starts it
  moves them to their local Inbox and they get a notification (and a Cliq DM if enabled).
- **Receiving**: shares are accepted automatically into the Inbox. *Settings → Sharing* can ask
  first, or block specific people.

## Troubleshooting

| Symptom | Check |
| :-- | :-- |
| People list is empty | Office key set and saved; same config file on both PCs; firewall rule allowed; both PCs on the same subnet. |
| "port-in-use" | Another Hopper (or app) uses TCP 47821; Hopper tries up to 47830 automatically. |
| Shares always go via the server | The firewall is blocking TCP 47821 on the receiving PC. |
| No Cliq DM | Bot enabled, endpoint and zapikey saved; the recipient's Zoho email is filled in and they have subscribed to the bot. Use *Send test DM*. |
