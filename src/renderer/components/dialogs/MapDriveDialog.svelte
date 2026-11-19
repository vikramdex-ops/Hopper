<script lang="ts">
  // "Map network drive": a shared folder, a free drive letter and "Reconnect at sign-in".
  // Uses the current Windows sign-in; if the server wants another account, Hopper's sign-in comes first.
  import { untrack } from 'svelte'
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { net } from '../../lib/network.svelte'
  import { freeDriveLetters, mappableUnc, parseAddress, type NetError } from '@shared/network'

  let { remote = '', close }: { remote?: string; close: (v?: { local: string; remote: string } | null) => void } = $props()
  let folder = $state(untrack(() => mappableUnc(remote) ?? remote))
  const letters = $derived(freeDriveLetters(app.drives.map((d) => d.root)))
  let letter = $state(untrack(() => freeDriveLetters(app.drives.map((d) => d.root))[0] ?? ''))
  let reconnect = $state(true)
  let busy = $state(false)
  let error = $state<NetError | null>(null)

  async function submit() {
    if (busy) return
    const a = parseAddress(folder)
    const unc = a.ok ? mappableUnc(a.unc) : null
    if (!unc) {
      error = { code: 'noshare', message: a.ok ? 'Pick a shared folder, not just the computer: \\\\server\\share.' : a.message, canSignIn: false }
      return
    }
    if (!letter) {
      error = { code: 'busy', message: 'Every drive letter is in use. Disconnect a drive first.', canSignIn: false }
      return
    }
    busy = true
    error = null
    const r = await net.map(letter, unc, reconnect)
    busy = false
    if (r.error) {
      error = r.error
      return
    }
    close({ local: r.local ?? `${letter}:`, remote: unc })
  }

  async function signInAndRetry() {
    const a = parseAddress(folder)
    if (!a.ok) return
    if (await net.signIn(a.host, a.share)) await submit()
  }
</script>

<Dialog title="Map network drive" icon="network" width={480} onclose={() => close(null)} onsubmit={submit}>
  <label class="field">
    <span>Folder</span>
    <input class="input" bind:value={folder} spellcheck="false" placeholder={'\\\\server\\share'} aria-label="Shared folder" disabled={busy} oninput={() => (error = null)} />
  </label>
  <label class="field">
    <span>Drive</span>
    <select class="input" bind:value={letter} aria-label="Drive letter" disabled={busy || !letters.length}>
      {#each letters as l (l)}<option value={l}>{l}:</option>{/each}
    </select>
  </label>
  <label class="check">
    <input type="checkbox" bind:checked={reconnect} disabled={busy} />
    <span>Reconnect at sign-in</span>
  </label>
  {#if error}
    <div class="err" role="alert">
      <Icon name="error" />
      <span>{error.message}</span>
    </div>
    {#if error.canSignIn}
      <button type="button" class="btn sm" onclick={signInAndRetry} disabled={busy}>Sign in and try again</button>
    {/if}
  {:else}
    <p class="hint">Windows uses your current sign-in for this folder.</p>
  {/if}
  {#snippet footer()}
    {#if busy}<span class="caption wait">Connecting…</span>{/if}
    <button type="submit" class="btn primary" disabled={busy}>Map drive</button>
    <button type="button" class="btn" onclick={() => close(null)}>Cancel</button>
  {/snippet}
</Dialog>

<style>
  .hint {
    margin: -6px 0 0;
  }
  .err {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    font-size: 13px;
    color: var(--bad);
  }
  .err :global(svg) {
    flex: none;
    margin-top: 2px;
  }
  .wait {
    margin-right: auto;
    align-self: center;
  }
</style>
