<script lang="ts">
  // Renders the dialog stack and registers every dialog opener in the command registry.
  import { app } from '../lib/app.svelte'
  import { dialogs } from '../lib/commands'
  import ConfirmDialog from './dialogs/ConfirmDialog.svelte'
  import PromptDialog from './dialogs/PromptDialog.svelte'
  import { registerDialogs } from './dialogs/registry'

  app.confirmImpl = (title, body, ok) => app.dialog<boolean>(ConfirmDialog, { title, body, ok }).then((v) => !!v)
  app.promptImpl = (title, value, label) => app.dialog<string | null>(PromptDialog, { title, value, label }).then((v) => (v === undefined ? null : v))
  registerDialogs(dialogs)
</script>

{#each app.dialogs as d (d.id)}
  {@const C = d.component}
  <C {...d.props} close={(v?: unknown) => app.closeDialog(d.id, v)} />
{/each}
