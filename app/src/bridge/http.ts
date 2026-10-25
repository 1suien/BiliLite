/**
 * 原生 HTTP 客户端（CapacitorHttp）+ 类 fetch 响应对象
 *
 * 还原自 reference/decompiled/js/index-jTHZJced.js：
 *  - 745 行   `const xt = R("CapacitorHttp", { web: () => new Lt() })`：本工程改用
 *             官方 `@capacitor/core` 的 `CapacitorHttp`（官方 web 实现已内置，等价于原构建里的 Lt）。
 *  - 748-751 行 `ye()`：取消异常（name = "AbortError"，message "请求已取消"）。
 *  - 752-761 行 `Tt()`：把可能被合并的 set-cookie 头拆成多条（按 `name=` 起始判断）。
 *  - 762-795 行 `class Ot`：类 fetch 响应对象（status/ok/url/headers.get/has/getSetCookie/text()/json()）。
 *  - 796-804 行 `Ut()`：把原生返回的 data（字符串/对象/数字）统一成字符串。
 *  - 805-847 行 `It()`：把 `CapacitorHttp.request` 包装成 fetch 形状（connectTimeout/readTimeout/AbortSignal）。
 *  - 139-147 行 常规请求头 `dt`（UA/Referer/Origin…）。
 *  - 148-158 行 Cookie 模式 `Ne` 与 `pt()`（从持久化 store 拼 Cookie 头）。
 *  - 163-186 行 `ht()`：响应里的 Set-Cookie 写回 store 并持久化。
 *  - 187-193 行 `qe()`：URL 拼查询参数（跳过 null / 空串）。
 *  - 194-228 行 `I()`：统一请求（默认 15s 超时、返回 {ok,status,json,text,url}）。
 *  - 229-238 行 `w()`：业务码判定（非 0 抛 Error 并带 `biliCode`）。
 */
import { CapacitorHttp } from '@capacitor/core'
import type { HttpResponse } from '@capacitor/core'
import { applySetCookie, splitSetCookie, state } from './state'

/** 常规请求头：与原构建 dt 一致，B 站接口不带这些会被风控 */
export const BASE_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
}

/** 连接超时 / 读取超时（毫秒）：与原生 OkHttp 的两个超时对应 */
export const DEFAULT_CONNECT_TIMEOUT = 15000
export const DEFAULT_READ_TIMEOUT = 20000

/** 取消请求时抛的异常（与原实现一致：name = AbortError） */
function abortError(): Error {
  const e = new Error('请求已取消')
  e.name = 'AbortError'
  return e
}

/** 类 fetch 的响应对象：还原 `class Ot` */
export class BiliHttpResponse {
  readonly status: number
  readonly ok: boolean
  /** 最终请求地址（原生层返回的 url，拿不到时用请求地址） */
  url = ''
  readonly headers: {
    get(name: string): string | null
    has(name: string): boolean
    getSetCookie(): string[]
  }

  private readonly _text: string
  private readonly _setCookies: string[]

  constructor(text: string, status: number, rawHeaders?: Record<string, unknown> | null) {
    this._text = text
    this.status = status
    this.ok = status >= 200 && status < 300

    // 原生返回的 headers 是普通对象，值可能是数组（多值头，如 set-cookie）
    const map = new Map<string, string>()
    for (const [key, value] of Object.entries(rawHeaders || {})) {
      if (value == null) continue
      map.set(String(key).toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value))
    }
    this._setCookies = splitSetCookie(map.get('set-cookie'))

    this.headers = {
      get: (name: string) => {
        const key = String(name).toLowerCase()
        if (key === 'set-cookie') return map.get('set-cookie') ?? null
        return map.has(key) ? (map.get(key) as string) : null
      },
      has: (name: string) => map.has(String(name).toLowerCase()),
      getSetCookie: () => this._setCookies,
    }
  }

  async text(): Promise<string> {
    return this._text
  }

  async json(): Promise<any> {
    return JSON.parse(this._text)
  }
}

/** 响应体的任何形态 -> 字符串：还原 `Ut()` */
function stringifyData(data: unknown): string {
  if (data == null) return ''
  if (typeof data === 'string') return data
  if (typeof data === 'object') return JSON.stringify(data)
  return String(data)
}

/** 可用 fetch 形状的函数签名（与原实现的 `Be` 一致） */
export type FetchLike = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: any
    redirect?: RequestRedirect
    signal?: AbortSignal
  },
) => Promise<BiliHttpResponse>

/**
 * 创建「走原生 CapacitorHttp」的 fetch：还原 `It()`
 *
 * opts.connectTimeout / readTimeout 直接透传给原生 OkHttp。
 * 说明：GET/HEAD 不发送 body（原生层也不允许），body 只支持字符串，
 * 因此调用方要自己把 JSON / 表单序列化成字符串。
 */
