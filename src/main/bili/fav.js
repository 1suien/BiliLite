import { api, fixUrl } from './http.js'
import { store } from '../store.js'

const FOLDER_LIST = 'https://api.bilibili.com/x/v3/fav/folder/created/list-all'
const FOLDER_COLLECTED = 'https://api.bilibili.com/x/v3/fav/folder/collected/list'
const RESOURCE_LIST = 'https://api.bilibili.com/x/v3/fav/resource/list'

function requireLogin() {
  const user = store.state.user
  if (!user || !store.isLoggedIn()) {
    const err = new Error('请先扫码登录后再使用收藏功能')
    err.needLogin = true
    throw err
  }
  return user
}

function normalizeFolder(f) {
  return {
    id: f.id,
    fid: f.fid,
    mid: f.mid,
    title: f.title,
    cover: fixUrl(f.cover),
    mediaCount: f.media_count,
    attr: f.attr,
    isDefault: f.id === f.mid
  }
}

export async function fetchFavFolders() {
  const user = requireLogin()
  const data = await api(FOLDER_LIST, { params: { up_mid: user.mid, web_location: 333.1387 } })
  const list = (data && data.list) || []
  return list.map(normalizeFolder)
}

export async function fetchCollectedFolders() {
  const user = requireLogin()
  const data = await api(FOLDER_COLLECTED, {
    params: { up_mid: user.mid, pn: 1, ps: 20, web_location: 333.1387 }
  })
  const list = (data && data.list) || []
  return list.map(normalizeFolder)
}

export async function fetchFavResources(mediaId, pn = 1, ps = 20) {
  requireLogin()
  const data = await api(RESOURCE_LIST, {
    params: { media_id: mediaId, pn, ps, keyword: '', order: 'mtime', type: 0, tid: 0, platform: 'web' }
  })
  const info = data.info || {}
  const medias = (data.medias || []).map((m) => ({
    id: m.id,
    bvid: m.bvid,
    aid: m.id,
    title: m.title,
    cover: fixUrl(m.cover),
    intro: m.intro,
    duration: m.duration,
    upper: m.upper && m.upper.name,
    upperMid: m.upper && m.upper.mid,
    favTime: m.fav_time,
    pubtime: m.pubtime,
    cntInfo: m.cnt_info || {}
  }))
  return {
    info: {
      id: info.id,
      title: info.title,
      mediaCount: info.media_count,
      cover: fixUrl(info.cover)
    },
    hasMore: Boolean(data.has_more),
    medias
  }
}
