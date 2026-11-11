<script lang="ts">
  // Dexterity Share: the client links I created — who has opened and downloaded them, when they
  // expire, with copy, extend and revoke. Reads the share store on the office server directly.
  import { onMount } from 'svelte'
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { engine, host } from '../../lib/api'
  import { fmtAgo, fmtDateFull, fmtSize, plural } from '../../lib/format'
  import { EXPIRY_DAYS, buildEmail, daysLeft, fmtExpiryDate, normalizeStaffWeb, type PublicLink, type PublicShareStatus, type StaffPassCreated, type StaffPassInfo } from '@shared/pubshare'

  let { close }: { close: (v?: unknown) => void } = $props()

  let links = $state.raw<PublicLink[]>([])
  let status = $state<PublicShareStatus | null>(null)
  let loading = $state(true)
  let error = $state('')
  let scope = $state<'mine' | 'all'>('mine')
  let busy = $state('')
  let confirm = $state('')
  let extendDays = $state<Record<string, number>>({})
  let copied = $state('')

  const live = $derived(links.filter((l) => !l.expired).length)

  // ---- "Use in a browser": a personal pass for the staff page (site/share/create/) ----------
  const web = $derived(normalizeStaffWeb(app.office?.publicShare?.web))
  let browserOpen = $state(false)
  let passes = $state.raw<StaffPassInfo[]>([])
  let made = $state<StaffPassCreated | null>(null)
  let passBusy = $state('')
  let passError = $state('')
  let passConfirm = $state('')

  async function loadPasses() {
    try {
      passes = await engine.call<StaffPassInfo[]>('pubshare.passList', 'mine')
      passError = ''
    } catch (e: any) {
      passError = String(e?.message ?? e).replace(/^Error:\s*/, '')
    }
  }

  function toggleBrowser() {
    browserOpen = !browserOpen
    if (browserOpen) void loadPasses()
    else made = null
  }

  async function makePass() {
    if (passBusy) return
    passBusy = 'new'
    try {
      made = await engine.call<StaffPassCreated>('pubshare.passCreate')
      passError = ''
      await loadPasses()
    } catch (e: any) {
      passError = String(e?.message ?? e).replace(/^Error:\s*/, '')
    } finally {
      passBusy = ''
    }
  }

  async function copyPass() {
    if (!made) return
    await host.clip.writeText(made.link)
    flash('pass')
  }

  async function switchOff(p: StaffPassInfo) {
    if (passBusy) return
    passBusy = p.id
    try {
      await engine.call('pubshare.passRevoke', p.id)
      if (made?.id === p.id) made = null
      passConfirm = ''
      app.toast('success', 'Browser sign-in switched off', `The browser signed in on ${fmtDateFull(p.createdAt)} can no longer create links.`)
      await loadPasses()
    } catch (e: any) {
      app.toast('error', "Couldn't switch it off", String(e?.message ?? e).replace(/^Error:\s*/, ''))
    } finally {
      passBusy = ''
    }
  }

  async function load() {
    loading = true
    error = ''
    try {
      links = await engine.call<PublicLink[]>('pubshare.list', scope)
    } catch (e: any) {
      error = String(e?.message ?? e).replace(/^Error:\s*/, '')
      links = []
    } finally {
      loading = false
    }
  }

  onMount(() => {
    void load()
    void engine.call<PublicShareStatus>('pubshare.status').then((s) => (status = s), () => {})
  })

  function flash(key: string) {
    copied = key
    setTimeout(() => copied === key && (copied = ''), 1600)
  }

  async function copyLink(l: PublicLink) {
    await host.clip.writeText(l.url)
    flash(`l:${l.id}`)
  }

  async function copyEmail(l: PublicLink) {
    const m = buildEmail({ url: l.url, title: l.title, message: l.message, sender: l.sender, files: l.files, expiresAt: l.expiresAt, hasPassword: l.hasPassword })
    await host.clip.writeText(`Subject: ${m.subject}\r\n\r\n${m.body}`)
    flash(`e:${l.id}`)
  }

  async function extend(l: PublicLink) {
    if (busy) return
    busy = l.id
    try {
      const until = await engine.call<number>('pubshare.extend', l.id, extendDays[l.id] ?? 7)
      app.toast('success', `“${l.title}” now expires on ${fmtExpiryDate(until)}`, 'Tell the client if you already told them the old date.')
      await load()
    } catch (e: any) {
      app.toast('error', "Couldn't extend the link", String(e?.message ?? e).replace(/^Error:\s*/, ''))
    } finally {
      busy = ''
    }
  }

  async function revoke(l: PublicLink) {
    if (busy) return
    busy = l.id
    try {
      await engine.call('pubshare.revoke', l.id)
      app.toast('success', `Revoked “${l.title}”`, 'The link stopped working and its files were removed from the server.')
      confirm = ''
      await load()
    } catch (e: any) {
      app.toast('error', "Couldn't revoke the link", String(e?.message ?? e).replace(/^Error:\s*/, ''))
    } finally {
      busy = ''
    }
  }

  function expiry(l: PublicLink) {
    if (l.expired) return 'Expired'
    const d = daysLeft(l.expiresAt)
    return d <= 1 ? 'Expires within a day' : `${d} days left`
  }
