<script lang="ts">
  import Dialog from '../Dialog.svelte'
  let { title, value = '', label, close }: { title: string; value?: string; label?: string; close: (v?: string | null) => void } = $props()
  let text = $state(value)
</script>

<Dialog {title} width={440} onclose={() => close(null)} onsubmit={() => close(text)}>
  <label class="field">
    {#if label}<span>{label}</span>{/if}
    <input class="input" bind:value={text} spellcheck="false" />
  </label>
  {#snippet footer()}
    <button type="submit" class="btn primary">OK</button>
    <button type="button" class="btn" onclick={() => close(null)}>Cancel</button>
  {/snippet}
</Dialog>
