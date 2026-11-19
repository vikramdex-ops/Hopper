// "Who has it open" in the window: the panel opener, close requests from other PCs (a prompt the
// user answers here), Hopper letting go of its own handles, status labels and lock badges.
import { app, type MenuItem } from './app.svelte'
import { engine, host, lan } from './api'
import { basename } from './format'
import { toUnc } from './lan2.svelte'
import { isArchivePath, isVirtual } from './pane.svelte'
import { cleanLabelDefs, type LabelDef } from '@shared/labels'
import { isBusyError, opPaths, within, type UnlockOp } from '@shared/unlock'
import type { JobInfo } from '@shared/types'

export interface UnlockPrompt {
  promptId: string
  from: string
  fromName: string
  path: string
  kind: 'app' | 'explorer' | 'notice'
  app: string
}

/** The office's labels (or the default set). */
export const labelDefs = (): LabelDef[] => cleanLabelDefs(app.office?.labels)

export const labelById = (id: string | undefined) => (id ? labelDefs().find((d) => d.id === id) : undefined)

/** The "Label" submenu: every office label, Clear label and Edit note. */
export function labelMenu(paths: string[], current?: string): MenuItem[] {
  const items: MenuItem[] = labelDefs().map((d, i) => ({ label: d.name, color: d.color, checked: current === d.id, keys: i < 5 ? `Ctrl+Alt+${i + 1}` : undefined, run: () => void unlockUi.setLabel(paths, d.id) }))
  items.push({ separator: true }, { label: 'Clear label', icon: 'close', keys: 'Ctrl+Alt+0', run: () => void unlockUi.setLabel(paths, null) })
  if (paths.length === 1) items.push({ label: 'Edit note…', icon: 'edit', run: () => void editNote(paths[0]) })
  return items
}

/** Note on one item, through the prompt dialog (the inspector edits it in place too). */
export async function editNote(path: string) {
  const prev = app.active.labelOf(path)?.note ?? ''
  const v = await app.prompt(`Note on ${basename(path)}`, prev, 'Seen by everyone in the office (leave empty to remove)')
  if (v === null || v === undefined || v === prev) return
  await unlockUi.setNote(path, v)
}

class UnlockUi {
  private started = false
  private shownPrompts = new Set<string>()

  init() {
    if (this.started) return
    this.started = true
    lan.on('unlock-prompt', (p: UnlockPrompt) => this.showPrompt(p))
    // another PC asked who holds these: Hopper's own handles go at once
    lan.on('unlock-release', ({ paths }: { paths: string[] }) => this.release(paths))
    // the PC that was asked answers: closed means the blocked operation can go now
    lan.on('unlock-status', (s: { id: string; status: string; message?: string; from: string }) => {
      const who = app.personName(s.from)
      if (s.status === 'closed') {
        app.toast('success', `${who} closed it`, this.lookupJobs.has(s.id) ? 'Trying again now.' : undefined)
        this.closed(s.id)
      } else if (s.status === 'declined') app.toast('info', `${who} can’t close it now`)
      else if (s.status === 'failed') app.toast('warning', `It is still open on ${who}’s PC`, s.message)
      else if (s.status === 'asked' && s.message) app.toast('info', `${who}: ${s.message}`)
    })
    engine.on('labels-changed', () => {
      for (const p of app.panes) void p.loadLabels()
    })
    void lan.call<UnlockPrompt[]>('unlock.pending').then((l) => l.forEach((p) => this.showPrompt(p))).catch(() => {})
    // labels set on other PCs: look again now and then
    setInterval(() => {
      for (const p of app.panes) if (!isVirtual(p.path) || p.path.startsWith('hopper:search')) void p.loadLabels()
    }, 30_000)
  }

  /** Open the "Who has it open" panel for these paths; `op` is what to finish once they are free. */
  open(paths: string[], op?: UnlockOp) {
    const real = paths.filter((p) => !isVirtual(p) && !isArchivePath(p))
    if (!real.length) return
    void import('./commands').then((m) => m.dialogs.unlock?.(real, op))
  }

  /** A toast that offers the panel after an operation failed because a file was open. */
  offer(title: string, message: string, op: UnlockOp) {
    app.toast('warning', title, message, [{ label: 'Who has it open?', run: () => this.open(opPaths(op), op) }], true)
  }

  /** For errors from rename, delete, move and copy: is this "the file is open somewhere"? */
  busy(message: string | undefined) {
    return !!message && isBusyError(message)
  }

  /** Paths as the other PCs see them (mapped drives as UNC). */
  shared(paths: string[]) {
    return paths.map((p) => toUnc(p, app.drives).path)
  }

  private release(paths: string[]) {
    void engine.call('watch.release', paths).catch(() => {})
    const held = (p?: string) => !!p && paths.some((r) => within(p, r))
    if (held(app.quickLook?.path)) app.quickLook = null
    if (app.viewer && app.viewer.entries.some((e) => held(e.path))) app.viewer = null
  }

