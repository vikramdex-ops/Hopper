<script lang="ts">
  import { tick } from 'svelte'
  import { app, type MenuItem } from '../lib/app.svelte'
  import Icon from './Icon.svelte'

  let el: HTMLDivElement | undefined = $state()
  let pos = $state({ x: 0, y: 0 })
  let sub = $state<{ items: MenuItem[]; x: number; y: number; parent: number } | null>(null)
  let subEl: HTMLDivElement | undefined = $state()
  let hot = $state(-1)

  const items = $derived(app.menu ? app.menu.items : [])

  $effect(() => {
    if (!app.menu) return
    sub = null
    hot = -1
    pos = { x: app.menu.x, y: app.menu.y }
    void tick().then(() => {
      if (!el) return
      const r = el.getBoundingClientRect()
      pos = {
        x: Math.min(pos.x, window.innerWidth - r.width - 8),
        y: r.height + pos.y > window.innerHeight - 8 ? Math.max(8, pos.y - r.height) : pos.y
      }
      el.focus()
    })
  })

  function close() {
    app.menu = null
    sub = null
  }

  function choose(it: MenuItem) {
    if (it.disabled || it.separator) return
    if (it.submenu) return
    close()
    it.run?.()
  }

  async function openSub(it: MenuItem, i: number, target: HTMLElement) {
    if (!it.submenu) {
      sub = null
      return
    }
    const r = target.getBoundingClientRect()
    sub = { items: it.submenu, x: r.right - 4, y: r.top - 4, parent: i }
    await tick()
    if (subEl) {
      const sr = subEl.getBoundingClientRect()
      if (sr.right > window.innerWidth - 8) sub = { ...sub, x: r.left - sr.width + 4 }
      if (sr.bottom > window.innerHeight - 8) sub = { ...sub!, y: Math.max(8, window.innerHeight - sr.height - 8) }
    }
  }

  function key(e: KeyboardEvent) {
    const list = items.map((x, i) => ({ x, i })).filter(({ x }) => !x.separator && !x.disabled)
    if (e.key === 'Escape') {
      e.preventDefault()
      if (sub) sub = null
      else close()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const cur = list.findIndex(({ i }) => i === hot)
      const next = e.key === 'ArrowDown' ? (cur + 1) % list.length : (cur - 1 + list.length) % list.length
      hot = list[next]?.i ?? -1
    } else if (e.key === 'Enter' && hot >= 0) {
      e.preventDefault()
      const it = items[hot]
      if (it.submenu) {
        const node = el?.querySelectorAll('.mi')[hot] as HTMLElement
        if (node) void openSub(it, hot, node)
      } else choose(it)
    } else if (e.key === 'ArrowRight' && hot >= 0 && items[hot].submenu) {
      const node = el?.querySelectorAll('.mi')[hot] as HTMLElement
      if (node) void openSub(items[hot], hot, node)
    } else if (e.key === 'ArrowLeft') sub = null
  }
</script>

{#if app.menu}
  <div class="scrim" onmousedown={close} oncontextmenu={(e) => { e.preventDefault(); close() }} role="presentation"></div>
  <div class="menu" bind:this={el} style:left={`${pos.x}px`} style:top={`${pos.y}px`} tabindex="-1" role="menu" onkeydown={key}>
    {#each items as it, i (i)}
      {#if it.separator}
        {#if i > 0 && i < items.length - 1 && !items[i - 1]?.separator}<div class="sep"></div>{/if}
      {:else}
        <button class="mi" class:hot={hot === i || sub?.parent === i} class:danger={it.danger} disabled={it.disabled} role="menuitem"
          onmouseenter={(e) => { hot = i; void openSub(it, i, e.currentTarget) }}
          onclick={(e) => (it.submenu ? openSub(it, i, e.currentTarget as HTMLElement) : choose(it))}>
          <span class="ic">{#if it.checked}<Icon name="check" />{:else if it.icon}<Icon name={it.icon} />{/if}</span>
          <span class="lbl ellipsis">{it.label}</span>
          {#if it.keys}<span class="kbd">{it.keys}</span>{/if}
          {#if it.submenu}<Icon name="chevronRight" size={12} />{/if}
        </button>
      {/if}
    {/each}
  </div>
  {#if sub}
    <div class="menu" bind:this={subEl} style:left={`${sub.x}px`} style:top={`${sub.y}px`} role="menu">
      {#each sub.items as it, i (i)}
        {#if it.separator}
          <div class="sep"></div>
        {:else}
          <button class="mi" class:danger={it.danger} disabled={it.disabled} role="menuitem" onclick={() => choose(it)}>
            <span class="ic">{#if it.checked}<Icon name="check" />{:else if it.icon}<Icon name={it.icon} />{/if}</span>
            <span class="lbl ellipsis">{it.label}</span>
            {#if it.keys}<span class="kbd">{it.keys}</span>{/if}
          </button>
        {/if}
      {/each}
    </div>
  {/if}
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 900;
  }
  .menu {
    position: fixed;
    z-index: 901;
    min-width: 220px;
    max-width: 380px;
    max-height: calc(100vh - 16px);
    overflow-y: auto;
    padding: 4px;
    border-radius: var(--r-lg);
    background: var(--flyout);
    border: 1px solid var(--stroke-2);
    box-shadow: var(--shadow-flyout);
    backdrop-filter: blur(30px) saturate(1.2);
    outline: none;
    animation: pop var(--mid) var(--ease);
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }
  .mi {
    width: 100%;
    height: 32px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 10px 0 8px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--text);
    text-align: left;
  }
  .mi:disabled {
    color: var(--text-3);
  }
  .mi.hot:not(:disabled),
  .mi:hover:not(:disabled) {
    background: var(--hover);
  }
  .mi.danger:not(:disabled) .ic {
    color: var(--bad);
  }
  .ic {
    width: 16px;
    display: flex;
    flex: none;
  }
  .lbl {
    flex: 1;
  }
  .sep {
    height: 1px;
    background: var(--divider);
    margin: 4px -4px;
  }
</style>
