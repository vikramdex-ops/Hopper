<script lang="ts">
  // Dexterity Share: turn the selection into a download link for an external client. The files are
  // copied to the office server's share store (zipped first when asked); the client opens the link
  // on the Dexterity Share page. The result view gives the link and a ready-made e-mail text.
  import { onMount } from 'svelte'
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { engine, host } from '../../lib/api'
  import { basename, dirname, fmtEta, fmtRate, fmtSize, plural } from '../../lib/format'
  import {
    DAY_MS, EXPIRY_DAYS, MAX_RECIPIENTS, buildEmail, daysLeft, fmtExpiryDate, generatePassword, mailtoUrl, normalizeDays, parseRecipients,
    type PublicLink, type PublicShareConfig, type PublicShareCreated, type PublicShareSpec, type PublicShareStatus
  } from '@shared/pubshare'

  let { paths, close }: { paths?: string[]; close: (v?: unknown) => void } = $props()

  const entries = paths ? [] : app.active.targets()
  const files = paths ?? entries.map((e) => e.path)
  const known = entries.length > 0
  const bytes = entries.reduce((a, e) => a + (e.dir ? 0 : e.size), 0)
  const hasFolders = entries.some((e) => e.dir)
  const isArchive = files.length === 1 && /\.(zip|7z|rar)$/i.test(files[0])
  const cfg = (app.office as { publicShare?: Partial<PublicShareConfig> } | null)?.publicShare
  const presets = (app.settings?.archivePresets ?? []).filter((p) => !p.volumeMB && p.format !== 'rar')

  const stem = (p: string) => basename(p).replace(/\.[^.]+$/, '')
  let title = $state(files.length === 1 ? (hasFolders ? basename(files[0]) : stem(files[0])) : basename(dirname(files[0] ?? '')) || 'Files')
  let message = $state('')
  let days = $state(normalizeDays(cfg?.defaultDays))
  /** who can download: anyone with the link, with a password, or only named addresses (code by e-mail) */
  let protect = $state<'none' | 'password' | 'email'>('none')
  let password = $state('')
  let showPw = $state(false)
  let recipientsText = $state('')
  let zipFirst = $state(hasFolders || files.length > 1)
  let presetId = $state(presets.find((p) => p.id === app.settings?.defaultPreset)?.id ?? presets[0]?.id ?? 'fast')
  let maxDownloads = $state(0)

  let phase = $state<'form' | 'working' | 'done' | 'failed'>('form')
  let created = $state<PublicShareCreated | null>(null)
  let link = $state<PublicLink | null>(null)
  let error = $state('')
  let status = $state<PublicShareStatus | null>(null)
  let copied = $state('')

  const expiresAt = $derived(created?.expiresAt ?? Date.now() + days * DAY_MS)
  const job = $derived(created ? app.jobs.find((j) => j.id === created!.jobId) : undefined)
  const pct = $derived(job?.total ? Math.min(100, (job.done / job.total) * 100) : 0)
  const full = $derived(!!status && status.freeBytes != null && status.minFreeBytes != null && status.freeBytes - bytes < status.minFreeBytes)
  const usePw = $derived(protect === 'password')
  const useEmail = $derived(protect === 'email')
  const pwProblem = $derived(usePw && password && password.length < 6 ? 'Use at least 6 characters' : '')
  /** the share server reports in its heartbeat whether it can send e-mail */
  const mailReady = $derived(status?.server?.mail === true)
  const recipients = $derived(parseRecipients(recipientsText))
  const recipProblem = $derived(
    !useEmail
      ? ''
      : recipients.bad.length
        ? `${recipients.bad.length === 1 ? 'Not an e-mail address' : 'Not e-mail addresses'}: ${recipients.bad.join(', ')}`
        : recipients.list.length > MAX_RECIPIENTS
          ? `At most ${MAX_RECIPIENTS} addresses (${recipients.list.length} typed)`
          : ''
  )
  /** the chosen protection is complete (a password typed, or 1-10 good addresses on a server that can mail) */
  const protectOk = $derived(usePw ? !!password && !pwProblem : useEmail ? mailReady && recipients.list.length > 0 && !recipProblem : true)
  const email = $derived(
    created
      ? buildEmail({
          url: created.url,
          title: link?.title ?? title,
          message,
          sender: app.settings?.profile.displayName || 'Dexterity Design Services',
          files: link?.files ?? [],
          expiresAt: created.expiresAt,
          hasPassword: usePw && !!password,
          recipientsOnly: useEmail
        })
      : null
  )

  onMount(() => {
    void engine.call<PublicShareStatus>('pubshare.status').then((s) => (status = s), () => {})
  })

  $effect(() => {
    if (phase !== 'working' || !job) return
    if (job.state === 'done') void finish()
    else if (job.state === 'failed' || job.state === 'cancelled') {
      error = job.state === 'cancelled' ? 'Cancelled. Nothing was published.' : (job.error ?? job.errors[0]?.message ?? 'The link could not be created')
      phase = 'failed'
    }
  })

  async function finish() {
    // the manifest holds what was really published (zip name, sizes)
    const mine = await engine.call<PublicLink[]>('pubshare.list').catch(() => [] as PublicLink[])
    link = mine.find((l) => l.id === created!.id) ?? null
    phase = 'done'
  }

  async function go() {
    if (phase !== 'form' || !title.trim() || !protectOk) return
    error = ''
    // With a known selection the tick box decides; for paths handed in from elsewhere the engine
    // works out whether a zip is needed (a folder always is).
    const zip = zipFirst ? { presetId, name: title.trim() } : known || files.length > 1 ? null : undefined
    const spec: PublicShareSpec = {
      paths: files,
      title: title.trim(),
      message: message.trim() || undefined,
      days,
      password: (usePw && password) || undefined,
      recipients: useEmail ? recipients.list : undefined,
      zip,
      maxDownloads
    }
    try {
      created = await engine.call<PublicShareCreated>('pubshare.create', spec)
      phase = 'working'
    } catch (e: any) {
      error = String(e?.message ?? e).replace(/^Error:\s*/, '')
      phase = 'failed'
    }
  }

  async function copy(what: 'link' | 'email' | 'password' | 'subject') {
    if (!created || !email) return
    const text = what === 'link' ? created.url : what === 'password' ? password : what === 'subject' ? email.subject : `Subject: ${email.subject}\r\n\r\n${email.body}`
    await host.clip.writeText(text)
    copied = what
    setTimeout(() => copied === what && (copied = ''), 1800)
  }

  function mail() {
    if (email) void host.shell.openExternal(mailtoUrl(email.subject, email.body))
  }
