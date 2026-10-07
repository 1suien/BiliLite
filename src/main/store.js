import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_SETTINGS = {
  theme: 'dark',
  defaultQuality: 80,
  autoNext: true,
  seekStep: 5,
  backupPath: '',
  playerVolume: 0.8,
  autoCheckin: true,
  playbackRate: 1,
  danmakuOn: true,
  danmakuOpacity: 0.9,
  danmakuArea: 1,
  autoHideCtl: true,
  /** 侧栏顺序（路由路径数组；空数组 = 用代码里的默认顺序） */
  navOrder: [],
  /** 字幕：自动开启在线字幕 */
  subAuto: false,
  /** 字幕：字号 px / 是否画背景遮罩 / 距舞台底部百分比 */
  subFontSize: 22,
  subBg: true,
  subBottom: 8,
  /** 专注弹层里的快捷任务（可自定义；空数组 = 用代码里的默认四个） */
  focusTasks: ['阅读', '刷题', '看课', '整理笔记'],
  /** 自定义主题：是否启用 / 当前的 7 个颜色 / 存下来的套装 / 正在套用的套装 id */
  themeOn: false,
  themeCustom: {},
  themeSets: [],
  themeSetId: ''
}

function filePath() {
  return path.join(app.getPath('userData'), 'study-bili.json')
}

function encodeSecret(payload) {
  const json = JSON.stringify(payload)
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(json).toString('base64')
    }
  } catch {
    /* fall through to plain storage */
  }
  return 'raw:' + Buffer.from(json, 'utf8').toString('base64')
}

function decodeSecret(blob) {
  if (!blob || typeof blob !== 'string') return {}
  try {
    if (blob.startsWith('enc:')) {
      return JSON.parse(safeStorage.decryptString(Buffer.from(blob.slice(4), 'base64')))
    }
    if (blob.startsWith('raw:')) {
      return JSON.parse(Buffer.from(blob.slice(4), 'base64').toString('utf8'))
    }
  } catch {
    /* corrupted secret blob -> start clean */
  }
  return {}
}

export const store = {
  state: {
    settings: { ...DEFAULT_SETTINGS },
    user: null,
    cookies: {}
  },

  load() {
    try {
      const raw = fs.readFileSync(filePath(), 'utf8')
      const parsed = JSON.parse(raw)
      this.state.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) }
      this.state.user = parsed.user || null
      this.state.cookies = decodeSecret(parsed.secure).cookies || {}
    } catch {
      this.state.settings = { ...DEFAULT_SETTINGS }
      this.state.user = null
      this.state.cookies = {}
    }
    return this.state
  },

  persist() {
    const payload = {
      version: 1,
      settings: this.state.settings,
      user: this.state.user,
      secure: encodeSecret({ cookies: this.state.cookies })
    }
    try {
      fs.mkdirSync(path.dirname(filePath()), { recursive: true })
      fs.writeFileSync(filePath() + '.tmp', JSON.stringify(payload, null, 2), 'utf8')
      fs.renameSync(filePath() + '.tmp', filePath())
    } catch (err) {
      console.error('[store] 持久化失败:', err)
    }
  },

  patchSettings(patch) {
    this.state.settings = { ...this.state.settings, ...patch }
    this.persist()
    return this.state.settings
  },

  setUser(user) {
    this.state.user = user
    this.persist()
  },

  clearAuth() {
    this.state.user = null
    this.state.cookies = {}
    this.persist()
  },

  isLoggedIn() {
    return Boolean(this.state.cookies.SESSDATA)
  }
}
