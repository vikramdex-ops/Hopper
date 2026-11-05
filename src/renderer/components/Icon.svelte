<script lang="ts">
  import { iconSvg } from '../lib/icons'
  let { name, size = 16, cls = '' }: { name: string; size?: number; cls?: string } = $props()
</script>

{@html iconSvg(name, size, cls)}
