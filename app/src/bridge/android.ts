/**
 * 安卓数据桥：把 window.bili 安装成与桌面桥完全一致的契约对象
 *
 * 还原自 reference/decompiled/js/index-jTHZJced.js：
 *  - 2077-2101 行 `oe()`：安卓上没有原生文件选择器，用隐藏的 `<input type=file>` 选文件
 *  - 2102-2109 行 `dr()`：FileReader 读成 Uint8Array
 *  - 948-1011 行 `Ft/$t/jt/W/We/Mt/Nt/Bt/qt/Vt/He/Ee/Kt/Wt`：
 *      本地视频的「伪路径」方案 —— 文件对象存在内存 Map 里，对外只暴露
 *      `android://{24位id}/{文件名}`，渲染层拿这个路径当作本地视频的 path/url
 *  - 2110-2123 行 `Oe/fr/se/Ue()`：字幕伪路径 Map、导出占位文案、上次导出的 uri、调系统分享
 *  - 2124-2260 行 `hr`：handler map（唯一的业务入口表）
 *  - 2261-2284 行 `et()` / `d()`：invoke（返回 {ok,...}）/ call（失败抛 Error）
 *  - 2285-2348 行 `Ie`：window.bili 本体
 *  - 2349-2351 行 `gr()`：启动装配（设置 store、explicit cookie、原生 fetch、load、挂 window.bili）
 *  - 2063-2076 行 `ur()`：app:ping 里用的版本号（取自 @capacitor/app）
 *
 * 渲染层契约见 ./types.ts；本文件只做「通道名 -> 业务函数」的转发与平台相关实现。
 */
import { createNativeFetch, setFetchImpl, useExplicitCookies } from './http'
import { state } from './state'
import { md5Hex } from './wbi'
import {
  favFolders,
  favResources,
  homeFeed,
  homePopular,
  logoutSession,
  qrGenerate,
  qrPoll,
  restoreSession,
  searchUps,
  searchVideos,
  sendDanmaku,
  upFollowings,
  upInfo,
  upLatest,
  upResolve,
  upVideos,
  videoDanmaku,
  videoOnline,
  videoPages,
  videoPlayurl,
  videoRelated,
  videoSubtitle,
  viewVideo,
} from './api'
import type { WbiBridge } from './types'

// ---------------------------------------------------------------------------
// 平台相关小工具
// ---------------------------------------------------------------------------

/** 支持直接播放的视频扩展名：还原 `$t` */
const VIDEO_EXTENSIONS = [
  'mp4',
  'm4v',
  'webm',
  'mkv',
  'mov',
  'avi',
  'flv',
  'ts',
  'm2ts',
  'mpg',
  'mpeg',
  'wmv',
  '3gp',
  'ogv',
]
/** 支持直接播放的音频扩展名：还原 `jt` */
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma']

/** 扩展名 -> MIME：还原 `Ft`（浏览器给的 file.type 为空时用它兜底） */
const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  wmv: 'video/x-ms-wmv',
  '3gp': 'video/3gpp',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wma: 'audio/x-ms-wma',
}

/**
 * 本地文件记录表：id -> {file, url}
 * 只活在内存里（刷新页面即失效），这是安卓 WebView 拿不到真实路径的折中方案。
 */
const FILE_STORE = new Map<string, { file: File; url: string }>()

/** 字幕文件的伪路径表：`subtitle://{文件名}#{序号}` -> File：还原 `Oe` */
const SUBTITLE_STORE = new Map<string, File>()

/** sys.pickFile 的占位返回值：还原 `fr` */
const PICK_FILE_PLACEHOLDER = '本机（导出时用系统面板选保存位置）'

/** 最近一次导出的文件 uri（`sys.revealPath` 用它调分享面板）：还原 `se` */
let lastExportUri = ''

/** 字幕可接受的扩展名 / 大小上限：还原 `pr` / `mr` */
const SUBTITLE_EXTENSIONS = ['srt', 'vtt', 'ass', 'ssa']
const SUBTITLE_MAX_BYTES = 8 * 1024 * 1024

/** 取小写扩展名（不含点）：还原 `We()` */
function extOf(name: string): string {
  const matched = /\.([^.\\/]+)$/.exec(name || '')
  return matched ? matched[1].toLowerCase() : ''
}

