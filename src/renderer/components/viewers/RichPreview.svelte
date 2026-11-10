<script lang="ts">
  // Picks and feeds the built-in viewer for one file: PDF, spreadsheet, Word, or a drawing
  // (DWG saved preview, MicroStation V7 viewer, preview stored in an OLE file such as .sha / DGN V8).
  // Drawings are recognised by their content, not their extension. When nothing can be shown it
  // says so plainly and falls back to the Windows thumbnail if this PC has one.
  import { onDestroy } from 'svelte'
  import type { Entry } from '@shared/types'
  import { engine } from '../../lib/api'
  import { openDocViewer } from '../../lib/docviewer.svelte'
  import { KIND_COLOR, KIND_ICON, kindOf, type RichMode } from '../../lib/filetypes'
  import type { DgnDrawing, DocxPreview, DwgPreview, FileSniff, OlePreview, PreviewImage } from '../../../engine/preview/types'
  import Icon from '../Icon.svelte'
  import PdfView from './PdfView.svelte'
  import SheetView from './SheetView.svelte'
  import WordView from './WordView.svelte'
  import PanImage from './PanImage.svelte'
  import DgnView from './DgnView.svelte'

  let { entry, mode, size = 'side' }: { entry: Entry; mode: RichMode; size?: 'side' | 'large' | 'full' } = $props()

  type State =
    | { t: 'loading' }
    | { t: 'pdf'; url: string }
    | { t: 'sheet' }
    | { t: 'word'; doc: DocxPreview }
    | { t: 'dgn'; drawing: DgnDrawing }
    | { t: 'image'; url: string; caption: string; dark: boolean; props: [string, string][] }
    | { t: 'none'; message: string; detail: string; props: [string, string][]; thumb: boolean }

  let st = $state<State>({ t: 'loading' })
  let token = 0
  let blobUrl = ''
  let thumbOk = $state(true)
  let showProps = $state(false)

  const enc = encodeURIComponent
  const slot = $derived(size === 'full' ? 'viewer' : size === 'large' ? 'quicklook' : 'inspector')
  const expand = $derived(size === 'full' ? undefined : () => openDocViewer(entry, mode))
  const thumbUrl = $derived(`hopper://thumb/?p=${enc(entry.path)}&s=512&v=${entry.mtime}-${entry.size}`)
  const k = $derived(kindOf(entry.ext, entry.dir))

  function blob(img: PreviewImage) {
    if (blobUrl) URL.revokeObjectURL(blobUrl)
    blobUrl = URL.createObjectURL(new Blob([img.data as BlobPart], { type: img.mime }))
    return blobUrl
  }

  const none = (message: string, detail = '', props: [string, string][] = []): State => ({ t: 'none', message, detail, props, thumb: true })

  async function load(e: Entry, m: RichMode) {
    const my = ++token
    st = { t: 'loading' }
    thumbOk = true
    showProps = false
    const call = <T,>(method: string, ...args: unknown[]) => engine.call<T>(method, e.path, ...args, slot)
    try {
      if (e.size === 0) {
        st = { ...none('This file is empty (0 bytes).'), thumb: false } as State
      } else if (m === 'pdf') {
        st = { t: 'pdf', url: `hopper://file/?p=${enc(e.path)}` }
      } else if (m === 'sheet') {
        st = { t: 'sheet' }
      } else if (m === 'word') {
        const kind = await call<FileSniff>('preview.sniff')
        if (my !== token) return
        if (kind === 'zip') {
          const doc = await call<DocxPreview>('preview.docx')
          if (my === token) st = { t: 'word', doc }
        } else if (kind === 'cfb') {
          const o = await call<OlePreview>('preview.ole')
          if (my !== token) return
          if (o.app === 'Word') st = none("Older Word files (.doc) can't be shown here without Word.", 'Open the file in Word, or save it as .docx to preview it in Hopper.', o.props)
          // A .docx stored as an OLE container without a Word stream is an encrypted document.
          else if (e.ext === 'docx') st = none('This document is password-protected, so it cannot be shown here.', 'Open it in Word and enter the password.', o.props)
          else st = none('This file is not a Word document Hopper can read.', '', o.props)
        } else if (my === token) st = none('This file is not a Word document Hopper can read.')
      } else {
        const kind = await call<FileSniff>('preview.sniff')
        if (my !== token) return
        if (kind === 'dgn7') {
          const drawing = await call<DgnDrawing>('preview.dgn')
          if (my === token) st = { t: 'dgn', drawing }
        } else if (kind === 'dwg') {
          const d = await call<DwgPreview>('preview.dwg')
          if (my !== token) return
          const ver = `${d.release || 'DWG'} format (${d.version})`
          if (d.image) st = { t: 'image', url: blob(d.image), caption: `Saved preview · open in AutoCAD / BricsCAD for the live drawing · ${ver}`, dark: false, props: [] }
          else st = none(d.note || 'No preview picture is saved in this drawing.', ver)
        } else if (kind === 'cfb') {
          const o = await call<OlePreview>('preview.ole')
          if (my !== token) return
          const what = o.app === 'compound file' ? '' : o.app === 'MicroStation V8' ? 'MicroStation V8 design file' : `${o.app} file`
          if (o.image) st = { t: 'image', url: blob(o.image), caption: `Preview stored in the file${what ? ` · ${what}` : ''} · open it in its own program for the live drawing`, dark: false, props: o.props }
          else st = none(o.note || 'No preview is stored in this file.', what, o.props)
        } else if (my === token) st = none('Hopper has no built-in preview for this kind of file.')
      }
    } catch (err: any) {
      const msg = String(err?.message ?? err).replace(/^Error:\s*/, '')
      if (my === token && msg !== 'superseded') st = none(msg)
    }
  }

  $effect(() => {
    void load(entry, mode)
  })
  onDestroy(() => {
    token++
    if (blobUrl) URL.revokeObjectURL(blobUrl)
  })
