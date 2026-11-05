<script lang="ts">
  // Keyboard shortcut sheet: every command and its keys, grouped, read from the command registry.
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { commands, type Command } from '../../lib/commands'

  let { close }: { close: (v?: unknown) => void } = $props()

  let q = $state('')
  let all = $state(false)

  const groups = $derived.by(() => {
    const f = q.trim().toLowerCase()
    const map = new Map<string, Command[]>()
    for (const c of commands) {
      if (!all && !c.keys?.length) continue
      if (f && !c.label.toLowerCase().includes(f) && !c.group.toLowerCase().includes(f) && !(c.keys ?? []).some((k) => k.toLowerCase().includes(f))) continue
      const g = map.get(c.group)
      g ? g.push(c) : map.set(c.group, [c])
    }
    return [...map]
  })
  const count = $derived(groups.reduce((a, [, list]) => a + list.length, 0))

  const parts = (k: string) => (k === '+' ? ['+'] : k.split('+').map((p) => (p === '' ? '+' : p)))
</script>

<Dialog title="Keyboard shortcuts" icon="keyboard" width={760} onclose={() => close()}>
  <div class="row">
    <input class="input" bind:value={q} placeholder="Filter by command, group or key (e.g. Ctrl+Shift)" spellcheck="false" autofocus />
    <label class="check"><input type="checkbox" bind:checked={all} /> Include commands without a key</label>
  </div>

  {#if !count}
    <div class="caption">No command matches “{q}”.</div>
  {:else}
    <div class="cols">
      {#each groups as [group, list] (group)}
        <section>
          <h3 class="subtitle">{group}</h3>
          {#each list as c (c.id)}
            <div class="cmd">
              <span class="ic">{#if c.icon}<Icon name={c.icon} size={14} />{/if}</span>
              <span class="ellipsis lbl">{c.label}</span>
              <span class="keys">
                {#each c.keys ?? [] as k, i (k)}
                  {#if i > 0}<span class="caption">or</span>{/if}
                  <span class="combo">{#each parts(k) as p, j (j)}<kbd>{p}</kbd>{/each}</span>
                {:else}
                  <span class="caption">—</span>
                {/each}
              </span>
            </div>
          {/each}
        </section>
      {/each}
    </div>
  {/if}

  {#snippet footer()}
    <span class="caption foot">Ctrl+K opens the command palette, where every command can be run by name.</span>
    <button type="button" class="btn primary" onclick={() => close()}>Close</button>
  {/snippet}
</Dialog>

<style>
  .cols {
    columns: 2;
    column-gap: 28px;
  }
  section {
    break-inside: avoid;
    margin-bottom: 14px;
  }
  h3 {
    margin: 0 0 4px;
    color: var(--text-2);
  }
  .cmd {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    border-bottom: 1px solid var(--divider);
    font-size: 13px;
  }
  .ic {
    width: 14px;
    display: flex;
    color: var(--text-2);
  }
  .lbl {
    flex: 1;
    min-width: 0;
  }
  .keys {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 4px;
    align-items: center;
  }
  .combo {
    display: inline-flex;
    gap: 2px;
  }
  kbd {
    font: 11px/16px var(--font);
    padding: 1px 5px;
    border-radius: var(--r-sm);
    border: 1px solid var(--control-stroke);
    border-bottom-color: var(--control-stroke-bottom);
    background: var(--control);
    color: var(--text-2);
  }
  .foot {
    flex: 1;
    align-self: center;
  }
</style>