/** 是否是能直接播的音视频：还原 `Mt()` */
function isPlayable(file: File): boolean {
  const ext = extOf(file.name)
  return VIDEO_EXTENSIONS.includes(ext) || AUDIO_EXTENSIONS.includes(ext)
}

/** 文件指纹 -> 24 位 id：还原 `Nt()`（对 名称|大小|修改时间 取 md5 前 24 位） */
function fileId(file: File): string {
  return md5Hex(`${file.name}|${file.size}|${file.lastModified}`).slice(0, 24)
}

/** 伪路径：还原 `Bt()` */
function pseudoPath(id: string, name: string): string {
  return `android://${id}/${name}`
}

/** 从伪路径里取 id：还原 `qt()` */
function idFromPseudoPath(path: any): string {
  const matched = /^android:\/\/([0-9a-f]{24})\//.exec(String(path || ''))
  return matched ? matched[1] : ''
}

/** 登记文件并保证有 blob url：还原 `Vt()` */
function ensureRecord(file: File): { id: string; rec: { file: File; url: string } } {
  const id = fileId(file)
  const existing = FILE_STORE.get(id)
  if (existing && existing.file === file) return { id, rec: existing }
  // 同名同大小同 mtime 但文件对象换了（重新选了一次）：旧 blob url 要释放
  if (existing && existing.url) URL.revokeObjectURL(existing.url)
  const rec = { file, url: URL.createObjectURL(file) }
  FILE_STORE.set(id, rec)
  return { id, rec }
}

/** File -> 渲染层要的本地视频条目：还原 `He()` */
function describeFile(file: File): any {
  const { id, rec } = ensureRecord(file)
  const ext = extOf(file.name)
  return {
    id,
    path: pseudoPath(id, file.name),
    name: file.name,
    dir: '本机文件',
    ext,
    size: file.size,
    mtime: file.lastModified,
    mime: file.type || MIME_BY_EXT[ext] || '',
    url: rec.url,
  }
}

/** File[] -> 条目数组（过滤不可播、按中文名排序）：还原 `Ee()` */
function describeFiles(files: File[]): any[] {
  const picked = (files || []).filter((file) => file && isPlayable(file))
  picked.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  return picked.map(describeFile)
}

/** 是否是原生私有目录里的绝对路径（0.4.15 起的本地导入 / 分享接收） */
function isNativeMediaPath(path: any): boolean {
  const raw = String(path || '')
  return raw.startsWith('/') || raw.startsWith('file://')
}

/** 取 LocalMedia 原生插件（懒加载：浏览器预览里没有这个插件） */
let localMediaPlugin: any = null
async function localMedia(): Promise<any> {
  const { registerPlugin } = await import('@capacitor/core')
  if (!localMediaPlugin) localMediaPlugin = registerPlugin('LocalMedia')
  return localMediaPlugin
}

/**
 * 路径数组 -> 条目（失效的放 missing）：还原 `Kt()`，本机定制 0.4.15 扩展
 *
 * - `android://…` 伪路径：从内存 FILE_STORE 还原（WebView `<input type=file>` 选的文件）
 * - 绝对路径 / file://：走原生 LocalMediaPlugin.probe（文件已复制到 App 私有目录，重启后仍在）
 */
async function restoreEntries(paths: string[]): Promise<{ entries: any[]; missing: string[] }> {
  const entries: any[] = []
  const missing: string[] = []
  const nativePaths: string[] = []
  for (const path of paths || []) {
    if (isNativeMediaPath(path)) {
      nativePaths.push(String(path))
      continue
    }
    const id = idFromPseudoPath(path)
    const rec = id && FILE_STORE.get(id)
    if (rec) entries.push(describeFile(rec.file))
    else if (id) missing.push(id)
  }
  if (nativePaths.length) {
    try {
      const res = await (await localMedia()).probe({ paths: nativePaths })
      for (const entry of res.entries || []) entries.push(entry)
      for (const path of res.missing || []) missing.push(String(path))
    } catch {
      for (const path of nativePaths) missing.push(path)
    }
  }
  return { entries, missing }
}

