/**
 * 持久化状态：settings（偏好）+ user（登录用户）+ cookies（B 站 Cookie）
 *
 * 还原自 reference/decompiled/js/index-jTHZJced.js：
 *  - 1012-1017 行 `re = R("Preferences", ...)`：本工程直接用官方 `@capacitor/preferences`。
 *  - 1018-1038 行 `ie`：默认设置；`K = "bililite.state.v1"`：存储键。
 *  - 1039-1045 行 `Ht()`：secure 字段编码（`"raw:" + base64(UTF-8 JSON)`）。
 *  - 1046-1057 行 `zt()`：secure 字段解析（兼容老数据 / 坏数据回落 {}）。
 *  - 1058-1069 行 `Gt()` / `Jt()`：localStorage 兜底读写。
 *  - 1070-1132 行 `_e`：load / persist / patchSettings / setUser / clearAuth / isLoggedIn。
 *  - 163-186 行 `ht()` 里「解析 set-cookie 并写回」的部分（本文件实现为 applySetCookie）。
 *
 * 存储格式（与原构建一致）：
 * {
 *   "version": 1,
 *   "settings": {...},
 *   "user": {mid,uname,face,level,coins,vip} | null,
 *   "secure": "raw:eyJjb29raWVzIjp7..."   // cookies 不明文落盘
 * }
 */
import { Preferences } from '@capacitor/preferences'
import type { User } from '@/types'

/** Preferences / localStorage 的存储键 */
export const STATE_KEY = 'bililite.state.v1'

/**
 * 默认设置：逐字还原原构建的 `ie`
 *
 * 注意：这里只有原生侧默认值；渲染层 settings store 还会再补
 * `accent` / `focusTargets` / `hideDanmakuArea` / `autoMark` 等纯 UI 字段。
 */
export const DEFAULT_SETTINGS: Record<string, any> = {
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
  navOrder: [],
  subAuto: false,
  subFontSize: 22,
  subBg: true,
  subBottom: 8,
  focusTasks: ['阅读', '刷题', '看课', '整理笔记'],
}

/** secure 字段编码：JSON -> UTF-8 -> base64，加 "raw:" 前缀。还原 `Ht()` */
export function encodeSecure(payload: unknown): string {
  const json = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return 'raw:' + btoa(binary)
}

/** secure 字段解析：还原 `zt()`，任何异常都返回 {} */
export function decodeSecure(raw: unknown): any {
  if (!raw || typeof raw !== 'string') return {}
  try {
    if (raw.startsWith('raw:')) {
      const binary = atob(raw.slice(4))
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      return JSON.parse(new TextDecoder().decode(bytes))
    }
  } catch {
    // 老版本/损坏的数据：当作没有
  }
  return {}
}

/** 读 localStorage（兜底）：还原 `Gt()` */
function readLocal(): string | null {
  try {
    return localStorage.getItem(STATE_KEY)
  } catch {
    return null
  }
}

/** 写 localStorage（兜底）：还原 `Jt()` */
function writeLocal(value: string): void {
  try {
    localStorage.setItem(STATE_KEY, value)
  } catch {
    // 隐私模式/配额满：忽略
  }
}

/**
 * 把可能被合并成一条的 set-cookie 头拆开：还原 `Tt()`
 *
 * 原生 OkHttp 有时把多个 Set-Cookie 用逗号拼在一起，而 cookie 值里也可能有逗号，
 * 所以只在「逗号后面跟着 `name=`」时才认为是一条新的 cookie。
 */
export function splitSetCookie(raw?: string | null): string[] {
  if (!raw) return []
  const list: string[] = []
  let current = ''
  for (const part of String(raw).split(',')) {
    if (/^\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=/.test(part) && current.includes('=')) {
      list.push(current.trim())
      current = part
    } else {
      current = current ? `${current},${part}` : part
    }
  }
  if (current.trim()) list.push(current.trim())
  return list
}

