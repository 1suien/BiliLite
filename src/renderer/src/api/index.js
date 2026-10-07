/**
 * 渲染层 API 门面。
 * 真正的实现在主进程（src/main/bili/*），这里只通过 preload 暴露的 window.bili 调用。
 */

const bridge = typeof window !== 'undefined' ? window.bili : null

export const hasBridge = Boolean(bridge)

function missing() {
  const err = new Error('未检测到桌面端桥接（window.bili）。请通过 Electron 启动，而不是直接用浏览器打开。')
  err.needLogin = false
  return Promise.reject(err)
}

function proxy(path) {
  return bridge
    ? path
    : () => missing()
}

export const api = {
  ping: proxy(() => bridge.ping()),

  auth: {
    restore: proxy(() => bridge.auth.restore()),
    qrGenerate: proxy(() => bridge.auth.qrGenerate()),
    qrPoll: proxy((key) => bridge.auth.qrPoll(key)),
    logout: proxy(() => bridge.auth.logout())
  },

  home: {
    feed: proxy((page) => bridge.home.feed(page)),
    popular: proxy((page) => bridge.home.popular(page))
  },

  search: {
    videos: proxy((kw, page, order) => bridge.search.videos(kw, page, order)),
    ups: proxy((kw, page) => bridge.search.ups(kw, page))
  },

  video: {
    view: proxy((bvid) => bridge.video.view(bvid)),
    pages: proxy((bvid) => bridge.video.pages(bvid)),
    playurl: proxy((bvid, cid, qn) => bridge.video.playurl(bvid, cid, qn)),
    related: proxy((bvid) => bridge.video.related(bvid)),
    danmaku: proxy((cid, segment) => bridge.video.danmaku(cid, segment)),
    online: proxy((bvid, cid) => bridge.video.online(bvid, cid)),
    subtitle: proxy((bvid, cid) => bridge.video.subtitle(bvid, cid)),
    sendDanmaku: proxy((payload) => bridge.video.sendDanmaku(payload))
  },

  up: {
    info: proxy((mid) => bridge.up.info(mid)),
    videos: proxy((mid, pn, keyword) => bridge.up.videos(mid, pn, keyword)),
    resolve: proxy((query) => bridge.up.resolve(query)),
    latest: proxy((mids, perUp) => bridge.up.latest(mids, perUp)),
    followings: proxy((pn, ps) => bridge.up.followings(pn, ps))
  },

  fav: {
    folders: proxy(() => bridge.fav.folders()),
    resources: proxy((mediaId, pn) => bridge.fav.resources(mediaId, pn))
  },

  settings: {
    get: proxy(() => bridge.settings.get()),
    patch: proxy((patch) => bridge.settings.patch(patch))
  },

  sys: {
    openExternal: proxy((url) => bridge.sys.openExternal(url)),
    pickFile: proxy(() => bridge.sys.pickFile()),
    revealPath: proxy((path) => bridge.sys.revealPath(path)),
    // 本地字幕：选文件只返回路径；读文件返回 { path, name, size, bytes }
    pickSubtitle: proxy(() => bridge.sys.pickSubtitle()),
    readSubtitle: proxy((path) => bridge.sys.readSubtitle(path)),
    // 同步接口：拖拽进来的文件把 File 换成磁盘路径（拖入本地字幕要用）
    pathForFile: (file) => (bridge ? bridge.sys.pathForFile(file) : '')
  },

  backup: {
    write: proxy((dir, name, text) => bridge.backup.write(dir, name, text))
  },

  cache: {
    list: proxy(() => bridge.cache.list()),
    stats: proxy(() => bridge.cache.stats()),
    local: proxy((bvid, cid) => bridge.cache.local(bvid, cid)),
    probe: proxy((bvid, cid, qn) => bridge.cache.probe(bvid, cid, qn)),
    start: proxy((req) => bridge.cache.start(req)),
    cancel: proxy((key) => bridge.cache.cancel(key)),
    remove: proxy((key) => bridge.cache.remove(key)),
    clear: proxy(() => bridge.cache.clear()),
    reveal: proxy((key) => bridge.cache.reveal(key)),
    exportMp4: proxy((key, saveAs) => bridge.cache.exportMp4(key, saveAs)),
    path: proxy(() => bridge.cache.path()),
    pickDir: proxy(() => bridge.cache.pickDir()),
    openDir: proxy(() => bridge.cache.openDir()),
    // 事件订阅不是 Promise：桥接缺失时返回一个空退订函数
    onProgress: (cb) => (bridge && bridge.cache.onProgress ? bridge.cache.onProgress(cb) : () => {})
  }
}

export default api