/** 移除本地文件记录（同时释放 blob url）：还原 `Wt()` */
function removeEntry(id: string): boolean {
  const rec = FILE_STORE.get(id)
  if (rec) {
    if (rec.url) URL.revokeObjectURL(rec.url)
    FILE_STORE.delete(id)
  }
  return true
}

/**
 * 用隐藏的 `<input type=file>` 选文件：还原 `oe()`
 *
 * 安卓 WebView 里只能这样唤起系统文件选择器；`window.focus` 后 800ms 还没 change
 * 就当作用户取消（与原实现一致，注意这个定时器不是 bug 而是原行为）。
 */
function pickFilesWithInput(opts: { accept?: string; multiple?: boolean } = {}): Promise<File[]> {
  const { accept = '', multiple = false } = opts
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (accept) input.accept = accept
    input.multiple = multiple
    // 移出屏幕但保留在 DOM 里（安卓上必须可见/可点击才会有反应）
    input.style.position = 'fixed'
    input.style.left = '-10000px'
    document.body.appendChild(input)

    const finish = (files: File[]) => {
      input.remove()
      resolve(files || [])
    }

    input.addEventListener('change', () => finish(Array.from(input.files || [])))
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => {
          if (document.body.contains(input)) finish([])
        }, 800)
      },
      { once: true },
    )
    input.click()
  })
}

/** File -> Uint8Array：还原 `dr()` */
function readFileBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsArrayBuffer(file)
  })
}

/** 调系统「保存到…」分享面板把文件交出去：还原 `Ue()` */
async function shareFile(uri: string, title: string): Promise<void> {
  const { Share } = await import('@capacitor/share')
  await Share.share({ title, text: title, files: [uri], dialogTitle: '保存到…' })
}

/** 版本号（app:ping 用）：还原 `ur()`，拿不到时回落到构建版本兜底值（0.4.13，本机构建） */
let cachedVersion = ''
async function getAppVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion
  try {
    const { App } = await import('@capacitor/app')
    const info = await App.getInfo()
    cachedVersion = (info && info.version) || ''
  } catch {
    cachedVersion = ''
  }
  return cachedVersion || '0.4.16'
}

// ---------------------------------------------------------------------------
// handler map：通道名 -> 实现（逐字还原 `hr`）
// ---------------------------------------------------------------------------

type Handler = (payload?: any) => Promise<any> | any

