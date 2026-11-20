import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { app } from './lib/app.svelte'
import { engine } from './lib/api'
import { dialogs } from './lib/commands'
import { formatPath } from './lib/pathcopy'
import { watchUi } from './lib/folderwatch.svelte'

const density = (() => {
  try {
    return localStorage.getItem('density') ?? ''
  } catch {
    return ''
  }
})()
if (density) document.documentElement.dataset.density = density

// Handle for the end-to-end tests (tests/e2e) to drive and inspect the app.
;(window as any).__hopper = app
;(app as any).__engine = (m: string, ...a: unknown[]) => engine.call(m, ...a)
;(app as any).__dialogs = dialogs
;(app as any).__formatPath = formatPath
;(app as any).__watch = watchUi

// The Win+V clipboard panel is its own small window loading this page with #clipboard.
if (location.hash === '#clipboard') {
  document.documentElement.dataset.panel = 'clipboard'
  void import('./components/ClipPanel.svelte').then((m) => mount(m.default, { target: document.getElementById('app')! }))
} else mount(App, { target: document.getElementById('app')! })
