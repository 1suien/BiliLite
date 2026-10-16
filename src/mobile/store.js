/**
 * 安卓端（Capacitor + WebView）的存储实现。
 *
 * 接口与 `src/main/store.js` 完全一致（state / load / persist / patchSettings /
 * setUser / clearAuth / isLoggedIn），B 站接口层 `src/main/bili/*` 通过
 * `setBiliStore(store)` 注入后就能在两个平台上跑同一份代码。
 *
 * 与桌面端的三个差别：
 * 1. 桌面端写 `userData/study-bili.json`（cookie 用 DPAPI 加密）；这里写 WebView 的
 *    localStorage —— 它在安卓上是**应用私有目录**（只有本 App 能读），卸载即清空。
 *    因此这里不再做二次加密，而是靠系统沙箱；`secure` 字段依旧保留同样的信封格式，
 *    方便以后换成 Keystore 加密而不用改上层。
 * 2. 桌面端 `isLoggedIn()` 看 `cookies.SESSDATA`；WebView 里 SESSDATA 是 HttpOnly，
 *    JS 读不到（Cookie 由原生 CookieManager 自动随请求带上），所以这里看 `state.user`。
 * 3. 没有 `safeStorage`，`enc:` 分支不存在，一律 `raw:`（base64 只是编码，不是加密）。
 */

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

export const store = {
  state: {
    settings: { ...DEFAULT_SETTINGS },
    user: null,
    cookies: {}
  },

  load() {
    let parsed = null
    try {
      parsed = JSON.parse(localStorage.getItem(KEY) || 'null')
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
    try {
      localStorage.setItem(KEY, JSON.stringify(payload))
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
    // WebView 里读不到 HttpOnly 的 SESSDATA，用已缓存的用户对象判断
    return Boolean(this.state.user) || Boolean(this.state.cookies.SESSDATA)
  }
}

export default store
