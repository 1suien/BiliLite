import { storeProxy } from './runtime.js'

const store = storeProxy()

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export const BASE_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com'
}

/**
 * Cookie 的携带方式。
 * - `explicit`（默认，两端都用）：每次请求自己拼 `Cookie:` 头。
 *   桌面端主进程的 net/undici 不共享渲染层的 cookie jar；安卓端走的是原生
 *   CapacitorHttp 插件（不是浏览器 fetch），头由我们完全掌控，所以也自己拼。
 *   而且 B 站扫码登录拿凭据的方式是解析 poll 响应体里的 `data.url` 查询串
 *   （见 auth.js 的 absorbCrossDomain），不依赖 Set-Cookie，所以自己拼完全够用。
 * - `native`（保留给「请求确实由 WebView/OkHttp 发出、Cookie 由 CookieManager
 *   自动带上」的场景）：这时再手动拼一次反而会与原生 jar 打架。
 */
let cookieMode = 'explicit'

export function setCookieMode(mode) {
  cookieMode = mode === 'native' ? 'native' : 'explicit'
}

export function cookieHeader() {
  if (cookieMode === 'native') return ''
  return Object.entries(store.state.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

/**
 * 可注入的 fetch。
 *
 * 桌面端用 Node/undici 的全局 fetch，这里保持默认不动；安卓端必须换掉，原因是
 * **浏览器 fetch 禁止设置几个 B 站强依赖的头**：
 *   - `Referer` / `Origin`：实测 `upos-*.bilivideo.com` 的分片没有
 *     `Referer: https://www.bilibili.com/` 一律 403（见 README 的实测记录），
 *     而 WebView 只会自动带上自己的页面地址；
 *   - `Cookie`：同样是 forbidden header，JS 设了也会被丢掉；
 *   - `Origin`：`x/web-interface/search/type` 这类接口缺了它会被风控回 412。
 * 所以安卓端把 fetch 换成基于原生 `CapacitorHttp.request()` 的实现
 * （见 `src/mobile/native-http.js`），头由 OkHttp 直接发出，绕开全部限制。
 */
let fetchImpl = (...args) => globalThis.fetch(...args)

export function setHttpFetch(fn) {
  fetchImpl = typeof fn === 'function' ? fn : (...args) => globalThis.fetch(...args)
}

function absorbSetCookie(res) {
  let list = []
  if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie()
  if (!list.length) {
    const single = res.headers.get('set-cookie')
    if (single) list = [single]
  }
  let changed = false
  for (const line of list) {
    const pair = String(line).split(';')[0]
    const i = pair.indexOf('=')
    if (i <= 0) continue
    const name = pair.slice(0, i).trim()
    const value = pair.slice(i + 1).trim()
    if (!name) continue
    if (!value || /^(deleted|expired)$/i.test(value)) {
      if (name in store.state.cookies) {
        delete store.state.cookies[name]
        changed = true
      }
    } else if (store.state.cookies[name] !== value) {
      store.state.cookies[name] = value
      changed = true
    }
  }
  if (changed) store.persist()
}

export function buildUrl(url, params) {
  const u = new URL(url)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue
      u.searchParams.set(k, String(v))
    }
  }
  return u.toString()
}

/** Raw request that keeps the shared cookie jar in sync. */
export async function request(url, { method = 'GET', params, headers = {}, body, timeout = 15000 } = {}) {
  const full = buildUrl(url, params)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const jar = cookieHeader()
    const res = await fetchImpl(full, {
      method,
      headers: { ...BASE_HEADERS, ...(jar ? { Cookie: jar } : {}), ...headers },
      body,
      redirect: 'follow',
      signal: controller.signal
    })
    absorbSetCookie(res)
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    return { ok: res.ok, status: res.status, json, text, url: full }
  } finally {
    clearTimeout(timer)
  }
}

/** Request that asserts B 站 standard envelope `{ code, message, data }`. */
export async function api(url, options) {
  const res = await request(url, options)
  if (!res.json) {
    throw new Error(`接口返回非 JSON（HTTP ${res.status}）`)
  }
  if (res.json.code !== 0) {
    const msg = res.json.message || res.json.msg || `code ${res.json.code}`
    const err = new Error(msg)
    err.biliCode = res.json.code
    throw err
  }
  return res.json.data
}

/** Normalise protocol-relative CDN urls coming from the API. */
export function fixUrl(u) {
  if (!u) return ''
  if (u.startsWith('//')) return 'https:' + u
  if (u.startsWith('http://')) return 'https://' + u.slice(7)
  return u
}
