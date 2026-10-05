import { createHash } from 'node:crypto'
import { request } from './http.js'

/** Fixed permutation table published by bilibili's web player. */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21,
  56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
]

const KEY_TTL = 30 * 60 * 1000
let cache = { imgKey: '', subKey: '', at: 0 }

async function getWbiKeys(force = false) {
  if (!force && cache.imgKey && Date.now() - cache.at < KEY_TTL) return cache
  const res = await request('https://api.bilibili.com/x/web-interface/nav')
  const info = res.json && res.json.data && res.json.data.wbi_img
  if (!info || !info.img_url || !info.sub_url) {
    throw new Error('无法获取 WBI 签名密钥，请检查网络')
  }
  const basename = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
  cache = { imgKey: basename(info.img_url), subKey: basename(info.sub_url), at: Date.now() }
  return cache
}

export function mixinKey(imgKey, subKey) {
  const raw = imgKey + subKey
  return MIXIN_KEY_ENC_TAB.map((n) => raw[n] || '').join('').slice(0, 32)
}

/** Returns params extended with `wts` + `w_rid`, ready to send to a wbi endpoint. */
export async function signParams(params) {
  const { imgKey, subKey } = await getWbiKeys()
  const key = mixinKey(imgKey, subKey)
  const withTs = { ...params, wts: Math.round(Date.now() / 1000) }
  const query = Object.keys(withTs)
    .sort()
    .map((k) => {
      const v = String(withTs[k]).replace(/[!'()*]/g, '')
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
    })
    .join('&')
  const w_rid = createHash('md5').update(query + key).digest('hex')
  return { ...withTs, w_rid }
}

/** Drop the cached keys so the next signed call re-fetches them (used on -403). */
export function invalidateWbiKeys() {
  cache = { imgKey: '', subKey: '', at: 0 }
}
