<script lang="ts">
  // Dexterity Share: the client links I created — who has opened and downloaded them, when they
  // expire, with copy, extend and revoke. Reads the share store on the office server directly.
  import { onMount } from 'svelte'
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { engine, host } from '../../lib/api'
  import { fmtAgo, fmtSize, plural } from '../../lib/format'
  import { EXPIRY_DAYS, buildEmail, daysLeft, fmtExpiryDate, type PublicLink, type PublicShareStatus } from '@shared/pubshare'

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
    <select class="input" bind:value={scope} onchange={load} aria-label="Whose links">
      <option value="mine">My links</option>
      <option value="all">Everyone's links</option>
    </select>
    <button type="button" class="btn icon" title="Refresh" aria-label="Refresh" onclick={load}><Icon name="refresh" /></button>
  </div>

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
</style>
