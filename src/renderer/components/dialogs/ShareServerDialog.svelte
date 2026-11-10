<script lang="ts">
  // Dexterity Share setup (office admin): three steps to make this PC the office's share server —
  // use this PC, get the tunnel program, connect the pointer — then a test from the internet.
  // Each step shows a live tick; every failure says what to do next.
  import { onMount } from 'svelte'
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { host } from '../../lib/api'
  import { lanx } from '../../lib/lan2.svelte'
  import { fmtAgo, fmtSize } from '../../lib/format'
  import { DEFAULT_MIN_FREE_GB, DEFAULT_PAGE_URL, type PublicShareConfig, type ShareServerSettings, type ShareServerState } from '@shared/pubshare'

  let { close }: { close: (v?: unknown) => void } = $props()

  type State = ShareServerState & { settings: ShareServerSettings; tunnelTokenSaved: boolean; protected: boolean }
  let st = $state.raw<State | null>(null)
  let busy = $state('')
  let errors = $state<Record<string, string>>({})
  let token = $state('')
  let tunnelToken = $state('')
  let progress = $state<{ done: number; total: number } | null>(null)
  let test = $state<{ ok: boolean; text: string } | null>(null)
  let tokenNote = $state('')
  let advanced = $state(false)
  let minFree = $state(((app.office as { publicShare?: PublicShareConfig } | null)?.publicShare?.minFreeGB ?? DEFAULT_MIN_FREE_GB) as number)

  const admin = $derived(lanx.meta.admin)
  const share = $derived((app.office as { publicShare?: PublicShareConfig } | null)?.publicShare)
  const s = $derived(st?.settings)
  const fixed = $derived(!!s && s.mode !== 'quick')
  const ok1 = $derived(!!st && st.enabled && st.storeOk && !!share?.enabled)
  const ok2 = $derived(!!st && (st.settings.mode === 'external' || st.cloudflared.found))
  const ok3 = $derived(!!st && !!st.pointer.gist && st.pointer.hasToken && !st.pointer.error)
  const live = $derived(!!st && st.tunnel.verified)

  const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error:\s*/, '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

  async function refresh() {
    try {
      st = (await host.share.state()) as State
    } catch (e) {
      errors = { ...errors, load: clean(e) }
    }
  }

  onMount(() => {
    void refresh()
    const off = host.share.on((m: { type: string; done?: number; total?: number }) => {
      if (m.type === 'share-progress') progress = { done: m.done ?? 0, total: m.total ?? 0 }
      else void refresh()
    })
    const t = setInterval(refresh, 4000)
    return () => {
      off()
      clearInterval(t)
    }
  })

  async function run(step: string, fn: () => Promise<void>) {
    if (busy) return
    busy = step
    errors = { ...errors, [step]: '' }
    try {
      await fn()
    } catch (e) {
      errors = { ...errors, [step]: clean(e) }
    } finally {
      busy = ''
      await refresh()
    }
  }

  /** The shared office config records only what every PC needs: on/off, the gist id and the key fingerprint. */
  async function saveOffice(patch: Partial<PublicShareConfig>) {
    const r = await host.office.get()
    if (!r.config) throw new Error('The office config is not loaded. Open Settings → Office and load or create it first.')
    const cur: Partial<PublicShareConfig> = (r.config as { publicShare?: PublicShareConfig }).publicShare ?? {}
    const next = { enabled: false, store: '', pageUrl: DEFAULT_PAGE_URL, defaultDays: 7, ...cur, ...patch }
    await host.office.save({ ...r.config, publicShare: next } as typeof r.config)
    await app.reloadOffice()
  }

  const useThisPc = () =>
    run('pc', async () => {
      // the first status may still be on its way when the button is pressed
      if (!st?.pc) await refresh()
      if (!st?.pc) throw new Error('Hopper is still starting the share service. Try again in a moment.')
      await saveOffice({ enabled: true, host: { user: lanx.meta.user, pc: st.pc } })
      await host.share.configure({ enabled: true })
    })

  const stopHere = () =>
    run('pc', async () => {
      await host.share.configure({ enabled: false })
    })

  const download = () =>
    run('cf', async () => {
      progress = { done: 0, total: 0 }
      try {
        await host.share.call('downloadCloudflared')
        await host.share.configure({ cloudflaredPath: '' })
      } finally {
        progress = null
      }
    })

  const browse = () =>
    run('cf', async () => {
      const files = await host.dialog.files('Choose cloudflared.exe', [{ name: 'Program', extensions: ['exe'] }])
      const file = Array.isArray(files) ? files[0] : files
      if (!file) return
      await host.share.call('probeCloudflared', file)
      await host.share.configure({ cloudflaredPath: file })
    })

  const connect = () =>
    run('ptr', async () => {
      if (!token.trim()) throw new Error('Paste the token from GitHub first.')
      const r = (await host.share.connectPointer(token)) as { gist: string; key: string; login: string; extraScopes: string[]; reused: boolean }
      await saveOffice({ pointer: { gist: r.gist, key: r.key } })
      token = ''
      tokenNote = `Connected as ${r.login}.${r.extraScopes.length ? ` This token can also do: ${r.extraScopes.join(', ')}. It works, but a token with only "gist" is safer.` : ''}`
      await host.share.call('republish')
    })

  const runTest = () =>
    run('test', async () => {
      test = null
      try {
        const r = (await host.share.call('selfTest')) as { base: string; ms: number; pointerOk: boolean | null }
        test = { ok: true, text: `It works. A test file went out through ${r.base.replace('https://', '')} and came back intact in ${(r.ms / 1000).toFixed(1)} s.${r.pointerOk === false ? ' The pointer on GitHub is not up to date yet; it is retried every minute.' : ''}` }
      } catch (e) {
        test = { ok: false, text: clean(e) }
      }
    })

  const setMode = (mode: ShareServerSettings['mode']) => run('adv', async () => void (await host.share.configure({ mode })))
  const setBase = (publicBase: string) => run('adv', async () => void (await host.share.configure({ publicBase: publicBase.trim() })))
  const setBand = (patch: Partial<ShareServerSettings['bandwidth']>) => run('adv', async () => void (await host.share.configure({ bandwidth: { ...s!.bandwidth, ...patch } })))
  const saveTunnelToken = () =>
    run('adv', async () => {
      await host.share.setTunnelToken(tunnelToken)
      tunnelToken = ''
    })
  const saveMinFree = () => run('adv', async () => saveOffice({ minFreeGB: Math.max(0, Number(minFree) || 0) }))
  const num = (e: Event) => Math.max(0, Number((e.currentTarget as HTMLInputElement).value) || 0)
