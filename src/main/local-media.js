import { protocol, dialog, shell } from 'electron'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'

/**
 * 本地视频播放的支撑层。
 *
 * 为什么不用 file://：渲染层要按播放器节奏发 `Range` 请求（跳进度要定位字节），file:// 既不受控、
 * 也不带 `Accept-Ranges`；用自定义协议 `lmedia://local/<id>` 把「已登记过的文件」服务出去，
 * 既支持 Range，也不用给渲染层开放任意路径读取能力（协议只认登记表里的 id，路径拼不进来）。
 *
 * 不做任何转码/解析：时长、缩略图都交给渲染层的 <video> + canvas 去做，主进程零运行时依赖。
 */

export const LOCAL_SCHEME = 'lmedia'

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.wmv': 'video/x-ms-wmv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ogv': 'video/ogg',
  '.3gp': 'video/3gpp'
}

/** 打开文件对话框里给出的筛选（其他扩展名也能通过「全部文件」选到） */
export const VIDEO_EXTS = Object.keys(MIME).map((e) => e.slice(1))

/** 递归扫描文件夹时认这些扩展名 */
const SCAN_EXTS = new Set(Object.keys(MIME))

const MAX_SCAN_FILES = 500
const SCAN_MAX_DEPTH = 4

/** id ↔ 绝对路径：只在内存里，重启后由渲染层拿本地列表重新登记（id 是路径哈希，因此地址稳定） */
const registry = new Map()

function idFor(file) {
  return crypto.createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 24)
}

function entryFor(file, st) {
  const abs = path.resolve(file)
  const ext = path.extname(abs).toLowerCase()
  const id = idFor(abs)
  registry.set(id, abs)
  return {
    id,
    path: abs,
    name: path.basename(abs),
    dir: path.dirname(abs),
    ext: ext.replace('.', ''),
    size: st.size,
    mtime: st.mtimeMs,
    mime: MIME[ext] || 'application/octet-stream',
    url: `${LOCAL_SCHEME}://local/${id}`
  }
}

async function describe(file) {
  try {
    const st = await fsp.stat(file)
    if (!st.isFile() || st.size === 0) return null
    return entryFor(file, st)
  } catch {
    return null
  }
}

/** 必须在 app ready 之前调用。 */
export function registerLocalScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: LOCAL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
        bypassCSP: true
      }
    }
  ])
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim())
  if (!m) return null
  let start = m[1] === '' ? null : Number(m[1])
  let end = m[2] === '' ? null : Number(m[2])
  if (start === null && end === null) return null
  if (start === null) {
    const len = Math.min(end, size)
    start = size - len
    end = size - 1
  } else if (end === null || end >= size) {
    end = size - 1
  }
  if (start > end || start >= size) return { invalid: true, size }
  return { start, end, size }
}

function streamFile(file, start, end) {
  return Readable.toWeb(fs.createReadStream(file, { start, end }))
}

async function handleLocalRequest(request) {
  let url = null
  try {
    url = new URL(request.url)
  } catch {
    return new Response('bad url', { status: 400 })
  }
  const parts = url.pathname.split('/').filter(Boolean)
  const id = parts[0]
  if (parts.length !== 1 || !/^[0-9a-f]{24}$/.test(id || '')) return new Response('not found', { status: 404 })
  const file = registry.get(id)
  if (!file) return new Response('not registered', { status: 404 })

  let st = null
  try {
    st = await fsp.stat(file)
  } catch {
    return new Response('not found', { status: 404 })
  }
  if (!st.isFile() || st.size === 0) return new Response('not found', { status: 404 })

  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
  const range = parseRange(request.headers.get('range'), st.size)
  if (range && range.invalid) {
    return new Response('range not satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${st.size}` }
    })
  }
  if (range) {
    return new Response(streamFile(file, range.start, range.end), {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      }
    })
  }
  return new Response(streamFile(file, 0, st.size - 1), {
    status: 200,
    headers: {
      'Content-Type': type,
      'Content-Length': String(st.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    }
  })
}

/** app ready 之后调用。 */
export function installLocalProtocol() {
  protocol.handle(LOCAL_SCHEME, handleLocalRequest)
}

/** 「打开文件」：多选，认得常见视频扩展名，但也允许选「全部文件」 */
export async function pickLocalFiles() {
  const res = await dialog.showOpenDialog({
    title: '打开本地视频',
    buttonLabel: '打开',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '视频', extensions: VIDEO_EXTS },
      { name: '全部文件', extensions: ['*'] }
    ]
  })
  if (res.canceled || !res.filePaths.length) return { canceled: true }
  const entries = []
  for (const f of res.filePaths) {
    const e = await describe(f)
    if (e) entries.push(e)
  }
  return { entries }
}

/** 递归扫描一个文件夹（最多 4 层、最多 500 个文件），按路径排序 */
async function scanDir(dir, depth, out) {
  if (depth > SCAN_MAX_DEPTH || out.length >= MAX_SCAN_FILES) return
  let items = []
  try {
    items = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  for (const it of items) {
    if (out.length >= MAX_SCAN_FILES) return
    if (it.name.startsWith('.')) continue
    const full = path.join(dir, it.name)
    if (it.isDirectory()) {
      await scanDir(full, depth + 1, out)
    } else if (it.isFile() && SCAN_EXTS.has(path.extname(it.name).toLowerCase())) {
      const e = await describe(full)
      if (e) out.push(e)
    }
  }
}

export async function pickLocalFolder() {
  const res = await dialog.showOpenDialog({
    title: '打开文件夹（递归找视频）',
    buttonLabel: '扫描这个文件夹',
    properties: ['openDirectory']
  })
  if (res.canceled || !res.filePaths[0]) return { canceled: true }
  const dir = res.filePaths[0]
  const out = []
  await scanDir(dir, 0, out)
  return { dir, entries: out, truncated: out.length >= MAX_SCAN_FILES }
}

/** 渲染层每次启动把本地列表里的路径重新登记一遍，拿回稳定的 lmedia:// 地址 */
export async function registerLocal(paths) {
  const list = Array.isArray(paths) ? paths.slice(0, 2000) : []
  const entries = []
  const missing = []
  for (const p of list) {
    if (typeof p !== 'string' || !p) continue
    const e = await describe(p)
    if (e) entries.push(e)
    else missing.push(p)
  }
  return { entries, missing }
}

export function removeLocal(id) {
  if (typeof id === 'string') registry.delete(id)
  return { ok: true }
}

/** 在资源管理器里定位到文件（用于「打开位置」） */
export function revealLocal(file) {
  if (typeof file !== 'string' || !file) throw new Error('缺少文件路径')
  shell.showItemInFolder(path.resolve(file))
  return { ok: true }
}
