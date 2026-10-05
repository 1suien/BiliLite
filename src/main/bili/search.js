import { api, fixUrl } from './http.js'
import { signParams, invalidateWbiKeys } from './wbi.js'
import { ensureBuvid } from './auth.js'

const SEARCH_TYPE = 'https://api.bilibili.com/x/web-interface/wbi/search/type'
const SEARCH_UP = 'https://api.bilibili.com/x/web-interface/wbi/search/type'

const ORDER = new Set(['totalrank', 'click', 'pubdate', 'dm', 'stow'])

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
}

function normalizeVideo(v) {
  return {
    bvid: v.bvid,
    aid: v.aid,
    title: stripHtml(v.title),
    cover: fixUrl(v.pic),
    upName: v.author,
    upMid: v.mid,
    play: v.play,
    danmaku: v.video_review,
    duration: v.duration,
    pubdate: v.pubdate,
    tag: stripHtml(v.tag)
  }
}

export async function searchVideo(keyword, page = 1, order = 'totalrank') {
  await ensureBuvid()
  const base = {
    search_type: 'video',
    keyword,
    page,
    page_size: 30,
    order: ORDER.has(order) ? order : 'totalrank'
  }
  let data
  try {
    data = await api(SEARCH_TYPE, { params: await signParams(base) })
  } catch (err) {
    if (err.biliCode === -403) {
      invalidateWbiKeys()
      data = await api(SEARCH_TYPE, { params: await signParams(base) })
    } else {
      throw err
    }
  }
  const items = (data.result || [])
    .filter((v) => v.bvid)
    .map(normalizeVideo)
  return {
    keyword,
    page,
    pages: data.numPages || 1,
    total: data.numResults || items.length,
    items
  }
}

export async function searchUp(keyword, page = 1) {
  await ensureBuvid()
  const base = {
    search_type: 'bili_user',
    keyword,
    page,
    page_size: 20
  }
  const data = await api(SEARCH_UP, { params: await signParams(base) })
  const items = (data.result || []).map((u) => ({
    mid: u.mid,
    name: stripHtml(u.uname),
    face: fixUrl(u.upic),
    fans: u.fans,
    videos: u.videos,
    sign: stripHtml(u.usign),
    level: u.level
  }))
  return { keyword, page, pages: data.numPages || 1, total: data.numResults || items.length, items }
}
