import { ipcMain, shell, dialog } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { store } from './store.js'
import { qrGenerate, qrPoll, restore, logout } from './bili/auth.js'
import { fetchView, fetchPages, fetchPlayurl, fetchRelated } from './bili/video.js'
import { searchVideo, searchUp } from './bili/search.js'
import { fetchRecommend, fetchPopular } from './bili/home.js'
import { fetchFavFolders, fetchCollectedFolders, fetchFavResources } from './bili/fav.js'
import { fetchUpInfo, fetchUpVideos, fetchLatestByMids, fetchFollowings, resolveUp } from './bili/space.js'

function wrap(handler) {
  return async (_event, payload) => {
    try {
      const data = await handler(payload || {})
      return { ok: true, data }
    } catch (err) {
      return {
        ok: false,
        message: err && err.message ? err.message : String(err),
        code: err && err.biliCode,
        needLogin: Boolean(err && err.needLogin)
      }
    }
  }
}

const handlers = {
  'app:ping': wrap(async () => ({ pong: Date.now(), version: '0.1.0' })),

  // ---- 认证 ----
  'auth:restore': wrap(async () => ({ user: await restore(), loggedIn: store.isLoggedIn() })),
  'auth:qrGenerate': wrap(async () => qrGenerate()),
  'auth:qrPoll': wrap(async ({ qrcodeKey }) => qrPoll(qrcodeKey)),
  'auth:logout': wrap(async () => logout()),

  // ---- 首页 ----
  'home:feed': wrap(async ({ page }) => fetchRecommend(page || 1)),
  'home:popular': wrap(async ({ page }) => fetchPopular(page || 1)),

  // ---- 搜索 ----
  'search:videos': wrap(async ({ keyword, page, order }) => searchVideo(keyword, page || 1, order || 'totalrank')),
  'search:ups': wrap(async ({ keyword, page }) => searchUp(keyword, page || 1)),

  // ---- 视频 ----
  'video:view': wrap(async ({ bvid }) => fetchView(bvid)),
  'video:pages': wrap(async ({ bvid }) => fetchPages(bvid)),
  'video:playurl': wrap(async ({ bvid, cid, qn }) => fetchPlayurl(bvid, cid, qn || 80)),
  'video:related': wrap(async ({ bvid }) => fetchRelated(bvid)),

  // ---- UP 主 ----
  'up:info': wrap(async ({ mid }) => fetchUpInfo(mid)),
  'up:videos': wrap(async ({ mid, pn, keyword }) => fetchUpVideos(mid, pn || 1, 30, keyword || '')),
  'up:resolve': wrap(async ({ query }) => resolveUp(query)),
  'up:latest': wrap(async ({ mids, perUp }) => fetchLatestByMids(mids, perUp || 2)),
  'up:followings': wrap(async ({ pn, ps }) =>
    fetchFollowings(store.state.user && store.state.user.mid, pn || 1, ps || 50)
  ),

  // ---- 收藏 ----
  'fav:folders': wrap(async () => ({
    created: await fetchFavFolders(),
    collected: await fetchCollectedFolders()
  })),
  'fav:resources': wrap(async ({ mediaId, pn }) => fetchFavResources(mediaId, pn || 1, 20)),

  // ---- 设置 ----
  'settings:get': wrap(async () => store.state.settings),
  'settings:patch': wrap(async (patch) => store.patchSettings(patch)),

  // ---- 系统 ----
  'sys:openExternal': wrap(async ({ url }) => {
    if (/^https?:\/\//.test(url || '')) await shell.openExternal(url)
    return true
  }),
  'sys:pickFile': wrap(async () => {
    const res = await dialog.showOpenDialog({ title: '选择目录', properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? '' : res.filePaths[0]
  }),
  'sys:revealPath': wrap(async ({ path }) => {
    if (path) shell.showItemInFolder(path)
    return true
  }),

  // ---- 备份 ----
  'backup:write': wrap(async ({ dir, name, text }) => {
    if (!dir) throw new Error('还没有选择备份目录')
    await mkdir(dir, { recursive: true })
    const file = join(dir, basename(name || `study-bili-${Date.now()}.json`))
    await writeFile(file, text, 'utf8')
    return file
  })
}

export function registerIpc() {
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, handler)
  }
  return Object.keys(handlers)
}