export function createNativeFetch(
  opts: { connectTimeout?: number; readTimeout?: number } = {},
): FetchLike {
  const connectTimeout = opts.connectTimeout || DEFAULT_CONNECT_TIMEOUT
  const readTimeout = opts.readTimeout || DEFAULT_READ_TIMEOUT

  return async function nativeFetch(url, init = {}) {
    const method = String(init.method || 'GET').toUpperCase()

    const signal = init.signal
    // 已经取消的请求不再发出去（原生层无法中途取消，只能提前返回）
    if (signal && signal.aborted) throw abortError()

    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(init.headers || {})) {
      if (value != null) headers[key] = String(value)
    }

    let data: string | undefined
    if (init.body !== undefined && init.body !== null && method !== 'GET' && method !== 'HEAD') {
      data = typeof init.body === 'string' ? init.body : String(init.body)
    }

    const pending = CapacitorHttp.request({
      url,
      method,
      headers,
      data,
      connectTimeout,
      readTimeout,
    }) as Promise<HttpResponse>

    // AbortSignal：原生请求无法真正取消，只是让 Promise 提前 reject（与原实现一致）
    let res: HttpResponse
    if (signal) {
      pending.catch(() => {})
      res = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          if (signal.aborted) reject(abortError())
          else signal.addEventListener('abort', () => reject(abortError()), { once: true })
        }),
      ])
    } else {
      res = await pending
    }

    if (!res || typeof res.status !== 'number') {
      throw new Error('原生请求没有返回有效响应')
    }

    const response = new BiliHttpResponse(stringifyData(res.data), res.status, res.headers as any)
    response.url = (res as any).url || url
    return response
  }
}

/** 当前使用的 fetch 实现（启动时由 installAndroidBridge 换成原生实现） */
let fetchImpl: FetchLike = createNativeFetch()

/** 替换 fetch 实现：还原 `mt()` */
export function setFetchImpl(fn?: FetchLike | null): void {
  fetchImpl = typeof fn === 'function' ? fn : createNativeFetch()
}

/**
 * Cookie 头模式：还原 `ft()` / `pt()`
 * - `explicit`（默认）：把 store 里的 cookies 手动拼进 Cookie 头（原生 OkHttp 不会自动带 WebView 的 cookie）
 * - `native`：交给原生 CookieManager，不再手动拼
 */
let cookieMode: 'explicit' | 'native' = 'explicit'

/** 设为 explicit 模式（与原构建启动时 `ft()` 的行为一致） */
export function useExplicitCookies(): void {
  cookieMode = 'explicit'
}

/** 拼 Cookie 头：还原 `pt()` */
function cookieHeader(): string {
  if (cookieMode === 'native') return ''
  return Object.entries(state.cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ')
}

/** URL 拼查询参数（null / 空串跳过）：还原 `qe()` */
export function buildUrl(url: string, params?: Record<string, any> | null): string {
  const u = new URL(url)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === '') continue
      u.searchParams.set(key, String(value))
    }
  }
  return u.toString()
}

/** 把响应里的 Set-Cookie 写回持久化 store：还原 `ht()` */
function persistSetCookies(res: BiliHttpResponse): void {
  let list: string[] = []
  if (typeof (res.headers as any).getSetCookie === 'function') {
    list = res.headers.getSetCookie()
  }
  if (!list.length) {
    const raw = res.headers.get('set-cookie')
    if (raw) list = [raw]
  }
  if (list.length) applySetCookie(list)
}

export interface RequestOptions {
  method?: string
  params?: Record<string, any> | null
  headers?: Record<string, string>
  body?: any
  /** 超时（毫秒），默认 15s */
  timeout?: number
  signal?: AbortSignal
}

export interface RequestResult {
  ok: boolean
  status: number
  /** 解析出来的 JSON（解析失败为 null） */
  json: any
  /** 原始文本 */
  text: string
  /** 实际请求地址 */
  url: string
}

/**
 * 统一请求：还原 `I()`
 *
 * 自动带上常规头 + Cookie，超时用 AbortController 实现（默认 15s），
 * 响应文本尝试 JSON.parse，失败则 json = null（由调用方决定怎么办）。
 */
export async function request(url: string, opts: RequestOptions = {}): Promise<RequestResult> {
  const { method = 'GET', params, headers = {}, body, timeout = 15000, signal } = opts

  const fullUrl = buildUrl(url, params)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  // 调用方也可能传 signal（如弹幕批量取消），两者任一触发都取消
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  try {
    const cookie = cookieHeader()
    const res = await fetchImpl(fullUrl, {
      method,
      headers: { ...BASE_HEADERS, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body,
      redirect: 'follow',
      signal: controller.signal,
    })

    persistSetCookies(res)

    const text = await res.text()
    let json: any = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }

    return { ok: res.ok, status: res.status, json, text, url: fullUrl }
  } finally {
    clearTimeout(timer)
  }
}

/** 失败时附加的标记（与原实现一致，渲染层靠这两个字段分流） */
export interface BiliError extends Error {
  needLogin?: boolean
  biliCode?: number
  transient?: boolean
}

/** 抛一个带标记的业务错误 */
export function biliError(message: string, extra: Partial<BiliError> = {}): BiliError {
  const e: BiliError = new Error(message)
  if (extra.needLogin) e.needLogin = true
  if (extra.biliCode != null) e.biliCode = extra.biliCode
  if (extra.transient) e.transient = true
  return e
}

/**
 * 请求并返回 `data`：还原 `w()`
 *
 * 约定：B 站接口返回 `{code, message|msg, data}`，code !== 0 视为失败，
 * 抛出的 Error 带 `biliCode`（渲染层用它判断 -403 风控 / -101 未登录）。
 */
export async function getData<T = any>(url: string, opts: RequestOptions = {}): Promise<T> {
  const res = await request(url, opts)
  if (!res.json) throw new Error(`接口返回非 JSON（HTTP ${res.status}）`)
  if (res.json.code !== 0) {
    const message = res.json.message || res.json.msg || `code ${res.json.code}`
    throw biliError(message, { biliCode: res.json.code })
  }
  return res.json.data as T
}

export { splitSetCookie }
