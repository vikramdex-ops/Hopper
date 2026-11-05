<script lang="ts">
  import { app } from '../lib/app.svelte'
  import Icon from './Icon.svelte'
  const ICON = { info: 'info', success: 'success', warning: 'warning', error: 'error' } as const
</script>

<div class="toasts" aria-live="polite">
  {#each app.toasts as t (t.id)}
    <div class="toast {t.kind}" role="status">
      <span class="ic"><Icon name={ICON[t.kind]} /></span>
      <div class="body">
        <div class="t">{t.title}</div>
        {#if t.body}<div class="caption">{t.body}</div>{/if}
        {#if t.actions?.length}
          <div class="acts">
            {#each t.actions as a (a.label)}
              <button class="btn sm" onclick={() => { a.run(); app.dismissToast(t.id) }}>{a.label}</button>
            {/each}
          </div>
        {/if}
      </div>
      <button class="x" aria-label="Dismiss" onclick={() => app.dismissToast(t.id)}><Icon name="close" size={12} /></button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 1200;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 360px;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    gap: 12px;
    padding: 12px 10px 12px 14px;
    border-radius: var(--r-lg);
    background: var(--flyout);
    border: 1px solid var(--stroke-2);
    box-shadow: var(--shadow-flyout);
    backdrop-filter: blur(30px);
    animation: in var(--mid) var(--ease);
  }
  @keyframes in {
    from {
      transform: translateX(24px);
      opacity: 0;
    }
  }
  .ic {
    display: flex;
    padding-top: 2px;
  }
  .info .ic {
    color: var(--info);
  }
  .success .ic {
    color: var(--ok);
  }
  .warning .ic {
    color: var(--warn);
  }
  .error .ic {
    color: var(--bad);
  }
  .body {
    flex: 1;
    min-width: 0;
    word-break: break-word;
  }
  .t {
    font-weight: 600;
  }
  .acts {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }
  .x {
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--text-2);
    display: grid;
    place-items: center;
    flex: none;
  }
  .x:hover {
    background: var(--hover);
  }
</style>
