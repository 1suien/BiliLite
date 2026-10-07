import { protocol } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { CACHE_FILES, cacheRootPath } from './video-cache.js'

/**
 * 离线缓存的自定义协议：`bcache://media/<bvid>/<cid>/<v.m4s|a.m4s|export.mp4>`
 *
 * 为什么不用 file://：渲染层要按播放器的节奏发 `Range` 请求（dash.js 会先探一小段读 sidx，
 * 再按时间区间跳着取），file:// 既不受控又不支持 Range/CORS。这里自己实现一个支持
 * `Range` + `Accept-Ranges` 的协议，播放器代码一行都不用改（见 video-cache.js 顶部说明）。
 */

export const CACHE_SCHEME = 'bcache'

const MIME = {
  'v.m4s': 'video/mp4',
  'a.m4s': 'audio/mp4',
  'export.mp4': 'video/mp4'
}
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

/** 必须在 app ready 之前调用。 */
export function registerCacheScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CACHE_SCHEME,
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
    // bytes=-N：最后 N 个字节
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
  const node = fs.createReadStream(file, { start, end })
  return Readable.toWeb(node)
}

async function handleCacheRequest(request) {
  let url = null
  try {
    url = new URL(request.url)
  } catch {
    return new Response('bad url', { status: 400 })
  }
  const parts = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s))
  const [bvid, cid, name] = parts
  if (parts.length !== 3 || !NAME_RE.test(bvid || '') || !NAME_RE.test(cid || '') || !CACHE_FILES.includes(name)) {
    return new Response('not found', { status: 404 })
  }
  const root = cacheRootPath()
  if (!root) return new Response('cache not ready', { status: 503 })
  const file = path.join(root, bvid, cid, name)
  // 双保险：解析后的路径必须仍在缓存根目录之内
  const rel = path.relative(root, file)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return new Response('forbidden', { status: 403 })

  let st = null
  try {
    st = await fsp.stat(file)
  } catch {
    return new Response('not found', { status: 404 })
  }
  if (!st.isFile() || st.size === 0) return new Response('not found', { status: 404 })

  const type = MIME[name] || 'application/octet-stream'
  const range = parseRange(request.headers.get('range'), st.size)
  if (range && range.invalid) {
    return new Response('range not satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${st.size}` }
    })
  }
  if (range) {
    const length = range.end - range.start + 1
    return new Response(streamFile(file, range.start, range.end), {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(length),
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
export function installCacheProtocol() {
  protocol.handle(CACHE_SCHEME, handleCacheRequest)
}
