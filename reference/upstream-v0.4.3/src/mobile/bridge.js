/**
 * 安卓端把桌面端的 `window.bili` 桥接层**原样重实现一遍**。
 *
 * 关键设计：渲染层 `src/renderer/src/api/index.js` 只认 `window.bili` 这一个门面，
 * 它不关心对面是 Electron 的 IPC 还是 WebView 里的函数调用。所以安卓端只要在
 * Vue 挂载**之前**把同样形状的 `window.bili` 装上去，**整个渲染层一行都不用改**。
 *
 * 数据与网络逻辑全部复用 `src/main/bili/*`（那一层已经和 electron 解耦，只保留
 * fetch / URL / AbortController）。桌面端独有的能力（选目录、本地视频库、
 * 在资源管理器里定位文件）在这里给出等价的移动端实现或明确的中文提示。
 */

import { setBiliStore, storeProxy } from '../main/bili/runtime.js'
import { setCookieMode, setHttpFetch } from '../main/bili/http.js'
import { createNativeFetch } from './native-http.js'
import { acceptFiles, registerPaths, forget } from './local-files.js'
import { store } from './store.js'
import { qrGenerate, qrPoll, restore, logout } from '../main/bili/auth.js'
import { fetchView, fetchPages, fetchPlayurl, fetchRelated } from '../main/bili/video.js'
import { searchVideo, searchUp } from '../main/bili/search.js'
import { fetchRecommend, fetchPopular } from '../main/bili/home.js'
import { fetchFavFolders, fetchCollectedFolders, fetchFavResources } from '../main/bili/fav.js'
import { fetchUpInfo, fetchUpVideos, fetchLatestByMids, fetchFollowings, resolveUp } from '../main/bili/space.js'
import { fetchDanmaku, fetchOnlineTotal, fetchSubtitle, sendDanmaku } from '../main/bili/danmaku.js'

const storeRef = storeProxy()

/** 版本号：优先问 Capacitor 的 App 插件，拿不到就退回构建时注入的常量。 */
let cachedVersion = ''

async function appVersion() {
  if (cachedVersion) return cachedVersion
  try {
    const mod = await import('@capacitor/app')
    const info = await mod.App.getInfo()
    cachedVersion = (info && info.version) || ''
  } catch {
    cachedVersion = ''
  }
  return cachedVersion || '0.4.1'
}

/* ------------------------------------------------------------------ *
 * 移动端的文件选择：用隐藏的 <input type="file"> 顶替 Electron 的 dialog
 * ------------------------------------------------------------------ */

function pickFilesFromInput({ accept = '', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (accept) input.accept = accept
    input.multiple = multiple
    input.style.position = 'fixed'
    input.style.left = '-10000px'
    document.body.appendChild(input)
    const done = (files) => {
      input.remove()
      resolve(files || [])
    }
    input.addEventListener('change', () => done(Array.from(input.files || [])))
    // 安卓上取消选择不会触发 change，靠窗口重新获得焦点兜底
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => {
          if (document.body.contains(input)) done([])
        }, 800)
      },
      { once: true }
    )
    input.click()
  })
}

function readFileBytes(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(new Uint8Array(fr.result))
    fr.onerror = () => reject(new Error('读取文件失败'))
    fr.readAsArrayBuffer(file)
  })
}

/** 字幕：路徑 -> File 的临时映射（安卓没有真实可读路径） */
const subCache = new Map()

/** 设置页「备份目录」里显示的名字：安卓上没有可写的绝对路径可填 */
const BACKUP_LABEL = '本机（导出时用系统面板选保存位置）'

/** 最近一次导出的备份文件；`设置 → 打开` 用它再弹一次分享面板 */
let lastBackupUri = ''

/** 把文件丢进系统分享面板，用户可选「保存到文件 / 网盘 / 微信…」 */
async function shareFile(uri, title) {
  const { Share } = await import('@capacitor/share')
  await Share.share({ title, text: title, files: [uri], dialogTitle: '保存到…' })
}

