import { store } from '../store.js'

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export const BASE_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com'
}

export function cookieHeader() {
  return Object.entries(store.state.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
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
export async function request(url, { method = 'GET', params, headers = {}, timeout = 15000 } = {}) {
  const full = buildUrl(url, params)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const jar = cookieHeader()
    const res = await fetch(full, {
      method,
      headers: { ...BASE_HEADERS, ...(jar ? { Cookie: jar } : {}), ...headers },
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
