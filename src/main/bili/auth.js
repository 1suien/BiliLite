import { api, request, fixUrl } from './http.js'
import { classifyNav, toNavUser } from './nav-classify.js'
import { store } from '../store.js'

const QR_GENERATE = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
const QR_POLL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
const NAV = 'https://api.bilibili.com/x/web-interface/nav'
const SPI = 'https://api.bilibili.com/x/frontend/finger/spi'

/** 游客态也需要 buvid3 才会被风控放行，登录前后都值得先拿一次。 */
export async function ensureBuvid(force = false) {
  if (!force && store.state.cookies.buvid3) return store.state.cookies.buvid3
  try {
    const data = await api(SPI)
    if (data) {
      if (data.b_3) store.state.cookies.buvid3 = data.b_3
      if (data.b_4) store.state.cookies.buvid4 = data.b_4
      store.persist()
    }
  } catch (err) {
    console.warn('[auth] buvid 获取失败：', err.message)
  }
  return store.state.cookies.buvid3 || ''
}

function absorbCrossDomain(url) {
  if (!url) return
  try {
    const u = new URL(url)
    for (const key of ['DedeUserID', 'DedeUserID__ckMd5', 'SESSDATA', 'bili_jct']) {
      const v = u.searchParams.get(key)
      if (v) store.state.cookies[key] = v
    }
    store.persist()
  } catch {
    /* ignore malformed redirect */
  }
}

/**
 * 登录态校验。三种结果要分清楚，别把「风控/网络异常」当成「未登录」：
 * - 正常登录 → 返回用户对象
 * - B 站**明确**回未登录（code -101，或 code 0 且 isLogin === false）→ 返回 null
 * - 其他异常（-352 风控、超时、缺 data、5xx）→ 抛 `err.transient = true`，调用方必须保留 cookie
 *
 * 曾经的写法是「拿不到 user 就当未登录」，于是 nav 被风控一次，restore() 就把
 * cookie 全清掉（store.clearAuth()），表现就是「扫码登录后过一会儿自动退出」。
 */
export async function fetchNav() {
  const res = await request(NAV)
  const c = classifyNav(res.json || {}, res.status)
  if (c.kind === 'user') return toNavUser(c.data, fixUrl)
  if (c.kind === 'guest') return null
  const err = new Error(c.message)
  err.transient = true
  err.biliCode = c.code
  throw err
}

export async function qrGenerate() {
  await ensureBuvid()
  const data = await api(QR_GENERATE)
  return { url: data.url, qrcodeKey: data.qrcode_key }
}

const POLL_STATUS = {
  0: 'success',
  86038: 'expired',
  86090: 'scanned',
  86101: 'waiting'
}

export async function qrPoll(qrcodeKey) {
  const res = await request(QR_POLL, {
    params: { qrcode_key: qrcodeKey, source: 'main-fe-header' },
    timeout: 12000
  })
  const body = res.json || {}
  const data = body.data || {}
  const status = POLL_STATUS[data.code] || 'error'
  if (status === 'success') {
    absorbCrossDomain(data.url)
    let user = null
    try {
      user = await fetchNav()
    } catch (err) {
      // 扫码已经成功、cookie 也已经落盘，nav 这一下被风控/超时不该判登录失败
      console.warn('[auth] 登录后校验暂失败（登录仍有效）：', err.message)
    }
    if (user) store.setUser(user)
    return { status: 'success', user: user || store.state.user || null }
  }
  return { status, message: data.message || body.message || '' }
}

export async function restore() {
  await ensureBuvid()
  if (!store.isLoggedIn()) return { loggedIn: false, user: null }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const user = await fetchNav()
      if (!user) {
        // 只有 B 站明确回「未登录」才清凭据
        store.clearAuth()
        return { loggedIn: false, user: null }
      }
      store.setUser(user)
      return { loggedIn: true, user }
    } catch (err) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 600))
        continue
      }
      // 风控/网络异常：保留 cookie 与上次的用户信息，别把用户踢下线
      console.warn('[auth] 登录态校验失败，保留登录：', err.message)
      return { loggedIn: true, user: store.state.user || null, stale: true, message: err.message }
    }
  }
  return { loggedIn: true, user: store.state.user || null, stale: true }
}

export async function logout() {
  try {
    if (store.state.cookies.bili_jct) {
      await request('https://passport.bilibili.com/login/exit/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `biliCSRF=${encodeURIComponent(store.state.cookies.bili_jct)}`
      })
    }
  } catch (err) {
    console.warn('[auth] 退出接口失败（忽略）：', err.message)
  }
  store.clearAuth()
  return { loggedIn: false }
}
