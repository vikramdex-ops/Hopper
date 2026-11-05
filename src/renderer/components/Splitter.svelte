<script lang="ts">
  let { onDrag, vertical = false }: { onDrag: (fraction: number, px: number) => void; vertical?: boolean } = $props()
  let el: HTMLDivElement

  function down(e: PointerEvent) {
    const parent = el.parentElement!
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const r = parent.getBoundingClientRect()
      const px = vertical ? ev.clientY - r.top : ev.clientX - r.left
      onDrag(px / (vertical ? r.height : r.width), px)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
</script>

<div bind:this={el} class="splitter" class:vertical role="separator" aria-orientation={vertical ? 'horizontal' : 'vertical'} onpointerdown={down}></div>

<style>
  .splitter {
    flex: none;
    width: 8px;
    cursor: col-resize;
    position: relative;
  }
  .splitter::after {
    content: '';
    position: absolute;
    inset: 40% 3.5px;
    border-radius: 1px;
    background: transparent;
    transition: background var(--fast);
  }
  .splitter:hover::after {
    background: var(--stroke-strong);
  }
  .vertical {
    width: auto;
    height: 8px;
    cursor: row-resize;
  }
</style>
