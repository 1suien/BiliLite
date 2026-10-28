/**
 * 设置与主题（深/浅色、强调色、播放器/字幕/导航等偏好）
 * 还原自 settings-pVrVExzx.js
 */
import { defineStore } from 'pinia'
import { bili } from '@/bridge'
import type { FocusTarget, Settings } from '@/types'

/** 强调色（--accent）：用于按钮/选中态的主色 */
export const ACCENTS: Record<string, { label: string; dark: string; light: string }> = {
  mono: { label: '纯白', dark: '#ffffff', light: '#17171a' },
  cyan: { label: '青', dark: '#5ad1c8', light: '#0f766e' },
  blue: { label: '蓝', dark: '#6ea8fe', light: '#1d4ed8' },
  purple: { label: '紫', dark: '#b39ddb', light: '#6d28d9' },
  orange: { label: '橙', dark: '#f0a868', light: '#b45309' },
  green: { label: '绿', dark: '#7fd68a', light: '#15803d' },
}

/** 品牌色（--brand）：用于进度条/链接/图表 */
export const BRANDS: Record<string, { dark: string; light: string }> = {
  mono: { dark: '#4aa8ff', light: '#0f6fd1' },
  cyan: { dark: '#5ad1c8', light: '#0f766e' },
  blue: { dark: '#6ea8fe', light: '#1d4ed8' },
  purple: { dark: '#b39ddb', light: '#6d28d9' },
  orange: { dark: '#f0a868', light: '#b45309' },
  green: { dark: '#7fd68a', light: '#15803d' },
}

/** 专注目标可选颜色 */
export const FOCUS_COLORS: Record<string, { label: string; dark: string; light: string }> = {
  blue: { label: '蓝', dark: '#4aa8ff', light: '#0f6fd1' },
  cyan: { label: '青', dark: '#5ad1c8', light: '#0f766e' },
  purple: { label: '紫', dark: '#b39ddb', light: '#6d28d9' },
  orange: { label: '橙', dark: '#f0a868', light: '#b45309' },
  green: { label: '绿', dark: '#7fd68a', light: '#15803d' },
  rose: { label: '玫', dark: '#f48fb1', light: '#be185d' },
}

export const FOCUS_COLOR_KEYS = Object.keys(FOCUS_COLORS)

/** 默认的专注任务：本机构建 0.4.10 起不再「自带」目标，列表由用户自己加 */
export const DEFAULT_FOCUS_TASKS: string[] = []

/** 主题 -> 颜色值 */
export function accentColor(key: string, theme: string): string {
  const item = FOCUS_COLORS[key] || FOCUS_COLORS[FOCUS_COLOR_KEYS[0]]
  return theme === 'light' ? item.light : item.dark
}

/** 新建专注目标 */
export function makeFocusTarget(name: any, index = 0): FocusTarget {
  return {
    name: String(name || '').trim(),
    color: FOCUS_COLOR_KEYS[index % FOCUS_COLOR_KEYS.length],
    archived: false,
    createdAt: Date.now(),
  }
}