</script>

<Dialog title="Set up Dexterity Share" icon="cloud" width={640} onclose={() => close()}>
  {#if !admin}
    <div class="note warn"><Icon name="info" /> <span>Only the office admin sets this up. This PC shows the current state.</span></div>
  {/if}
  <p class="lead">Clients download straight from one office PC that stays on. Do these three steps <b>on that PC</b>, once. About five minutes.</p>
  {#if errors.load}<div class="note bad"><Icon name="error" /> <span>{errors.load}</span></div>{/if}

  <ol class="steps">
    <li class:done={ok1}>
      <div class="mark">{#if ok1}<Icon name="check" />{:else}1{/if}</div>
      <div class="body">
        <div class="h">Use this PC as the share server</div>
        <div class="caption">It must stay switched on and signed in to Windows. Hopper will start with Windows and keep running in the tray.</div>
        {#if st}
          <div class="caption">Files are kept in <span class="mono">{share?.store || 'PublicShares, beside office.json'}</span>{st.health?.freeBytes != null ? ` · ${fmtSize(st.health.freeBytes)} free` : ''}</div>
          {#if st.enabled && st.storeError}<div class="err">{st.storeError}</div>{/if}
          {#if st.enabled && st.serverError}<div class="err">{st.serverError}. Close the other program using it, or change the port under Advanced.</div>{/if}
        {/if}
        {#if errors.pc}<div class="err">{errors.pc}</div>{/if}
        <div class="row">
          {#if st?.enabled}
            <span class="okc"><Icon name="success" /> This PC ({st.pc}) is the share server</span>
            <span class="spacer"></span>
            <button type="button" class="btn subtle sm" disabled={!admin || !!busy} onclick={stopHere}>Stop using this PC</button>
          {:else}
            <button type="button" class="btn primary" disabled={!admin || !!busy} onclick={useThisPc}><Icon name="computer" /> {busy === 'pc' ? 'Starting…' : 'Use this PC'}</button>
            {#if share?.host?.pc && share.host.pc !== st?.pc}<span class="caption">Currently set up on {share.host.pc}.</span>{/if}
          {/if}
        </div>
      </div>
    </li>

    <li class:done={ok2} class:off={!st?.enabled}>
      <div class="mark">{#if ok2}<Icon name="check" />{:else}2{/if}</div>
      <div class="body">
        <div class="h">Get the tunnel program</div>
        <div class="caption">“cloudflared” by Cloudflare lets clients reach this PC without opening any port on the office router. Hopper downloads it from Cloudflare's official GitHub release and checks its checksum.</div>
        {#if progress}
          <div class="bar"><i style:width={`${progress.total ? (progress.done / progress.total) * 100 : 5}%`}></i></div>
          <div class="caption">{fmtSize(progress.done)}{progress.total ? ` of ${fmtSize(progress.total)}` : ''}</div>
        {/if}
        {#if errors.cf}<div class="err">{errors.cf}</div>{/if}
        <div class="row">
          {#if st?.cloudflared.found}
            <span class="okc"><Icon name="success" /> Ready{st.cloudflared.version ? ` · version ${st.cloudflared.version}` : ''}</span>
            <span class="spacer"></span>
            <button type="button" class="btn subtle sm" disabled={!admin || !!busy} onclick={download}>Download again</button>
          {:else}
            <button type="button" class="btn primary" disabled={!admin || !!busy || !st?.enabled} onclick={download}><Icon name="download" /> {busy === 'cf' ? 'Downloading…' : 'Download (about 55 MB)'}</button>
          {/if}
          <button type="button" class="btn subtle sm" disabled={!admin || !!busy || !st?.enabled} onclick={browse}>I already have it…</button>
        </div>
      </div>
    </li>

    <li class:done={ok3} class:off={!ok2 || !st?.enabled}>
      <div class="mark">{#if ok3}<Icon name="check" />{:else}3{/if}</div>
      <div class="body">
        <div class="h">Connect the pointer</div>
        <div class="caption">The tunnel's address changes when this PC restarts. Hopper keeps the current address in a small note (a “gist”) on the office's GitHub account, so links already e-mailed keep working. Paste a GitHub token that has <b>only the “gist” permission</b>:</div>
        <div class="caption how">github.com → your picture → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic) → tick only <b>gist</b> → Generate → copy.</div>
        {#if ok3}
          <div class="row"><span class="okc"><Icon name="success" /> Connected{st?.pointer.published ? ' · address published' : live ? ' · publishing…' : ''}</span></div>
        {/if}
        {#if tokenNote}<div class="caption">{tokenNote}</div>{/if}
        {#if st?.pointer.error}<div class="err">{st.pointer.error}</div>{/if}
        {#if errors.ptr}<div class="err">{errors.ptr}</div>{/if}
        {#if st && !st.protected}<div class="err">Windows cannot protect a saved token on this PC right now. Sign out and in again, then retry.</div>{/if}
        <div class="row">
          <input class="input" type="password" bind:value={token} placeholder={ok3 ? 'Paste a new token to replace the saved one' : 'Paste the token here (starts with ghp_)'} autocomplete="off" spellcheck="false" disabled={!admin || !st?.enabled} />
          <button type="button" class="btn" class:primary={!ok3} disabled={!admin || !!busy || !token.trim() || !st?.enabled} onclick={connect}>{busy === 'ptr' ? 'Checking…' : ok3 ? 'Replace' : 'Connect'}</button>
        </div>
        <div class="caption">The token is kept on this PC only, encrypted by Windows. It is never written to the office config.</div>
      </div>
    </li>
  </ol>

  <div class="final" class:ready={ok1 && ok2 && (ok3 || fixed)}>
    <div class="row">
      <span class="dot" class:on={live}></span>
      <span class="grow">
        {#if !st?.enabled}Not running on this PC.
        {:else if live}Online at <span class="mono">{st!.tunnel.base?.replace('https://', '')}</span>{st!.tunnel.since ? ` since ${fmtAgo(st!.tunnel.since)}` : ''}{st!.health ? ` · ${st!.health.activeDownloads} downloading · ${fmtSize(st!.health.bytesToday)} sent today` : ''}
        {:else if st.tunnel.error}{st.tunnel.error}
        {:else if ok2}Connecting to the internet… (up to a minute)
        {:else}Waiting for step 2.{/if}
      </span>
      <button type="button" class="btn" class:primary={ok1 && ok2 && (ok3 || fixed)} disabled={!!busy || !live} onclick={runTest}><Icon name="network" /> {busy === 'test' ? 'Testing…' : 'Test from the internet'}</button>
    </div>
    {#if test}<div class={test.ok ? 'note good' : 'note bad'}><Icon name={test.ok ? 'success' : 'error'} /> <span>{test.text}</span></div>{/if}
  </div>

  <button type="button" class="btn subtle sm disclose" aria-expanded={advanced} onclick={() => (advanced = !advanced)}><Icon name={advanced ? 'chevronDown' : 'chevronRight'} /> Advanced</button>
  {#if advanced && s}
    <div class="adv">
      {#if errors.adv}<div class="err">{errors.adv}</div>{/if}
      <div class="grid">
        <label class="field"><span>Upload limit <span class="caption">(Mbit/s, 0 = none)</span></span>
          <input class="input" type="number" min="0" step="1" value={s.bandwidth.mbps} disabled={!admin} onchange={(e) => setBand({ mbps: num(e) })} /></label>
        <label class="field"><span>…during office hours <span class="caption">(0 = same)</span></span>
          <input class="input" type="number" min="0" step="1" value={s.bandwidth.officeMbps} disabled={!admin} onchange={(e) => setBand({ officeMbps: num(e) })} /></label>
        <label class="field"><span>Office hours from</span>
          <input class="input" type="time" value={s.bandwidth.officeFrom} disabled={!admin} onchange={(e) => setBand({ officeFrom: e.currentTarget.value })} /></label>
        <label class="field"><span>to <span class="caption">(Monday–Saturday)</span></span>
          <input class="input" type="time" value={s.bandwidth.officeTo} disabled={!admin} onchange={(e) => setBand({ officeTo: e.currentTarget.value })} /></label>
        <label class="field"><span>Keep free on the server <span class="caption">(GB; new links are refused below this)</span></span>
          <input class="input" type="number" min="0" step="1" bind:value={minFree} disabled={!admin} onchange={saveMinFree} /></label>
        <label class="field"><span>Address</span>
          <select class="input" value={s.mode} disabled={!admin} onchange={(e) => setMode(e.currentTarget.value as ShareServerSettings['mode'])}>
            <option value="quick">Free Cloudflare quick tunnel (changes on restart)</option>
            <option value="named">My Cloudflare tunnel (own domain)</option>
            <option value="external">My own address (other tunnel or proxy)</option>
          </select></label>
      </div>
      {#if s.mode !== 'quick'}
        <label class="field"><span>Fixed public address</span>
          <input class="input" value={s.publicBase} placeholder="https://files.example.com" spellcheck="false" disabled={!admin} onchange={(e) => setBase(e.currentTarget.value)} /></label>
        <div class="caption">Point it at <span class="mono">http://127.0.0.1:{s.port}</span> on this PC. With a pointer connected (step 3), links keep working if you change this address later.</div>
      {/if}
      {#if s.mode === 'named'}
        <label class="field"><span>Cloudflare tunnel token {#if st?.tunnelTokenSaved}<span class="caption">(saved)</span>{/if}</span>
          <div class="row"><input class="input" type="password" bind:value={tunnelToken} autocomplete="off" spellcheck="false" disabled={!admin} /><button type="button" class="btn" disabled={!admin || !tunnelToken.trim() || !!busy} onclick={saveTunnelToken}>Save</button></div></label>
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    <span class="caption foot">Step-by-step guide: docs/DEXTERITY-SHARE-IT.md</span>
    <button type="button" class="btn primary" onclick={() => close(true)}>Done</button>
  {/snippet}
</Dialog>

<style>
  .lead {
    margin: 0;
    color: var(--text-2);
  }
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .steps li {
    display: flex;
    gap: 12px;
    padding: 12px 14px;
    border-radius: var(--r-lg);
    border: 1px solid var(--stroke-2);
    background: var(--layer-solid);
  }
  .steps li.off {
    opacity: 0.6;
  }
  .mark {
    width: 28px;
    height: 28px;
    flex: none;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-weight: 600;
    background: var(--hover);
    color: var(--text-2);
  }
  li.done .mark {
    background: var(--ok);
    color: var(--card-solid);
  }
  .body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .h {
    font-weight: 600;
    font-size: 15px;
  }
  .how {
    padding: 6px 10px;
    border-radius: var(--r-md);
    background: var(--hover);
    color: var(--text);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
  }
  .row .input {
    flex: 1;
  }
  .okc {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--ok);
    font-weight: 600;
    font-size: 13px;
  }
  .err {
    color: var(--bad);
    font-size: 13px;
  }
  .mono {
    font-family: var(--mono);
    font-size: 12px;
    user-select: text;
    overflow-wrap: anywhere;
  }
  .bar {
    height: 6px;
    border-radius: 3px;
    background: var(--stroke-2);
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .final {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    border-radius: var(--r-lg);
    border: 1px dashed var(--stroke-strong);
    font-size: 13px;
  }
  .final.ready {
    border-style: solid;
    border-color: var(--accent);
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .dot {
    background: var(--text-3);
  }
  .dot.on {
    background: var(--ok);
  }
  .note {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 8px 12px;
    border-radius: var(--r-md);
    font-size: 13px;
    background: var(--hover);
  }
  .note.good {
    background: color-mix(in srgb, var(--ok) 12%, transparent);
  }
  .note.bad {
    background: color-mix(in srgb, var(--bad) 10%, transparent);
  }
  .note.warn {
    background: color-mix(in srgb, var(--warn) 10%, transparent);
  }
  .disclose {
    align-self: flex-start;
  }
  .adv {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px 12px;
  }
  .foot {
    flex: 1;
    align-self: center;
  }
</style>
