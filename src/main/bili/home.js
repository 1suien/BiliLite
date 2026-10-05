import { api, fixUrl } from './http.js'
import { signParams, invalidateWbiKeys } from './wbi.js'
import { ensureBuvid } from './auth.js'

const RCMD = 'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd'
const RANKING = 'https://api.bilibili.com/x/web-interface/ranking/v2'
const POPULAR = 'https://api.bilibili.com/x/web-interface/popular'

function normalize(v) {
  const owner = v.owner || {}
  const stat = v.stat || {}
  return {
    bvid: v.bvid,
    aid: v.aid,
    cid: v.cid,
    title: v.title,
    cover: fixUrl(v.pic),
    upName: owner.name || v.author,
    upMid: owner.mid || v.mid,
    play: stat.view != null ? stat.view : v.play,
    danmaku: stat.danmaku != null ? stat.danmaku : v.video_review,
    duration: v.duration,
    pubdate: v.pubdate,
    reason: v.rcmd_reason && v.rcmd_reason.content
  }
}

export async function fetchRecommend(page = 1) {
  await ensureBuvid()
  const base = {
    web_location: 1430650,
    feed_version: 'V8',
    fresh_type: 4,
    ps: 12,
    fresh_idx: page,
    fresh_idx_1h: page,
    fetch_row: page
  }
  try {
    const data = await api(RCMD, { params: await signParams(base) })
    const items = (data.item || []).filter((v) => v.bvid).map(normalize)
    if (items.length) return { source: 'recommend', items }
  } catch (err) {
    if (err.biliCode === -403) invalidateWbiKeys()
  }
  return fetchPopular(page)
}

export async function fetchPopular(page = 1) {
  try {
    const data = await api(POPULAR, { params: { pn: page, ps: 20, web_location: 333.934 } })
    const items = (data.list || []).map(normalize)
    return { source: 'popular', items }
  } catch {
    const data = await api(RANKING, { params: { rid: 0, type: 'all' } })
    return { source: 'ranking', items: (data.list || []).map(normalize) }
  }
}