</script>

<Dialog title={phase === 'done' ? 'Client link ready' : 'Create client link'} icon="link" width={600} onclose={() => close(phase === 'done')} onsubmit={go}>
  {#if phase === 'form'}
    <div class="what">
      <Icon name={files.length === 1 ? (hasFolders ? 'folder' : isArchive ? 'zip' : 'file') : 'layers'} size={20} />
      <span class="ellipsis">{files.length === 1 ? basename(files[0]) : plural(files.length, 'item')}</span>
      {#if bytes}<span class="caption">{fmtSize(bytes)}{hasFolders ? ' + folders' : ''}</span>{/if}
    </div>

    {#if status && !status.enabled}
      <div class="warn"><Icon name="warning" /> <span>Dexterity Share isn't switched on for this office yet. Ask whoever looks after Hopper (Settings → Office → Dexterity Share).</span></div>
    {:else if status && !status.storeOk}
      <div class="warn"><Icon name="warning" /> <span>The share folder on the server can't be reached: {status.storeError}. Check that the office server is on.</span></div>
    {:else if full}
      <div class="warn bad"><Icon name="warning" /> <span>The office server is nearly full ({fmtSize(status!.freeBytes!)} free; client links must leave {fmtSize(status!.minFreeBytes!)}). Revoke old links under My client links, or ask IT to free space.</span></div>
    {:else if status && !status.healthy}
      <div class="warn"><Icon name="warning" /> <span>{status.healthError ?? 'The share server is not answering'}. You can still create the link — the client can download as soon as the server is back.</span></div>
    {/if}

    <label class="field">
      <span>Title <span class="caption">(the client sees this)</span></span>
      <input class="input" bind:value={title} maxlength="200" spellcheck="true" />
    </label>
    <label class="field">
      <span>Message to the client <span class="caption">(optional — shown on the page and in the e-mail)</span></span>
      <textarea class="input" rows="3" bind:value={message} maxlength="4000" placeholder="e.g. Please find the Lot 07 isometrics, rev B, with the comment register."></textarea>
    </label>

    <div class="grid">
      <label class="field">
        <span>Link expires after</span>
        <select class="input" bind:value={days}>
          {#each EXPIRY_DAYS as d (d)}<option value={d}>{d} {d === 1 ? 'day' : 'days'}</option>{/each}
        </select>
        <span class="hint">{fmtExpiryDate(expiresAt)}</span>
      </label>
      <label class="field">
        <span>Download limit</span>
        <select class="input" bind:value={maxDownloads}>
          <option value={0}>No limit</option>
          <option value={1}>Once</option>
          <option value={3}>3 times</option>
          <option value={5}>5 times</option>
          <option value={10}>10 times</option>
        </select>
        <span class="hint">{maxDownloads ? 'Complete downloads per file' : 'Until the link expires'}</span>
      </label>
    </div>

    <div class="field" role="radiogroup" aria-label="Who can download">
      <span>Who can download</span>
      <div class="radios">
        <label class="check"><input type="radio" name="protect" bind:group={protect} value="none" /> Anyone with the link</label>
        <label class="check"><input type="radio" name="protect" bind:group={protect} value="password" /> Password</label>
        <label class="check" class:disabled={!mailReady} title={mailReady ? '' : 'E-mail codes are not set up on the share server'}>
          <input type="radio" name="protect" bind:group={protect} value="email" disabled={!mailReady} /> Only these e-mail addresses (code by e-mail)
        </label>
      </div>
      {#if status && !mailReady}<span class="hint">E-mail codes are not set up on the share server yet. Whoever looks after Dexterity Share can set them up in Share server settings → E-mail codes.</span>{/if}
    </div>

    {#if usePw}
      <label class="field">
        <span>Password <span class="caption">(send it to the client separately, never in the same e-mail)</span></span>
        <div class="row">
          <input class="input" type={showPw ? 'text' : 'password'} bind:value={password} autocomplete="new-password" spellcheck="false" />
          <button type="button" class="btn" title="Make a strong password" onclick={() => ((password = generatePassword()), (showPw = true))}><Icon name="lock" /> Generate</button>
          <button type="button" class="btn icon" title={showPw ? 'Hide' : 'Show'} aria-label={showPw ? 'Hide password' : 'Show password'} onclick={() => (showPw = !showPw)}><Icon name={showPw ? 'hidden' : 'eye'} /></button>
        </div>
        {#if pwProblem}<span class="hint bad">{pwProblem}</span>{/if}
      </label>
    {:else if useEmail}
      <label class="field">
        <span>E-mail addresses <span class="caption">(up to {MAX_RECIPIENTS}; separate with commas or one per line)</span></span>
        <textarea class="input" rows="2" bind:value={recipientsText} maxlength="4000" spellcheck="false" autocomplete="off" placeholder="name@client.com"></textarea>
        {#if recipProblem}
          <span class="hint bad">{recipProblem}</span>
        {:else}
          <span class="hint">{recipients.list.length ? `${recipients.list.length} ${recipients.list.length === 1 ? 'address' : 'addresses'} · ` : ''}The page asks the client for their e-mail address and sends a one-time code to the address typed here. Anyone else is turned away.</span>
        {/if}
      </label>
    {/if}

    {#if !isArchive}
      <div class="zipline">
        <label class="check" class:disabled={hasFolders}>
          <input type="checkbox" bind:checked={zipFirst} disabled={hasFolders} /> Zip into one file
          <span class="caption">{hasFolders ? '(folders are always sent as one zip)' : files.length > 1 ? '(one download for the client)' : ''}</span>
        </label>
        {#if zipFirst && presets.length > 1}
          <select class="input" bind:value={presetId} aria-label="Zip preset">
            {#each presets as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
          </select>
        {/if}
      </div>
    {/if}
  {:else if phase === 'working'}
    <div class="busy">
      <div class="title2">Publishing “{title}”</div>
      <div class="bar"><i style:width={`${pct}%`}></i></div>
      <div class="caption line">
        <span>{job?.state === 'paused' ? 'Paused' : job?.current ? basename(job.current) : 'Preparing…'}</span>
        <span>{job?.total ? `${fmtSize(job.done)} of ${fmtSize(job.total)}` : ''}{job?.rate ? ` · ${fmtRate(job.rate)} · ${fmtEta(job.total - job.done, job.rate)}` : ''}</span>
      </div>
      <p class="caption">The files are being {zipFirst ? 'zipped and ' : ''}copied to the office server and checksummed. The link starts working when this finishes. You can close this window; the job carries on in the transfer queue and the link appears under <b>My client links</b>.</p>
    </div>
  {:else if phase === 'done' && created}
    <div class="ok"><Icon name="success" /> <span>The link is live. It expires on <b>{fmtExpiryDate(created.expiresAt)}</b> ({plural(daysLeft(created.expiresAt), 'day')}).</span></div>
    <label class="field">
      <span>Link for the client</span>
      <div class="row">
        <input class="input mono" readonly value={created.url} onfocus={(e) => e.currentTarget.select()} />
        <button type="button" class="btn primary" onclick={() => copy('link')}><Icon name={copied === 'link' ? 'check' : 'copy'} /> {copied === 'link' ? 'Copied' : 'Copy link'}</button>
      </div>
    </label>
    {#if link}
      <div class="caption">{link.files.length === 1 ? link.files[0].name : plural(link.files.length, 'file')} · {fmtSize(link.bytes)}{maxDownloads ? ` · ${maxDownloads === 1 ? 'one download' : `${maxDownloads} downloads`} per file` : ''}</div>
    {/if}
    {#if link?.recipients}
      <div class="caption">Only for: {link.recipients.join(', ')}. Each gets a one-time code by e-mail when they open the link.</div>
    {/if}
    {#if usePw && password}
      <div class="pw">
        <Icon name="lock" />
        <span>Password: <b class="mono">{password}</b></span>
        <button type="button" class="btn sm" onclick={() => copy('password')}>{copied === 'password' ? 'Copied' : 'Copy'}</button>
        <span class="caption">Give it to the client by phone or a separate message. Hopper does not keep it: note it now.</span>
      </div>
    {/if}
    {#if email}
      <label class="field">
        <span>E-mail text <span class="caption">(subject: {email.subject})</span></span>
        <textarea class="input mail" rows="9" readonly value={email.body}></textarea>
      </label>
    {/if}
    {#if status && !status.healthy}
      <div class="warn"><Icon name="warning" /> <span>{status.healthError ?? 'The share server is not answering'} — the client will see “can't reach our file server” until it is back. Tell IT before you send the e-mail.</span></div>
    {/if}
  {:else}
    <div class="warn bad"><Icon name="error" /> <span>{error}</span></div>
    <div class="caption">Nothing was published and nothing was left on the server.</div>
  {/if}

  {#snippet footer()}
    {#if phase === 'form'}
      <span class="caption foot">Files stay on the office server. Only this link can reach them, until it expires.</span>
      <button type="submit" class="btn primary" disabled={!title.trim() || !files.length || !protectOk || full || status?.enabled === false || status?.storeOk === false}><Icon name="link" /> Create link</button>
      <button type="button" class="btn" onclick={() => close()}>Cancel</button>
    {:else if phase === 'working'}
      <span class="spacer"></span>
      <button type="button" class="btn" onclick={() => created && engine.call('jobs.cancel', created.jobId)}>Cancel</button>
      <button type="button" class="btn primary" onclick={() => ((app.drawer = true), close())}>Continue in background</button>
    {:else if phase === 'done'}
      <button type="button" class="btn" onclick={() => copy('email')}><Icon name={copied === 'email' ? 'check' : 'copy'} /> {copied === 'email' ? 'Copied' : 'Copy e-mail text'}</button>
      <button type="button" class="btn" onclick={mail}><Icon name="send" /> Open in mail app</button>
      <span class="spacer"></span>
      <button type="button" class="btn primary" onclick={() => close(true)}>Done</button>
    {:else}
      <span class="spacer"></span>
      <button type="button" class="btn" onclick={() => ((phase = 'form'), (created = null))}>Back</button>
      <button type="button" class="btn primary" onclick={() => close()}>Close</button>
    {/if}
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
  .warn,
  .ok {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 8px 12px;
    border-radius: var(--r-md);
    font-size: 13px;
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 10%, transparent);
  }
  .warn.bad {
    color: var(--bad);
    background: color-mix(in srgb, var(--bad) 10%, transparent);
  }
  .ok {
    color: var(--text);
    background: color-mix(in srgb, var(--ok) 12%, transparent);
  }
  .ok :global(svg) {
    color: var(--ok);
  }
  .warn span,
  .ok span {
    color: var(--text);
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .hint.bad {
    color: var(--bad);
  }
  .radios {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
    align-items: center;
    min-height: 32px;
  }
  .zipline {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 32px;
  }
  .zipline .check {
    flex: 1;
  }
  .disabled {
    opacity: 0.75;
  }
  .busy {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 8px 0;
  }
  .title2 {
    font-weight: 600;
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
    transition: width var(--mid) linear;
  }
  .line {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-variant-numeric: tabular-nums;
  }
  .busy p {
    margin: 4px 0 0;
  }
  .mono {
    font-family: var(--mono);
    font-size: 13px;
    user-select: text;
  }
  .pw {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: var(--r-md);
    border: 1px solid var(--stroke-2);
    background: var(--layer-solid);
  }
  .pw .caption {
    flex-basis: 100%;
  }
  .mail {
    font-size: 13px;
    line-height: 18px;
    resize: vertical;
  }
  .foot {
    flex: 1;
    align-self: center;
  }
</style>
