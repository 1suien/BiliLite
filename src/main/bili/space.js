import { api, fixUrl } from './http.js'
import { signParams } from './wbi.js'

const ARC_SEARCH = 'https://api.bilibili.com/x/space/wbi/arc/search'
const CARD = 'https://api.bilibili.com/x/web-interface/card'

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
  const data = await api(ARC_SEARCH, { params: await signParams(base) })
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
