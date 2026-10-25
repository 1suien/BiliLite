/**
 * 应用启动入口
 *
 * 顺序与 APK 一致：
 *  1. 打平台标记（html[data-platform] 控制安全区/触控样式）
 *  2. 安装数据桥 window.bili（安卓：CapacitorHttp 实现；桌面：Electron 已注入）
 *  3. 安装剪贴板/全屏/PiP 等原生能力
 *  4. 挂载 Vue 应用
 *  5. 接管安卓返回键
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { useUiStore } from './stores/ui'
import './styles/global.css'

async function boot() {
  document.documentElement.dataset.platform = 'android'

  /**
   * 演示模式（还原工程新增的开发者工具，原 APK 没有）：
   *  - 开发模式（vite dev）下如果没有任何桥被注入（用普通浏览器打开），自动启用；
   *  - 地址带 ?mock=1 时启用，但只允许本机来源（localhost/127.0.0.1/::1）或 dev：
   *    真机上页面 origin 是 https://www.bilibili.com，若不加限制，被诱导打开 ?mock=1
   *    就会装上假数据桥并往真实 IndexedDB 里种演示数据。`npm run preview` 起在 127.0.0.1，
   *    截图工具（tools/browser/shot.mjs）因此不受影响。
   * 启用后 window.bili 由本地假数据实现，并往 IndexedDB 种一批演示数据，方便在桌面浏览器里预览所有页面。
   */
  const dev = !!((import.meta as any).env && (import.meta as any).env.DEV)
  const localOrigin = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(location.hostname)
  const wantMock = new URLSearchParams(location.search).has('mock')
  if (wantMock && !localOrigin && !dev) {
    console.warn('[mobile] 忽略 ?mock=1：演示模式只允许在本机来源（localhost/127.0.0.1）打开')
  }
  const mockMode = (dev && !window.bili) || (wantMock && (localOrigin || dev))
  if (mockMode) {
    const { installMockBridge } = await import('./bridge/mock')
    installMockBridge()
    const { seedDemoData } = await import('./dev/seed')
    await seedDemoData()
  }

  // 桌面端（Electron）已经注入 window.bili；否则安装安卓桥
  const hasDesktopBridge =
    typeof window !== 'undefined' && !!window.bili && window.bili.platform !== 'android'
  if (mockMode) {
    console.info('[mobile] 演示模式：使用 mock 数据桥，跳过安卓桥')
  } else if (hasDesktopBridge) {
    console.info('[mobile] 检测到桌面桥，跳过安卓桥安装（仅用于桌面预览平板布局）')
  } else {
    const { installAndroidBridge } = await import('./bridge/android')
    await installAndroidBridge()
  }

  const { installClipboard } = await import('./native/clipboard')
  const { installFullscreen, installPip } = await import('./native/pip')
  installClipboard()
  installFullscreen()
  installPip()

  const app = createApp(App)
  const pinia = createPinia()
  app.use(pinia)

  app.use(router)
  app.mount('#app')

  // 与 APK 一致：数据初始化在 App.vue 的 onMounted 里（设置→登录态→本地数据），
  // 这里挂载后立刻接管返回键，不阻塞首屏。
  installBackButton()
}

/** 安卓返回键：先关弹窗 → 退出全屏 → 退剧场 → 路由后退 → 最小化 */
async function installBackButton() {
  let AppPlugin: any = null
  try {
    const mod = await import('@capacitor/app')
    AppPlugin = mod.App
  } catch (e: any) {
    console.warn('[mobile] @capacitor/app 不可用，跳过返回键接管：', e && e.message)
    return
  }
  if (!AppPlugin || typeof AppPlugin.addListener !== 'function') return

  AppPlugin.addListener('backButton', () => {
    let ui: any = null
    try {
      ui = useUiStore()
    } catch {
      ui = null
    }
    if (ui) {
      if (ui.loginOpen) {
        ui.loginOpen = false
        return
      }
      if (ui.confirmState && ui.confirmState.open) {
        ui.answerConfirm(false)
        return
      }
    }
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
      return
    }
    if (document.querySelector('.app.theater')) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      return
    }
    if (window.history.state && window.history.state.back) {
      router.back()
      return
    }
    AppPlugin.minimizeApp().catch(() => AppPlugin.exitApp())
  })
}

boot().catch((e) => {
  console.error('[mobile] 渲染层启动失败:', e)
  const root = document.getElementById('app')
  if (root) {
    root.innerHTML =
      '<div style="padding:32px;font:14px/1.7 system-ui;color:#f3f3f4;background:#0a0a0b;height:100%"><h2 style="margin:0 0 12px">BiliLite 启动失败</h2><pre style="white-space:pre-wrap;color:#ff9b9b">' +
      String((e && e.stack) || e) +
      '</pre></div>'
  }
})