</script>

<div class="rich" class:full={size === 'full'}>
  {#if st.t === 'pdf'}
    {#key st.url}<PdfView url={st.url} size={entry.size} onexpand={expand} />{/key}
  {:else if st.t === 'sheet'}
    <SheetView path={entry.path} {slot} onexpand={expand} />
  {:else if st.t === 'word'}
    <WordView html={st.doc.html} notes={st.doc.notes} onexpand={expand} />
  {:else if st.t === 'dgn'}
    <DgnView drawing={st.drawing} onexpand={expand} />
  {:else if st.t === 'image'}
    <PanImage src={st.url} alt={entry.name} plainWheel={size !== 'side'} onexpand={expand} />
    <div class="caption cap">{st.caption}</div>
    {#if st.props.length}
      <button class="btn subtle sm more" onclick={() => (showProps = !showProps)}><Icon name="info" /> {showProps ? 'Hide' : 'Show'} details stored in the file</button>
    {/if}
  {:else if st.t === 'none'}
    <div class="none">
      {#if st.thumb && thumbOk}
        <img class="shell" src={thumbUrl} alt="" onerror={() => (thumbOk = false)} />
        <div class="caption">Windows thumbnail</div>
      {:else}
        <span style:color={KIND_COLOR[k]}><Icon name={KIND_ICON[k]} size={56} /></span>
      {/if}
      <div class="msg">{st.message}</div>
      {#if st.detail}<div class="caption">{st.detail}</div>{/if}
    </div>
  {:else}
    <div class="none"><span class="spin"></span></div>
  {/if}
  {#if (st.t === 'none' && st.props.length) || (st.t === 'image' && showProps)}
    <div class="props">
      <div class="caption">Details stored in the file</div>
      <dl>
        {#each st.props as [name, value], i (i)}
          <dt>{name}</dt>
          <dd>{value}</dd>
        {/each}
      </dl>
    </div>
  {/if}
</div>

<style>
  .rich {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    min-width: 0;
  }
  .cap {
    padding: 6px 2px 0;
    flex: none;
  }
  .more {
    align-self: flex-start;
    margin-top: 4px;
    flex: none;
  }
  .none {
    flex: 1;
    min-height: 140px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    text-align: center;
    padding: 12px;
  }
  .msg {
    font-weight: 600;
    max-width: 46ch;
  }
  .none .caption {
    max-width: 52ch;
  }
  .shell {
    max-width: 100%;
    max-height: 55%;
    border-radius: var(--r-md);
    box-shadow: var(--shadow-card);
  }
  .props {
    flex: none;
    max-height: 48%;
    overflow: auto;
    margin: 8px 0 0;
    padding: 8px 10px;
    font-size: 12px;
    border: 1px solid var(--stroke);
    border-radius: var(--r-md);
    background: var(--layer-solid);
    user-select: text;
  }
  .props dl {
    display: grid;
    grid-template-columns: minmax(90px, max-content) 1fr;
    gap: 3px 12px;
    margin: 6px 0 0;
  }
  .props dt {
    color: var(--text-2);
  }
  .props dd {
    margin: 0;
    min-width: 0;
    word-break: break-word;
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
