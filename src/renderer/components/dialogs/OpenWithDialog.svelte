<script lang="ts">
  // Open with: the apps registered on this PC for the file type, listed and started by Hopper,
  // plus "Choose another app" through Hopper's own file picker.
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { host } from '../../lib/api'
  import { dialogs } from '../../lib/commands'
  import type { Entry } from '@shared/types'

  let { entry, close }: { entry: Entry; close: (v?: unknown) => void } = $props()

  interface AppInfo {
    name: string
    label: string
    recommended: boolean
    icon?: string
  }
  let apps = $state<AppInfo[]>([])
  let loading = $state(true)
  let error = $state('')
  let hot = $state(0)

  void host.shell
    .openWithList(entry.path)
    .then((l: AppInfo[]) => {
      // Windows lists some handlers with no name, and some twice
      const seen = new Set<string>()
      apps = l
        .filter((a) => a.label.trim() && !seen.has(a.label.toLowerCase()) && !!seen.add(a.label.toLowerCase()))
        .sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.label.localeCompare(b.label))
    })
    .catch((e: Error) => (error = e.message))
    .finally(() => (loading = false))

  const isExe = (p?: string) => !!p && /^[a-zA-Z]:\\.*\.exe$/i.test(p)

  async function open(a: AppInfo) {
    try {
      await host.shell.openWithInvoke(entry.path, a.name)
      close(true)
    } catch (e: any) {
      error = `${a.label}: ${e.message}`
    }
  }

  async function other() {
    const exe = (await dialogs.pickFolder?.({ title: 'Choose an app', mode: 'file', filter: ['exe', 'bat', 'cmd'], start: 'C:\\Program Files' })) as string | undefined
    if (!exe) return
    try {
      await host.shell.openWithApp(exe, entry.path)
      close(true)
    } catch (e: any) {
      error = e.message
    }
  }

  function key(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      hot = Math.min(apps.length - 1, hot + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      hot = Math.max(0, hot - 1)
    }
  }
</script>

<Dialog title="Open with" icon="openWith" width={440} onclose={() => close()} onsubmit={() => apps[hot] && open(apps[hot])}>
  <div class="caption ellipsis" title={entry.path}>{entry.name}</div>
  {#if error}<div class="err"><Icon name="warning" /> {error}</div>{/if}
  <div class="list" role="listbox" tabindex="0" onkeydown={key}>
    {#if loading}
      <div class="caption pad">Looking for apps…</div>
    {:else if !apps.length}
      <div class="caption pad">No apps are registered for .{entry.ext || 'this type'} on this PC.</div>
    {/if}
    {#each apps as a, i (i)}
      <button type="button" class="app" class:hot={i === hot} onmouseenter={() => (hot = i)} onclick={() => open(a)}>
        <span class="ic">
          {#if isExe(a.icon) || isExe(a.name)}
            <img src={`hopper://icon/?p=${encodeURIComponent(isExe(a.icon) ? a.icon! : a.name)}&e=exe&z=normal`} alt="" width="28" height="28" />
          {:else}
            <Icon name="app" size={24} />
          {/if}
        </span>
        <span class="ellipsis lbl">{a.label}</span>
        {#if a.recommended}<span class="caption">Recommended</span>{/if}
      </button>
    {/each}
  </div>
  {#snippet footer()}
    <button type="button" class="btn" onclick={other}><Icon name="folderOpen" /> Choose another app…</button>
    <span style="flex:1"></span>
    <button type="submit" class="btn primary" disabled={!apps.length}>Open</button>
    <button type="button" class="btn" onclick={() => close()}>Cancel</button>
  {/snippet}
</Dialog>

<style>
  .list {
    max-height: 340px;
    overflow: auto;
    border: 1px solid var(--stroke);
    border-radius: var(--r-md);
    padding: 4px;
    outline: none;
  }
  .app {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    height: 44px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    text-align: left;
  }
  .app.hot {
    background: var(--hover);
  }
  .ic {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    flex: none;
  }
  .lbl {
    flex: 1;
  }
  .pad {
    padding: 16px;
    text-align: center;
  }
  .err {
    display: flex;
    gap: 8px;
    align-items: center;
    color: var(--bad);
    font-size: 13px;
  }
</style>