const SUB_EXTS = ['srt', 'vtt', 'ass', 'ssa']
const SUB_MAX_BYTES = 8 * 1024 * 1024

/* ------------------------------------------------------------------ *
 * 通道表：与 src/main/ipc.js 一一对应
 * ------------------------------------------------------------------ */

const handlers = {
  'app:ping': async () => ({ pong: Date.now(), version: await appVersion() }),

  // 与桌面端一样：restore() 自己就返回 { loggedIn, user }，不要再套一层
  'auth:restore': async () => {
    const r = (await restore()) || {}
    return { user: r.user || null, loggedIn: Boolean(r.loggedIn), stale: Boolean(r.stale), message: r.message || '' }
  },
  'auth:qrGenerate': async () => qrGenerate(),
  'auth:qrPoll': async ({ qrcodeKey }) => qrPoll(qrcodeKey),
  'auth:logout': async () => logout(),

  'home:feed': async ({ page }) => fetchRecommend(page || 1),
  'home:popular': async ({ page }) => fetchPopular(page || 1),

  'search:videos': async ({ keyword, page, order }) => searchVideo(keyword, page || 1, order || 'totalrank'),
  'search:ups': async ({ keyword, page }) => searchUp(keyword, page || 1),

  'video:view': async ({ bvid }) => fetchView(bvid),
  'video:pages': async ({ bvid }) => fetchPages(bvid),
  'video:playurl': async ({ bvid, cid, qn }) => fetchPlayurl(bvid, cid, qn || 80),
  'video:related': async ({ bvid }) => fetchRelated(bvid),
  'video:danmaku': async ({ cid, segment }) => fetchDanmaku(cid, segment || 1),
  'video:online': async ({ bvid, cid }) => fetchOnlineTotal(bvid, cid),
  'video:subtitle': async ({ bvid, cid }) => fetchSubtitle(bvid, cid),
  'video:sendDanmaku': async (payload) => sendDanmaku(payload),

  'up:info': async ({ mid }) => fetchUpInfo(mid),
  'up:videos': async ({ mid, pn, keyword }) => fetchUpVideos(mid, pn || 1, 30, keyword || ''),
  'up:resolve': async ({ query }) => resolveUp(query),
  'up:latest': async ({ mids, perUp }) => fetchLatestByMids(mids, perUp || 2),
  'up:followings': async ({ pn, ps }) =>
    fetchFollowings(storeRef.state.user && storeRef.state.user.mid, pn || 1, ps || 50),

  'fav:folders': async () => ({
    created: await fetchFavFolders(),
    collected: await fetchCollectedFolders()
  }),
  'fav:resources': async ({ mediaId, pn }) => fetchFavResources(mediaId, pn || 1, 20),

  'settings:get': async () => storeRef.state.settings,
  'settings:patch': async (patch) => storeRef.patchSettings(patch),

  // 安卓：交给系统浏览器打开（Capacitor 的 _system 目标）
  'sys:openExternal': async ({ url }) => {
    if (/^https?:\/\//.test(url || '')) {
      const w = window.open(url, '_system')
      if (!w) window.location.href = url
    }
    return true
  },
  // 安卓没有「选一个可写目录」这种概念：SAF 给的目录没有可回写的绝对路径，
  // 写公共「文档」目录又要额外权限。所以这里只给个说明字符串，真正落地靠
  // backup:write —— 文件先写进应用目录，再弹系统分享面板让用户自己选存哪儿。
  'sys:pickFile': async () => BACKUP_LABEL,
  'sys:revealPath': async () => {
    if (!lastBackupUri) throw new Error('还没有导出过备份；先点「写入 JSON 备份」')
    // 安卓上没有「在资源管理器里定位」，等价物是再分享一次那个文件
    await shareFile(lastBackupUri, 'BiliLite 学习数据备份')
    return true
  },
  'sys:pickSubtitle': async () => {
    const files = await pickFilesFromInput({ accept: '.srt,.vtt,.ass,.ssa', multiple: true })
    const out = []
    for (const f of files) {
      const ext = (f.name.split('.').pop() || '').toLowerCase()
      if (!SUB_EXTS.includes(ext)) continue
      if (f.size > SUB_MAX_BYTES) continue
      const fake = `subtitle://${f.name}#${out.length}`
      subCache.set(fake, f)
      out.push(fake)
    }
    return out
  },
  'sys:readSubtitle': async ({ path }) => {
    const f = subCache.get(path)
    if (!f) throw new Error('字幕文件已失效，请重新选择')
    const bytes = await readFileBytes(f)
    return { path, name: f.name, size: f.size, bytes }
  },

  // 本地视频库：安卓上等价物是系统文件选择器（SAF）+ blob: URL，
  // 见 src/mobile/local-files.js 顶部的说明（含「重启后要重选」这条限制）
  'local:pickFiles': async () => {
    const files = await pickFilesFromInput({ accept: 'video/*,audio/*', multiple: true })
    if (!files.length) return { canceled: true }
    return { entries: acceptFiles(files) }
  },
  'local:pickFolder': async () => {
    // 没有「选文件夹」这个动作，等价物就是一次多选
    const files = await pickFilesFromInput({ accept: 'video/*,audio/*', multiple: true })
    if (!files.length) return { canceled: true }
    return { dir: '本机文件', entries: acceptFiles(files), truncated: files.length >= 500 }
  },
  'local:register': async ({ paths }) => registerPaths(paths),
  'local:remove': async ({ id }) => forget(id),
  'local:reveal': async () => {
    throw new Error('安卓上没有「在资源管理器里定位」，去系统「文件」应用里找这个文件')
  },

  'backup:write': async ({ name, text }) => {
    const file = name || `bililite-${Date.now()}.json`
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
    // ① 先试公共「文档」目录：写成功的话插到电脑上就能看到（Android 9 及以下，
    //    或用户给过「所有文件访问」权限时才可能成功）
    let uri = ''
    let where = '文档'
    try {
      const res = await Filesystem.writeFile({
        path: file,
        data: String(text == null ? '' : text),
        directory: Directory.Documents,
        encoding: Encoding.UTF8,
        recursive: true
      })
      uri = res.uri
    } catch {
      // ② 分区存储下写公共目录必然失败，退到应用私有目录（一定能写）
      const res = await Filesystem.writeFile({
        path: file,
        data: String(text == null ? '' : text),
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
        recursive: true
      })
      uri = res.uri
      where = '应用缓存'
    }
    lastBackupUri = uri
    // ③ 再弹系统分享面板：用户可以自己决定存到「文件」、网盘、微信……
    //    安卓上这才是「把数据存到本地」的正路（应用私有目录用户看不到）
    try {
      await shareFile(uri, `BiliLite 学习数据备份 ${file}`)
      return `${where}/${file}（已打开「保存到」面板，可另存到任意位置）`
    } catch {
      // 用户取消分享、或设备没有分享面板：文件本身已经写好了
      return `${where}/${file}`
    }
  }
}

