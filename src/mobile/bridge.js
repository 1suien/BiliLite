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
  return cachedVersion || '0.4.0'
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
  // 安卓没有「选一个可写目录」这种概念（要用 SAF），这里明确告诉用户
  'sys:pickFile': async () => {
    const err = new Error('安卓版暂不支持选择备份目录，学习数据仍然保存在本机应用内')
    throw err
  },
  'sys:revealPath': async () => true,
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

  // 安卓版不做本地视频库（要 SAF + 内容 URI 才能解码），给出明确提示
  'local:pickFiles': async () => {
    throw new Error('安卓版暂不支持本地视频库，可以直接搜索 B 站视频')
  },
  'local:pickFolder': async () => {
    throw new Error('安卓版暂不支持本地视频库，可以直接搜索 B 站视频')
  },
  'local:register': async () => ({ entries: [] }),
  'local:remove': async () => true,
  'local:reveal': async () => true,

  'backup:write': async ({ name, text }) => {
    // 安卓走 Capacitor Filesystem 写到应用的 Documents 目录
    try {
      const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
      const res = await Filesystem.writeFile({
        path: name || `bililite-${Date.now()}.json`,
        data: text,
        directory: Directory.Documents,
        encoding: Encoding.UTF8,
        recursive: true
      })
      return res.uri
    } catch (err) {
      throw new Error('导出失败：' + (err && err.message ? err.message : String(err)))
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
export function installBridge() {
  setBiliStore(store)
  // B 站接口全部由原生 CapacitorHttp 发出（见 native-http.js 的注释）：Referer /
  // Origin / Cookie 这三个头在浏览器 fetch 里是 forbidden header，设了也会被丢掉，
  // 而 B 站三者都依赖。既然头由我们自己写，Cookie 就继续自己拼（explicit）——
  // 扫码登录的凭据是从 poll 响应体的 data.url 查询串里解析出来的，
  // 不依赖 Set-Cookie，所以自拼 Cookie 完全够用。
  setCookieMode('explicit')
  setHttpFetch(createNativeFetch())
  store.load()
  window.bili = api
  return api
}

export default installBridge
