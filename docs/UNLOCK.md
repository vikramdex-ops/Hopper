# Who has it open, Unlock, and status labels

When a file or folder cannot be moved, renamed, deleted or overwritten because it is open somewhere,
Hopper can find out who has it open, ask them to close it, and finish the job once it is closed.
The same release adds shared status labels and notes.

## Who has it open

- **Lock badge.** Many programs leave a lock file next to an open document: Microsoft Office
  (`~$Report.docx`), AutoCAD (`Plan.dwl`, `Plan.dwl2`) and LibreOffice (`.~lock.Report.odt#`).
  Hopper shows a lock on the document's row ("Open by ‹person› on ‹PC›" in the tooltip and in the
  details pane) with whatever the lock file itself says. Office records only the person's name;
  AutoCAD and LibreOffice also record the computer. Hopper only reads lock files; it never changes or
  deletes them. The lock files themselves are hidden unless **Show hidden items** is on.
- **Who has this open?** (right-click, the command palette, or the details pane) asks every Hopper on
  the office network. It is also offered automatically when a move, rename, delete or copy fails
  because a file is in use.

Each Hopper answers with what its own PC knows:

- programs on that PC holding the file (Windows Restart Manager; this works for files on the
  server through `\\server\share` paths and mapped drives alike);
- File Explorer windows showing the folder, or a folder inside it (for folders);
- Hopper's own handles (folder watchers, previews), which it lets go of at once, without asking;
- whether that person opened the file through Hopper recently.

For a folder, Hopper checks the files inside it (up to 2,000 files, 15 seconds) and says so when a
folder is larger than that.

The panel lists every holder with their name, PC, program and status (Open, Asked, Closed, Not now,
Still open). A Hopper that does not answer (switched off, or older than 2.8) is listed as such.

## Asking someone to close it

**Ask to close** sends a request to that person's PC. Their Hopper shows a prompt:
"‹person› needs Report.docx. It is open in Microsoft Word on this PC." with three choices:

- **Close it**: Hopper asks that one program to close the way Windows does at sign-out. The program
  can ask to save first, or refuse. Nothing is ever force-closed on a person's PC.
- **I'll close it myself**
- **Not now**

The answer comes back to the person who asked. On your own PC the button is simply **Close it**.

Settings → Sharing → **Send close requests via** chooses how the request travels: a prompt in
Hopper, a Dexterity Connect message (reaches people who are away from their PC or not running
Hopper, see CONNECT-SETUP.md), or both (the default).

## Wait and retry

**Wait and retry** keeps the blocked operation (move, rename, delete, copy) and tries again every 10
seconds and as soon as a holder reports the file closed. It shows in Transfers, where it can be
cancelled like any other job, and gives up after the time set in Settings → Sharing (10 minutes by
default). A delete to the Recycle Bin waits until no program on this PC holds the files, then
deletes.

## Nobody claims it

A file can stay open on the server although no Hopper reports it: a PC without Hopper, a PC that
went to sleep or crashed, or a program on the server itself.

- The people whose Hopper says they opened the file recently can be asked to close it (Hopper prompt
  and/or Dexterity Connect message).
- **The server agent.** The Hopper running on the file server recognises requests for its own shares
  (it compares the request's `\\server\share` with the folders it shares and its own names and
  addresses) and answers with the server's own list of open files: the Windows account, the file and
  the number of locks. A row the server knows but nobody's Hopper claims is shown with that account;
  if the server cannot name it, the panel says "Unknown — the server still has it open". Hopper
  never guesses a holder.

### Turning on the server agent (once, on the file server)

Listing and closing the server's open files, and checking who is connected, needs administrator
rights, which a normal Hopper does not have. On the file server, an office admin opens
**Settings → Office → File unlock on this server** and clicks **Allow file unlock on this server**:

- Windows asks once for administrator permission (UAC).
- Hopper copies its helper to `C:\Program Files\Hopper\Agent\HopperShell.exe`. That folder lets
  only SYSTEM and Administrators change it; everyone else can only read and run it. The copy is
  checked against the SHA-256 checksum built into this Hopper; if it does not match, setup stops and
  removes it.
- Hopper adds a scheduled task, **Hopper file unlock**, that runs that copy (never a file in a user
  folder or on a network drive) with the highest rights of the signed-in account, on demand only. No
  password is stored. A Hopper that itself runs from a network drive refuses to set this up.
