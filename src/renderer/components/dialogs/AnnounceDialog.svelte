<script lang="ts">
  // Compose an office announcement: title, details, level, an optional folder it is about and
  // an optional expiry. Anyone in the office can post.
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { host, lan } from '../../lib/api'
  import { lanx, toUnc } from '../../lib/lan2.svelte'
  import { plural } from '../../lib/format'
  import type { AnnouncementLevel, AnnouncementView } from '@shared/types'

  let { path, close }: { path?: string; close: (v?: unknown) => void } = $props()

  const LEVELS: { id: AnnouncementLevel; label: string; hint: string }[] = [
    { id: 'info', label: 'Info', hint: 'Listed under Announcements and shown as a toast. No banner.' },
    { id: 'important', label: 'Important', hint: 'Banner at the top of Hopper until each person clicks Got it.' },
    { id: 'urgent', label: 'Urgent', hint: 'Red banner, a toast that stays, and a Windows notification.' }
  ]
  const EXPIRY = [
    { id: '', label: 'Never' },
    { id: '1h', label: 'In 1 hour', ms: 3600_000 },
    { id: 'today', label: 'End of today' },
    { id: '1d', label: 'In 24 hours', ms: 24 * 3600_000 },
    { id: '7d', label: 'In 7 days', ms: 7 * 24 * 3600_000 }
  ]

  let title = $state('')
  let body = $state('')
  let level = $state<AnnouncementLevel>('important')
  let folder = $state(path ?? '')
  let expiry = $state('')
  let busy = $state(false)

  const unc = $derived(toUnc(folder, app.drives))
  const folderOk = $derived(!folder.trim() || /^(\\\\[^\\]+\\[^\\]+|[a-zA-Z]:\\)/.test(unc.path))
  const online = $derived(app.peers.filter((p) => !p.self && p.status !== 'offline').length)
  const known = $derived(new Set(app.peers.filter((p) => !p.self).map((p) => p.user)).size)

  function expires() {
    const e = EXPIRY.find((x) => x.id === expiry)
    if (!e || !e.id) return undefined
    if (e.ms) return Date.now() + e.ms
    const d = new Date()
    d.setHours(23, 59, 59, 0)
    return d.getTime()
  }

  async function browse() {
    const d = await host.dialog.folder('Folder this announcement is about', folder || undefined)
    if (d) folder = d
  }

  async function post() {
    if (busy || !title.trim() || !folderOk) return
    busy = true
    try {
      const a = await lan.call<AnnouncementView>('announce.post', { title: title.trim(), body: body.trim(), level, path: folder.trim() ? unc.path : undefined, expires: expires() })
      if (a.notStored) app.toast('warning', 'Announced to the PCs that are on now', "The office folder couldn't be written, so PCs that are off will not see it. Check the office config path.")
      else app.toast('success', 'Announcement posted', `${plural(online, 'PC')} online get it now; the rest see it when Hopper starts.`)
      close(a)
    } catch (e: any) {
      app.toast('error', "Couldn't post the announcement", e.message)
    } finally {
      busy = false
    }
  }
</script>

<Dialog title="New announcement" icon="bell" width={580} onclose={() => close()} onsubmit={post}>
  {#if !lanx.canAnnounce}
    <div class="warn"><Icon name="warning" /> <span>Hopper is still finding out who you are. Try again in a moment.</span></div>
  {/if}
  <label class="field">
    <span>Title</span>
    <input class="input" bind:value={title} maxlength="120" placeholder="e.g. P10001 project folder is almost full" autofocus />
  </label>
  <label class="field">
    <span>Details <span class="caption">(optional)</span></span>
    <textarea class="input" rows="4" bind:value={body} maxlength="4000" placeholder="e.g. Please make a local backup of your working files and clear out old exports by 5 pm."></textarea>
  </label>

  <div class="levels" role="radiogroup" aria-label="Level">
    {#each LEVELS as l (l.id)}
      <button type="button" role="radio" aria-checked={level === l.id} class="lvl {l.id}" class:on={level === l.id} onclick={() => (level = l.id)}>
        <span class="nm"><span class="sw"></span>{l.label}</span>
        <span class="caption">{l.hint}</span>
      </button>
    {/each}
  </div>

  <label class="field">
    <span>Folder it is about <span class="caption">(optional; people get an Open folder button)</span></span>
    <div class="row">
      <input class="input" bind:value={folder} spellcheck="false" placeholder="\\server\share\project folder" />
      <button type="button" class="btn" onclick={browse}><Icon name="folderOpen" /> Browse…</button>
    </div>
  </label>
  {#if folder.trim() && !folderOk}
    <div class="caption warnText">Type a full path, like \\server\share\folder or X:\folder.</div>
  {:else if folder.trim() && !unc.shared}
    <div class="caption warnText">{folder.slice(0, 2).toUpperCase()} is a disk on this PC; other PCs can only open it if they have the same drive.</div>
  {:else if folder.trim() && unc.path !== folder.trim()}
    <div class="caption">Sent as {unc.path} so it opens on every PC.</div>
  {/if}

  <label class="field narrow">
    <span>Stops showing</span>
    <select class="input" bind:value={expiry}>
      {#each EXPIRY as e (e.id)}<option value={e.id}>{e.label}</option>{/each}
    </select>
  </label>

  {#snippet footer()}
    <span class="caption foot">Goes to {plural(online, 'PC')} online now{known > online ? ` and ${plural(known - online, 'colleague')} when they next open Hopper` : ''}.</span>
    <button type="submit" class="btn primary" disabled={busy || !title.trim() || !folderOk || !lanx.canAnnounce}><Icon name="bell" /> {busy ? 'Posting…' : 'Announce'}</button>
    <button type="button" class="btn" onclick={() => close()}>Cancel</button>
  {/snippet}
</Dialog>

<style>
  .levels {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .lvl {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 10px;
    text-align: left;
    border-radius: var(--r-md);
    border: 1px solid var(--stroke);
    background: var(--layer-solid);
    --tone: var(--accent);
  }
  .lvl.important {
    --tone: var(--warn);
  }
  .lvl.urgent {
    --tone: var(--bad);
  }
  .lvl:hover {
    background: var(--hover);
  }
  .lvl.on {
    border-color: var(--tone);
    box-shadow: inset 0 0 0 1px var(--tone);
  }
  .nm {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    font-size: 13px;
  }
  .sw {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--tone);
  }
  .narrow {
    max-width: 220px;
  }
  .warn {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 8px 12px;
    border-radius: var(--r-md);
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 10%, transparent);
    font-size: 13px;
  }
  .warnText {
    color: var(--warn);
  }
  .foot {
    flex: 1;
    align-self: center;
  }
</style>
