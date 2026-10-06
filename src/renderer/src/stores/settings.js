import { defineStore } from 'pinia'
import api from '../api'

/** 强调色预设：名字 → 深色/浅色两套取值 */
export const ACCENT_PRESETS = {
  mono: { label: '纯白', dark: '#ffffff', light: '#17171a' },
  cyan: { label: '青', dark: '#5ad1c8', light: '#0f766e' },
  blue: { label: '蓝', dark: '#6ea8fe', light: '#1d4ed8' },
  purple: { label: '紫', dark: '#b39ddb', light: '#6d28d9' },
  orange: { label: '橙', dark: '#f0a868', light: '#b45309' },
  green: { label: '绿', dark: '#7fd68a', light: '#15803d' }
}

/** 用相对亮度决定强调色上的文字用黑还是白 */
function readableFg(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim())
  if (!m) return '#0a0a0b'
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.6 ? '#0a0a0b' : '#ffffff'
}

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    loaded: false,
    settings: {
      theme: 'dark',
      accent: 'mono',
      defaultQuality: 80,
      autoNext: true,
      seekStep: 5,
      backupPath: '',
      playerVolume: 0.8,
      hideDanmakuArea: true,
      autoMark: true,
      /** 播放超过 5 分钟后自动打卡 */
      autoCheckin: true,
      /** 播放器：倍速 */
      playbackRate: 1,
      /** 播放器：弹幕开关 / 不透明度 / 显示区域（1 全屏、0.5 半屏、0.25 顶部四分之一） */
      danmakuOn: true,
      danmakuOpacity: 0.9,
      danmakuArea: 1,
      /** 播放器：鼠标不动时自动隐藏控制栏 */
      autoHideCtl: true
    }
  }),
  actions: {
    applyTheme() {
      const theme = this.settings.theme === 'light' ? 'light' : 'dark'
      document.documentElement.dataset.theme = theme
      const a = String(this.settings.accent || 'mono')
      const hex = a.startsWith('#')
        ? a
        : ((ACCENT_PRESETS[a] || ACCENT_PRESETS.mono)[theme] || ACCENT_PRESETS.mono[theme])
      document.documentElement.style.setProperty('--accent', hex)
      document.documentElement.style.setProperty('--accent-fg', readableFg(hex))
    },
    async init() {
      if (this.loaded) return
      try {
        const s = await api.settings.get()
        if (s && typeof s === 'object') this.settings = { ...this.settings, ...s }
      } catch {
        /* 设置读不到就用默认值，不阻塞启动 */
      }
      this.applyTheme()
      this.loaded = true
    },
    async patch(patch) {
      this.settings = { ...this.settings, ...patch }
      this.applyTheme()
      try {
        const s = await api.settings.patch(patch)
        if (s && typeof s === 'object') this.settings = { ...this.settings, ...s }
      } catch {
        /* 落盘失败时保持内存值 */
      }
    }
  }
})
