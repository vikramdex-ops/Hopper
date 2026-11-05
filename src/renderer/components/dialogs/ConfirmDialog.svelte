<script lang="ts">
  import Dialog from '../Dialog.svelte'
  let { title, body, ok = 'OK', close }: { title: string; body?: string; ok?: string; close: (v?: boolean) => void } = $props()
</script>

<Dialog {title} width={440} onclose={() => close(false)} onsubmit={() => close(true)}>
  {#if body}<p class="body">{body}</p>{/if}
  {#snippet footer()}
    <button type="submit" class="btn primary" autofocus>{ok}</button>
    <button type="button" class="btn" onclick={() => close(false)}>Cancel</button>
  {/snippet}
</Dialog>

<style>
  .body {
    margin: 0;
    color: var(--text-2);
  }
</style>
