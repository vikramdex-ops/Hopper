<script lang="ts">
  // Share with people: type "@" (or just a name) to pick colleagues and groups.
  // Shares the explicit selection only (or the paths it is given): a row that merely has focus
  // is never sent, and with nothing selected the dialog offers pickers instead.
  import { tick } from 'svelte'
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { host } from '../../lib/api'
  import { isArchivePath, isVirtual } from '../../lib/pane.svelte'
  import { basename, fmtSize, initials, personColor, plural } from '../../lib/format'

  let { to = [], paths, close }: { to?: string[]; paths?: string[]; close: (v?: unknown) => void } = $props()

  const real = (p: string) => !isVirtual(p) && !isArchivePath(p)
  const entries = paths ? [] : app.active.selected.filter((e) => real(e.path))
  const initial = paths ?? entries.map((e) => e.path)
  let files = $state<string[]>([...initial])
  const picked = $derived(files.length !== initial.length)
  const bytes = $derived(picked ? 0 : entries.reduce((a, e) => a + (e.dir ? 0 : e.size), 0))
  const hasFolders = $derived(!picked && entries.some((e) => e.dir))

  async function chooseFiles() {
    const more = (await host.dialog.files('Choose files to share')).filter(real)
    files = [...new Set([...files, ...more])]
  }

  async function chooseFolder() {
    const d = await host.dialog.folder('Choose a folder to share', real(app.active.path) ? app.active.path : undefined)
    if (d && real(d)) files = [...new Set([...files, d])]
  }

  let chosen = $state<string[]>([...to])
  let query = $state('')
  let message = $state('')
  let zipFirst = $state(false)
  let notifyCliq = $state(app.office?.cliq.enabled ?? false)
  let hot = $state(0)
  let input: HTMLInputElement | undefined = $state()

  interface Option {
    id: string
    name: string
    sub: string
    group: boolean
    status?: string
  }

  const options = $derived.by<Option[]>(() => {
    const q = query.replace(/^@/, '').trim().toLowerCase()
    const people: Option[] = app.peers
      .filter((p) => !p.self)
      .map((p) => ({ id: p.user, name: p.displayName, sub: `${p.host}${p.status === 'offline' ? ' · offline — via server' : ''}`, group: false, status: p.status }))
    const groups: Option[] = app.groups.map((g) => ({ id: `group:${g.id}`, name: g.name, sub: plural(g.members.length, 'person'), group: true }))
    const recent = app.settings?.recentShares ?? []
    return [...groups, ...people]
      .filter((o) => !chosen.includes(o.id))
      .filter((o) => !q || o.name.toLowerCase().includes(q) || o.id.toLowerCase().includes(q))
      .sort((a, b) => {
        const ra = recent.indexOf(a.id)
        const rb = recent.indexOf(b.id)
        if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb)
        if ((a.status === 'offline') !== (b.status === 'offline')) return a.status === 'offline' ? 1 : -1
        return a.name.localeCompare(b.name)
      })
      .slice(0, 8)
  })
  const open = $derived(query.length > 0 || chosen.length === 0)

  function pick(o: Option) {
    chosen = [...chosen, o.id]
    query = ''
    hot = 0
    void tick().then(() => input?.focus())
  }

  function key(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      hot = Math.min(options.length - 1, hot + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      hot = Math.max(0, hot - 1)
    } else if ((e.key === 'Enter' || e.key === 'Tab') && open && options[hot] && query) {
      e.preventDefault()
      pick(options[hot])
    } else if (e.key === 'Backspace' && !query && chosen.length) {
      chosen = chosen.slice(0, -1)
    }
  }

  function send() {
    if (!chosen.length || !files.length) return
    void app.share({ to: $state.snapshot(chosen), paths: $state.snapshot(files), message: message.trim() || undefined, zipFirst, notifyCliq })
    close(true)
  }

  const ready = $derived(app.lanStatus?.ready)
</script>

