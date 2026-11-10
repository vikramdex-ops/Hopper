import { resolve, sep } from 'node:path'
import { defineConfig } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

const shared = { '@shared': resolve(__dirname, 'src/shared') }
const res = { alias: shared, preserveSymlinks: true }
// U: is a mapped network drive and Node realpaths it to the UNC form, which Vite then
// can't relate to the root; preserveSymlinks keeps every id on the U:\ spelling.
const posix = (p: string) => resolve(__dirname, p).split(sep).join('/')

export default defineConfig({
  main: {
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
    resolve: res,
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } }
    }
  },
  renderer: {
    root: posix('src/renderer'),
    resolve: res,
    plugins: [svelte()],
    build: {
      outDir: posix('out/renderer'),
      rollupOptions: { input: { index: posix('src/renderer/index.html') } }
    }
  }
})
