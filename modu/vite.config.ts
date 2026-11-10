import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Capacitor 加载的是 file:// 下的 dist，所以 base 必须是相对路径 './'
export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2019',
    outDir: 'dist',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 3000,
  },
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173 },
})
