<script lang="ts">
  import { onDestroy } from 'svelte'
  import type { Entry, ArchiveEntry } from '@shared/types'
  import { engine } from '../lib/api'
  import { app } from '../lib/app.svelte'
  import { isArchivePath, splitArchive } from '../lib/pane.svelte'
  import { kindOf, richMode, KIND_COLOR, KIND_ICON, type RichMode } from '../lib/filetypes'
  import { fmtSize, plural } from '../lib/format'
  import { renderMarkdown } from '../lib/markdown'
  import Icon from './Icon.svelte'
  import RichPreview from './viewers/RichPreview.svelte'
  import { docViewer } from '../lib/docviewer.svelte'

  let { entry, large = false }: { entry: Entry; large?: boolean } = $props()

  type State =
    | { t: 'none' }
    | { t: 'loading' }
    | { t: 'image'; src: string; full: string }
    | { t: 'media'; src: string; video: boolean }
    | { t: 'rich'; mode: RichMode }
    | { t: 'text'; text: string; truncated: boolean; mono: boolean }
    | { t: 'md'; html: string }
    | { t: 'archive'; items: ArchiveEntry[]; total: number }
    | { t: 'folder'; dirs: number; files: number; bytes: number }
    | { t: 'font'; family: string }
    | { t: 'thumb'; src: string }
    | { t: 'error'; message: string }

  let st = $state<State>({ t: 'none' })
  let token = 0
  let fontFace: FontFace | null = null
  let media: HTMLMediaElement | undefined = $state()

  const enc = encodeURIComponent
  const fileUrl = (p: string) => `hopper://file/?p=${enc(p)}`
  const thumbUrl = (e: Entry, s: number) => `hopper://thumb/?p=${enc(e.path)}&s=${s}&v=${e.mtime}-${e.size}`
  const TEXT_LIKE = new Set(['text', 'code', 'markdown', 'data', 'html'])

  function cleanup() {
    if (media) {
      media.pause()
      media.removeAttribute('src')
      media.load()
    }
    if (fontFace) {
      document.fonts.delete(fontFace)
      fontFace = null
    }
  }

  async function render(e: Entry) {
    const my = ++token
    cleanup()
    if (isArchivePath(e.path)) {
      st = { t: 'none' }
      return
    }
    const k = kindOf(e.ext, e.dir)
    try {
      if (e.dir) {
        st = { t: 'loading' }
        const r = await engine.call<{ entries: Entry[] }>('fs.list', e.path)
        if (my !== token) return
        const files = r.entries.filter((x) => !x.dir)
        st = { t: 'folder', dirs: r.entries.length - files.length, files: files.length, bytes: files.reduce((a, x) => a + x.size, 0) }
      } else if (k === 'image' && !['psd', 'heic', 'heif', 'tif', 'tiff'].includes(e.ext)) {
        // A shell thumbnail keeps memory low; the viewer loads full resolution.
        st = { t: 'image', src: e.ext === 'svg' || e.ext === 'gif' ? fileUrl(e.path) : thumbUrl(e, large ? 1024 : 512), full: fileUrl(e.path) }
      } else if (k === 'video' || k === 'audio') {
        st = { t: 'media', src: fileUrl(e.path), video: k === 'video' }
      } else if (richMode(e.ext)) {
        // PDF, spreadsheets, Word and drawings have their own interactive viewers.
        st = { t: 'rich', mode: richMode(e.ext)! }
      } else if (k === 'file' && e.size >= 1536 && (await sniffDrawing(e, my))) {
        // Unknown extension, but the content is a drawing (border and sheet files often are).
        st = { t: 'rich', mode: 'cad' }
      } else if (my !== token) {
        return
      } else if (k === 'font') {
        const family = `pv-${my}`
        fontFace = new FontFace(family, `url("${fileUrl(e.path)}")`)
        await fontFace.load()
        if (my !== token) return
        document.fonts.add(fontFace)
        st = { t: 'font', family }
      } else if (k === 'archive') {
        st = { t: 'loading' }
        const items = await engine.call<ArchiveEntry[]>('archive.list', e.path)
        if (my !== token) return
        st = { t: 'archive', items: items.slice(0, 300), total: items.length }
      } else if (TEXT_LIKE.has(k) || (e.size < 64 * 1024 && k === 'file')) {
        st = { t: 'loading' }
        const r = await engine.call<{ text: string; truncated: boolean; binary: boolean }>('fs.readText', e.path, 256 * 1024)
        if (my !== token) return
        if (r.binary) st = { t: 'thumb', src: thumbUrl(e, 256) }
        else if (k === 'markdown') st = { t: 'md', html: renderMarkdown(r.text) }
        else st = { t: 'text', text: r.text, truncated: r.truncated, mono: k !== 'text' }
      } else {
        st = { t: 'thumb', src: thumbUrl(e, large ? 768 : 384) }
      }
    } catch (err: any) {
      if (my === token) st = { t: 'error', message: String(err?.message ?? err).replace(/^Error:\s*/, '') }
    }
  }

  async function sniffDrawing(e: Entry, my: number) {
    try {
      const kind = await engine.call<string>('preview.sniff', e.path, large ? 'quicklook-sniff' : 'inspector-sniff')
      return my === token && (kind === 'dgn7' || kind === 'dwg')
    } catch {
      return false
    }
  }

  $effect(() => {
    void render(entry)
  })
  onDestroy(() => {
    token++
    cleanup()
  })

  const k = $derived(kindOf(entry.ext, entry.dir))