const handlers: Record<string, Handler> = {
  /** 连通性/版本探测 */
  'app:ping': async () => ({ pong: Date.now(), version: await getAppVersion() }),

  /** 恢复登录态（本地 cookies -> nav 校验） */
  'auth:restore': async () => {
    const result = (await restoreSession()) || ({} as any)
    return {
      user: result.user || null,
      loggedIn: !!result.loggedIn,
      stale: !!result.stale,
      message: result.message || '',
    }
  },
  /** 生成扫码登录二维码 */
  'auth:qrGenerate': async () => qrGenerate(),
  /** 轮询扫码状态（成功时已写 cookie + user） */
  'auth:qrPoll': async ({ qrcodeKey }: any) => qrPoll(qrcodeKey),
  /** 退出登录 */
  'auth:logout': async () => logoutSession(),

  /** 首页推荐 */
  'home:feed': async ({ page }: any) => homeFeed(page || 1),
  /** 热门/排行榜 */
  'home:popular': async ({ page }: any) => homePopular(page || 1),

  /** 搜索视频 */
  'search:videos': async ({ keyword, page, order }: any) =>
    searchVideos(keyword, page || 1, order || 'totalrank'),
  /** 搜索 UP 主 */
  'search:ups': async ({ keyword, page }: any) => searchUps(keyword, page || 1),

  /** 视频详情 */
  'video:view': async ({ bvid }: any) => viewVideo(bvid),
  /** 分 P 列表 */
  'video:pages': async ({ bvid }: any) => videoPages(bvid),
  /** 播放地址（DASH） */
  'video:playurl': async ({ bvid, cid, qn }: any) => videoPlayurl(bvid, cid, qn || 80),
  /** 相关推荐 */
  'video:related': async ({ bvid }: any) => videoRelated(bvid),
  /** 弹幕（按分段） */
  'video:danmaku': async ({ cid, segment }: any) => videoDanmaku(cid, segment || 1),
  /** 同时在看人数 */
  'video:online': async ({ bvid, cid }: any) => videoOnline(bvid, cid),
  /** 字幕列表（含内容） */
  'video:subtitle': async ({ bvid, cid }: any) => videoSubtitle(bvid, cid),
  /** 发弹幕（payload 直接用，含 bvid/cid/msg/progress/mode/color/fontsize） */
  'video:sendDanmaku': async (payload: any) => sendDanmaku(payload),

  /** UP 名片 */
  'up:info': async ({ mid }: any) => upInfo(mid),
  /** UP 投稿列表 */
  'up:videos': async ({ mid, pn, keyword }: any) => upVideos(mid, pn || 1, 30, keyword || ''),
  /** UID/链接/昵称 -> UP 主 */
  'up:resolve': async ({ query }: any) => upResolve(query),
  /** 批量最新投稿 */
  'up:latest': async ({ mids, perUp }: any) => upLatest(mids, perUp || 2),
  /** 关注列表（导入） */
  'up:followings': async ({ pn, ps }: any) =>
    upFollowings(state.user && state.user.mid, pn || 1, ps || 50),

  /** 收藏夹（创建 + 收藏） */
  'fav:folders': async () => {
    const list = await favFolders()
    return { created: list.created, collected: list.collected }
  },
  /** 收藏夹内容 */
  'fav:resources': async ({ mediaId, pn }: any) => favResources(mediaId, pn || 1, 20),

  /** 读取设置 */
  'settings:get': async () => state.settings,
  /** 合并设置并返回新对象 */
  'settings:patch': async (patch: any) => state.patchSettings(patch),

  /** 用系统浏览器打开外链 */
  'sys:openExternal': async ({ url }: any) => {
    if (/^https?:\/\//.test(url || '')) {
      window.open(url, '_system') || (window.location.href = url)
    }
    return true
  },
  /** 安卓上不做原生导出，返回占位文案（导出走 backup.write） */
  'sys:pickFile': async () => PICK_FILE_PLACEHOLDER,
  /** 把上次导出的备份文件交给系统「保存到」面板 */
  'sys:revealPath': async () => {
    if (!lastExportUri) throw new Error('还没有导出过备份；先点「写入 JSON 备份」')
    await shareFile(lastExportUri, 'BiliLite 学习数据备份')
    return true
  },
  /** 选字幕文件（只接受 srt/vtt/ass/ssa，≤8MB），返回伪路径 */
  'sys:pickSubtitle': async () => {
    const files = await pickFilesWithInput({ accept: '.srt,.vtt,.ass,.ssa', multiple: true })
    const paths: string[] = []
    for (const file of files) {
      const ext = (file.name.split('.').pop() || '').toLowerCase()
      if (!SUBTITLE_EXTENSIONS.includes(ext) || file.size > SUBTITLE_MAX_BYTES) continue
      const path = `subtitle://${file.name}#${paths.length}`
      SUBTITLE_STORE.set(path, file)
      paths.push(path)
    }
    return paths
  },
  /** 按伪路径读字幕字节 */
  'sys:readSubtitle': async ({ path }: any) => {
    const file = SUBTITLE_STORE.get(path)
    if (!file) throw new Error('字幕文件已失效，请重新选择')
    const bytes = await readFileBytes(file)
    return { path, name: file.name, size: file.size, bytes }
  },

  /** 选择本地视频/音频（多个） */
  'local:pickFiles': async () => {
    const files = await pickFilesWithInput({ accept: 'video/*,audio/*', multiple: true })
    return files.length ? { entries: describeFiles(files) } : { canceled: true }
  },
  /**
   * 安卓原生导入（0.4.15）：SAF 选文件 → 复制到 App 私有目录 → 返回可持久播放的条目。
   * 好处是不吃内存（`https://localhost/_capacitor_file_…` 支持 Range 边下边播），刷新/重启也在。
   */
  'local:pickNative': async () => {
    const res = await (await localMedia()).pickAndImport({ multiple: true })
    return res || { canceled: true }
  },
  /** 取别的 App「分享 / 用其他应用打开」过来的文件（WPS 网盘里的视频走这条） */
  'local:sharedPending': async () => (await localMedia()).sharedPending(),
  /** 按绝对路径还原条目（重启后） */
  'local:probe': async ({ paths }: any) => (await localMedia()).probe({ paths }),
  /** 删除私有目录里的导入文件 */
  'local:discard': async ({ path }: any) => (await localMedia()).discard({ path }),
  /** 私有目录占用情况 */
  'local:storageInfo': async () => (await localMedia()).storageInfo(),
  /** 诊断系统文件选择器可用性（0.4.16） */
  'local:diagnose': async () => (await localMedia()).diagnose(),
  /** 选择本地「文件夹」（安卓没有目录选择器，同样用多选文件模拟） */
  'local:pickFolder': async () => {
    const files = await pickFilesWithInput({ accept: 'video/*,audio/*', multiple: true })
    return files.length
      ? { dir: '本机文件', entries: describeFiles(files), truncated: files.length >= 500 }
      : { canceled: true }
  },
  /** 把持久化的伪路径还原成条目（失效的放 missing，供 UI 清理） */
  'local:register': async ({ paths }: any) => restoreEntries(paths),
  /** 移除一个本地文件记录（原生导入的顺手删掉私有目录里的文件） */
  'local:remove': async ({ id, path }: any) => {
    if (path && isNativeMediaPath(path)) {
      try {
        await (await localMedia()).discard({ path })
      } catch {
        // 删不掉就算了，至少把记录移除
      }
    }
    return removeEntry(id)
  },
  /** 安卓上无法定位文件 */
  'local:reveal': async () => {
    throw new Error('安卓上没有「在资源管理器里定位」，去系统「文件」应用里找这个文件')
  },

  /** 写 JSON 备份：先 Documents，失败退 Cache，然后弹「保存到」面板 */
  'backup:write': async ({ name, text }: any) => {
    const fileName = name || `bililite-${Date.now()}.json`
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')

    let uri = ''
    let label = '文档'
    try {
      const res = await Filesystem.writeFile({
        path: fileName,
        data: String(text ?? ''),
        directory: Directory.Documents,
        encoding: Encoding.UTF8,
        recursive: true,
      })
      uri = res.uri
    } catch {
      const res = await Filesystem.writeFile({
        path: fileName,
        data: String(text ?? ''),
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
        recursive: true,
      })
      uri = res.uri
      label = '应用缓存'
    }
    lastExportUri = uri

    try {
      await shareFile(uri, `BiliLite 学习数据备份 ${fileName}`)
      return `${label}/${fileName}（已打开「保存到」面板，可另存到任意位置）`
    } catch {
      return `${label}/${fileName}`
    }
  },
}

