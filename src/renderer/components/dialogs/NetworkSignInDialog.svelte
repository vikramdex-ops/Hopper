<script lang="ts">
  // Hopper's own sign-in for a network computer or share (not the Windows credential prompt).
  // The password lives only in this dialog until it is handed to Windows, then it is cleared.
  import { onDestroy, untrack } from 'svelte'
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { net } from '../../lib/network.svelte'
  import type { NetError } from '@shared/network'

  let { host, share = '', close }: { host: string; share?: string; close: (v?: boolean) => void } = $props()
  const remote = $derived(share ? `\\\\${host}\\${share}` : `\\\\${host}`)
  let user = $state(untrack(() => net.listing(host)?.remembered ?? ''))
  let password = $state('')
  let remember = $state(false)
  let busy = $state(false)
  let error = $state<NetError | null>(null)

  onDestroy(() => (password = ''))

  async function submit() {
    if (busy) return
    if (!user.trim()) {
      error = { code: 'badlogin', message: 'Type the user name for an account on ' + host + '.', canSignIn: true }
      return
    }
    busy = true
    error = null
    const r = await net.connect(remote, user.trim(), password, remember)
    busy = false
    if (r.error) {
      error = r.error
      return
    }
    password = ''
    close(true)
  }

  async function signOutAndRetry() {
    busy = true
    await net.signOut(host, false)
    busy = false
    await submit()
  }
</script>

<Dialog title={`Sign in to ${host}`} icon="lock" width={440} onclose={() => close(false)} onsubmit={submit}>
  <p class="lead">{share ? `${remote} needs` : `${host} needs`} a user name and password for an account on that computer.</p>
  <label class="field">
    <span>User name</span>
    <input class="input" bind:value={user} spellcheck="false" autocomplete="off" placeholder={`${host}\\name, or name`} aria-label="User name" disabled={busy} />
  </label>
  <label class="field">
    <span>Password</span>
    <!-- svelte-ignore a11y_autofocus -->
    <input class="input" type="password" bind:value={password} autocomplete="off" aria-label="Password" disabled={busy} autofocus={!!user} />
  </label>
  <label class="check">
    <input type="checkbox" bind:checked={remember} disabled={busy} />
    <span>Remember on this PC</span>
  </label>
  <p class="hint">{remember ? 'Windows keeps the password in Credential Manager for this user on this PC. Hopper does not store it.' : 'Without this, Hopper stays signed in until you sign out of Windows.'}</p>
  {#if error}
    <div class="err" role="alert">
      <Icon name="error" />
      <span>{error.message}</span>
    </div>
    {#if error.code === 'conflict'}
      <button type="button" class="btn sm" onclick={signOutAndRetry} disabled={busy}>Sign out of {host} and try again</button>
    {/if}
  {/if}
  {#snippet footer()}
    {#if busy}<span class="caption wait">Signing in…</span>{/if}
    <button type="submit" class="btn primary" disabled={busy}>Sign in</button>
    <button type="button" class="btn" onclick={() => close(false)}>Cancel</button>
  {/snippet}
</Dialog>

<style>
  .lead {
    margin: 0;
    color: var(--text-2);
    word-break: break-word;
  }
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
