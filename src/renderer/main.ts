import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { app } from './lib/app.svelte'
import { engine } from './lib/api'

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

mount(App, { target: document.getElementById('app')! })