function parseHex(color: any): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(color).trim())
  if (!m) return null
  const v = parseInt(m[1], 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

/** 在指定底色上应该用黑字还是白字（用于 --accent-fg） */
export function pickAccentFg(color: any): string {
  const rgb = parseHex(color)
  if (!rgb) return '#0a0a0b'
  const luma = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255
  return luma > 0.6 ? '#0a0a0b' : '#ffffff'
}

/** 品牌色上的前景色（对比度更宽容：0.45 阈值） */
export function pickBrandFg(color: any): string {
  const rgb = parseHex(color)
  if (!rgb) return '#06121f'
  const luma = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255
  return luma > 0.45 ? '#06121f' : '#ffffff'
}

/** #rrggbb -> rgba(r,g,b,a) */
export function withAlpha(color: any, alpha: number): string {
  const rgb = parseHex(color)
  if (!rgb) return `rgba(15, 111, 209, ${alpha})`
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`
}

/** 与原生侧一致的默认设置 */
export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  accent: 'mono',
  defaultQuality: 80,
  autoNext: true,
  seekStep: 5,
  backupPath: '',
  playerVolume: 0.8,
  hideDanmakuArea: true,
  autoMark: true,
  autoCheckin: true,
  playbackRate: 1,
  danmakuOn: true,
  danmakuOpacity: 0.9,
  danmakuArea: 1,
  autoHideCtl: true,
  navOrder: [],
  subAuto: false,
  subFontSize: 22,
  subBg: true,
  subBottom: 8,
  focusTasks: [],
  focusTargets: [],
}

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    loaded: false,
    settings: { ...DEFAULT_SETTINGS } as Settings,
  }),
  actions: {
    /** 把主题变量写到 <html> 上（CSS 里全部走 var(--xxx)） */
    applyTheme() {
      const theme = this.settings.theme === 'light' ? 'light' : 'dark'
      document.documentElement.dataset.theme = theme

      const accentKey = String(this.settings.accent || 'mono')
      const accent = accentKey.startsWith('#') ? accentKey : (ACCENTS[accentKey] || ACCENTS.mono)[theme] || ACCENTS.mono[theme]
      document.documentElement.style.setProperty('--accent', accent)
      document.documentElement.style.setProperty('--accent-fg', pickAccentFg(accent))

      const brand = accentKey.startsWith('#') ? accentKey : (BRANDS[accentKey] || BRANDS.mono)[theme] || BRANDS.mono[theme]
      const root = document.documentElement.style
      root.setProperty('--brand', brand)
      root.setProperty('--brand-soft', withAlpha(brand, theme === 'light' ? 0.1 : 0.16))
      root.setProperty('--brand-line', withAlpha(brand, theme === 'light' ? 0.3 : 0.38))
      root.setProperty('--brand-fg', pickBrandFg(brand))
      root.setProperty('--ring', withAlpha(brand, theme === 'light' ? 0.38 : 0.45))
    },
    async init() {
      if (this.loaded) return
      try {
        const remote = await bili.settings.get()
        if (remote && typeof remote === 'object') {
          this.settings = { ...this.settings, ...remote }
        }
      } catch {}
      this.applyTheme()
      // 本机构建 0.4.10：不再自动创建「自带的目标」（阅读 / 刷题 / 看课 / 整理笔记）。
      // 旧版本首次启动会把这四个预设写成目标列表，升级后一次性清掉；
      // 之后不会再执行（focusPresetsCleared 一旦为 true 就跳过），用户自己加的目标不受影响。
      if (!this.settings.focusPresetsCleared) {
        const legacy = ['阅读', '刷题', '看课', '整理笔记']
        const list = Array.isArray(this.settings.focusTargets) ? this.settings.focusTargets : []
        const names = list.map((t: any) => String((t && t.name) || '').trim())
        const isLegacyPresets =
          names.length === legacy.length && names.every((n: string) => legacy.includes(n))
        if (isLegacyPresets) await this.setFocusTargets([])
        await this.patch({ focusPresetsCleared: true })
      }
      this.loaded = true
    },
    async patch(patch: Partial<Settings>) {
      this.settings = { ...this.settings, ...patch }
      this.applyTheme()
      try {
        const next = await bili.settings.patch(patch)
        if (next && typeof next === 'object') this.settings = { ...this.settings, ...next }
      } catch {}
    },
    /** 规范化并保存专注目标（最多 24 个，focusTasks 最多 8 个） */
    async setFocusTargets(list: FocusTarget[]) {
      const targets = (Array.isArray(list) ? list : [])
        .map((t: any) => {
          // 本机构建 0.4.12：一个目标可以设多个提醒时间（每天重复）
          const reminders = (Array.isArray(t && t.reminders) ? t.reminders : [])
            .map((x: any) => String(x || '').trim())
            .filter((x: string) => /^\d{2}:\d{2}$/.test(x))
          const times = [...new Set(reminders)].sort().slice(0, 8)
          return {
            name: String((t && t.name) || '').trim().slice(0, 12),
            color: FOCUS_COLORS[t && t.color] ? t.color : FOCUS_COLOR_KEYS[0],
            archived: !!(t && t.archived),
            createdAt: Number(t && t.createdAt) || Date.now(),
            ...(times.length ? { reminders: times } : {}),
          }
        })
        .filter((t) => t.name)
        .slice(0, 24)
      await this.patch({
        focusTargets: targets,
        focusTasks: targets.filter((t) => !t.archived).map((t) => t.name).slice(0, 8),
      })
      return targets
    },
    /** 设置某个专注目标的多提醒时间（本机构建 0.4.12） */
    async setTargetReminders(name: string, times: string[]) {
      const key = String(name || '').trim()
      if (!key) return false
      const list = Array.isArray(this.settings.focusTargets) ? [...this.settings.focusTargets] : []
      const idx = list.findIndex((t: any) => String(t && t.name) === key)
      if (idx < 0) return false
      const clean = [...new Set((Array.isArray(times) ? times : [])
        .map((x: any) => String(x || '').trim())
        .filter((x: string) => /^\d{2}:\d{2}$/.test(x)))].sort().slice(0, 8)
      list[idx] = { ...list[idx], ...(clean.length ? { reminders: clean } : { reminders: [] }) } as any
      await this.setFocusTargets(list)
      return true
    },
  },
})
