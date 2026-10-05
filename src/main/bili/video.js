import { api, fixUrl } from './http.js'
import { signParams } from './wbi.js'

const VIEW = 'https://api.bilibili.com/x/web-interface/view'
const PAGELIST = 'https://api.bilibili.com/x/player/pagelist'
const PLAYURL = 'https://api.bilibili.com/x/player/wbi/playurl'
const RELATED = 'https://api.bilibili.com/x/web-interface/archive/related'

/** fnval 位掩码：DASH + HDR + 4K + 杜比音频 + 杜比视界 + 8K + AV1 */
const FNVAL = 16 + 64 + 128 + 256 + 512 + 1024 + 2048

export function normalizeView(d) {
  const pages = (d.pages || []).map((p) => ({
    cid: p.cid,
    page: p.page,
    part: p.part,
    duration: p.duration
  }))
  return {
    aid: d.aid,
    bvid: d.bvid,
    cid: d.cid,
    title: d.title,
    desc: d.desc || '',
    cover: fixUrl(d.pic),
    pubdate: d.pubdate,
    duration: d.duration,
    tname: d.tname || '',
    owner: {
      mid: d.owner && d.owner.mid,
      name: (d.owner && d.owner.name) || '',
      face: fixUrl(d.owner && d.owner.face)
    },
    stat: {
      view: (d.stat && d.stat.view) || 0,
      danmaku: (d.stat && d.stat.danmaku) || 0,
      like: (d.stat && d.stat.like) || 0,
      coin: (d.stat && d.stat.coin) || 0,
      favorite: (d.stat && d.stat.favorite) || 0,
      reply: (d.stat && d.stat.reply) || 0
    },
    pages: pages.length ? pages : [{ cid: d.cid, page: 1, part: d.title, duration: d.duration }]
  }
}

export async function fetchView(bvid) {
  const d = await api(VIEW, { params: { bvid } })
  return normalizeView(d)
}

export async function fetchPages(bvid) {
  const d = await api(PAGELIST, { params: { bvid } })
  return (d || []).map((p) => ({ cid: p.cid, page: p.page, part: p.part, duration: p.duration }))
}

export async function fetchRelated(bvid) {
  const d = await api(RELATED, { params: { bvid } })
  return (d || []).map((v) => ({
    bvid: v.bvid,
    title: v.title,
    cover: fixUrl(v.pic),
    upName: v.owner && v.owner.name,
    play: (v.stat && v.stat.view) || 0,
    duration: v.duration,
    pubdate: v.pubdate
  }))
}

function pickTrack(list, mapper) {
  if (!Array.isArray(list)) return []
  return list.map(mapper).filter((t) => t.url)
}

export async function fetchPlayurl(bvid, cid, qn = 80) {
  const params = await signParams({
    bvid,
    cid,
    qn,
    fnver: 0,
    fnval: FNVAL,
    fourk: 1,
    platform: 'pc',
    high_quality: 1
  })
  const d = await api(PLAYURL, { params })
  const dash = d.dash
  return {
    mode: dash ? 'dash' : 'durl',
    quality: d.quality,
    acceptQuality: d.accept_quality || [],
    acceptDescription: d.accept_description || [],
    supportFormats: (d.support_formats || []).map((f) => ({
      quality: f.quality,
      label: f.new_description || f.display_desc || f.format,
      codecs: f.codecs
    })),
    dash: dash
      ? {
          duration: dash.duration,
          video: pickTrack(dash.video, (v) => ({
            id: v.id,
            url: fixUrl(v.baseUrl || v.base_url),
            backup: (v.backupUrl || v.backup_url || []).map(fixUrl),
            codecs: v.codecs,
            mimeType: v.mimeType || 'video/mp4',
            width: v.width,
            height: v.height,
            bandwidth: v.bandwidth,
            frameRate: v.frameRate
          })),
          audio: pickTrack(dash.audio, (a) => ({
            id: a.id,
            url: fixUrl(a.baseUrl || a.base_url),
            backup: (a.backupUrl || a.backup_url || []).map(fixUrl),
            codecs: a.codecs,
            mimeType: a.mimeType || 'audio/mp4',
            bandwidth: a.bandwidth
          }))
        }
      : null,
    durl: (d.durl || []).map((x) => ({
      url: fixUrl(x.url),
      backup: (x.backup_url || []).map(fixUrl),
      size: x.size,
      length: x.length
    }))
  }
}