  private showPrompt(p: UnlockPrompt) {
    if (this.shownPrompts.has(p.promptId)) return
    this.shownPrompts.add(p.promptId)
    const file = basename(p.path)
    if (p.kind === 'notice') {
      const forced = p.app === 'forced'
      const title = forced ? `${p.fromName} closed ${file} on the file server` : `${p.fromName} needs ${file}`
      const body = forced ? 'If you had unsaved work in it, save it under a new name.' : 'It is still open somewhere. If you have it open, please save your work and close it.'
      app.toast(forced ? 'warning' : 'info', title, body, [{ label: 'OK', run: () => void lan.call('unlock.answer', p.promptId, 'later') }], true)
      if (!document.hasFocus()) new Notification(title, { body })
      return
    }
    const where = p.kind === 'explorer' ? 'a File Explorer window' : p.app || 'a program'
    const title = `${p.fromName} needs ${file}`
    const body = `It is open in ${where} on this PC. ${p.kind === 'explorer' ? 'Close it moves that window out of the folder.' : 'Close it asks the program to close; it asks you to save anything unsaved.'}`
    const answer = (choice: 'close' | 'self' | 'later') => async () => {
      const r = await lan.call<{ ok: boolean; status?: string; error?: string }>('unlock.answer', p.promptId, choice).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
      if (choice === 'close') app.toast(r.ok ? 'success' : 'warning', r.ok ? `Closed ${file}` : `${file} is still open`, r.ok ? `${p.fromName} has been told.` : r.error)
    }
    app.toast('warning', title, body, [
      { label: 'Close it', run: answer('close') },
      { label: 'I’ll close it myself', run: answer('self') },
      { label: 'Not now', run: answer('later') }
    ], true)
    if (!document.hasFocus()) new Notification(title, { body })
  }

  // ---- labels -------------------------------------------------------------------

  async setLabel(paths: string[], label: string | null) {
    const real = paths.filter((p) => !isVirtual(p) && !isArchivePath(p))
    if (!real.length) return
    try {
      await engine.call('labels.set', real, { label })
      for (const p of app.panes) void p.loadLabels()
    } catch (e: any) {
      app.toast('error', "Couldn't set the label", String(e?.message ?? e).replace(/^Error:\s*/, ''))
    }
  }

  async setNote(path: string, note: string) {
    try {
      await engine.call('labels.set', [path], { note: note.trim() || null })
      for (const p of app.panes) void p.loadLabels()
      return true
    } catch (e: any) {
      app.toast('error', "Couldn't save the note", String(e?.message ?? e).replace(/^Error:\s*/, ''))
      return false
    }
  }

  // ---- wait and retry -----------------------------------------------------------

  /** "Wait and retry" jobs started from the panel, with what they finish. */
  private waits = new Map<string, UnlockOp>()
  /** lookup id -> the wait job to nudge when a holder lets go */
  private lookupJobs = new Map<string, string>()

  link(lookupId: string, jobId: string) {
    this.lookupJobs.set(lookupId, jobId)
  }

  /** a holder closed the file: the waiting job tries now */
  closed(lookupId: string) {
    const j = this.lookupJobs.get(lookupId)
    if (j) this.nudge(j)
  }

  /** a wait job still running for any of these paths (the panel shows it again) */
  jobFor(paths: string[]) {
    const want = new Set(paths.map((p) => p.toLowerCase()))
    for (const [id, op] of this.waits) {
      const j = app.jobs.find((x) => x.id === id)
      if (j && ['queued', 'running', 'paused', 'waiting'].includes(j.state) && opPaths(op).some((p) => want.has(p.toLowerCase()))) return id
    }
    return undefined
  }

  async wait(op: UnlockOp) {
    const id = await engine.call<string>('unlock.wait', op, { minutes: app.settings?.unlock?.waitMinutes ?? 10 })
    this.waits.set(id, op)
    app.showProgress()
    return id
  }

  /** A holder let go: try now instead of at the next 10-second retry. */
  nudge(jobId: string) {
    void engine.call('unlock.nudge', jobId).catch(() => {})
  }

  jobFinished(j: JobInfo) {
    const op = this.waits.get(j.id)
    if (!op) return
    this.waits.delete(j.id)
    if (j.state === 'done' && j.output === 'recycle-ready') void this.recycleReady(op)
    else if (j.state === 'done') for (const p of app.panes) void p.refresh()
  }

  /** Recycle what a "Wait and retry" job found free (the Recycle Bin is the window's job). */
  async recycleReady(op: UnlockOp) {
    if (op.kind !== 'recycle') return
    const r = await host.shell.trash(op.paths)
    if (r.done.length) {
      void engine.call('fs.recordRecycle', r.done)
      app.toast('success', `Deleted ${r.done.length === 1 ? basename(r.done[0]) : `${r.done.length} items`}`, 'They were closed, so the delete went through.')
    }
    if (r.failed.length) app.toast('error', `${r.failed.length} item(s) could not be deleted`, r.failed[0].message)
    for (const p of app.panes) void p.refresh()
  }
}

export const unlockUi = new UnlockUi()
