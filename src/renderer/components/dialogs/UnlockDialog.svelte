<script lang="ts">
  // "Who has it open": asks every Hopper on the network (and the file server's Hopper) who holds
  // these files, shows each holder live, and lets you ask them to close it, wait and retry the
  // blocked operation, or (office admins, on the server) force it closed. See docs/UNLOCK.md.
  import { onMount, untrack } from 'svelte'
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { engine, lan } from '../../lib/api'
  import { basename, plural } from '../../lib/format'
  import { unlockUi } from '../../lib/unlock.svelte'
  import { aggregateHolders, holderWho, type Holder, type HoldersReply, type HolderStatus, type UnlockOp } from '@shared/unlock'

  let { paths, op, close }: { paths: string[]; op?: UnlockOp; close: (v?: unknown) => void } = $props()

  interface Answer {
    id: string
    peer: string
    name: string
    host: string
    user?: string
    self?: boolean
    reply?: HoldersReply & { partial?: boolean }
    error?: string
  }

  // the panel is about the paths it was opened with
  const list = untrack(() => paths)
  const shared = unlockUi.shared(list)
  const via = app.settings?.unlock?.via ?? 'both'
  const title = list.length === 1 ? basename(list[0]) : plural(list.length, 'item')
  const lockNotes = list.map((p) => app.active.lockText(p)).filter(Boolean)
  /** Windows logins named by AutoCAD and LibreOffice lock files (Office ones name only the person) */
  const lockUsers = [...new Set(list.flatMap((p) => app.active.lockMap.get(p.toLowerCase()) ?? []).map((l) => app.active.lockOwners[l.toLowerCase()]?.user).filter((u): u is string => !!u))]

  let lookupId = $state('')
  let asked = $state(0)
  let answers = $state.raw<Answer[]>([])
  let done = $state(false)
  let statuses = $state<Record<string, { status: HolderStatus; message?: string }>>({})
  let jobId = $state(unlockUi.jobFor(list) ?? '')
  let isAdmin = $state(false)
  let error = $state('')
  let notified = $state('')

  const rows = $derived(aggregateHolders(answers.flatMap((a) => a.reply?.holders ?? [])).map((h) => ({ ...h, ...(statuses[h.id] ?? {}) })))
  const open = $derived(rows.filter((h) => h.kind !== 'hopper'))
  const released = $derived(rows.filter((h) => h.kind === 'hopper'))
  const silent = $derived(answers.filter((a) => a.error))
  const server = $derived(answers.find((a) => a.reply?.server)?.reply?.server)
  const partial = $derived(answers.some((a) => a.reply?.partial))
  /** people whose Hopper says they opened it recently (not counting holders already listed) */
  const recent = $derived(answers.filter((a) => a.reply?.recent?.length && a.user && !open.some((h) => h.user === a.user)).map((a) => ({ user: a.user!, name: a.name })))
  const job = $derived(jobId ? app.jobs.find((j) => j.id === jobId) : undefined)
  const waiting = $derived(!!job && ['queued', 'running', 'paused', 'waiting'].includes(job.state))
  const anyUnc = shared.some((p) => p.startsWith('\\\\'))

  const STATUS: Record<HolderStatus, string> = {
    open: 'Open',
    asking: 'Asking…',
    asked: 'Asked',
    closed: 'Closed',
    declined: 'Not now',
    'no-answer': 'No answer',
    released: 'Released',
    failed: 'Still open'
  }

  async function find() {
    answers = []
    statuses = {}
    done = false
    error = ''
    try {
      const r = await lan.call<{ id: string; peers: number }>('unlock.find', shared)
      lookupId = r.id
      asked = r.peers + 1
      if (jobId) unlockUi.link(lookupId, jobId)
    } catch (e: any) {
      error = String(e?.message ?? e).replace(/^Error:\s*/, '')
      done = true
    }
  }

  onMount(() => {
    const offs = [
      lan.on('unlock-update', (d: Answer) => {
        if (d.id === lookupId) answers = [...answers.filter((a) => a.peer !== d.peer), d]
      }),
      lan.on('unlock-done', (d: { id: string }) => {
        if (d.id === lookupId) done = true
      }),
      lan.on('unlock-status', (s: { id: string; holder: string; status: HolderStatus; message?: string }) => {
        if (s.id === lookupId) statuses = { ...statuses, [s.holder]: { status: s.status, message: s.message } }
      })
    ]
    void find()
    void lan.call<boolean>('unlock.isAdmin').then((v) => (isAdmin = v)).catch(() => {})
    return () => offs.forEach((off) => off?.())
  })

  async function ask(h: Holder) {
    statuses = { ...statuses, [h.id]: { status: 'asking' } }
    try {
      const r = await lan.call<{ hopper?: string; connect?: string; error?: string }>('unlock.ask', lookupId, $state.snapshot(h), via)
      const st: HolderStatus = r.hopper === 'closed' ? 'closed' : r.hopper === 'asked' || r.connect === 'sent' ? 'asked' : 'failed'
      const parts = [r.hopper === 'asked' ? 'Asked on their PC' : r.hopper === 'unreachable' ? 'Their Hopper is not reachable' : '', r.connect === 'sent' ? 'Dexterity Connect message sent' : r.connect === 'connect-off' && via !== 'hopper' ? 'Dexterity Connect is not set up' : r.connect?.startsWith('failed') ? `Connect: ${r.connect.slice(8)}` : '', r.error ?? '']
      statuses = { ...statuses, [h.id]: { status: st, message: parts.filter(Boolean).join(' · ') } }
      if (st === 'closed') unlockUi.closed(lookupId)
    } catch (e: any) {
      statuses = { ...statuses, [h.id]: { status: 'failed', message: String(e?.message ?? e).replace(/^Error:\s*/, '') } }
    }
  }

  async function notify(users: string[]) {
    if (!users.length) return
    notified = 'Sending…'
    try {
      const r = await lan.call<Record<string, string>>('unlock.notify', lookupId, users, shared[0], via)
      const sent = Object.values(r).filter((v) => v.includes('hopper') && !v.includes('hopper-failed') || v.includes('sent')).length
      notified = sent ? `Told ${sent} ${sent === 1 ? 'person' : 'people'}` : 'Nobody could be reached (no Hopper online, and Dexterity Connect is not set up)'
    } catch (e: any) {
      notified = String(e?.message ?? e).replace(/^Error:\s*/, '')
    }
  }

  async function force(h: Holder, fileId: number) {
    const who = holderWho(h)
    const ok = await app.confirm(
      `Force ${basename(h.path)} closed on the file server?`,
      `${who} loses the connection to the file. Anything they have not saved in it is lost or has to be saved under a new name. They get a message, and this is written to the office's unlock log. Ask them first whenever you can.`,
      'Force close'
    )
    if (!ok) return
    statuses = { ...statuses, [h.id]: { status: 'asking', message: 'Closing on the server…' } }
    try {
      const r = await lan.call<{ t: string; code?: string; message?: string }>('unlock.force', lookupId, $state.snapshot(h), fileId)
      if (r?.t === 'forced') {
        statuses = { ...statuses, [h.id]: { status: 'closed', message: 'Closed on the server' } }
        unlockUi.closed(lookupId)
      } else statuses = { ...statuses, [h.id]: { status: 'failed', message: forceError(r?.code, r?.message) } }
    } catch (e: any) {
      statuses = { ...statuses, [h.id]: { status: 'failed', message: String(e?.message ?? e).replace(/^Error:\s*/, '') } }
    }
  }

  const forceError = (code?: string, m?: string) =>
    code === 'needs-admin' ? 'The file server’s Hopper needs admin rights (Settings → Office → File unlock on this server)'
    : code === 'not-admin' ? 'The file server refused: the account it sees connected from your PC is not an office admin'
    : code === 'no-session' ? 'The file server does not see your PC connected: open the share from your PC first (any folder on it), then try again'
    : code === 'sessions-unavailable' ? 'The file server could not check who is connected; try again in a moment'
    : code === 'not-server' ? 'That PC is not the file server for this file'
    : code === 'not-open' ? 'The server no longer has it open'
    : m || code || 'Failed'

  async function wait() {
    if (!op) return
    try {
      jobId = await unlockUi.wait(op)
      if (lookupId) unlockUi.link(lookupId, jobId)
    } catch (e: any) {
      app.toast('error', "Couldn't start waiting", String(e?.message ?? e).replace(/^Error:\s*/, ''))
    }
  }

  const ids = (h: Holder) => [...(h.fileId !== undefined ? [h.fileId] : []), ...(h.fileIds ?? [])]
  const canAsk = (h: Holder & { status: HolderStatus }) => (h.kind === 'app' || h.kind === 'explorer') && !['asking', 'closed'].includes(h.status)
