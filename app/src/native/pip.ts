/**
 * 全屏 / 沉浸式 / 横屏锁定 / 画中画
 * 还原自 index-jTHZJced.js 里的 installFullscreen() 与 installPip()
 */
import { ScreenOrientation } from '@capacitor/screen-orientation'
import { StatusBar } from '@capacitor/status-bar'
import { Immersive, Pip } from './plugins'

export function installFullscreen() {
  document.addEventListener('fullscreenchange', async () => {
    const on = !!document.fullscreenElement
    // CSS 里用 html[data-fullscreen="1"] 收起导航/边框
    document.documentElement.dataset.fullscreen = on ? '1' : '0'
    try {
      await Immersive.setImmersive({ on })
    } catch {}
    try {
      if (on) await StatusBar.hide()
      else await StatusBar.show()
    } catch {}
    try {
      if (on) await ScreenOrientation.lock({ orientation: 'landscape' })
      else await ScreenOrientation.unlock()
    } catch {}
  })
}

/**
 * 画中画：监听页面里 <video> 的播放/暂停，把状态与画面矩形同步给原生，
 * 由原生 PiP 窗口接管（安卓 8.0+）。
 */
export function installPip() {
  let playing = false

  const rectOf = () => {
    const video = document.querySelector('video')
    if (!video) return null
    const r = video.getBoundingClientRect()
    if (!r || r.width <= 0 || r.height <= 0) return null
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  }

  const sync = (state: boolean) => {
    playing = state
    document.documentElement.dataset.pip = state ? '1' : '0'
    const payload: any = { playing }
    const rect = rectOf()
    if (rect) Object.assign(payload, rect)
    Pip.setPlaying(payload).catch(() => {})
  }

  document.addEventListener(
    'play',
    (e: any) => {
      if (e.target && e.target.tagName === 'VIDEO') sync(true)
    },
    true,
  )

  const stop = (e: any) => {
    if (e.target && e.target.tagName === 'VIDEO') sync(false)
  }
  document.addEventListener('pause', stop, true)
  document.addEventListener('ended', stop, true)

  const onLayout = () => {
    if (!playing) return
    const rect = rectOf()
    if (rect) Pip.setGeometry(rect).catch(() => {})
  }
  window.addEventListener('resize', onLayout, { passive: true })
  window.addEventListener('orientationchange', onLayout, { passive: true })
  document.addEventListener('fullscreenchange', onLayout)
}
