<script lang="ts">
  // Announcements: everything posted to the office, newest first. Anyone can acknowledge; admins
  // and announcers also see who has acknowledged, can post new ones and withdraw old ones.
  import { onMount } from 'svelte'
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { lan } from '../../lib/api'
  import { isLive, lanx, LEVEL_LABEL } from '../../lib/lan2.svelte'
  import { fmtAgo, fmtDateFull, plural } from '../../lib/format'
  import type { AnnouncementView } from '@shared/types'

  let { close }: { close: (v?: unknown) => void } = $props()

  let showOld = $state(false)
  let open = $state<string | null>(null)

  const current = $derived(lanx.announcements.filter((a) => isLive(a, lanx.now)))
  const old = $derived(lanx.announcements.filter((a) => !isLive(a, lanx.now)))
  /** everyone this PC knows, for "not yet" lists */
  const everyone = $derived([...new Map(app.peers.filter((p) => !p.self).map((p) => [p.user, p.displayName || p.user])).entries()])

  onMount(() => {
    void lan.call('announce.sync').then((l) => (lanx.announcements = l)).catch(() => {})
  })

  // listing them is reading them
  $effect(() => {
    for (const a of current) if (!a.read) lanx.markRead(a.id)
  })

  const waiting = (a: AnnouncementView) => everyone.filter(([u]) => u !== a.by && !a.acks?.some((k) => k.user === u))

  async function withdraw(a: AnnouncementView) {
    if (!(await app.confirm(`Withdraw "${a.title}"?`, 'It leaves every banner and stays in the history, marked withdrawn.', 'Withdraw'))) return
    await lan.call('announce.withdraw', a.id).catch((e) => app.toast('error', "Couldn't withdraw it", e.message))
  }

  function go(path: string) {
    close()
    void app.active.navigate(path)
  }
</script>

{#snippet card(a: AnnouncementView, past: boolean)}
  <div class="card {a.level}" class:past class:unacked={!past && !a.acked && a.level !== 'info'} data-announcement={a.id}>
    <div class="top">
      <span class="lvl">{LEVEL_LABEL[a.level]}</span>
      <b class="ttl">{a.title}</b>
      <span class="caption when" title={fmtDateFull(a.at)}>{a.byName} · {fmtAgo(a.at)}</span>
    </div>
    {#if a.body}<div class="body">{a.body}</div>{/if}
    {#if a.path}
      <button type="button" class="pathbtn" title="Open in Hopper" onclick={() => go(a.path!)}><Icon name="folderOpen" size={14} /> <span class="ellipsis">{a.path}</span></button>
    {/if}
    <div class="foot">
      <span class="caption grow">
        {#if a.withdrawn}Withdrawn{:else if a.expires && a.expires <= lanx.now}Expired {fmtAgo(a.expires)}{:else if a.expires}Shows until {fmtDateFull(a.expires)}{/if}
      </span>
      {#if a.acks}
        <button type="button" class="link" onclick={() => (open = open === a.id ? null : a.id)}>
          {plural(a.acks.length, 'person')} acknowledged{everyone.length ? ` of ${everyone.filter(([u]) => u !== a.by).length}` : ''}
        </button>
        {#if !past}<button type="button" class="btn subtle sm" onclick={() => withdraw(a)}>Withdraw</button>{/if}
      {/if}
      {#if !past && a.by !== lanx.meta.user}
        {#if a.acked}
          <span class="caption ok"><Icon name="check" size={13} /> You acknowledged{a.ackedAt ? ` ${fmtAgo(a.ackedAt)}` : ''}</span>
        {:else}
          <button type="button" class="btn primary sm" onclick={() => lanx.ack(a.id)}><Icon name="check" /> Got it</button>
        {/if}
      {/if}
    </div>
    {#if a.acks && open === a.id}
      {@const not = waiting(a)}
      <div class="acks">
        <div><span class="caption">Acknowledged:</span> {a.acks.length ? a.acks.map((k) => `${app.personName(k.user) !== k.user ? app.personName(k.user) : k.name} (${fmtAgo(k.at)})`).join(', ') : 'nobody yet'}</div>
        {#if not.length}<div><span class="caption">Not yet:</span> {not.map(([, n]) => n).join(', ')}</div>{/if}
      </div>
    {/if}
  </div>
{/snippet}

<Dialog title="Announcements" icon="bell" width={680} onclose={() => close()}>
  <div class="list">
    {#each current as a (a.id)}
      {@render card(a, false)}
    {:else}
      <div class="none">
        <Icon name="bell" size={36} />
        <div class="subtitle">No announcements right now</div>
        <div class="caption">Office-wide notices from the admin show up here and, when they matter, as a banner at the top of Hopper.</div>
      </div>
    {/each}
    {#if old.length}
      <button type="button" class="link older" onclick={() => (showOld = !showOld)}>{showOld ? 'Hide' : 'Show'} {plural(old.length, 'older announcement')} (expired or withdrawn)</button>
      {#if showOld}
        {#each old as a (a.id)}{@render card(a, true)}{/each}
      {/if}
    {/if}
  </div>

  {#snippet footer()}
    <span class="caption tail">{lanx.canAnnounce ? 'You can post announcements for the whole office.' : 'Admins and announcers can post. Got it tells them you have seen one.'}</span>
    {#if lanx.canAnnounce}
      <button type="button" class="btn primary" onclick={() => lanx.compose()}><Icon name="plus" /> New announcement</button>
    {/if}
    <button type="button" class="btn" onclick={() => close()}>Close</button>
  {/snippet}
</Dialog>

<style>
  .list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 180px;
    max-height: 60vh;
    overflow: auto;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 14px;
    border-radius: var(--r-md);
    border: 1px solid var(--stroke);
    border-left: 4px solid var(--tone);
    background: var(--layer-solid);
    --tone: var(--accent);
  }
  .card.important {
    --tone: var(--warn);
  }
  .card.urgent {
    --tone: var(--bad);
  }
  .card.unacked {
    background: color-mix(in srgb, var(--tone) 7%, var(--layer-solid));
  }
  .card.past {
    opacity: 0.7;
    --tone: var(--stroke-strong);
  }
  .top {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .lvl {
    flex: none;
    padding: 0 6px;
    border-radius: 8px;
    font-size: 11px;
    font-weight: 600;
    line-height: 16px;
    color: var(--card-solid);
    background: var(--tone);
  }
  .ttl {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .when {
    flex: none;
  }
  .body {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
    font-size: 13px;
  }
  .pathbtn {
    align-self: flex-start;
    max-width: 100%;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    border-radius: var(--r-sm);
    border: 1px solid var(--stroke);
    background: var(--card-solid);
    font: 12px/18px var(--mono);
    color: var(--accent);
  }
  .pathbtn:hover {
    background: var(--hover);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 24px;
  }
  .grow {
    flex: 1;
  }
  .ok {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--ok);
  }
  .acks {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 10px;
    border-radius: var(--r-sm);
    background: var(--card-solid);
    font-size: 13px;
  }
  .none {
    margin: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 30px 0;
    color: var(--text-2);
    text-align: center;
    max-width: 380px;
  }
  .link {
    border: 0;
    background: none;
    color: var(--accent);
    font-size: 12px;
    padding: 0;
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .older {
    align-self: flex-start;
  }
  .tail {
    flex: 1;
    align-self: center;
  }
</style>
