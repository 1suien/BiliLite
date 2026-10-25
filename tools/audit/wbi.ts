/**
 * WBI 签名（B 站 web 接口的 w_rid 校验）+ MD5
 *
 * 还原自 reference/decompiled/js/index-jTHZJced.js：
 *  - 848-908 行 `ve` / `Ke` / `Rt` / `Dt` / `ue`：纯 JS 的 MD5 实现（这里导出为 md5Hex）。
 *  - 1269-1274 行 `ln`：mixinKey 重排表；`un = 30 分钟`：密钥缓存时长。
 *  - 1276-1287 行 `dn()`：取 nav 接口里的 wbi_img，从 URL 里截出 img_key / sub_key，缓存 30 分钟。
 *  - 1288-1294 行 `fn()`：用重排表把 img_key + sub_key 搅成 32 位 mixinKey。
 *  - 1295-1308 行 `U()`：参数排序 + 特殊字符过滤 + wts + `w_rid = md5(query + mixinKey)`。
 *  - 1309-1311 行 `de()`：清缓存（遇到 -403 风控时重签一次）。
 *
 * 说明：MD5 是自己实现的，因为 WebView 里没有 node:crypto，
 * 原构建同样是自带一份 MD5（被 WBI 与 APP 接口签名共用）。
 */
import { request } from './http.ts'

/** 每轮的左移位数 */
const SHIFT_AMOUNTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
  14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
  21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

/** 正弦常量表 K[i] = floor(abs(sin(i+1)) * 2^32) */
const SINE_TABLE = new Uint32Array(64)
for (let i = 0; i < 64; i += 1) {
  SINE_TABLE[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)
}

/** 输入统一成字节：还原 `Rt()` */
function toBytes(input: string | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new TextEncoder().encode(String(input))
}

/** 计算 MD5 的四个 32 位字（小端）：还原 `Dt()` */
function md5Words(input: string | Uint8Array): [number, number, number, number] {
  const bytes = toBytes(input)
  const len = bytes.length
  // 补齐到 512 位块：末尾 1 字节 0x80 + 8 字节长度
  const paddedLen = (((len + 8) >> 6) + 1) << 6
  const buf = new Uint8Array(paddedLen)
  buf.set(bytes)
  buf[len] = 0x80

  const view = new DataView(buf.buffer)
  const bitLen = len * 8
  view.setUint32(paddedLen - 8, bitLen >>> 0, true)
  view.setUint32(paddedLen - 4, Math.floor(bitLen / 4294967296), true)

  let a0 = 1732584193
  let b0 = 4023233417
  let c0 = 2562383102
  let d0 = 271733878

  const words = new Uint32Array(16)
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4, true)

    let a = a0
    let b = b0
    let c = c0
    let d = d0

    for (let i = 0; i < 64; i += 1) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }
      f = (f + a + SINE_TABLE[i] + words[g]) | 0
      a = d
      d = c
      c = b
      b = (b + ((f << SHIFT_AMOUNTS[i]) | (f >>> (32 - SHIFT_AMOUNTS[i])))) | 0
    }

    a0 = (a0 + a) | 0
    b0 = (b0 + b) | 0
    c0 = (c0 + c) | 0
    d0 = (d0 + d) | 0
  }

  return [a0, b0, c0, d0]
}

/** MD5 -> 32 位小写十六进制：还原 `ue()` */
export function md5Hex(input: string | Uint8Array): string {
  const words = md5Words(input)
  let out = ''
  for (let i = 0; i < 4; i += 1) {
    const word = words[i]
    for (let j = 0; j < 4; j += 1) {
      out += ((word >>> (j * 8)) & 255).toString(16).padStart(2, '0')
    }
  }
  return out
}

/** mixinKey 重排表（64 项）：还原 `ln` */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

/** 密钥缓存有效期：30 分钟（原构建 `un`） */
const KEY_TTL = 30 * 60 * 1000

/** nav 接口地址 */
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'

interface WbiKeys {
  imgKey: string
  subKey: string
  /** 取到密钥的时间戳（毫秒） */
  at: number
}

let cache: WbiKeys = { imgKey: '', subKey: '', at: 0 }

/**
 * 取 WBI 密钥：还原 `dn()`
 *
 * 从 `/x/web-interface/nav` 的 `data.wbi_img.img_url` / `sub_url` 里截出
 * 文件名（去掉目录与 `.png` 后缀）；30 分钟内复用缓存。
 */
export async function getWbiKeys(force = false): Promise<WbiKeys> {
  if (!force && cache.imgKey && Date.now() - cache.at < KEY_TTL) return cache

  const res = await request(NAV_URL)
  const wbi = res.json && res.json.data && res.json.data.wbi_img
  if (!wbi || !wbi.img_url || !wbi.sub_url) {
    throw new Error('无法获取 WBI 签名密钥，请检查网络')
  }
  const keyOf = (url: string) => url.slice(url.lastIndexOf('/') + 1, url.lastIndexOf('.'))
  cache = { imgKey: keyOf(wbi.img_url), subKey: keyOf(wbi.sub_url), at: Date.now() }
  return cache
}

/** 由 img_key + sub_key 算 mixinKey（32 位）：还原 `fn()` */
export function getMixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i] || '')
    .join('')
    .slice(0, 32)
}

/**
 * 给参数加 WBI 签名：还原 `U()`
 *
 * 规则：按 key 排序 -> 值去掉 `!'()*` -> 各自 encodeURIComponent -> 拼 `k=v&…`
 * -> 末尾加 wts（秒）-> `w_rid = md5(query + mixinKey)`。
 */
export async function encWbi(params: Record<string, any>): Promise<Record<string, any>> {
  const { imgKey, subKey } = await getWbiKeys()
  const mixinKey = getMixinKey(imgKey, subKey)

  const withTs: Record<string, any> = {
    ...params,
    wts: Math.round(Date.now() / 1000),
  }

  const query = Object.keys(withTs)
    .sort()
    .map((key) => {
      const value = String(withTs[key]).replace(/[!'()*]/g, '')
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    })
    .join('&')

  return { ...withTs, w_rid: md5Hex(query + mixinKey) }
}

/** 清空密钥缓存（遇到 -403 风控时重签一次）：还原 `de()` */
export function clearWbiCache(): void {
  cache = { imgKey: '', subKey: '', at: 0 }
}
