/**
 * 渲染层唯一的数据来源：window.bili
 *
 * 原 APK 是「薄 UI + 原生数据层」架构：
 *  - 安卓：启动时由 src/bridge/android.ts 安装 window.bili（CapacitorHttp 走原生 OkHttp，带 cookie）
 *  - 桌面预览：Electron 主进程注入 window.bili
 * 渲染层只通过本文件的 `bili` 对象访问网络/文件/系统能力。
 */
import type { WbiBridge } from './types'

export type { WbiBridge }

declare global {
  interface Window {
    bili?: WbiBridge
    Capacitor?: any
  }
}

/** 当前平台的桥（延迟读取，避免模块加载顺序问题） */
function impl(): WbiBridge {
  const b = typeof window !== 'undefined' ? window.bili : null
  if (!b) {
    const e: any = new Error(
      '未检测到数据桥（window.bili）。安卓端请通过 Capacitor 启动；桌面端请通过 Electron 启动。',
    )
    e.needLogin = false
    throw e
  }
  return b
}

/**
 * 与原构建一致的「延迟代理」：没装桥时调用会在运行期抛出可读错误，
 * 而不是在 import 阶段就炸掉整个页面。
 */
export const bili: WbiBridge = {
  get platform() {
    return (typeof window !== 'undefined' && window.bili && window.bili.platform) || 'unknown'
  },
  ping: () => impl().ping(),
  auth: {
    restore: () => impl().auth.restore(),
    qrGenerate: () => impl().auth.qrGenerate(),
    qrPoll: (key: string) => impl().auth.qrPoll(key),
    logout: () => impl().auth.logout(),
  },
  home: {
    feed: (page?: number) => impl().home.feed(page),
    popular: (page?: number) => impl().home.popular(page),
  },
  search: {
    videos: (kw: string, page?: number, order?: string) => impl().search.videos(kw, page, order),
    ups: (kw: string, page?: number) => impl().search.ups(kw, page),
  },
  video: {
    view: (bvid: string) => impl().video.view(bvid),
    pages: (bvid: string) => impl().video.pages(bvid),
    playurl: (bvid: string, cid: any, qn: number) => impl().video.playurl(bvid, cid, qn),
    related: (bvid: string) => impl().video.related(bvid),
    danmaku: (cid: any, segment?: number) => impl().video.danmaku(cid, segment),
    online: (bvid: string, cid: any) => impl().video.online(bvid, cid),
    subtitle: (bvid: string, cid: any) => impl().video.subtitle(bvid, cid),
    sendDanmaku: (payload: any) => impl().video.sendDanmaku(payload),
  },
  up: {
    info: (mid: any) => impl().up.info(mid),
    videos: (mid: any, pn?: number, keyword?: string) => impl().up.videos(mid, pn, keyword),
    resolve: (query: string) => impl().up.resolve(query),
    latest: (mids: (string | number)[], perUp?: number) => impl().up.latest(mids, perUp),
    followings: (pn?: number, ps?: number) => impl().up.followings(pn, ps),
  },
  fav: {
    folders: () => impl().fav.folders(),
    resources: (mediaId: any, pn?: number) => impl().fav.resources(mediaId, pn),
  },
  settings: {
    get: () => impl().settings.get(),
    patch: (patch: any) => impl().settings.patch(patch),
  },
  sys: {
    openExternal: (url: string) => impl().sys.openExternal(url),
    pickFile: () => impl().sys.pickFile(),
    revealPath: (path: string) => impl().sys.revealPath(path),
    pickSubtitle: () => impl().sys.pickSubtitle(),
    readSubtitle: (path: string) => impl().sys.readSubtitle(path),
    pathForFile: (file?: any) => impl().sys.pathForFile(file),
  },
  backup: {
    write: (dir: string, name: string, text: string) => impl().backup.write(dir, name, text),
  },
  local: {
    pickFiles: () => impl().local.pickFiles(),
    pickFolder: () => impl().local.pickFolder(),
    // 本机定制 0.4.15：安卓原生导入 / 分享接收（浏览器 mock 桥也实现了同名方法）
    pickNative: () => (impl().local.pickNative ? impl().local.pickNative!() : impl().local.pickFiles()),
    diagnose: () =>
      impl().local.diagnose ? impl().local.diagnose!() : Promise.resolve({ openDocument: false, getContent: false, sdk: 0 }),
    sharedPending: () =>
      impl().local.sharedPending ? impl().local.sharedPending!() : Promise.resolve({ entries: [], missing: [] }),
    scanVideos: (limit?: number) =>
      impl().local.scanVideos ? impl().local.scanVideos!(limit) : Promise.resolve({ items: [], count: 0 }),
    importSelected: (uris: string[]) =>
      impl().local.importSelected ? impl().local.importSelected!(uris) : impl().local.pickFiles(),
    probe: (paths: string[]) =>
      impl().local.probe ? impl().local.probe!(paths) : Promise.resolve({ entries: [], missing: paths }),
    discard: (path: string) => (impl().local.discard ? impl().local.discard!(path) : Promise.resolve({ ok: true })),
    storageInfo: () =>
      impl().local.storageInfo
        ? impl().local.storageInfo!()
        : Promise.resolve({ dir: '', count: 0, bytes: 0 }),
    register: (paths: string[]) => impl().local.register(paths),
    remove: (id: string, path?: string) => impl().local.remove(id, path),
    reveal: (path: string) => impl().local.reveal(path),
  },
}
