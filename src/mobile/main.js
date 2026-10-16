/**
 * 安卓端入口。
 *
 * 顺序很关键：`src/renderer/src/api/index.js` 在**模块顶层**就读了 `window.bili`，
 * 所以桥接层必须在它被求值之前装好 —— 因此渲染层入口用动态 `import()` 延后加载，
 * 而不是静态 import（静态 import 会被提升到桥接代码之前执行）。
 * 存储换成原生 Preferences 后 `installBridge()` 变成异步（要等真实设置/登录态读出来
 * 再挂载渲染层，否则会先闪一下默认主题和「未登录」）。
 *
 * 这里不用顶层 await —— vite 的构建目标是 es2020，esbuild 在 es2020 下会拒绝 TLA。
 */

import { installBridge } from './bridge.js'
import { installPlatformShims } from './platform.js'
import './mobile.css'

/** 渲染层/样式里可以据此判断「这是安卓端」（桌面端没有这个属性） */
document.documentElement.dataset.platform = 'android'

/**
 * 桌面端 Electron 预览用的逃生口：把 `mobile/www` 丢进带 preload 的桌面窗口里，
 * 用 1047×654 的平板视口核对布局时，窗口上已经有一个**能连真实接口**的桌面桥
 * （`window.bili` 来自 preload）。这时候不能再让安卓桥覆盖它，否则预览页既拿不到
 * 数据、也看不到真实内容。安卓真机上 `window.bili` 一定是 undefined，所以照常安装。
 */
const hasDesktopBridge = typeof window !== 'undefined' && !!window.bili && window.bili.platform !== 'android'

async function boot() {
  if (hasDesktopBridge) {
    console.info('[mobile] 检测到桌面桥，跳过安卓桥安装（仅用于桌面预览平板布局）')
  } else {
    await installBridge()
  }

  // 剪贴板 / 全屏 / 画中画这几项平台能力做成 shim，渲染层完全不用改。
  // 桌面预览时 Capacitor 的 web 实现会 reject，shim 内部已兜住，不影响预览。
  installPlatformShims()

  await import('../renderer/src/main.js')
  await wireAndroidBack()
}

boot().catch((err) => {
  // 这一步失败就是白屏，把原因直接画到页面上，省得只能靠 logcat 猜
  console.error('[mobile] 渲染层启动失败:', err)
  const el = document.getElementById('app')
  if (el) {
    el.innerHTML =
      '<div style="padding:32px;font:14px/1.7 system-ui;color:#f3f3f4;background:#0a0a0b;height:100%">' +
      '<h2 style="margin:0 0 12px">BiliLite 启动失败</h2>' +
      '<pre style="white-space:pre-wrap;color:#ff9b9b">' +
      String((err && err.stack) || err) +
      '</pre></div>'
  }
})

/**
 * 安卓物理返回键 / 返回手势。
 *
 * 默认行为是「WebView 历史里没得退了就直接退出 App」，用起来很突兀：
 * 弹层开着的时候按返回应该先关弹层，在首页按返回应该收到后台。
 * 所以这里按优先级接管：登录弹层 → 确认框 → 全屏 → 剧场模式 → 路由历史 → 收进后台。
 */
async function wireAndroidBack() {
  let App = null
  try {
    App = (await import('@capacitor/app')).App
  } catch (err) {
    console.warn('[mobile] @capacitor/app 不可用，跳过返回键接管：', err && err.message)
    return
  }
  if (!App || typeof App.addListener !== 'function') return

  const [{ default: router }, { useUiStore }] = await Promise.all([
    import('../renderer/src/router.js'),
    import('../renderer/src/stores/ui.js')
  ])

  App.addListener('backButton', () => {
    let ui = null
    try {
      ui = useUiStore() // app.use(pinia) 之后 pinia 已是 active，可以直接取
    } catch (err) {
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
    // 全屏播着的时候，返回键先退全屏（系统全屏不吃 Escape）
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
      return
    }
    // 剧场模式开着的时候先退剧场模式（App.vue 的 Escape 处理器负责）
    const theaterOn = document.querySelector('.app.theater')
    if (theaterOn) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      return
    }
    // hash 路由下 window.history.state.back 就是上一页；首页时它是 null
    const back = window.history.state && window.history.state.back
    if (back) {
      router.back()
      return
    }
    // 已经在首页：收到后台，而不是直接杀掉进程（和主流安卓 App 一致）
    App.minimizeApp().catch(() => App.exitApp())
  })
}
