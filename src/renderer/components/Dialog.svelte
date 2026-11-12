<script lang="ts">
  // Shared modal frame: title, scrollable body, footer with actions. Esc closes, Enter submits.
  import type { Snippet } from 'svelte'
  import { onMount } from 'svelte'
  import Icon from './Icon.svelte'

  let {
    title,
    width = 520,
    onclose,
    onsubmit,
    children,
    footer,
    icon
  }: { title: string; width?: number; onclose: () => void; onsubmit?: () => void; children: Snippet; footer?: Snippet; icon?: string } = $props()

  let el: HTMLFormElement

  onMount(() => {
    const first = el.querySelector<HTMLElement>('[autofocus], input:not([type=checkbox]):not([type=radio]), textarea, select, .btn.primary')
    // always put focus inside the dialog so Esc and Enter reach it
    first?.focus()
    // a disabled control can't take focus; fall back to the dialog itself
    if (!el.contains(document.activeElement)) el.focus()
  })

  /**
   * Keep focus inside the dialog when the focused control disappears (focus falls to <body>),
   * so Esc and Enter still reach it. Never interfere with a focus move the user is making:
   * relatedTarget is set whenever focus is going to another element, and the check waits until
   * the browser has finished moving focus. Reacting in a microtask instead ran mid-move, while
   * activeElement was briefly <body>, and stole focus from the field the user clicked.
   */
  function focusOut(e: FocusEvent) {
    if (e.relatedTarget) return
    setTimeout(() => {
      if (!el?.isConnected || !document.hasFocus()) return
      const a = document.activeElement
      if (a && a !== document.body) return
      // only the top-most dialog takes focus back
      const all = document.querySelectorAll('form.dlg')
      if (all[all.length - 1] === el) el.focus()
    }, 0)
  }

  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onclose()
    }
  }
</script>

<div class="scrim" role="presentation" onmousedown={(e) => e.target === e.currentTarget && onclose()}>
  <form
    class="dlg"
    tabindex="-1"
    bind:this={el}
    style:width={`${width}px`}
    role="dialog"
    aria-modal="true"
    aria-label={title}
    onkeydown={key}
    onfocusout={focusOut}
    onsubmit={(e) => {
      e.preventDefault()
      onsubmit?.()
    }}
  >
    <header>
      {#if icon}<span class="hi"><Icon name={icon} size={20} /></span>{/if}
      <h2 class="title">{title}</h2>
      <button type="button" class="btn subtle icon sm" aria-label="Close" onclick={onclose}><Icon name="close" /></button>
    </header>
    <div class="content">
      {@render children()}
    </div>
    {#if footer}
      <footer>{@render footer()}</footer>
    {/if}
  </form>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 1100;
    background: var(--scrim);
    display: grid;
    place-items: center;
    animation: fade var(--mid) var(--ease);
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .dlg {
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 64px);
    display: flex;
    flex-direction: column;
    border-radius: var(--r-xl);
    background: var(--card-solid);
    border: 1px solid var(--stroke-2);
    box-shadow: var(--shadow-dialog);
    overflow: hidden;
    animation: pop var(--mid) var(--ease);
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(1.04);
    }
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 20px 16px 8px 24px;
  }
  .hi {
    color: var(--accent);
    display: flex;
  }
  h2 {
    flex: 1;
    margin: 0;
  }
  .content {
    padding: 8px 24px 20px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 20px 24px;
    background: var(--layer-solid);
    border-top: 1px solid var(--divider);
  }
  .content :global(label.field) {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
  }
  .content :global(.row) {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .content :global(.row > .input) {
    flex: 1;
  }
  .content :global(.hint) {
    font-size: 12px;
    color: var(--text-2);
  }
</style>
