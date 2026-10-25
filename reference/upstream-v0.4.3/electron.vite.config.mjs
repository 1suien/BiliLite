import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

const r = (p) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: r('src/main/index.js') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: r('src/preload/index.js') } }
    }
  },
  renderer: {
    root: r('src/renderer'),
    resolve: {
      alias: { '@': r('src/renderer/src') }
    },
    build: {
      rollupOptions: { input: { index: r('src/renderer/index.html') } }
    },
    plugins: [vue()]
  }
})
