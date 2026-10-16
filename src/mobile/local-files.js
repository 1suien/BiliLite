/**
 * 安卓端的「本地视频库」。
 *
 * 桌面端（`src/main/local-media.js`）走的是绝对路径 + 自建的 `lmedia://` 协议；
 * 安卓 WebView 里既没有可读的绝对路径，也没有注册自定义协议的入口，所以这里换一条路：
 *
 * 1. 用隐藏的 `<input type="file">` 让用户在系统文件选择器里挑文件（SAF）；
 * 2. 拿到的 `File` 直接 `URL.createObjectURL()` 成 `blob:` URL —— 播放器只需要一个
 *    能播的 URL，`<video src>` / MSE 兜底路径都认，所以渲染层一行都不用改；
 * 3. 条目形状跟桌面端 `entryFor()` 完全一致（id/path/name/dir/ext/size/mtime/mime/url），
 *    这样 `LocalView.vue` 的列表、封面、进度记录逻辑原样可用。
 *
 * 两个已知限制（已写进 `mobile/README.md`）：
 * - File 句柄只在本次页面会话里有效。App 重启后系统不再给同一个文件的读权限，
 *   条目会变成「文件不在了」，需要重新选一次；这也是 Android 分区存储的正常表现。
 * - id 由「文件名 + 大小 + 修改时间」哈希得到，所以**重新选同一个文件会拿到同一个 id**，
 *   之前存的播放进度、笔记能接上。
 */

import { md5hex } from '../main/bili/md5.js'

/** 与 src/main/local-media.js 的 EXT_MIME 保持同一套扩展名归类 */
const VIDEO_EXT = ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'flv', 'ts', 'm2ts', 'mpg', 'mpeg', 'wmv', '3gp', 'ogv']
const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma']

const EXT_MIME = {
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
  wma: 'audio/x-ms-wma'
}

/** id -> { file, url }（只在本次会话里有效） */
const registry = new Map()

function extOf(name) {
  const m = /\.([^.\\/]+)$/.exec(name || '')
  return m ? m[1].toLowerCase() : ''
}

function isMedia(name) {
  const ext = extOf(name)
  return VIDEO_EXT.includes(ext) || AUDIO_EXT.includes(ext)
}

/** 稳定 id：同一个文件重新选也会得到同一个 id（进度/笔记因此能接上） */
export function localId(file) {
  return md5hex(`${file.name}|${file.size}|${file.lastModified}`).slice(0, 24)
}

/** 伪造一个稳定的「路径」给渲染层持久化；register 时再从里面解回 id */
export function pathOf(id, name) {
  return `android://${id}/${name}`
}

function idFromPath(path) {
  const m = /^android:\/\/([0-9a-f]{24})\//.exec(String(path || ''))
  return m ? m[1] : ''
}

function remember(file) {
  const id = localId(file)
  const prev = registry.get(id)
  if (prev && prev.file === file) return { id, rec: prev }
  if (prev && prev.url) URL.revokeObjectURL(prev.url)
  const rec = { file, url: URL.createObjectURL(file) }
  registry.set(id, rec)
  return { id, rec }
}

/** 组装成渲染层认得的条目 */
export function entryOf(file) {
  const { id, rec } = remember(file)
  const ext = extOf(file.name)
  return {
    id,
    path: pathOf(id, file.name),
    name: file.name,
    dir: '本机文件',
    ext,
    size: file.size,
    mtime: file.lastModified,
    mime: file.type || EXT_MIME[ext] || '',
    url: rec.url
  }
}

/** 用户挑了一批文件 -> 条目（过滤掉非音视频，按文件名排序） */
export function acceptFiles(files) {
  const list = (files || []).filter((f) => f && isMedia(f.name))
  list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  return list.map(entryOf)
}

/** 渲染层拿持久化的 path 列表回来问：哪些还在、哪些没了 */
export function registerPaths(paths) {
  const entries = []
  const missing = []
  for (const p of paths || []) {
    const id = idFromPath(p)
    const rec = id && registry.get(id)
    if (rec) entries.push(entryOf(rec.file))
    else if (id) missing.push(id)
  }
  return { entries, missing }
}

/** 从列表里移除（磁盘上的文件不碰） */
export function forget(id) {
  const rec = registry.get(id)
  if (rec) {
    if (rec.url) URL.revokeObjectURL(rec.url)
    registry.delete(id)
  }
  return true
}
