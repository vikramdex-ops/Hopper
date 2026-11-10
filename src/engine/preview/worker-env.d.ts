// electron-vite's "?nodeWorker" import: bundles the file as a worker and returns its constructor.
declare module '*?nodeWorker' {
  import type { Worker, WorkerOptions } from 'node:worker_threads'
  export default function (options: WorkerOptions): Worker
}