/**
 * 解析 Set-Cookie 并写回 cookies：还原 `ht()` 的核心逻辑
 *
 * 只取第一段 `name=value`：值以 deleted/expired 结尾或为空时表示删除该 cookie。
 * 返回是否有变化（有变化时已持久化）。
 */
export function applySetCookie(list: string[]): boolean {
  let changed = false
  for (const header of list) {
    const pair = String(header).split(';')[0]
    const at = pair.indexOf('=')
    if (at <= 0) continue
    const name = pair.slice(0, at).trim()
    const value = pair.slice(at + 1).trim()
    if (!name) continue
    if (!value || /^(deleted|expired)$/i.test(value)) {
      if (name in state.cookies) {
        delete state.cookies[name]
        changed = true
      }
    } else if (state.cookies[name] !== value) {
      state.cookies[name] = value
      changed = true
    }
  }
  if (changed) state.persist()
  return changed
}

/** 持久化状态单例（原构建里的 `_e`） */
export const state = {
  /** 用户偏好（settings store 的持久化副本） */
  settings: { ...DEFAULT_SETTINGS } as Record<string, any>,
  /** 登录用户（来自 nav 接口，字段见 types.ts User） */
  user: null as User | null,
  /** B 站 Cookie 键值对（SESSDATA / bili_jct / buvid3 / DedeUserID …） */
  cookies: {} as Record<string, string>,

  /**
   * 从 Preferences 读取并恢复：还原 `load()`
   *
   * 顺序：Preferences -> localStorage -> 都没有则用默认值。
   * 首次只存在于 localStorage 的旧数据会顺手迁到 Preferences。
   */
  async load(): Promise<typeof state> {
    let raw: string | null = null
    try {
      const got = await Preferences.get({ key: STATE_KEY })
      raw = got && got.value ? got.value : null
    } catch (e: any) {
      console.warn('[store] 读原生 Preferences 失败，回退 localStorage：', e && e.message)
    }

    if (!raw) {
      const local = readLocal()
      if (local) {
        raw = local
        // 迁移到原生存储（失败无所谓，localStorage 里还有）
        Preferences.set({ key: STATE_KEY, value: local }).catch(() => {})
      }
    }

    let parsed: any = null
    try {
      parsed = raw ? JSON.parse(raw) : null
    } catch {
      parsed = null
    }

    if (!parsed || typeof parsed !== 'object') {
      this.settings = { ...DEFAULT_SETTINGS }
      this.user = null
      this.cookies = {}
      return this
    }

    this.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) }
    this.user = parsed.user || null
    this.cookies = decodeSecure(parsed.secure).cookies || {}
    return this
  },

  /**
   * 落盘：还原 `persist()`
   *
   * cookies 不明文存放，走 secure 字段（`raw:` + base64）。
   * Preferences 写失败只打日志；同时始终写一份 localStorage 兜底。
   */
  persist(): void {
    const payload = {
      version: 1,
      settings: this.settings,
      user: this.user,
      secure: encodeSecure({ cookies: this.cookies }),
    }
    const text = JSON.stringify(payload)
    Preferences.set({ key: STATE_KEY, value: text }).catch((e: any) => {
      console.error('[store] 原生持久化失败:', e)
    })
    writeLocal(text)
  },

  /** 合并设置并持久化，返回新的完整 settings：还原 `patchSettings()` */
  patchSettings(patch: Record<string, any>): Record<string, any> {
    this.settings = { ...this.settings, ...patch }
    this.persist()
    return this.settings
  },

  /** 写入登录用户并持久化：还原 `setUser()` */
  setUser(user: User | null): void {
    this.user = user
    this.persist()
  },

  /** 清空登录态（user + cookies）并持久化：还原 `clearAuth()` */
  clearAuth(): void {
    this.user = null
    this.cookies = {}
    this.persist()
  },

  /** 是否已登录：有 user 或有 SESSDATA：还原 `isLoggedIn()` */
  isLoggedIn(): boolean {
    return !!this.user || !!this.cookies.SESSDATA
  },
}
