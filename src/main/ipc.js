import { ipcMain, shell, dialog, app, BrowserWindow } from 'electron'
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
import {
  initVideoCache,
  listCache,
  cacheStats,
  lookupCache,
  probeCache,
  startCache,
  cancelCache,
  removeCache,
  clearCache,
  revealCache,
  runningTasks,
  exportCache
} from './video-cache.js'

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

  // ---- 离线缓存 ----
  // 列表接口一次性把「已缓存 + 正在下载 + 占用统计」都给渲染层，省得缓存页发三次请求
  'cache:list': wrap(async () => ({ rows: await listCache(), tasks: runningTasks(), stats: await cacheStats() })),
  'cache:stats': wrap(async () => cacheStats()),
  'cache:local': wrap(async ({ bvid, cid }) => lookupCache(bvid, cid)),
  'cache:probe': wrap(async ({ bvid, cid, qn }) => probeCache({ bvid, cid, qn })),
  'cache:start': wrap(async (req) => startCache(req)),
  'cache:cancel': wrap(async ({ key }) => cancelCache(key)),
  'cache:remove': wrap(async ({ key }) => removeCache(key)),
  'cache:clear': wrap(async () => clearCache()),
  'cache:reveal': wrap(async ({ key }) => revealCache(key)),
  'cache:export': wrap(async ({ key, saveAs }) => {
    if (!saveAs) return exportCache(key)
    const rows = await listCache()
    const row = rows.find((r) => r.key === key)
    const base = row && row.title ? `${row.title}${row.page ? ` P${row.page}` : ''}` : String(key || '').replace(':', '-')
    const safe = `${base}.mp4`.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)
    const res = await dialog.showSaveDialog({
      title: '导出为 MP4',
      defaultPath: safe,
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
    })
    if (res.canceled || !res.filePath) return { canceled: true }
    return exportCache(key, { outPath: res.filePath })
  }),

  // ---- 备份 ----
  'backup:write': wrap(async ({ dir, name, text }) => {
    if (!dir) throw new Error('还没有选择备份目录')
    await mkdir(dir, { recursive: true })
    const file = join(dir, basename(name || `bililite-${Date.now()}.json`))
    await writeFile(file, text, 'utf8')
    return file
  })
}

/**
 * 缓存模块初始化：目录固定在 `<userData>/offline-cache`，下载进度通过 `cache:progress`
 * 事件广播给所有窗口（渲染层用 preload 暴露的 api.cache.onProgress 订阅）。
 *
 * ⚠ 别用 `<userData>/cache`：Windows 路径大小写不敏感，那正好是 Chromium 自己的
 * HTTP 磁盘缓存目录（`Cache/Cache_Data/...`），我们的分片会和它混在一起 —— 占用统计、
 * 清空缓存都会误伤浏览器缓存（实测第一次跑就出现了 `cache/Cache_Data/data_3` 这种文件）。
 */
function initCache() {
  initVideoCache({
    root: join(app.getPath('userData'), 'offline-cache'),
    getPlayurl: (bvid, cid, qn) => fetchPlayurl(bvid, cid, qn || 80),
    onProgress: (payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('cache:progress', payload)
      }
    }
  })
}

export function registerIpc() {
  initCache()
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, handler)
  }
  return Object.keys(handlers)
}
