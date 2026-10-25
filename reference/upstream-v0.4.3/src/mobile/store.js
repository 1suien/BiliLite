/**
 * 安卓端（Capacitor + WebView）的存储实现。
 *
 * 接口与 `src/main/store.js` 一致（state / load / persist / patchSettings / setUser /
 * clearAuth / isLoggedIn），B 站接口层 `src/main/bili/*` 通过 `setBiliStore(store)`
 * 注入后就能在两个平台上跑同一份代码。
 *
 * 与桌面端的四个差别：
 * 1. 桌面端写 `userData/study-bili.json`（cookie 用 DPAPI 加密）；这里写
 *    **原生 Preferences**（安卓侧是 SharedPreferences，落在应用私有目录，
 *    升级 App 不会丢，WebView 清数据也不会带走）。同时在 localStorage 里留一份镜像，
 *    原生调用失败时不至于把设置丢光。
 * 2. `load()` 是异步的（要等原生读出来），所以 `installBridge()` 也得 await 它，
 *    再挂载渲染层 —— 否则会先闪一下默认主题和「未登录」。
 * 3. 桌面端 `isLoggedIn()` 看 `cookies.SESSDATA`；WebView 里 SESSDATA 是 HttpOnly，
 *    JS 读不到（Cookie 由原生 CookieManager 自动随请求带上），所以这里看 `state.user`。
 * 4. 没有 `safeStorage`，`enc:` 分支不存在，一律 `raw:`（base64 只是编码，不是加密）。
 *
 * 注：0.4.0 之前只有 localStorage，`load()` 里带一次性迁移。
 */

import { Preferences } from '@capacitor/preferences'
import { DEFAULT_SETTINGS } from '../shared/default-settings.js'

const KEY = 'bililite.state.v1'

function encodeSecret(payload) {
  const json = JSON.stringify(payload)
  // btoa 只吃 latin1，中文先过一遍 UTF-8 编码
  const bytes = new TextEncoder().encode(json)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i])
  return 'raw:' + btoa(bin)
}

function decodeSecret(blob) {
  if (!blob || typeof blob !== 'string') return {}
  try {
    if (blob.startsWith('raw:')) {
      const bin = atob(blob.slice(4))
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
      return JSON.parse(new TextDecoder().decode(bytes))
    }
  } catch {
    /* 坏掉的密文块 -> 当成空的重来 */
  }
  return {}
}

function readMirror() {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

function writeMirror(text) {
  try {
    localStorage.setItem(KEY, text)
  } catch {
    /* 配额满 / 私密模式，忽略 */
  }
}

export const store = {
  state: {
    settings: { ...DEFAULT_SETTINGS },
    user: null,
    cookies: {}
  },

  async load() {
    let raw = null
    try {
      const res = await Preferences.get({ key: KEY })
      raw = res && res.value ? res.value : null
    } catch (err) {
      console.warn('[store] 读原生 Preferences 失败，回退 localStorage：', err && err.message)
    }
    if (!raw) {
      // 0.4.0 之前写的是 localStorage：迁一次，之后就以 Preferences 为准
      const legacy = readMirror()
      if (legacy) {
        raw = legacy
        Preferences.set({ key: KEY, value: legacy }).catch(() => {})
      }
    }

    let parsed = null
    try {
      parsed = raw ? JSON.parse(raw) : null
    } catch {
      parsed = null
    }
    if (!parsed || typeof parsed !== 'object') {
      this.state.settings = { ...DEFAULT_SETTINGS }
      this.state.user = null
      this.state.cookies = {}
      return this.state
    }
    this.state.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) }
    this.state.user = parsed.user || null
    this.state.cookies = decodeSecret(parsed.secure).cookies || {}
    return this.state
  },

  persist() {
    const payload = {
      version: 1,
      settings: this.state.settings,
      user: this.state.user,
      secure: encodeSecret({ cookies: this.state.cookies })
    }
    const text = JSON.stringify(payload)
    // 保持同步签名（调用方都是 fire-and-forget），写入排队交给原生
    Preferences.set({ key: KEY, value: text }).catch((err) => {
      console.error('[store] 原生持久化失败:', err)
    })
    writeMirror(text)
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
    // WebView 里读不到 HttpOnly 的 SESSDATA，用已缓存的用户对象判断
    return Boolean(this.state.user) || Boolean(this.state.cookies.SESSDATA)
  }
}

export default store
