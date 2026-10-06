import { api, fixUrl } from './http.js'
import { signParams, invalidateWbiKeys } from './wbi.js'
import { searchUp } from './search.js'
import { ensureBuvid } from './auth.js'

const ARC_SEARCH = 'https://api.bilibili.com/x/space/wbi/arc/search'
const CARD = 'https://api.bilibili.com/x/web-interface/card'
const RELATION_FOLLOWINGS = 'https://api.bilibili.com/x/relation/followings'

/** 每个 UP 的最新投稿缓存：mid → { at, perUp, items } */
const latestCache = new Map()
const LATEST_TTL = 5 * 60 * 1000
const LATEST_CONCURRENCY = 4

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

export async function fetchUpInfo(mid) {
  const data = await api(CARD, { params: { mid, photo: false } })
  const c = data.card || {}
  return {
    mid: c.mid,
    name: c.name,
    face: fixUrl(c.face),
    fans: c.fans,
    sign: c.sign,
    level: c.level_info && c.level_info.current_level
  }
}

export async function fetchUpVideos(mid, pn = 1, ps = 30, keyword = '') {
  const base = {
    mid,
    pn,
    ps,
    tid: 0,
    keyword,
    order: 'pubdate',
    platform: 'web',
    web_location: 1550101,
    order_avoided: true
  }
  // 空间投稿接口匿名访问容易风控（-352/-412）或 wbi 过期（-403），重试一次兜底
  let data
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      data = await api(ARC_SEARCH, { params: await signParams(base) })
      break
    } catch (err) {
      const code = err && err.biliCode
      if (attempt === 0 && (code === -352 || code === -412)) {
        await ensureBuvid(true)
        await sleepMs(600)
        continue
      }
      if (attempt === 0 && code === -403) {
        invalidateWbiKeys()
        await sleepMs(300)
        continue
      }
      throw err
    }
  }
  const list = (data.list && data.list.vlist) || []
  return {
    page: data.page || {},
    items: list.map((v) => ({
      bvid: v.bvid,
      aid: v.aid,
      title: v.title,
      cover: fixUrl(v.pic),
      play: v.play,
      comment: v.comment,
      pubdate: v.created,
      length: v.length,
      description: v.description
    }))
  }
}

/** "MM:SS" / "HH:MM:SS" → 秒 */
function lengthToSeconds(text) {
  const parts = String(text || '')
    .split(':')
    .map((x) => Number(x) || 0)
  if (parts.length >= 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] || 0
}

/**
 * 批量取一批 UP 的最新投稿（首页「关注的 UP 更新」用）。
 * 并发 4，单个 UP 失败不影响其它；结果按发布时间倒序。
 */
export async function fetchLatestByMids(mids, perUp = 2, opts = {}) {
  const list = [...new Set((Array.isArray(mids) ? mids : []).map(String).filter(Boolean))].slice(0, 60)
  const limit = Math.max(1, Math.min(Number(perUp) || 2, 12))
  const useCache = opts.cache !== false
  const items = []
  const errors = []
  let cursor = 0

  async function one(mid) {
    const hit = latestCache.get(mid)
    if (useCache && hit && Date.now() - hit.at < LATEST_TTL && hit.perUp >= limit) return hit.items
    const res = await fetchUpVideos(mid, 1, limit)
    const rows = (res.items || []).map((v) => ({
      bvid: v.bvid,
      aid: v.aid,
      title: v.title,
      cover: v.cover,
      play: v.play,
      pubdate: v.pubdate,
      duration: lengthToSeconds(v.length),
      upMid: Number(mid)
    }))
    latestCache.set(mid, { at: Date.now(), perUp: limit, items: rows })
    return rows
  }

  async function worker() {
    while (cursor < list.length) {
      const mid = list[cursor++]
      try {
        const rows = await one(mid)
        for (const row of rows) items.push(row)
      } catch (err) {
        errors.push({ mid, message: (err && err.message) || String(err) })
      }
    }
  }

  const workers = Math.min(LATEST_CONCURRENCY, list.length)
  await Promise.all(Array.from({ length: workers }, worker))
  items.sort((a, b) => (b.pubdate || 0) - (a.pubdate || 0))
  return { items, errors, total: list.length, fetchedAt: Date.now() }
}

/** 读取自己的 B 站关注列表（需要登录） */
export async function fetchFollowings(vmid, pn = 1, ps = 50) {
  if (!vmid) {
    const err = new Error('需要先扫码登录才能导入 B 站关注列表')
    err.needLogin = true
    throw err
  }
  const base = { vmid: String(vmid), pn, ps, order: 'desc', order_type: 'attention' }
  let data
  try {
    data = await api(RELATION_FOLLOWINGS, { params: await signParams(base) })
  } catch (err) {
    // 关注列表部分版本要求 wbi 签名、部分版本要求不签名，双向兜底
    if (err.biliCode === -403 || err.biliCode === -352) {
      data = await api(RELATION_FOLLOWINGS, { params: base })
    } else {
      throw err
    }
  }
  const list = data.list || []
  return {
    page: pn,
    total: data.total || list.length,
    items: list.map((u) => ({
      mid: u.mid,
      name: u.uname,
      face: fixUrl(u.face),
      sign: u.sign,
      fans: u.fans,
      official: (u.official_verify && u.official_verify.desc) || ''
    }))
  }
}

/** 把用户输入的 UID / 空间链接 / 昵称解析成一个 UP */
export async function resolveUp(query) {
  const q = String(query || '').trim()
  if (!q) throw new Error('请输入 UP 主的 UID、空间主页链接或昵称')

  const fromUrl = /space\.bilibili\.com\/(\d+)/.exec(q)
  const mid = fromUrl ? fromUrl[1] : /^\d{1,12}$/.test(q) ? q : ''
  if (mid) {
    try {
      const info = await fetchUpInfo(mid)
      if (info && info.mid) return info
    } catch (err) {
      // 数字但查不到，继续当昵称搜
    }
  }

  const res = await searchUp(q, 1)
  const hit = res.items && res.items[0]
  if (!hit) throw new Error('没有找到这个 UP 主，换个 UID 或昵称试试')
  return {
    mid: hit.mid,
    name: hit.name,
    face: hit.face,
    fans: hit.fans,
    sign: hit.sign,
    level: hit.level,
    videos: hit.videos
  }
}
