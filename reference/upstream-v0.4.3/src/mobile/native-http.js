/**
 * 安卓端的 fetch 替身：把请求交给原生 CapacitorHttp 插件（OkHttp）发出。
 *
 * 为什么不能直接用 WebView 的 fetch（哪怕 Capacitor 已经把它代理到原生）：
 *   浏览器 fetch 有一批 **forbidden header**，JS 设了也会被静默丢掉，而这几个头
 *   B 站强依赖：
 *     - `Referer`：实测 `upos-*.bilivideo.com` 的分片
 *         no Referer → 403，`Referer: https://www.bilibili.com/` → 206，
 *         `Referer: https://localhost/` → 403。
 *     - `Origin`：`x/web-interface/search/type` 缺它会被风控回 412。
 *     - `Cookie`：同样设不进去，登录态就带不上。
 *   走原生插件后这些头由 OkHttp 直接写出，绕开全部浏览器限制。
 *
 * 另一半（真正的大流量）反而是 WebView 更合适：DASH 分片是渲染层
 * `player/dash.js` 用 `fetch(url, { headers: { Range } })` 拉的，需要**流式**响应
 * 才能边下边喂 MSE。Capacitor 的 fetch 补丁会把 GET 改写成同源代理地址，由原生
 * `WebViewLocalServer` 流式转发，既没有 CORS 又是流式的；而原生插件的响应体是
 * base64，不能流式。所以分工是：
 *   - 接口（JSON）→ 本文件的原生 fetch（要什么头给什么头）
 *   - 媒体（分片/Range）→ 不拦截，继续用 WebView 的被代理 fetch
 * 媒体分片靠 URL 里的签名鉴权，不需要 Cookie；Referer 则由 WebView 自动带
 * 页面地址（`server.hostname` = `www.bilibili.com`，见 mobile/capacitor.config.json）
 * 满足 CDN 校验。
 *
 * 返回的响应对象只实现 `http.js` 真正用到的部分：
 * `.ok` / `.status` / `.headers.get()` / `.headers.getSetCookie()` / `.text()`。
 */
import { CapacitorHttp } from '@capacitor/core'

const DEFAULT_CONNECT_TIMEOUT = 15000
const DEFAULT_READ_TIMEOUT = 20000

function abortError() {
  const err = new Error('请求已取消')
  err.name = 'AbortError'
  return err
}

/**
 * 原生返回的 `Set-Cookie` 是被 Java 用 `", "` 拼成一整条的（`getHeaderFields` 的
 * List 直接 join），而 Cookie 的 `Expires=Wed, 21 Oct 2026 ...` 里本身含逗号，
 * 不能无脑 `split(',')`。判据：逗号后面若紧跟 `name=` 且当前段已经出现过 `=`，
 * 说明那是下一条 Cookie 的开头。
 */
function splitSetCookie(raw) {
  if (!raw) return []
  const out = []
  let cur = ''
  for (const part of String(raw).split(',')) {
    const isCookieStart = /^\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=/.test(part)
    if (isCookieStart && cur.includes('=')) {
      out.push(cur.trim())
      cur = part
    } else {
      cur = cur ? `${cur},${part}` : part
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

class NativeResponse {
  constructor(text, status, rawHeaders) {
    this._text = text
    this.status = status
    this.ok = status >= 200 && status < 300
    this.url = ''

    const map = new Map()
    for (const [k, v] of Object.entries(rawHeaders || {})) {
      if (v === undefined || v === null) continue
      map.set(String(k).toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v))
    }
    this._setCookies = splitSetCookie(map.get('set-cookie'))
    this.headers = {
      get: (name) => {
        const key = String(name).toLowerCase()
        if (key === 'set-cookie') return map.get('set-cookie') ?? null
        return map.has(key) ? map.get(key) : null
      },
      has: (name) => map.has(String(name).toLowerCase()),
      getSetCookie: () => this._setCookies
    }
  }

  async text() {
    return this._text
  }

  async json() {
    return JSON.parse(this._text)
  }
}

/** 把 `res.data` 统一成文本：原生对 `application/json` 会直接解析成对象。 */
function toText(data) {
  if (data === undefined || data === null) return ''
  if (typeof data === 'string') return data
  if (typeof data === 'object') return JSON.stringify(data)
  return String(data)
}

export function createNativeFetch(options = {}) {
  const connectTimeout = options.connectTimeout || DEFAULT_CONNECT_TIMEOUT
  const readTimeout = options.readTimeout || DEFAULT_READ_TIMEOUT

  return async function nativeFetch(url, init = {}) {
    const method = String(init.method || 'GET').toUpperCase()

    const headers = {}
    for (const [k, v] of Object.entries(init.headers || {})) {
      if (v === undefined || v === null) continue
      headers[k] = String(v)
    }

    let data
    if (init.body !== undefined && init.body !== null && method !== 'GET' && method !== 'HEAD') {
      data = typeof init.body === 'string' ? init.body : String(init.body)
    }

    const call = CapacitorHttp.request({
      url,
      method,
      headers,
      data,
      connectTimeout,
      readTimeout
    })

    const signal = init.signal
    let res
    if (signal) {
      // 原生插件没有取消接口：超时/关闭时只能先把 Promise 竞速掉。
      // 这里先挂一个 catch，避免竞速输掉之后那次真实失败变成 unhandled rejection。
      call.catch(() => {})
      res = await Promise.race([
        call,
        new Promise((_, reject) => {
          if (signal.aborted) reject(abortError())
          else signal.addEventListener('abort', () => reject(abortError()), { once: true })
        })
      ])
    } else {
      res = await call
    }

    if (!res || typeof res.status !== 'number') {
      throw new Error('原生请求没有返回有效响应')
    }

    const out = new NativeResponse(toText(res.data), res.status, res.headers)
    out.url = res.url || url
    return out
  }
}

export default createNativeFetch