function unwrap(promise) {
  return Promise.resolve()
    .then(promise)
    .catch((err) => {
      const e = new Error((err && err.message) || '请求失败')
      if (err && err.needLogin) e.needLogin = true
      if (err && err.biliCode) e.biliCode = err.biliCode
      throw e
    })
}

/** 与 preload 一样：invoke 返回 { ok, data } 信封，call 负责解包。 */
function invoke(channel, payload) {
  const h = handlers[channel]
  if (!h) return Promise.resolve({ ok: false, message: `未授权的通道：${channel}` })
  return Promise.resolve()
    .then(() => h(payload || {}))
    .then((data) => ({ ok: true, data }))
    .catch((err) => ({
      ok: false,
      message: (err && err.message) || String(err),
      code: err && err.biliCode,
      needLogin: Boolean(err && err.needLogin)
    }))
}

async function call(channel, payload) {
  const res = await invoke(channel, payload)
  if (res && res.ok) return res.data
  const err = new Error((res && res.message) || '请求失败')
  if (res && res.needLogin) err.needLogin = true
  if (res && res.code) err.biliCode = res.code
  throw err
}

export const api = {
  /** 渲染层用它区分平台（有些入口在安卓上要隐藏，比如本地视频库） */
  platform: 'android',
  invoke,
  call,
  ping: () => call('app:ping'),

  auth: {
    restore: () => call('auth:restore'),
    qrGenerate: () => call('auth:qrGenerate'),
    qrPoll: (qrcodeKey) => call('auth:qrPoll', { qrcodeKey }),
    logout: () => call('auth:logout')
  },

  home: {
    feed: (page = 1) => call('home:feed', { page }),
    popular: (page = 1) => call('home:popular', { page })
  },

  search: {
    videos: (keyword, page = 1, order = 'totalrank') => call('search:videos', { keyword, page, order }),
    ups: (keyword, page = 1) => call('search:ups', { keyword, page })
  },

  video: {
    view: (bvid) => call('video:view', { bvid }),
    pages: (bvid) => call('video:pages', { bvid }),
    playurl: (bvid, cid, qn) => call('video:playurl', { bvid, cid, qn }),
    related: (bvid) => call('video:related', { bvid }),
    danmaku: (cid, segment = 1) => call('video:danmaku', { cid, segment }),
    online: (bvid, cid) => call('video:online', { bvid, cid }),
    subtitle: (bvid, cid) => call('video:subtitle', { bvid, cid }),
    sendDanmaku: (payload) => call('video:sendDanmaku', payload)
  },

  up: {
    info: (mid) => call('up:info', { mid }),
    videos: (mid, pn = 1, keyword = '') => call('up:videos', { mid, pn, keyword }),
    resolve: (query) => call('up:resolve', { query }),
    latest: (mids, perUp = 2) => call('up:latest', { mids, perUp }),
    followings: (pn = 1, ps = 50) => call('up:followings', { pn, ps })
  },

  fav: {
    folders: () => call('fav:folders'),
    resources: (mediaId, pn = 1) => call('fav:resources', { mediaId, pn })
  },

  settings: {
    get: () => call('settings:get'),
    patch: (patch) => call('settings:patch', patch)
  },

  sys: {
    openExternal: (url) => call('sys:openExternal', { url }),
    pickFile: () => call('sys:pickFile'),
    revealPath: (path) => call('sys:revealPath', { path }),
    pickSubtitle: () => call('sys:pickSubtitle'),
    readSubtitle: (path) => call('sys:readSubtitle', { path }),
    // 触屏没有「拖文件进来」，保留空实现让渲染层不用分支
    pathForFile: () => ''
  },

  backup: {
    write: (dir, name, text) => call('backup:write', { dir, name, text })
  },

  local: {
    pickFiles: () => call('local:pickFiles'),
    pickFolder: () => call('local:pickFolder'),
    register: (paths) => call('local:register', { paths }),
    remove: (id) => call('local:remove', { id }),
    reveal: (path) => call('local:reveal', { path })
  }
}

/**
 * 把桥接层装到 window 上。必须在 `src/renderer/src/api/index.js` 被求值之前调用
 * （那里是模块顶层 `const bridge = window.bili`）。
 */
export async function installBridge() {
  setBiliStore(store)
  // B 站接口全部由原生 CapacitorHttp 发出（见 native-http.js 的注释）：Referer /
  // Origin / Cookie 这三个头在浏览器 fetch 里是 forbidden header，设了也会被丢掉，
  // 而 B 站三者都依赖。既然头由我们自己写，Cookie 就继续自己拼（explicit）——
  // 扫码登录的凭据是从 poll 响应体的 data.url 查询串里解析出来的，
  // 不依赖 Set-Cookie，所以自拼 Cookie 完全够用。
  setCookieMode('explicit')
  setHttpFetch(createNativeFetch())
  // 存储走原生 Preferences，是异步的：必须等真实设置/登录态读出来再挂渲染层，
  // 否则会先闪一下默认主题和「未登录」
  await store.load()
  window.bili = api
  return api
}

export default installBridge