- When another PC asks who has a file open, the server's Hopper starts the task. The agent answers
  only these questions: the open files, the connected sessions, close one open file (only one that is
  open under an ordinary share, never C$, ADMIN$ or IPC$), and write the log line. It listens on a
  local named pipe named after the Windows account's SID that only that account can open, never
  from another computer; reads at most 64 KB per request; keeps a listening instance so nobody else
  can take the pipe's name; and exits after ten idle minutes. Before Hopper's helper sends anything
  to the pipe, it checks that the process serving it is the Program Files copy and runs elevated.
- The Windows account that runs Hopper on the server must be a member of Administrators.
- After Hopper updates, the page says **Update file unlock on this server** (one more UAC prompt),
  because the copy in Program Files no longer matches the new helper; until then the agent is not
  used.
- **Remove** in the same place deletes the task and the Program Files copy (Windows asks again).

Until it is turned on, the server's Hopper answers "needs admin rights" and the panel explains it.

## Force close (office admins only)

When the server agent lists a file and asking did not help, an office admin sees **Force close…** on
that row. Office admins are the standing admins and the account that set the office up (see
OFFICE-SETUP.md).

The name a Hopper gives on the network is not proof of who is asking (every Hopper has the office
key). So the file server decides by what Windows itself authenticated:

- The server looks at the address the request came from and at its own list of SMB sessions (who
  is connected to its shares, from which address). The request is accepted only when a session from
  that address belongs to an office admin. If there is no session from that PC, the admin is asked
  to open the share from their PC first (any folder on it) and try again.
- On the server itself, the Windows account signed in there counts.
- Open-file ids, which a force close needs, are only sent to a requester who passes the same check.
  Everyone else sees who has the file open, but no ids and no Force close button.

Then:

- Hopper first warns that anything unsaved in the file is lost, and asks for confirmation.
- The server checks that this open-file id really is open inside that path (not merely a path that
  starts the same way), then closes it (`NetFileClose`).
- The person whose file was closed gets a message naming the admin the server recognised (Dexterity
  Connect when configured, otherwise a Hopper prompt; a "closed on the file server" prompt is only
  accepted from the file server).
- Every force close is appended, on the file server, to
  **`%ProgramData%\Hopper\unlock-log.jsonl`** (usually `C:\ProgramData\Hopper`). Only SYSTEM and
  Administrators can change that folder; other accounts can read it. Each line records the time, the
  admin the server recognised, the name the requesting Hopper gave, the requesting address, the
  server, the file, the account it was open for, the open-file id, the lock count and whether it
  worked. The line is written by the elevated agent; Hopper never copies or rewrites the log.

## What travels over the network

All of these messages use the office key, like every other Hopper message, and are checked on
arrival: bounded names and counts, at most 50 paths per request, no `..`. Another PC may only ask
about `\\server\share` paths on hosts this PC already knows: its own names and addresses, the
servers behind its mapped drives, and the servers in the office config. Drive-letter paths,
`localhost`, admin shares (C$, ADMIN$, IPC$) and unknown hosts are ignored without being opened, so a
question can never make a PC connect to a host someone else chose. Only paths, program names,
people's names and statuses are sent, never file contents.

A close prompt shows the program name this PC finds holding the file (the request is dropped when
that program no longer holds it) and the asking person's name as Hopper knows them on the network,
not what the request says. One person can have at most three prompts open on a PC, and at most six a
minute. Answers ("closed", "not now") are only accepted from the PC that was asked. A Hopper only
closes something on its own PC after its own user clicks **Close it**; the only exception is the
admin force close above, which happens on the file server.

## Status labels and notes

- Colour labels for files and folders, seen by everyone in the office: by default **Checked**, **Sent
  to client**, **Hold**, **Revise** and **Final**. Office admins rename, recolour, add or remove them
  in Settings → Office → Status labels.
- Set a label with right-click → **Label**, **Alt+L**, or **Ctrl+Alt+1** to **5** (Ctrl+Alt+0
  clears it). Add a short note in the details pane, or with right-click → Label → Edit note.
- Labels show as a coloured pill in the file list and in the details pane, with who set it and when.
- Filter with `label:checked`, `label:"sent to client"` written as `label:sent-to-client`,
  `label:any` or `label:none`, in the search box or in Filter this folder; **Group by → Label**.
- Renames and moves made with Hopper take the label along. Renames made in File Explorer do not.

Labels are stored centrally, never inside project folders (so nothing extra ends up in a client
delivery): a `labels` folder next to office.json holds one file per server share, keyed by the
item's `\\server\share\…` path (a mapped drive counts as its UNC path; letter case does not matter).
Writes go to a temporary file that then replaces the old one, and Hopper re-reads the file around
every write, so two people labelling at the same moment both keep their change (for one item, the
latest change wins). Labels on a local disk (not a shared folder) are kept on that PC only, as are
all labels when there is no office config.