</script>

<Dialog title={`Who has ${title} open`} icon="lock" width={640} onclose={() => close()}>
  <div class="head caption">
    {#if error}
      <span class="warnText">{error}</span>
    {:else if !done}
      <span class="spin"><Icon name="refresh" size={12} /></span> Asking {plural(asked, 'Hopper')} on the network… {answers.length} answered
    {:else}
      Asked {plural(asked, 'Hopper')}: {answers.length - silent.length} answered{silent.length ? `, ${silent.length} did not` : ''}.
    {/if}
  </div>

  {#if lockNotes.length}
    <div class="note">
      <Icon name="lock" size={14} /> <span>Lock file: {lockNotes.join('; ')}</span>
      {#if lockUsers.length && done && !open.length}<button type="button" class="btn sm" onclick={() => notify(lockUsers)}>Ask them to close it</button>{/if}
    </div>
  {/if}

  {#if open.length}
    <div class="list" role="list">
      {#each open as h (h.id)}
        <div class="holder" role="listitem">
          <div class="who">
            <div class="ellipsis"><b>{holderWho(h)}</b></div>
            <div class="caption ellipsis" title={h.path}>
              {h.kind === 'smb' ? `File server${h.locks ? ` · ${plural(h.locks, 'lock')}` : ''}` : h.app}{list.length > 1 || h.path.toLowerCase() !== shared[0]?.toLowerCase() ? ` · ${basename(h.path)}` : ''}
            </div>
            {#if h.message}<div class="caption msg">{h.message}</div>{/if}
          </div>
          <span class="chip st-{h.status}">{STATUS[h.status]}</span>
          <div class="acts">
            {#if canAsk(h)}
              <button type="button" class="btn sm" onclick={() => ask(h)}>{h.peer === answers.find((a) => a.self)?.peer ? 'Close it' : 'Ask to close'}</button>
            {:else if h.kind === 'smb' && h.user && h.status !== 'closed'}
              <button type="button" class="btn sm" onclick={() => notify([h.user!])}>Message</button>
            {/if}
            {#if isAdmin && ids(h).length && h.status !== 'closed'}
              <button type="button" class="btn sm subtle danger" title="Close it on the file server (office admins)" onclick={() => force(h, ids(h)[0])}>Force close…</button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {:else if done && !error}
    <div class="empty">
      <Icon name="info" size={20} />
      <div>
        <div><b>Nobody on the network says they have it open.</b></div>
        <div class="caption">It may be open on a PC without Hopper, or a PC that went to sleep or crashed may still hold it on the file server.</div>
      </div>
    </div>
  {/if}

  {#if recent.length}
    <div class="note">
      <Icon name="history" size={14} />
      <span>Opened recently through Hopper by {recent.map((r) => r.name).join(', ')}.</span>
      <button type="button" class="btn sm" onclick={() => notify(recent.map((r) => r.user))}>Ask them to close it</button>
    </div>
  {/if}
  {#if notified}<div class="caption">{notified}</div>{/if}

  {#if released.length}
    <div class="caption">Hopper itself had {plural(released.length, 'handle')} on it; {released.length === 1 ? 'it was' : 'they were'} released.</div>
  {/if}
  {#if partial}
    <div class="caption">Large folder: only the first 2,000 files were checked.</div>
  {/if}
  {#if server && !server.ok}
    <div class="note warn">
      <Icon name="warning" size={14} />
      <span>{server.error === 'needs-admin' ? 'The file server’s Hopper answered but needs admin rights to see open files. An office admin can turn on Settings → Office → File unlock on this server, on the server.' : `The file server’s Hopper could not list open files: ${server.error}`}</span>
    </div>
  {:else if done && anyUnc && !server}
    <div class="caption">No Hopper on the file server answered, so files held by PCs without Hopper (or left open by a crashed PC) cannot be seen.</div>
  {/if}
  {#if silent.length}
    <div class="caption">No answer from {silent.map((a) => a.name).join(', ')} (offline, or an older Hopper).</div>
  {/if}

  {#if job}
    <div class="note">
      <Icon name="clock" size={14} />
      <span>{waiting ? `${job.title}. Hopper tries again every 10 seconds and as soon as someone closes it.` : job.state === 'done' ? 'Done.' : job.state === 'cancelled' ? 'Stopped waiting.' : `Gave up: ${job.error ?? ''}`}</span>
      {#if waiting}<button type="button" class="btn sm" onclick={() => engine.call('jobs.cancel', jobId)}>Stop waiting</button>{/if}
    </div>
  {/if}

  {#snippet footer()}
    <button type="button" class="btn" disabled={!done} onclick={find}><Icon name="refresh" /> Check again</button>
    {#if op && !waiting}
      <button type="button" class="btn" title={`Retries every 10 seconds for up to ${app.settings?.unlock?.waitMinutes ?? 10} minutes, then tells you`} onclick={wait}><Icon name="clock" /> Wait and retry</button>
    {/if}
    <button type="button" class="btn primary" onclick={() => close()}>Close</button>
  {/snippet}
</Dialog>

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 10px;
  }
  .spin {
    display: inline-flex;
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--stroke);
    border-radius: var(--r-md, 6px);
    margin-bottom: 10px;
  }
  .holder {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
  }
  .holder + .holder {
    border-top: 1px solid var(--stroke);
  }
  .who {
    min-width: 0;
  }
  .msg {
    color: var(--text-2);
  }
  .acts {
    display: flex;
    gap: 6px;
  }
  .chip {
    font-size: 11px;
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--subtle, rgb(127 127 127 / 0.12));
    white-space: nowrap;
  }
  .st-closed,
  .st-released {
    background: color-mix(in srgb, #2e9d5b 18%, transparent);
  }
  .st-declined,
  .st-failed {
    background: color-mix(in srgb, #d64545 16%, transparent);
  }
  .st-asked,
  .st-asking {
    background: color-mix(in srgb, #2f7ed8 16%, transparent);
  }
  .note,
  .empty {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 0;
  }
  .note.warn {
    color: var(--warn, #b26a00);
  }
  .empty {
    align-items: flex-start;
    padding: 10px;
    border: 1px dashed var(--stroke);
    border-radius: var(--r-md, 6px);
  }
  .danger {
    color: #d64545;
  }
</style>
