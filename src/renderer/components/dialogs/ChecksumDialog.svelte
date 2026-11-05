<script lang="ts">
  // Checksums for one file: SHA-256 on open, SHA-1 and MD5 on request, plus paste-to-compare.
  import { onMount, untrack } from 'svelte'
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { engine, host } from '../../lib/api'
  import { fmtSize } from '../../lib/format'
  import { isArchivePath, isVirtual } from '../../lib/pane.svelte'

  let { close }: { close: (v?: unknown) => void } = $props()

  const pane = app.active
  const file = (pane.focused && !pane.focused.dir ? pane.focused : pane.targets().find((e) => !e.dir)) ?? null
  const usable = !!file && !isVirtual(file.path) && !isArchivePath(file.path)

  const ALGOS = [
    { id: 'sha256', label: 'SHA-256' },
    { id: 'sha1', label: 'SHA-1' },
    { id: 'md5', label: 'MD5' }
  ] as const
  type Algo = (typeof ALGOS)[number]['id']

  let hashes = $state<Record<Algo, { value: string; busy: boolean; error: string }>>({
    sha256: { value: '', busy: false, error: '' },
    sha1: { value: '', busy: false, error: '' },
    md5: { value: '', busy: false, error: '' }
  })
  let expected = $state('')
  let open = true

  async function compute(a: Algo) {
    if (!file || !usable || hashes[a].busy) return
    hashes[a] = { value: '', busy: true, error: '' }
    try {
      const v = await engine.call<string>('fs.hash', file.path, a)
      if (open) hashes[a] = { value: v, busy: false, error: '' }
    } catch (e: any) {
      if (open) hashes[a] = { value: '', busy: false, error: String(e?.message ?? e).replace(/^Error:\s*/, '') }
    }
  }

  onMount(() => {
    void compute('sha256')
    return () => (open = false)
  })

  const want = $derived(expected.replace(/\s+/g, '').toLowerCase())
  const lengths: Record<number, Algo> = { 64: 'sha256', 40: 'sha1', 32: 'md5' }
  const verdict = $derived.by(() => {
    if (!want) return null
    if (!/^[0-9a-f]+$/.test(want)) return { kind: 'bad', text: 'That is not a hex checksum' }
    const hit = ALGOS.find((a) => hashes[a.id].value && hashes[a.id].value === want)
    if (hit) return { kind: 'ok', text: `Match: the ${hit.label} checksums are identical` }
    const algo = lengths[want.length]
    if (!algo) return { kind: 'bad', text: `Length ${want.length} doesn't fit SHA-256 (64), SHA-1 (40) or MD5 (32)` }
    const label = ALGOS.find((a) => a.id === algo)!.label
    if (hashes[algo].busy) return { kind: 'wait', text: `Computing ${label}…` }
    if (!hashes[algo].value) return { kind: 'wait', text: `Looks like ${label}; compute it to compare` }
    return { kind: 'bad', text: `Mismatch: the ${label} checksums differ` }
  })

  // A pasted MD5 or SHA-1 starts that algorithm automatically.
  $effect(() => {
    const algo = lengths[want.length]
    if (!algo || !/^[0-9a-f]+$/.test(want)) return
    untrack(() => {
      const h = hashes[algo]
      if (!h.value && !h.busy && !h.error) void compute(algo)
    })
  })

  async function copy(text: string) {
    await host.clip.writeText(text)
    app.toast('info', 'Checksum copied')
  }
</script>

<Dialog title="Checksum" icon="checksum" width={620} onclose={() => close()}>
  {#if !file}
    <div class="caption">Select a file first.</div>
  {:else}
    <div class="what">
      <Icon name="file" size={20} />
      <span class="ellipsis name" title={file.path}>{file.name}</span>
      <span class="caption">{fmtSize(file.size)}</span>
    </div>
    {#if !usable}
      <div class="caption">Checksums work on files in real folders, not inside archives or virtual views.</div>
    {:else}
      <div class="list">
        {#each ALGOS as a (a.id)}
          {@const h = hashes[a.id]}
          <div class="algo">
            <span class="lbl">{a.label}</span>
            {#if h.value}
              <code class="val" class:hit={!!want && h.value === want}>{h.value}</code>
              <button type="button" class="btn subtle icon sm" title={`Copy ${a.label}`} aria-label={`Copy ${a.label}`} onclick={() => copy(h.value)}><Icon name="copy" /></button>
            {:else if h.busy}
              <span class="caption val">Computing…</span>
            {:else if h.error}
              <span class="val err">{h.error}</span>
              <button type="button" class="btn sm" onclick={() => compute(a.id)}>Retry</button>
            {:else}
              <span class="val"></span>
              <button type="button" class="btn sm" onclick={() => compute(a.id)}>Compute</button>
            {/if}
          </div>
        {/each}
      </div>

      <label class="field">
        <span>Compare with <span class="caption">(paste the checksum you were given)</span></span>
        <input class="input mono" bind:value={expected} spellcheck="false" placeholder="Paste SHA-256, SHA-1 or MD5" />
      </label>
      {#if verdict}
        <div class="verdict {verdict.kind}">
          <Icon name={verdict.kind === 'ok' ? 'success' : verdict.kind === 'bad' ? 'error' : 'info'} />
          {verdict.text}
        </div>
      {/if}
    {/if}
  {/if}

  {#snippet footer()}
    {#if hashes.sha256.value}
      <button type="button" class="btn" onclick={() => copy(ALGOS.filter((a) => hashes[a.id].value).map((a) => `${a.label}: ${hashes[a.id].value}`).join('\r\n') + `\r\n${file?.name ?? ''}`)}><Icon name="copy" /> Copy all</button>
    {/if}
    <button type="button" class="btn primary" onclick={() => close()}>Close</button>
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
  .name {
    flex: 1;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .algo {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 32px;
  }
  .lbl {
    width: 64px;
    flex: none;
    color: var(--text-2);
    font-size: 13px;
  }
  .val {
    flex: 1;
    min-width: 0;
    word-break: break-all;
  }
  code.val {
    font: 12px/18px var(--mono);
    user-select: text;
    padding: 4px 6px;
    border-radius: var(--r-sm);
    background: var(--layer-solid);
    border: 1px solid var(--stroke);
  }
  code.val.hit {
    border-color: var(--ok);
  }
  .err {
    color: var(--bad);
    font-size: 13px;
  }
  .mono {
    font-family: var(--mono);
  }
  .verdict {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }
  .verdict.ok {
    color: var(--ok);
  }
  .verdict.bad {
    color: var(--bad);
  }
  .verdict.wait {
    color: var(--text-2);
  }
</style>
