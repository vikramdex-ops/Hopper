import { existsSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { defineConfig } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

/**
 * Office-specific values stay out of this public repository. They come from the environment
 * (HOPPER_STANDING_ADMINS="a,b,c"; a GitHub Actions secret for release builds) or from the
 * untracked file office.local.json ({"standingAdmins": ["a", "b"]}). Without either, a build has
 * no standing admins: the office is then configured from the PC that set it up.
 */
function standingAdmins(): string[] {
  const fromEnv = process.env.HOPPER_STANDING_ADMINS
  let list: unknown = fromEnv ? fromEnv.split(',') : []
  const local = resolve(__dirname, 'office.local.json')
  if (!fromEnv && existsSync(local)) list = JSON.parse(readFileSync(local, 'utf8').replace(/^﻿/, '')).standingAdmins ?? []
  return (Array.isArray(list) ? list : []).map((u) => String(u).trim().toLowerCase()).filter(Boolean)
}
const define = { __HOPPER_STANDING_ADMINS__: JSON.stringify(standingAdmins()) }

const shared = { '@shared': resolve(__dirname, 'src/shared') }
const res = { alias: shared, preserveSymlinks: true }
// U: is a mapped network drive and Node realpaths it to the UNC form, which Vite then
// can't relate to the root; preserveSymlinks keeps every id on the U:\ spelling.
const posix = (p: string) => resolve(__dirname, p).split(sep).join('/')

export default defineConfig({
  main: {
    define,
    resolve: res,
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          engine: resolve(__dirname, 'src/engine/index.ts'),
          lan: resolve(__dirname, 'src/lan/index.ts'),
          share: resolve(__dirname, 'src/share/index.ts')
        }
      }
    }
  },
  preload: {
    define,
    resolve: res,
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } }
    }
  },
  renderer: {
    root: posix('src/renderer'),
    define,
    resolve: res,
    plugins: [svelte()],
    build: {
      outDir: posix('out/renderer'),
      rollupOptions: { input: { index: posix('src/renderer/index.html') } }
    }
  }
})
