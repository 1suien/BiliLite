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

/** 自定义主题里能改的 7 个颜色；其余令牌由 buildThemeVars 从它们推出来（或继承基底深浅主题） */
export const THEME_COLORS = [
  { key: 'bg', label: '背景', dark: '#0a0a0b', light: '#f6f6f7' },
  { key: 'card', label: '卡片', dark: '#141416', light: '#ffffff' },
  { key: 'soft', label: '次级底色', dark: '#1c1d21', light: '#ececef' },
  { key: 'line', label: '边框线', dark: '#26272c', light: '#e2e2e6' },
  { key: 't1', label: '主文字', dark: '#f3f3f4', light: '#17171a' },
  { key: 't2', label: '次文字', dark: '#9b9ba4', light: '#5f5f68' },
  { key: 'accent', label: '强调色', dark: '#ffffff', light: '#17171a' }
]

/** 主题套装名字上限（和专注快捷任务一样短） */
export const THEME_NAME_MAX = 12

const HEX_RE = /^#?[0-9a-fA-F]{6}$/

/** 把用户填的色值收敛成 #rrggbb；不合法的用 fallback */
function normHex(v, fallback) {
  const s = String(v == null ? '' : v).trim()
  if (!HEX_RE.test(s)) return fallback
  return s.startsWith('#') ? s.toLowerCase() : `#${s.toLowerCase()}`
}

