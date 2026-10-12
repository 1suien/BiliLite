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

/**
 * 品牌色预设：只用于标记「当前位置 / 进度 / 焦点」——侧栏选中、分P 选中、焦点环、进度环。
 * 默认的 mono 是纯白/近黑，本身不带色彩信息，选中态只能靠底色深浅区分（浅色主题下几乎看不见），
 * 因此给它一个中性的蓝；选了青/蓝/紫/橙/绿的用户则沿用自己那一套色相。
 */
export const BRAND_PRESETS = {
  mono: { dark: '#4aa8ff', light: '#0f6fd1' },
  cyan: { dark: '#5ad1c8', light: '#0f766e' },
  blue: { dark: '#6ea8fe', light: '#1d4ed8' },
  purple: { dark: '#b39ddb', light: '#6d28d9' },
  orange: { dark: '#f0a868', light: '#b45309' },
  green: { dark: '#7fd68a', light: '#15803d' }
}

/**
 * 专注目标的色板：每个目标一个色相，渲染成列表左边那个「色块 + 名字首字」的圆标。
 * 存的是色相 key（不是 hex），这样深/浅两套主题各取各的值，和侧栏/品牌色一套做法。
 * 不用 emoji 当图标：Windows 上 emoji 一律是彩色的，跟黑白极简的基调打架。
 */
export const TARGET_COLORS = {
  blue: { label: '蓝', dark: '#4aa8ff', light: '#0f6fd1' },
  cyan: { label: '青', dark: '#5ad1c8', light: '#0f766e' },
  purple: { label: '紫', dark: '#b39ddb', light: '#6d28d9' },
  orange: { label: '橙', dark: '#f0a868', light: '#b45309' },
  green: { label: '绿', dark: '#7fd68a', light: '#15803d' },
  rose: { label: '玫', dark: '#f48fb1', light: '#be185d' }
}
export const TARGET_COLOR_KEYS = Object.keys(TARGET_COLORS)
/** 默认的四个目标（老版本 focusTasks 的出厂值，迁移时用） */
export const DEFAULT_FOCUS_TARGETS = ['阅读', '刷题', '看课', '整理笔记']

/** 色相 key + 主题 → 具体 hex；key 不认识就回落到第一个色相 */
export function targetHex(key, theme) {
  const c = TARGET_COLORS[key] || TARGET_COLORS[TARGET_COLOR_KEYS[0]]
  return theme === 'light' ? c.light : c.dark
}

/** 造一个目标条目；i 只用来轮着分配颜色 */
export function makeFocusTarget(name, i = 0) {
  return {
    name: String(name || '').trim(),
    color: TARGET_COLOR_KEYS[i % TARGET_COLOR_KEYS.length],
    archived: false,
    createdAt: Date.now()
  }
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

/**
 * 品牌色实心底（选中态胶囊、当前页码）上该用什么颜色的字。
 * 阈值比 readableFg 低：品牌色是一块「实心填充」，字要比按钮上的强调色更耐受一点；
 * 0.45 这档刚好让深色主题的 #4aa8ff 落到近黑字（白字只有 2.1:1）、
 * 浅色主题的 #0f6fd1 落到白字。
 */
export function brandFg(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim())
  if (!m) return '#06121f'
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.45 ? '#06121f' : '#ffffff'
}

/** #rrggbb → rgba(r, g, b, a)：给 --brand 派生浅底 / 描边 / 焦点环 */
function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim())
  if (!m) return `rgba(15, 111, 209, ${alpha})`
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
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
      autoHideCtl: true,
      /** 侧栏顺序：拖拽调整后存这里（路由路径数组；空 = 默认顺序） */
      navOrder: [],
      /** 字幕：自动开启在线字幕 */
      subAuto: false,
      /** 字幕显示：字号 px / 背景遮罩 / 距舞台底部百分比 */
      subFontSize: 22,
      subBg: true,
      subBottom: 8,
      /** 专注弹层里的快捷任务（可自定义；空数组 = 用代码里的默认四个） */
      focusTasks: ['阅读', '刷题', '看课', '整理笔记'],
      /**
       * 专注目标（学习页「专注」左栏那份列表）：{ name, color, archived, createdAt }。
       * 和 focusTasks 是同一份东西的两个视图 —— focusTasks 只是名字数组，历史包袱；
       * 每次保存目标都会把没有归档的名字同步回 focusTasks（见 setFocusTargets）。
       */
      focusTargets: []
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
      // 品牌色跟着强调色走：选中态/焦点环要有一致的色彩信号
      const brand = a.startsWith('#')
        ? a
        : ((BRAND_PRESETS[a] || BRAND_PRESETS.mono)[theme] || BRAND_PRESETS.mono[theme])
      const style = document.documentElement.style
      style.setProperty('--brand', brand)
      style.setProperty('--brand-soft', hexToRgba(brand, theme === 'light' ? 0.1 : 0.16))
      style.setProperty('--brand-line', hexToRgba(brand, theme === 'light' ? 0.3 : 0.38))
      style.setProperty('--brand-fg', brandFg(brand))
      style.setProperty('--ring', hexToRgba(brand, theme === 'light' ? 0.38 : 0.45))
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
      // 迁移：老版本只有 focusTasks（一串名字），第一次进设置时升级成 focusTargets
      // （带颜色 / 归档 / 创建时间）。已经有的用户不动，只补空的那一边。
      if (!Array.isArray(this.settings.focusTargets) || !this.settings.focusTargets.length) {
        const src =
          Array.isArray(this.settings.focusTasks) && this.settings.focusTasks.length
            ? this.settings.focusTasks
            : DEFAULT_FOCUS_TARGETS
        const list = src.map((n, i) => makeFocusTarget(n, i)).filter((t) => t.name)
        if (list.length) await this.setFocusTargets(list)
      }
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
    },

    /**
     * 保存专注目标列表。顺带把「没归档的名字」同步进 focusTasks ——
     * 弹层里的快捷任务 chips 用的还是那个旧字段，两边不能各说各话。
     */
    async setFocusTargets(list) {
      const clean = (Array.isArray(list) ? list : [])
        .map((t) => ({
          name: String((t && t.name) || '')
            .trim()
            .slice(0, 12),
          color: TARGET_COLORS[t && t.color] ? t.color : TARGET_COLOR_KEYS[0],
          archived: Boolean(t && t.archived),
          createdAt: Number(t && t.createdAt) || Date.now()
        }))
        .filter((t) => t.name)
        .slice(0, 24)
      await this.patch({
        focusTargets: clean,
        focusTasks: clean
          .filter((t) => !t.archived)
          .map((t) => t.name)
          .slice(0, 8)
      })
      return clean
    }
  }
})
