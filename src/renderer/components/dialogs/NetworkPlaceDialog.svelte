<script lang="ts">
  // "Add a network place": an address (\\server, \\server\share, smb://…) and an optional name.
  import { untrack } from 'svelte'
  import Dialog from '../Dialog.svelte'
  import { parseAddress } from '@shared/network'

  let { value = '', name: initialName = '', close }: { value?: string; name?: string; close: (v?: { path: string; name: string } | null) => void } = $props()
  let address = $state(untrack(() => value))
  let name = $state(untrack(() => initialName))
  let error = $state('')

  const preview = $derived.by(() => {
    const a = parseAddress(address)
    return a.ok && a.unc !== address.trim() ? a.unc : ''
  })

  function submit() {
    const a = parseAddress(address)
    if (!a.ok) {
      error = a.message
      return
    }
    close({ path: a.unc, name: name.trim() })
  }
</script>

<Dialog title="Add a network place" icon="network" width={480} onclose={() => close(null)} onsubmit={submit}>
  <label class="field">
    <span>Address</span>
    <input class="input" bind:value={address} spellcheck="false" placeholder={'\\\\server\\share'} aria-label="Network address" aria-invalid={!!error} oninput={() => (error = '')} />
  </label>
  {#if error}
    <p class="err" role="alert">{error}</p>
  {:else if preview}
    <p class="hint">Hopper will open <b>{preview}</b></p>
  {:else}
    <p class="hint">A computer (\\server), a shared folder (\\server\share) or a folder inside one. smb:// addresses work too.</p>
  {/if}
  <label class="field">
    <span>Name (optional)</span>
    <input class="input" bind:value={name} spellcheck="false" placeholder="Shown in the sidebar instead of the address" aria-label="Name" />
  </label>
  {#snippet footer()}
    <button type="submit" class="btn primary">Add</button>
    <button type="button" class="btn" onclick={() => close(null)}>Cancel</button>
  {/snippet}
</Dialog>

<style>
  .err {
    margin: -6px 0 0;
    font-size: 12px;
    color: var(--bad);
  }
  .hint {
    margin: -6px 0 0;
    word-break: break-all;
  }
</style>
