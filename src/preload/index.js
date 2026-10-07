import { contextBridge, ipcRenderer, webUtils } from 'electron'

const CHANNELS = [
  'app:ping',
  'auth:restore',
  'auth:qrGenerate',
  'auth:qrPoll',
  'auth:logout',
  'home:feed',
  'home:popular',
  'search:videos',
  'search:ups',
  'video:view',
  'video:pages',
  'video:playurl',
  'video:related',
  'video:danmaku',
  'video:online',
  'video:subtitle',
  'video:sendDanmaku',
  'up:info',
  'up:videos',
  'up:resolve',
  'up:latest',
  'up:followings',
  'fav:folders',
  'fav:resources',
  'settings:get',
  'settings:patch',
  'sys:openExternal',
  'sys:pickFile',
  'sys:revealPath',
  'sys:pickSubtitle',
  'sys:readSubtitle',
  'backup:write'
]

const allowed = new Set(CHANNELS)

function invoke(channel, payload) {
  if (!allowed.has(channel)) {
    return Promise.resolve({ ok: false, message: `未授权的通道：${channel}` })
  }
  return ipcRenderer.invoke(channel, payload)
}

/** 统一解包 { ok, data } 信封，失败时抛出带 message/needLogin 的 Error。 */
async function call(channel, payload) {
  const res = await invoke(channel, payload)
  if (res && res.ok) return res.data
  const err = new Error((res && res.message) || '请求失败')
  if (res && res.needLogin) err.needLogin = true
  if (res && res.code) err.biliCode = res.code
  throw err
}

const api = {
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
    // File.path 在 Electron 32+ 已移除，拖拽进来的文件必须走 webUtils 换真实路径
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    }
  },

  backup: {
    write: (dir, name, text) => call('backup:write', { dir, name, text })
  }
}

// 拖文件到窗口时浏览器默认会直接导航到 file://（整个应用白屏），这里统一拦住。
// 真正处理拖入文件的仍然是渲染层：preload 只把路径转成自定义事件广播出去（本地字幕就是这么加的）。
window.addEventListener(
  'dragover',
  (e) => {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  },
  true
)
window.addEventListener(
  'drop',
  (e) => {
    e.preventDefault()
    const files = e.dataTransfer && e.dataTransfer.files ? Array.from(e.dataTransfer.files) : []
    if (!files.length) return
    const paths = files.map((f) => api.sys.pathForFile(f)).filter(Boolean)
    if (!paths.length) return
    window.dispatchEvent(new CustomEvent('bili:files-dropped', { detail: { paths } }))
  },
  true
)

contextBridge.exposeInMainWorld('bili', api)
