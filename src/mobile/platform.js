/**
 * 安卓平台能力适配层（渲染层无感：不改 `src/renderer/**`，只在 window / document 上打补丁）。
 *
 * 补齐的是目标里点名的四项平台能力：
 * 1. **剪贴板**：渲染层用的是 `navigator.clipboard.writeText`（`LearnView.vue` 导出 JSON、
 *    `VideoView.vue` 复制 BV 号）。WebView 里这个 API 需要用户手势 + 焦点，失败率不低，
 *    所以这里换成 Capacitor 原生剪贴板；原生不可用（浏览器预览）时回退原实现。
 * 2. **全屏**：渲染层用 Fullscreen API（`VideoView.vue` 的 `requestFullscreen()`）。
 *    WebView 只能把它变成「整页铺满」，不会隐藏状态栏、也不会转横屏。这里监听
 *    fullscreenchange，进全屏时隐藏状态栏 + 锁横屏，退出时还原。
 * 3. **画中画**：全局监听 `<video>` 的 play/pause（捕获阶段，不必改播放器代码），把
 *    「在播 + 视频区域」汇报给原生 PipPlugin；按 Home 键时由
 *    `MainActivity.onUserLeaveHint()` 真正进入小窗。
 * 4. **返回键**：在 `src/mobile/main.js` 的 wireAndroidBack() 里，因为它要改路由。
 *
 * 所有原生调用都包了 try/catch —— 桌面预览（Electron 里跑这份 mobile bundle）或者
 * 浏览器里跑时，Capacitor 的 web 实现会 reject，这里静默跳过，不影响渲染层。
 */

import { registerPlugin } from '@capacitor/core'
import { Clipboard } from '@capacitor/clipboard'
import { StatusBar } from '@capacitor/status-bar'
import { ScreenOrientation } from '@capacitor/screen-orientation'

const Pip = registerPlugin('Pip')

/**
 * 把 navigator.clipboard 换成原生实现（保留原实现做兜底）。
 */
function installClipboard() {
  const original = navigator.clipboard
  const origWrite = original && original.writeText ? original.writeText.bind(original) : null

  const writeText = (text) => {
    const value = String(text == null ? '' : text)
    return Clipboard.write({ string: value }).catch((err) => {
      if (origWrite) return origWrite(value)
      throw err
    })
  }

  const shim = {
    writeText,
    readText: () => Clipboard.read().then((res) => (res && res.value) || '')
  }
  // 给 shim 打个标记，方便自动化验证「装的是原生版而不是浏览器原实现」
  try {
    Object.defineProperty(shim, '__bililite', { value: 'native-clipboard', enumerable: false })
  } catch {
    /* 忽略 */
  }

  // navigator.clipboard 在 Chromium 里是 Navigator.prototype 上的 getter，
  // 先试着在实例上盖一个自有属性，不行再改原型。
  try {
    Object.defineProperty(navigator, 'clipboard', { value: shim, configurable: true })
    return
  } catch {
    /* 掉到下面走原型 */
  }
  try {
    const proto = Object.getPrototypeOf(navigator)
    Object.defineProperty(proto, 'clipboard', { get: () => shim, configurable: true })
  } catch {
    /* 实在改不了就算了，渲染层还有原实现可用 */
  }
}

/**
 * 全屏时隐藏状态栏 + 锁横屏。
 */
function installFullscreen() {
  document.addEventListener('fullscreenchange', async () => {
    const on = Boolean(document.fullscreenElement)
    document.documentElement.dataset.fullscreen = on ? '1' : '0'
    try {
      if (on) await StatusBar.hide()
      else await StatusBar.show()
    } catch {
      /* 预览环境 / 系统不支持 */
    }
    try {
      if (on) await ScreenOrientation.lock({ orientation: 'landscape' })
      else await ScreenOrientation.unlock()
    } catch {
      /* 平板上部分系统会忽略方向锁定，忽略即可 */
    }
  })
}

/**
 * 画中画：只汇报状态和几何，进入时机交给原生。
 */
function installPip() {
  let playing = false

  const geometry = () => {
    const video = document.querySelector('video')
    if (!video) return null
    const r = video.getBoundingClientRect()
    if (!r || r.width <= 0 || r.height <= 0) return null
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  }

  const report = (next) => {
    playing = next
    // 便于自动化验证与排查（渲染层不读这个属性）
    document.documentElement.dataset.pip = next ? '1' : '0'
    const payload = { playing }
    const geo = geometry()
    if (geo) Object.assign(payload, geo)
    Pip.setPlaying(payload).catch(() => {
      /* 浏览器预览没有原生插件 */
    })
  }

  // 捕获阶段监听，<video> 是播放器内部创建的，拿不到它的引用
  document.addEventListener(
    'play',
    (e) => {
      if (e.target && e.target.tagName === 'VIDEO') report(true)
    },
    true
  )
  const stop = (e) => {
    if (e.target && e.target.tagName === 'VIDEO') report(false)
  }
  document.addEventListener('pause', stop, true)
  document.addEventListener('ended', stop, true)

  // 转屏 / 全屏切换后视频区域会变，重新量一次（不影响播放状态）
  const remeasure = () => {
    if (!playing) return
    const geo = geometry()
    if (geo) Pip.setGeometry(geo).catch(() => {})
  }
  window.addEventListener('resize', remeasure, { passive: true })
  window.addEventListener('orientationchange', remeasure, { passive: true })
  document.addEventListener('fullscreenchange', remeasure)
}

/** 装齐所有 shim；只应在安卓（或桌面预览）路径下调用。 */
export function installPlatformShims() {
  installClipboard()
  installFullscreen()
  installPip()
}

export default installPlatformShims