function rgb(hex) {
  const n = parseInt(normHex(hex, '#000000').slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** 线性混合：t=0 取 a、t=1 取 b（用来派生 hover / 强边框 / 三级文字这些令牌） */
function mix(a, b, t) {
  const A = rgb(a)
  const B = rgb(b)
  const to = (i) => Math.round(A[i] + (B[i] - A[i]) * t)
  return `#${[to(0), to(1), to(2)].map((x) => x.toString(16).padStart(2, '0')).join('')}`
}

function luminance(hex) {
  const [r, g, b] = rgb(hex)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

/** 用相对亮度决定强调色上的文字用黑还是白 */
function readableFg(hex) {
  return luminance(normHex(hex, '#ffffff')) > 0.6 ? '#0a0a0b' : '#ffffff'
}

/** 基底主题（深/浅）里那 7 个颜色的默认值 —— 启用自定义主题时的初始值 */
export function defaultThemeColors(theme) {
  const t = theme === 'light' ? 'light' : 'dark'
  const out = {}
  for (const c of THEME_COLORS) out[c.key] = c[t]
  return out
}

/** 界面上色块/输入框该显示的值（缺的键回落到基底主题） */
export function themeColorValue(custom, key, theme) {
  const base = defaultThemeColors(theme)
  return normHex(custom && custom[key], base[key] || '#000000')
}

/**
 * 把用户选的 7 个颜色展开成一整套 CSS 变量。
 * hover / 三级文字 / 强边框 / 骨架屏这些不单独让用户填，按基底亮度混出来，
 * 这样「只改几个色」也不会出现配色打架（比如深色 hover 配在浅色背景上）。
 */
export function buildThemeVars(colors, theme) {
  const base = defaultThemeColors(theme)
  const c = {}
  for (const k of Object.keys(base)) c[k] = normHex(colors && colors[k], base[k])
  return {
    '--bg': c.bg,
    '--bg-elev': mix(c.bg, c.card, 0.6),
    '--card': c.card,
    '--card-hover': mix(c.card, c.t1, 0.07),
    '--soft': c.soft,
    '--soft-hover': mix(c.soft, c.t1, 0.08),
    '--line': c.line,
    '--line-strong': mix(c.line, c.t1, 0.28),
    '--t1': c.t1,
    '--t2': c.t2,
    '--t3': mix(c.t2, c.bg, 0.3),
    '--link': c.accent,
    '--block': c.bg,
    '--skeleton': `linear-gradient(90deg, ${c.soft} 25%, ${mix(c.soft, c.bg, 0.55)} 37%, ${c.soft} 63%)`,
    '--accent': c.accent,
    '--accent-fg': readableFg(c.accent)
  }
}

/** 自定义主题写进 <html> 的内联变量名：关掉自定义时要逐个清掉，否则旧颜色还留在页面上 */
export const CUSTOM_VAR_KEYS = Object.keys(buildThemeVars(defaultThemeColors('dark'), 'dark'))

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
      /** 自定义主题：是否启用 / 当前这 7 个颜色 / 存下来的套装 / 正在套用的套装 id */
      themeOn: false,
      themeCustom: {},
      themeSets: [],
      themeSetId: ''
    }
  }),
  actions: {
    applyTheme() {
      const root = document.documentElement
      const theme = this.settings.theme === 'light' ? 'light' : 'dark'
      root.dataset.theme = theme
      // 先清掉上一轮自定义写进去的内联变量：否则关掉自定义主题后旧颜色还留着
      for (const k of CUSTOM_VAR_KEYS) root.style.removeProperty(k)
      if (this.settings.themeOn === true) {
        const vars = buildThemeVars(this.settings.themeCustom, theme)
        for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
        return // 强调色也在 vars 里，不用再走下面的预设逻辑
      }
      const a = String(this.settings.accent || 'mono')
      const hex = a.startsWith('#')
        ? a
        : ((ACCENT_PRESETS[a] || ACCENT_PRESETS.mono)[theme] || ACCENT_PRESETS.mono[theme])
      root.style.setProperty('--accent', hex)
      root.style.setProperty('--accent-fg', readableFg(hex))
    },
    /** 打开自定义主题：第一次进来用基底主题的 7 个颜色打底 */
    async enableCustomTheme() {
      const cur = this.settings.themeCustom || {}
      const colors = Object.keys(cur).length ? { ...cur } : defaultThemeColors(this.settings.theme)
      await this.patch({ themeOn: true, themeCustom: colors })
    },
    /** 关掉自定义主题，回到内置深浅 + 强调色预设 */
    async resetCustomTheme() {
      await this.patch({ themeOn: false, themeSetId: '' })
    },
    /** 拖取色器时的实时预览：只改内存与 CSS，不落盘（松手时再 saveThemeColors） */
    previewThemeColor(key, value) {
      if (!key) return
      const base = defaultThemeColors(this.settings.theme)
      const hex = normHex(value, base[key] || '#000000')
      this.settings = { ...this.settings, themeCustom: { ...(this.settings.themeCustom || {}), [key]: hex } }
      this.applyTheme()
    },
    /** 输入框里改色：合法就立刻生效并落盘 */
    async setThemeColor(key, value) {
      const base = defaultThemeColors(this.settings.theme)
      if (!HEX_RE.test(String(value == null ? '' : value).trim())) return false
      const hex = normHex(value, base[key] || '#000000')
      await this.patch({ themeOn: true, themeCustom: { ...(this.settings.themeCustom || {}), [key]: hex } })
      return true
    },
    /** 把当前这 7 个颜色落盘（取色器 change 时调） */
    async saveThemeColors() {
      await this.patch({ themeCustom: { ...(this.settings.themeCustom || {}) } })
    },
    /** 存成一套命名主题；同名覆盖 */
    async saveThemeSet(name) {
      const nm = String(name == null ? '' : name).trim().slice(0, THEME_NAME_MAX)
      if (!nm) return false
      const id = `th${Date.now().toString(36)}`
      const sets = (this.settings.themeSets || []).filter((s) => s && s.name !== nm)
      sets.push({ id, name: nm, colors: { ...(this.settings.themeCustom || {}) } })
      await this.patch({ themeSets: sets, themeSetId: id, themeOn: true })
      return true
    },
    /** 套用一套存好的主题 */
    async applyThemeSet(id) {
      const s = (this.settings.themeSets || []).find((x) => x && x.id === id)
      if (!s) return false
      await this.patch({ themeOn: true, themeCustom: { ...(s.colors || {}) }, themeSetId: id })
      return true
    },
    /** 删掉一套主题（正套着它时留在当前颜色上，只把标记清掉） */
    async removeThemeSet(id) {
      const sets = (this.settings.themeSets || []).filter((s) => s && s.id !== id)
      await this.patch({
        themeSets: sets,
        themeSetId: this.settings.themeSetId === id ? '' : this.settings.themeSetId
      })
      return true
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