<Dialog title="Share" icon="share" width={560} onclose={() => close()} onsubmit={send}>
  {#if files.length}
    <div class="what">
      <Icon name={files.length === 1 ? (hasFolders ? 'folder' : 'file') : 'layers'} size={20} />
      <span class="ellipsis" title={files.join(', ')}>{files.length === 1 ? basename(files[0]) : plural(files.length, 'item')}</span>
      {#if bytes}<span class="caption">{fmtSize(bytes)}{hasFolders ? ' + folders' : ''}</span>{/if}
      <button type="button" class="btn subtle sm" onclick={chooseFiles}>Add files…</button>
      {#if !paths}<button type="button" class="btn subtle icon sm" title="Clear" aria-label="Clear" onclick={() => (files = [])}><Icon name="close" size={12} /></button>{/if}
    </div>
  {:else}
    <div class="what none">
      <Icon name="info" size={20} />
      <span>Nothing is selected. Choose what to share:</span>
      <button type="button" class="btn sm" onclick={chooseFiles}><Icon name="file" /> Files…</button>
      <button type="button" class="btn sm" onclick={chooseFolder}><Icon name="folder" /> Folder…</button>
    </div>
  {/if}

  {#if !ready}
    <div class="warn"><Icon name="warning" /> <span>LAN sharing isn't ready on this PC{app.lanStatus?.reason ? ` (${app.lanStatus.reason})` : ''}. Set it up in Settings → Sharing.</span></div>
  {/if}

  <div class="to">
    <span class="lbl">To</span>
    <div class="chips" onclick={() => input?.focus()} role="presentation">
      {#each chosen as id (id)}
        <span class="chip">
          {#if id.startsWith('group:')}<Icon name="people" size={14} />{:else}<span class="av" style:background={personColor(id)}>{initials(app.personName(id))}</span>{/if}
          {app.personName(id)}
          <button type="button" aria-label={`Remove ${app.personName(id)}`} onclick={() => (chosen = chosen.filter((c) => c !== id))}><Icon name="close" size={10} /></button>
        </span>
      {/each}
      <input bind:this={input} bind:value={query} onkeydown={key} oninput={() => (hot = 0)} placeholder={chosen.length ? '' : 'Type @ and a name, or pick below'} spellcheck="false" autofocus />
    </div>
  </div>
  {#if open && options.length}
    <div class="opts" role="listbox">
      {#each options as o, i (o.id)}
        <button type="button" class="opt" class:hot={i === hot} onmouseenter={() => (hot = i)} onclick={() => pick(o)}>
          {#if o.group}
            <span class="av grp"><Icon name="people" size={14} /></span>
          {:else}
            <span class="av" style:background={personColor(o.id)}>{initials(o.name)}<span class="pres {o.status}"></span></span>
          {/if}
          <span class="on">{o.name}</span>
          <span class="caption ellipsis">{o.sub}</span>
        </button>
      {/each}
    </div>
  {:else if open && query}
    <div class="caption">No one matches “{query.replace(/^@/, '')}”. Only people running Hopper (or seen before) can receive.</div>
  {/if}

  <label class="field">
    <span>Message <span class="caption">(optional)</span></span>
    <textarea class="input" rows="2" bind:value={message} placeholder="e.g. Lot 07 isos for back-check — due Friday"></textarea>
  </label>

  <div class="opts2">
    <label class="check"><input type="checkbox" bind:checked={zipFirst} /> Zip before sending <span class="caption">(one file, faster for many small files)</span></label>
    <label class="check" class:disabled={!app.office?.cliq.enabled}>
      <input type="checkbox" bind:checked={notifyCliq} disabled={!app.office?.cliq.enabled} /> Send a Zoho Cliq DM to each person
      {#if !app.office?.cliq.enabled}<span class="caption">(set up the office bot in Settings → Office)</span>{/if}
    </label>
  </div>

  {#snippet footer()}
    <span class="caption foot">Online colleagues receive directly; offline ones get it via the office server.</span>
    <button type="submit" class="btn primary" disabled={!chosen.length || !files.length}><Icon name="send" /> Send</button>
    <button type="button" class="btn" onclick={() => close()}>Cancel</button>
  {/snippet}
</Dialog>

<style>
  .what {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: var(--r-md);
    background: var(--layer-solid);
    border: 1px solid var(--stroke);
  }
  .what span:first-of-type {
    flex: 1;
  }
  .warn {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 8px 12px;
    border-radius: var(--r-md);
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 10%, transparent);
    font-size: 13px;
  }
  .to {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .lbl {
    padding-top: 7px;
    width: 28px;
    color: var(--text-2);
  }
  .chips {
    flex: 1;
    min-height: 36px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 4px 6px;
    border-radius: var(--r-sm);
    border: 1px solid var(--control-stroke);
    border-bottom: 2px solid var(--accent);
    background: var(--input);
  }
  .chips input {
    flex: 1;
    min-width: 140px;
    border: 0;
    outline: 0;
    background: transparent;
    height: 26px;
    user-select: text;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 4px 0 3px;
    border-radius: 13px;
    background: var(--sel);
    font-size: 13px;
  }
  .chip button {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 0;
    background: transparent;
    display: grid;
    place-items: center;
    color: var(--text-2);
  }
  .chip button:hover {
    background: var(--hover);
  }
  .av {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: white;
    font-size: 9px;
    font-weight: 600;
    flex: none;
    position: relative;
  }
  .opt .av {
    width: 28px;
    height: 28px;
    font-size: 11px;
  }
  .av.grp {
    background: var(--stroke-strong);
    color: var(--text);
  }
  .pres {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 2px solid var(--card-solid);
    background: #6ccb5f;
  }
  .pres.offline {
    background: #8a8a8a;
  }
  .pres.busy {
    background: #e74856;
  }
  .pres.away {
    background: #fce100;
  }
  .opts {
    margin: -8px 0 0 38px;
    border-radius: var(--r-md);
    border: 1px solid var(--stroke-2);
    box-shadow: var(--shadow-flyout);
    background: var(--flyout);
    padding: 4px;
  }
  .opt {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 40px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    text-align: left;
  }
  .opt.hot {
    background: var(--hover);
  }
  .on {
    flex: none;
  }
  .opts2 {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .disabled {
    opacity: 0.7;
  }
  .foot {
    flex: 1;
    align-self: center;
  }
</style>