// ---------------------------------------------------------------------------
// invoke / call：渲染层与 handler map 之间的唯一通道
// ---------------------------------------------------------------------------

export interface InvokeResult {
  ok: boolean
  data?: any
  message?: string
  code?: number
  needLogin?: boolean
}

/** 调用一个通道，返回 {ok,data} / {ok:false,message,...}：还原 `et()` */
export async function invoke(channel: string, payload?: any): Promise<InvokeResult> {
  const handler = handlers[channel]
  if (!handler) {
    return { ok: false, message: `未授权的通道：${channel}` }
  }
  try {
    const data = await handler(payload || {})
    return { ok: true, data }
  } catch (e: any) {
    return {
      ok: false,
      message: (e && e.message) || String(e),
      code: e && e.biliCode,
      needLogin: !!(e && e.needLogin),
    }
  }
}

/** 调用一个通道，失败时抛带标记的 Error：还原 `d()` */
export async function call<T = any>(channel: string, payload?: any): Promise<T> {
  const result = await invoke(channel, payload)
  if (result && result.ok) return result.data as T

  const error: any = new Error((result && result.message) || '请求失败')
  if (result && result.needLogin) error.needLogin = true
  if (result && result.code) error.biliCode = result.code
  throw error
}

// ---------------------------------------------------------------------------
// window.bili 本体（还原 `Ie`）
// ---------------------------------------------------------------------------