</script>

<div class="pv" class:large>
  {#if st.t === 'image'}
    <button class="imgwrap" title="Open in viewer (Ctrl+Enter)" onclick={() => (app.viewer = { entries: app.active.rows.filter((r) => kindOf(r.ext) === 'image'), index: Math.max(0, app.active.rows.filter((r) => kindOf(r.ext) === 'image').findIndex((r) => r.path === entry.path)) })}>
      <img src={st.src} alt={entry.name} decoding="async" onerror={(e) => st.t === 'image' && ((e.currentTarget as HTMLImageElement).src = st.full)} />
    </button>
  {:else if st.t === 'media'}
    {#if st.video}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={media} src={st.src} controls preload="metadata"></video>
    {:else}
      <div class="glyph" style:color={KIND_COLOR.audio}><Icon name="audio" size={56} /></div>
      <audio bind:this={media} src={st.src} controls preload="metadata"></audio>
    {/if}
  {:else if st.t === 'rich'}
    <div class="richbox">
      {#if docViewer.entry?.path === entry.path}
        <!-- The full-window viewer has this file open; don't keep a second copy working behind it. -->
        <div class="glyph" style:color={KIND_COLOR[k]}><Icon name={KIND_ICON[k]} size={56} /></div>
        <div class="caption center">Open in the viewer</div>
      {:else}
        {#key entry.path}<RichPreview {entry} mode={st.mode} size={large ? 'large' : 'side'} />{/key}
      {/if}
    </div>
  {:else if st.t === 'text'}
    <pre class="text" class:mono={st.mono}>{st.text}</pre>
    {#if st.truncated}<div class="caption more">Showing the first 256 KB</div>{/if}
  {:else if st.t === 'md'}
    <div class="md">{@html st.html}</div>
  {:else if st.t === 'archive'}
    <div class="arch">
      <div class="caption">{plural(st.total, 'item')} · {fmtSize(st.items.reduce((a, x) => a + x.size, 0))} unpacked</div>
      {#each st.items as it (it.path)}
        <div class="ai"><Icon name={it.dir ? 'folder' : 'file'} size={14} /><span class="ellipsis">{it.path}</span><span class="caption">{it.dir ? '' : fmtSize(it.size)}</span></div>
      {/each}
    </div>
  {:else if st.t === 'folder'}
    <div class="glyph" style:color={KIND_COLOR.folder}><Icon name="folder" size={72} /></div>
    <div class="caption center">{plural(st.dirs, 'folder')}, {plural(st.files, 'file')} · {fmtSize(st.bytes)} (top level)</div>
  {:else if st.t === 'font'}
    <div class="font" style:font-family={st.family}>
      <div style="font-size: 36px">Aa Bb Cc</div>
      <div style="font-size: 18px">The quick brown fox jumps over the lazy dog</div>
      <div style="font-size: 14px">0123456789 ÆØÅ àéîõü ¿¡ &amp;@#</div>
    </div>
  {:else if st.t === 'thumb'}
    <div class="thumb">
      <img src={st.src} alt="" onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')} />
      <span class="glyph back" style:color={KIND_COLOR[k]}><Icon name={KIND_ICON[k]} size={64} /></span>
    </div>
  {:else if st.t === 'loading'}
    <div class="glyph"><span class="spin"></span></div>
  {:else if st.t === 'error'}
    <div class="glyph" style:color={KIND_COLOR[k]}><Icon name={KIND_ICON[k]} size={56} /></div>
    <div class="caption center">{st.message}</div>
  {:else}
    <div class="glyph" style:color={KIND_COLOR[k]}><Icon name={KIND_ICON[k]} size={56} /></div>
  {/if}
</div>

<style>
  .pv {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 120px;
  }
  .imgwrap {
    border: 0;
    padding: 0;
    background: repeating-conic-gradient(var(--stroke) 0 25%, transparent 0 50%) 0 0 / 16px 16px;
    border-radius: var(--r-md);
    display: grid;
    place-items: center;
    cursor: zoom-in;
    overflow: hidden;
  }
  .imgwrap img {
    max-width: 100%;
    max-height: 320px;
    object-fit: contain;
    display: block;
  }
  .large .imgwrap img {
    max-height: 72vh;
  }
  video {
    width: 100%;
    max-height: 60vh;
    border-radius: var(--r-md);
    background: black;
  }
  audio {
    width: 100%;
  }
  .richbox {
    height: clamp(300px, 58vh, 760px);
    min-width: 0;
  }
  .large .richbox {
    height: calc(88vh - 128px);
    min-height: 260px;
  }
  .text,
  .md,
  .arch {
    max-height: 420px;
    overflow: auto;
    border-radius: var(--r-md);
    background: var(--layer-solid);
    border: 1px solid var(--stroke);
    padding: 10px 12px;
    margin: 0;
    user-select: text;
  }
  .large .text,
  .large .md,
  .large .arch {
    max-height: 70vh;
  }
  .text {
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 12px;
    line-height: 18px;
  }
  .text.mono {
    font-family: var(--mono);
    white-space: pre;
  }
  .md {
    font-size: 13px;
  }
  .md :global(h1),
  .md :global(h2),
  .md :global(h3) {
    margin: 8px 0 4px;
    font-size: 15px;
  }
  .md :global(pre) {
    background: var(--stroke);
    padding: 8px;
    border-radius: 4px;
    overflow: auto;
  }
  .md :global(code) {
    font-family: var(--mono);
    font-size: 12px;
  }
  .md :global(a) {
    color: var(--accent);
  }
  .ai {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    height: 22px;
  }
  .ai span:first-of-type {
    flex: 1;
  }
  .glyph {
    display: grid;
    place-items: center;
    padding: 24px 0 8px;
  }
  .center {
    text-align: center;
  }
  .more {
    text-align: right;
  }
  .font {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px;
    border-radius: var(--r-md);
    background: var(--layer-solid);
    border: 1px solid var(--stroke);
    overflow: hidden;
  }
  .thumb {
    display: grid;
    place-items: center;
    position: relative;
    min-height: 160px;
  }
  .thumb img {
    max-width: 100%;
    max-height: 360px;
    border-radius: var(--r-md);
    position: relative;
    z-index: 1;
    box-shadow: var(--shadow-card);
  }
  .thumb .back {
    position: absolute;
    inset: 0;
  }
  .spin {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: 3px solid var(--stroke-strong);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
