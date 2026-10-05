import { api, request, fixUrl } from './http.js'
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

export async function fetchNav() {
  const res = await request(NAV)
  const data = res.json && res.json.data
  if (!data || !data.isLogin) return null
  return {
    mid: data.mid,
    uname: data.uname,
    face: fixUrl(data.face),
    level: (data.level_info && data.level_info.current_level) || 0,
    coins: data.money || 0,
    vip: data.vipStatus === 1
  }
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
    const user = await fetchNav()
    if (!user) return { status: 'error', message: '登录成功但获取用户信息失败，请重试' }
    store.setUser(user)
    return { status: 'success', user }
  }
  return { status, message: data.message || body.message || '' }
}

export async function restore() {
  await ensureBuvid()
  if (!store.isLoggedIn()) return { loggedIn: false, user: null }
  const user = await fetchNav()
  if (!user) {
    store.clearAuth()
    return { loggedIn: false, user: null }
  }
  store.setUser(user)
  return { loggedIn: true, user }
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
