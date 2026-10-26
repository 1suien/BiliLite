/**
 * @local/download-route — 把本地目录里的文件通过 DSH Web 端口当附件下载。
 *
 * 用途：在本机没有 adb / 文件管理器通道时，让浏览器地址栏直接下载构建产物
 * （例如 /root/学习软件/BiliLite-0.4.6-debug.apk）。
 *
 * 路由只在 DSH Web 服务上占一个前缀（默认 `/dl`），不参与连接层鉴权，
 * 所以只在回环地址下使用；路径会被限制在配置的 `dir` 目录内部。
 *
 * 配置项（cordis.patch.yml 的 config）：
 *   prefix: URL 前缀，默认 '/dl'
 *   dir:    允许下载的根目录，默认 /root/学习软件
 *
 * 特殊路径 `latest.apk`（或 `latest`）：自动挑 `dir` 下版本号最大的
 * `BiliLite-<x.y.z>-debug.apk`，并以固定文件名 `BiliLite-latest.apk` 下发——
 * 浏览器重复下载同名文件时可以选择覆盖，本地那份就跟着更新了。
 */
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const MIME = {
  '.apk': 'application/vnd.android.package-archive',
  '.aab': 'application/octet-stream',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.sha256': 'text/plain; charset=utf-8',
}

/** RFC 5987 `filename*` 值，兼容中文文件名。 */
function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/** 在 root 下找版本号最大的 BiliLite-<x.y.z>-debug.apk。 */
async function findLatestApk(root) {
  let names
  try {
    names = await readdir(root)
  } catch {
    return null
  }
  const versioned = names
    .map((name) => {
      const m = /^BiliLite-(\d+)\.(\d+)\.(\d+)-debug\.apk$/.exec(name)
      if (!m) return null
      return { name, key: [Number(m[1]), Number(m[2]), Number(m[3])] }
    })
    .filter(Boolean)
    .sort((a, b) => b.key[0] - a.key[0] || b.key[1] - a.key[1] || b.key[2] - a.key[2])
  if (!versioned.length) return null
  return resolve(root, versioned[0].name)
}

/** 只允许目录内的路径：拒绝空字节、目录穿越和解析后越界。 */
function resolveInside(root, relative) {
  if (relative.includes('\0')) return null
  const target = resolve(root, relative)
  if (target !== root && !target.startsWith(root + sep)) return null
  return target
}

export const inject = ['webServer']

export function apply(ctx, config) {
  const prefix = ('/' + String(config?.prefix ?? '/dl').replace(/^\/+|\/+$/g, '')).replace(/\/+$/, '')
  const root = resolve(String(config?.dir ?? '/root/学习软件'))
  if (prefix === '') throw new Error('download-route: prefix 不能为空')

  const handler = async (req, res) => {
    const send = (status, text) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : text)
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed')

    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    } catch {
      return send(400, 'bad request')
    }
    if (pathname !== prefix && !pathname.startsWith(prefix + '/')) return send(404, 'not found')

    const relative = pathname.slice(prefix.length).replace(/^\/+/, '')
    if (relative === '') return send(404, 'not found')

    // 固定入口：latest.apk / latest → 版本号最大的 APK，固定下载名。
    const isLatest = relative === 'latest.apk' || relative === 'latest'
    const target = isLatest ? await findLatestApk(root) : resolveInside(root, relative)
    if (target === null) return send(404, 'not found')
    const downloadName = isLatest ? 'BiliLite-latest.apk' : (relative.split('/').pop() ?? 'download')

    let info
    try {
      info = await stat(target)
    } catch {
      return send(404, 'not found')
    }
    if (!info.isFile()) return send(404, 'not found')

    const headers = {
      'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': String(info.size),
      'Content-Disposition': contentDisposition(downloadName),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    }
    res.writeHead(200, headers)
    if (req.method === 'HEAD') return res.end()

    const stream = createReadStream(target)
    stream.on('error', () => {
      // 头已发出，只能截断响应；客户端会看到不完整下载。
      res.destroy()
    })
    stream.pipe(res)
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: prefix, handler }),
    'download-route: download route',
  )
  ctx.logger?.info?.(`download-route: ${prefix}/<path> → ${root}`)
}
