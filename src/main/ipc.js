import { ipcMain, shell, dialog, app } from 'electron'
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { store } from './store.js'
import { qrGenerate, qrPoll, restore, logout } from './bili/auth.js'
import { fetchView, fetchPages, fetchPlayurl, fetchRelated } from './bili/video.js'
import { searchVideo, searchUp } from './bili/search.js'
import { fetchRecommend, fetchPopular } from './bili/home.js'
import { fetchFavFolders, fetchCollectedFolders, fetchFavResources } from './bili/fav.js'
import { fetchUpInfo, fetchUpVideos, fetchLatestByMids, fetchFollowings, resolveUp } from './bili/space.js'
import { fetchDanmaku, fetchOnlineTotal, fetchSubtitle, sendDanmaku } from './bili/danmaku.js'
import { pickLocalFiles, pickLocalFolder, registerLocal, removeLocal, revealLocal } from './local-media.js'

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

const SUB_EXTS = ['srt', 'vtt', 'ass', 'ssa']
const SUB_MAX_BYTES = 8 * 1024 * 1024

/**
 * 读一个本地字幕文件给渲染层。
 * 只认字幕扩展名、只读普通文件、限制 8MB —— 渲染层拿到的是字节（Uint8Array），
 * 编码（UTF-8 / GB18030）由渲染层用 TextDecoder 自己嗅探，主进程不猜编码。
 */
async function readSubtitleFile(file) {
  if (!file || typeof file !== 'string') throw new Error('没有拿到字幕文件路径')
  const ext = extname(file).slice(1).toLowerCase()
  if (!SUB_EXTS.includes(ext)) {
    throw new Error(`不认这种字幕格式：.${ext || '?'}（支持 srt / vtt / ass / ssa）`)
  }
  const info = await stat(file)
  if (!info.isFile()) throw new Error('这不是一个文件')
  if (info.size > SUB_MAX_BYTES) {
    throw new Error(`字幕文件太大了（${(info.size / 1024 / 1024).toFixed(1)}MB，上限 8MB）`)
  }
  const bytes = await readFile(file)
  return { path: file, name: basename(file), size: info.size, bytes }
}

const handlers = {
  'app:ping': wrap(async () => ({ pong: Date.now(), version: app.getVersion() })),

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
  'video:danmaku': wrap(async ({ cid, segment }) => fetchDanmaku(cid, segment || 1)),
  'video:online': wrap(async ({ bvid, cid }) => fetchOnlineTotal(bvid, cid)),
  'video:subtitle': wrap(async ({ bvid, cid }) => fetchSubtitle(bvid, cid)),
  'video:sendDanmaku': wrap(async (payload) => sendDanmaku(payload)),

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
  // 本地字幕：选文件（只返回路径）+ 按路径读字节
  'sys:pickSubtitle': wrap(async () => {
    const res = await dialog.showOpenDialog({
      title: '选择字幕文件',
      buttonLabel: '加载',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '字幕', extensions: SUB_EXTS },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    return res.canceled ? [] : res.filePaths
  }),
  'sys:readSubtitle': wrap(async ({ path }) => readSubtitleFile(path)),

  // ---- 本地视频 ----
  // 选择/扫描只回传文件信息（路径、名字、大小、mime），解码、时长、缩略图都在渲染层用 <video> 做，
  // 这样主进程不需要任何音视频解析库（不引入 ffmpeg / mp4box）。
  'local:pickFiles': wrap(async () => pickLocalFiles()),
  'local:pickFolder': wrap(async () => pickLocalFolder()),
  // 把绝对路径注册成 lmedia://local/<id> 地址；渲染层每次启动都用本地列表里的路径换一次地址
  'local:register': wrap(async ({ paths }) => registerLocal(paths)),
  'local:remove': wrap(async ({ id }) => removeLocal(id)),
  'local:reveal': wrap(async ({ path }) => revealLocal(path)),

  // ---- 备份 ----
  'backup:write': wrap(async ({ dir, name, text }) => {
    if (!dir) throw new Error('还没有选择备份目录')
    await mkdir(dir, { recursive: true })
    const file = join(dir, basename(name || `bililite-${Date.now()}.json`))
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
