<script lang="ts">
  // Strip under the command bar for things the whole office should not miss: an admin's invite
  // to join (only on a PC without an office key) and important or urgent announcements that
  // this user has not acknowledged yet. Info announcements never show here.
  import { app } from '../lib/app.svelte'
  import { lanx, LEVEL_LABEL } from '../lib/lan2.svelte'
  import { fmtAgo } from '../lib/format'
  import Icon from './Icon.svelte'

  const top = $derived(lanx.banner[0])
  const more = $derived(lanx.banner.length - 1)
  let joining = $state('')

  async function join(id: string) {
    const inv = lanx.joinPrompts.find((i) => i.id === id)
    if (!inv || joining) return
    joining = id
    try {
      await lanx.acceptInvite(inv)
    } finally {
      joining = ''
    }
  }
</script>

{#each lanx.joinPrompts as inv (inv.id)}
  <div class="bar invite" role="alert" data-invite={inv.id}>
    <span class="ic"><Icon name="people" size={18} /></span>
    <div class="txt">
      <div class="ttl ellipsis"><b>{inv.adminName}</b> ({inv.host || 'unknown PC'}, {inv.address}) invites this PC to join <b>{inv.officeName}</b></div>
      <div class="caption ellipsis">
        Key fingerprint <code>{inv.fingerprint}</code> · compare it with the one on {inv.adminName}'s Office page before joining. Nothing changes until you click Join.
      </div>
    </div>
    <button class="btn primary sm" disabled={!!joining} onclick={() => join(inv.id)}>{joining === inv.id ? 'Joining…' : 'Join'}</button>
    <button class="btn sm" disabled={!!joining} onclick={() => lanx.ignoreInvite(inv)}>Ignore</button>
  </div>
{/each}

{#if top}
  <div class="bar {top.level}" role="alert" data-announcement={top.id}>
    <span class="ic"><Icon name={top.level === 'urgent' ? 'warning' : 'bell'} size={18} /></span>
    <div class="txt">
      <div class="ttl ellipsis"><span class="lvl">{LEVEL_LABEL[top.level]}</span> <b>{top.title}</b></div>
      <div class="caption ellipsis" title={top.body}>
        {top.byName} · {fmtAgo(top.at)}{top.body ? ` · ${top.body.replace(/\s+/g, ' ')}` : ''}
      </div>
    </div>
    {#if top.path}
      <button class="btn sm" title={top.path} onclick={() => app.active.navigate(top.path!)}><Icon name="folderOpen" /> Open folder</button>
    {/if}
    <button class="btn sm" onclick={() => lanx.openList()}>{more > 0 ? `View all (${more} more)` : 'Details'}</button>
    <button class="btn primary sm" title="Tells the sender you have seen this" onclick={() => lanx.ack(top.id)}><Icon name="check" /> Got it</button>
  </div>
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 8px 6px 8px;
    padding: 7px 8px 7px 12px;
    border-radius: var(--r-md);
    border: 1px solid var(--stroke-2);
    background: var(--card-solid);
    --tone: var(--accent);
    border-left: 4px solid var(--tone);
  }
  .bar.important {
    --tone: var(--warn);
    background: color-mix(in srgb, var(--warn) 9%, var(--card-solid));
  }
  .bar.urgent {
    --tone: var(--bad);
    background: color-mix(in srgb, var(--bad) 11%, var(--card-solid));
  }
  .bar.invite {
    background: color-mix(in srgb, var(--accent) 9%, var(--card-solid));
  }
  .ic {
    display: flex;
    color: var(--tone);
    flex: none;
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .ttl {
    font-size: 13px;
  }
  .lvl {
    display: inline-block;
    padding: 0 6px;
    margin-right: 4px;
    border-radius: 8px;
    font-size: 11px;
    font-weight: 600;
    line-height: 16px;
    color: var(--card-solid);
    background: var(--tone);
  }
  code {
    font-family: var(--mono);
    user-select: text;
  }
  .btn {
    flex: none;
  }
</style>