</script>

<Dialog title="My client links" icon="link" width={720} onclose={() => close()}>
  <div class="top">
    {#if status}
      <span class="srv" class:okc={status.healthy} class:badc={!status.healthy}>
        <span class="dot"></span>
        {status.healthy ? 'Share server online' : !status.enabled ? 'Dexterity Share is switched off' : !status.storeOk ? `Store not reachable: ${status.storeError}` : (status.healthError ?? 'Share server offline')}
      </span>
    {/if}
    {#if status?.server && status.healthy}
      <span class="caption">{status.server.activeDownloads ? `${status.server.activeDownloads} downloading now · ` : ''}{fmtSize(status.server.bytesToday ?? 0)} sent today{status.freeBytes != null ? ` · ${fmtSize(status.freeBytes)} free on the server` : ''}{status.server.host ? ` · on ${status.server.host}` : ''}</span>
    {:else if status?.serverSeenAt && !status.healthy}
      <span class="caption">last seen {fmtAgo(status.serverSeenAt)}{status.server?.host ? ` on ${status.server.host}` : ''}</span>
    {/if}
    <span class="spacer"></span>
    {#if web.enabled}
      <button type="button" class="btn" aria-expanded={browserOpen} onclick={toggleBrowser} title="Create client links from a web browser, e.g. on another PC"><Icon name="cloud" /> Use in a browser</button>
    {/if}
    <select class="input" bind:value={scope} onchange={load} aria-label="Whose links">
      <option value="mine">My links</option>
      <option value="all">Everyone's links</option>
    </select>
    <button type="button" class="btn icon" title="Refresh" aria-label="Refresh" onclick={load}><Icon name="refresh" /></button>
  </div>

  {#if browserOpen && web.enabled}
    <section class="browser" aria-label="Use in a browser">
      <div class="bh">
        <b>Create links from a browser</b>
        <span class="caption">Upload a .zip, .rar or .7z (up to {web.maxGB} GB) from any PC and get a client link, without Hopper. The browser signs in with a personal link made here.</span>
      </div>
      {#if made}
        <div class="made" role="status">
          <label class="field"><span>Your sign-in link (shown only now)</span>
            <input class="input mono" readonly value={made.link} aria-label="Sign-in link" onfocus={(e) => e.currentTarget.select()} />
          </label>
          <div class="row">
            <button type="button" class="btn primary" onclick={copyPass}><Icon name={copied === 'pass' ? 'check' : 'copy'} /> {copied === 'pass' ? 'Copied' : 'Copy link'}</button>
            <button type="button" class="btn" onclick={() => host.shell.openExternal(made!.link)}><Icon name="open" /> Open in browser</button>
          </div>
          <div class="caption">Open it once in the browser you want to use, then bookmark the page: the link signs that browser in and is removed from the address bar. It works like a password, so do not send it to anyone; make a new one for each browser.</div>
        </div>
      {:else}
        <div class="row"><button type="button" class="btn primary" disabled={passBusy === 'new'} onclick={makePass}><Icon name="plus" /> {passBusy === 'new' ? 'Making…' : 'Make a sign-in link'}</button></div>
      {/if}
      {#if passError}<div class="caption badText">{passError}</div>{/if}
      {#if passes.length}
        <ul class="passes" aria-label="Browsers signed in">
          {#each passes as p (p.id)}
            <li>
              <span class="pt"><b>Made on {p.host || 'a PC'}</b> <span class="caption">{fmtDateFull(p.createdAt)} · {p.lastUsedAt ? `last used ${fmtAgo(p.lastUsedAt)}` : 'not used yet'}</span></span>
              {#if passConfirm === p.id}
                <span class="caption">That browser is signed out at once.</span>
                <button type="button" class="btn sm danger" disabled={passBusy === p.id} onclick={() => switchOff(p)}>Yes, switch off</button>
                <button type="button" class="btn sm" onclick={() => (passConfirm = '')}>Keep</button>
              {:else}
                <button type="button" class="btn sm danger" onclick={() => (passConfirm = p.id)}>Switch off</button>
              {/if}
            </li>
          {/each}
        </ul>
      {:else if !passError}
        <div class="caption">No browser is signed in yet.</div>
      {/if}
    </section>
  {/if}

  {#if error}
    <div class="empty"><Icon name="warning" size={20} /> <span>{error}</span></div>
  {:else if loading && !links.length}
    <div class="empty caption">Reading the share store…</div>
  {:else if !links.length}
    <div class="empty">
      <Icon name="link" size={24} />
      <span>No client links yet.</span>
      <span class="caption">Select files or a zip and choose <b>Create client link</b> to send them to a client.</span>
    </div>
  {:else}
    <div class="caption">{plural(links.length, 'link')} · {live} live</div>
    <ul class="list">
      {#each links as l (l.id)}
        <li class:expired={l.expired}>
          <div class="head">
            <span class="name ellipsis" title={l.title}>{l.title}</span>
            {#if l.hasPassword}<span class="tag" title="Password protected"><Icon name="lock" size={12} /> password</span>{/if}
            <span class="tag" class:warnc={!l.expired && daysLeft(l.expiresAt) <= 2} class:badc={l.expired} title={fmtExpiryDate(l.expiresAt)}>{expiry(l)}</span>
          </div>
          <div class="caption">
            {l.files.length === 1 ? l.files[0].name : plural(l.files.length, 'file')} · {fmtSize(l.bytes)} · created {fmtAgo(l.createdAt)}{scope === 'all' ? ` by ${l.sender || l.owner}` : ''} · expires {fmtExpiryDate(l.expiresAt)}
          </div>
          <div class="stats">
            {#if l.stats && (l.stats.views || l.stats.started)}
              <span class:hit={l.stats.downloads > 0}><Icon name="download" size={14} /> {l.stats.downloads ? `Downloaded ${l.stats.downloads === 1 ? 'once' : `${l.stats.downloads} times`}` : l.stats.started ? 'Download started, not finished' : 'Not downloaded yet'}{l.maxDownloads ? ` (limit ${l.maxDownloads} per file)` : ''}</span>
              <span><Icon name="eye" size={14} /> opened {l.stats.views === 1 ? 'once' : `${l.stats.views} times`}</span>
              {#if l.stats.lastDownloadAt}<span>last download {fmtAgo(l.stats.lastDownloadAt)}</span>{:else if l.stats.lastViewAt}<span>last opened {fmtAgo(l.stats.lastViewAt)}</span>{/if}
            {:else}
              <span>Not opened yet</span>
            {/if}
          </div>
          <div class="acts">
            {#if confirm === l.id}
              <span class="ask">Revoke this link? The client can no longer download and the files are removed from the server.</span>
              <button type="button" class="btn sm danger" disabled={busy === l.id} onclick={() => revoke(l)}>Yes, revoke</button>
              <button type="button" class="btn sm" onclick={() => (confirm = '')}>Keep</button>
            {:else}
              <button type="button" class="btn sm" disabled={l.expired} onclick={() => copyLink(l)}><Icon name={copied === `l:${l.id}` ? 'check' : 'copy'} /> {copied === `l:${l.id}` ? 'Copied' : 'Copy link'}</button>
              <button type="button" class="btn sm" disabled={l.expired} onclick={() => copyEmail(l)}><Icon name={copied === `e:${l.id}` ? 'check' : 'send'} /> {copied === `e:${l.id}` ? 'Copied' : 'Copy e-mail'}</button>
              <span class="spacer"></span>
              <select class="input sm" aria-label="Days to add" value={extendDays[l.id] ?? 7} onchange={(e) => (extendDays = { ...extendDays, [l.id]: Number(e.currentTarget.value) })}>
                {#each EXPIRY_DAYS as d (d)}<option value={d}>+{d} {d === 1 ? 'day' : 'days'}</option>{/each}
              </select>
              <button type="button" class="btn sm" disabled={busy === l.id} onclick={() => extend(l)}><Icon name="clock" /> {l.expired ? 'Revive' : 'Extend'}</button>
              <button type="button" class="btn sm danger" onclick={() => (confirm = l.id)}><Icon name="delete" /> Revoke</button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
    <div class="caption">Expired links stay here for a day (extend to revive them), then the server deletes their files.</div>
  {/if}

  {#snippet footer()}
    <span class="caption foot">Download counts come from the share server and update within a few seconds.</span>
    <button type="button" class="btn primary" onclick={() => close()}>Close</button>
  {/snippet}
</Dialog>

<style>
  .top {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .srv {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text-2);
  }
  .srv .dot {
    background: var(--text-3);
  }
  .srv.okc .dot {
    background: var(--ok);
  }
  .srv.badc .dot {
    background: var(--warn);
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 36px 12px;
    text-align: center;
    color: var(--text-2);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  li {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    border-radius: var(--r-md);
    border: 1px solid var(--stroke-2);
    background: var(--layer-solid);
  }
  li.expired .name {
    color: var(--text-2);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .name {
    flex: 1;
    font-weight: 600;
  }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    padding: 0 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
    background: var(--hover);
    color: var(--text-2);
    white-space: nowrap;
  }
  .tag.warnc {
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 12%, transparent);
  }
  .tag.badc {
    color: var(--bad);
    background: color-mix(in srgb, var(--bad) 12%, transparent);
  }
  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    font-size: 12px;
    color: var(--text-2);
  }
  .stats span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .stats .hit {
    color: var(--ok);
    font-weight: 600;
  }
  .acts {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .acts .input.sm {
    height: 28px;
    font-size: 13px;
  }
  .ask {
    flex: 1;
    font-size: 13px;
  }
  .foot {
    flex: 1;
    align-self: center;
  }
  .browser {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border-radius: var(--r-md);
    border: 1px solid var(--stroke-2);
    background: var(--layer-solid);
  }
  .bh {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .made {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .made .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
  }
  .mono {
    font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
    font-size: 12px;
  }
  .row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .passes {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .passes li {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 4px 0;
    border-top: 1px solid var(--stroke-2);
  }
  .pt {
    flex: 1;
    min-width: 0;
  }
  .badText {
    color: var(--bad);
  }
</style>
