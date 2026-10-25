/**
 * 安卓版（Capacitor）的 Vite 构建配置。
 *
 * root 指向 **mobile/**（也就是 Capacitor 工程目录），产物落在 `mobile/www/`，
 * 与 `capacitor.config.json` 的 `webDir: "www"` 对齐 —— 必须让 www 根目录下就是
 * index.html，Capacitor 才能正确加载。
 *
 * 页面入口 `mobile/index.html` 里用 `../src/mobile/main.js` 引到仓库里的共用源码
 * （渲染层、样式、B 站接口层都在 `src/` 下），桌面端（electron-vite）与安卓端
 * 只是入口和输出目录不同。
 */

import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * Capacitor 的依赖装在 `mobile/node_modules`，但引用它们的代码在 `src/mobile/`。
 * Node 的 bare specifier 解析只沿**祖先目录**往上找，`src/mobile/` 的祖先是仓库根，
 * 永远看不到 `mobile/node_modules` —— 所以这里显式指过去。
 */
const cap = (name) => fileURLToPath(new URL(`./node_modules/@capacitor/${name}`, import.meta.url))

export default defineConfig({
  root: here,
  // Capacitor 用本地 http 服务提供页面，用相对路径最稳
  base: './',
  publicDir: false,
  plugins: [vue()],
  resolve: {
    alias: [
      { find: '@capacitor/core', replacement: cap('core') },
      { find: '@capacitor/app', replacement: cap('app') },
      { find: '@capacitor/filesystem', replacement: cap('filesystem') },
      { find: '@capacitor/share', replacement: cap('share') },
      // 平台能力（见 src/mobile/platform.js 与 src/mobile/store.js）
      { find: '@capacitor/clipboard', replacement: cap('clipboard') },
      { find: '@capacitor/preferences', replacement: cap('preferences') },
      { find: '@capacitor/status-bar', replacement: cap('status-bar') },
      { find: '@capacitor/screen-orientation', replacement: cap('screen-orientation') }
    ]
  },
  build: {
    outDir: 'www',
    emptyOutDir: true,
    target: 'es2020',
    assetsInlineLimit: 4096,
    rollupOptions: {
      input: fileURLToPath(new URL('./index.html', import.meta.url))
    }
  },
  server: {
    host: '0.0.0.0',
    port: 5199,
    fs: { allow: [repoRoot] }
  }
})