/** 与桌面桥完全一致的契约对象 */
const bridge: WbiBridge & { invoke: typeof invoke; call: typeof call } = {
  platform: 'android',
  invoke,
  call,

  ping: () => call('app:ping'),

  auth: {
    restore: () => call('auth:restore'),
    qrGenerate: () => call('auth:qrGenerate'),
    qrPoll: (key: string) => call('auth:qrPoll', { qrcodeKey: key }),
    logout: () => call('auth:logout'),
  },

  home: {
    feed: (page = 1) => call('home:feed', { page }),
    popular: (page = 1) => call('home:popular', { page }),
  },

  search: {
    videos: (keyword: string, page = 1, order = 'totalrank') =>
      call('search:videos', { keyword, page, order }),
    ups: (keyword: string, page = 1) => call('search:ups', { keyword, page }),
  },

  video: {
    view: (bvid: string) => call('video:view', { bvid }),
    pages: (bvid: string) => call('video:pages', { bvid }),
    playurl: (bvid: string, cid: any, qn: number) => call('video:playurl', { bvid, cid, qn }),
    related: (bvid: string) => call('video:related', { bvid }),
    danmaku: (cid: any, segment = 1) => call('video:danmaku', { cid, segment }),
    online: (bvid: string, cid: any) => call('video:online', { bvid, cid }),
    subtitle: (bvid: string, cid: any) => call('video:subtitle', { bvid, cid }),
    sendDanmaku: (payload: any) => call('video:sendDanmaku', payload),
  },

  up: {
    info: (mid: any) => call('up:info', { mid }),
    videos: (mid: any, pn = 1, keyword = '') => call('up:videos', { mid, pn, keyword }),
    resolve: (query: string) => call('up:resolve', { query }),
    latest: (mids: (string | number)[], perUp = 2) => call('up:latest', { mids, perUp }),
    followings: (pn = 1, ps = 50) => call('up:followings', { pn, ps }),
  },

  fav: {
    folders: () => call('fav:folders'),
    resources: (mediaId: any, pn = 1) => call('fav:resources', { mediaId, pn }),
  },

  settings: {
    get: () => call('settings:get'),
    patch: (patch: any) => call('settings:patch', patch),
  },

  sys: {
    openExternal: (url: string) => call('sys:openExternal', { url }),
    pickFile: () => call('sys:pickFile'),
    revealPath: (path: string) => call('sys:revealPath', { path }),
    pickSubtitle: () => call('sys:pickSubtitle'),
    readSubtitle: (path: string) => call('sys:readSubtitle', { path }),
    /** 安卓上拿不到真实路径：原实现直接返回空串 */
    pathForFile: () => '',
  },

  backup: {
    write: (dir: string, name: string, text: string) => call('backup:write', { dir, name, text }),
  },

  local: {
    pickFiles: () => call('local:pickFiles'),
    pickFolder: () => call('local:pickFolder'),
    pickNative: () => call('local:pickNative'),
    diagnose: () => call('local:diagnose'),
    sharedPending: () => call('local:sharedPending'),
    probe: (paths: string[]) => call('local:probe', { paths }),
    discard: (path: string) => call('local:discard', { path }),
    storageInfo: () => call('local:storageInfo'),
    register: (paths: string[]) => call('local:register', { paths }),
    remove: (id: string, path?: string) => call('local:remove', { id, path }),
    reveal: (path: string) => call('local:reveal', { path }),
  },
}

/** 是否已经装过桥（force 重装时用） */
let installed = false

/**
 * 安装 Android 数据桥：还原 `gr()`
 *
 * 顺序与原构建一致：显式 Cookie 模式 -> 换成原生 fetch（CapacitorHttp）-> 读持久化状态
 * -> 挂 window.bili。返回时 window.bili 一定可用。
 *
 * @param opts.force 已经安装过也重新装一遍（默认跳过，避免重复初始化）
 */
export async function installAndroidBridge(opts: { force?: boolean } = {}): Promise<void> {
  if (installed && !opts.force) return

  // 1) 原生 OkHttp 不会自动带 WebView 的 Cookie，必须自己拼 Cookie 头
  useExplicitCookies()
  // 2) 请求走 CapacitorHttp（原生 OkHttp，绕开 WebView 的 CORS/证书限制）
  setFetchImpl(createNativeFetch())
  // 3) 恢复 settings / user / cookies
  await state.load()
  // 4) 挂载桥
  if (typeof window !== 'undefined') {
    window.bili = bridge as any
  }
  installed = true
}

export { bridge }
