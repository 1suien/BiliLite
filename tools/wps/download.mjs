#!/usr/bin/env node
/**
 * 下载 WPS 云盘里的视频到本机（只读云盘，不改不删）
 *
 * 先跑 node tools/wps/list.mjs 生成清单，然后：
 *   node tools/wps/download.mjs --ids 574502907669,574502513544
 *   node tools/wps/download.mjs --match 新概念 --limit 3
 *   node tools/wps/download.mjs --dir "/新概念/新概念英语 第三册" --limit 5
 *   node tools/wps/download.mjs --ids 574502907669 --open   # 下载完打印 /dl 链接
 *
 * 文件落盘到 .work/wps-dl/<云盘目录>/<文件名>，同一次下载支持断点续传（.part）。
 * 下载完成后可直接用 http://127.0.0.1:3080/dl/.work/wps-dl/... 给平板取件。
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve, posix } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ROOT, WORK, DL_DIR, VIDEOS_JSON, withContext, fileDownloadUrl, fmtSize, writeIndexHtml } from './lib.mjs'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf('--' + name)
  if (i < 0) return ''
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : 'true'
}
const ids = flag('ids')
const match = flag('match')
const dir = flag('dir')
const limit = Number(flag('limit') || 0) || 0
const open = argv.includes('--open')

if (!existsSync(VIDEOS_JSON)) {
  console.error('还没有清单：先运行 node tools/wps/list.mjs')
  process.exit(2)
}
const catalog = JSON.parse(readFileSync(VIDEOS_JSON, 'utf8'))
let items = catalog.items
if (ids) {
  const want = new Set(ids.split(',').map((s) => s.trim()).filter(Boolean))
  items = items.filter((f) => want.has(f.id))
}
if (match) items = items.filter((f) => (f.path + ' ' + f.name).toLowerCase().includes(match.toLowerCase()))
if (dir) items = items.filter((f) => f.dir.toLowerCase().includes(dir.toLowerCase()))
if (!ids && !match && !dir) {
  console.error('要指定下载哪些：--ids / --match / --dir（可加 --limit）')
  process.exit(2)
}
if (limit > 0) items = items.slice(0, limit)
if (!items.length) {
  console.error('没有匹配到的文件')
  process.exit(1)
}

const safeSeg = (s) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'unnamed'
const relPathOf = (f) => posix.join(f.dir.replace(/^\/+/, ''), safeSeg(f.name))
const absPathOf = (f) => resolve(DL_DIR, relPathOf(f))

console.log(`准备下载 ${items.length} 个文件，合计 ${fmtSize(items.reduce((s, f) => s + f.size, 0))}`)
mkdirSync(DL_DIR, { recursive: true })

const done = []
const failed = []
let idx = 0
await withContext(async (ctx) => {
  for (const f of items) {
    idx++
    const target = absPathOf(f)
    mkdirSync(dirname(target), { recursive: true })
    if (existsSync(target) && statSync(target).size === f.size && f.size > 0) {
      console.log(`[${idx}/${items.length}] 已存在，跳过 ${relPathOf(f)}`)
      done.push(f)
      continue
    }
    const part = target + '.part'
    let offset = existsSync(part) ? statSync(part).size : 0
    if (f.size && offset === f.size) {
      renameSync(part, target)
      console.log(`[${idx}/${items.length}] 续传完成 ${relPathOf(f)}`)
      done.push(f)
      continue
    }
    // 已经多下的 .part 比文件还大 → 重来
    if (f.size && offset > f.size) { rmSync(part, { force: true }); offset = 0 }

    process.stdout.write(`[${idx}/${items.length}] ${relPathOf(f)} (${fmtSize(f.size)}) `)
    try {
      const { url } = await fileDownloadUrl(ctx, f.id)
      const headers = offset > 0 ? { range: `bytes=${offset}-` } : {}
      const res = await fetch(url, { headers })
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length') || 0) + offset
      const stream = Readable.fromWeb(res.body)
      let got = offset
      let last = Date.now()
      let lastGot = got
      stream.on('data', (c) => {
        got += c.length
        const now = Date.now()
        if (now - last > 2000) {
          const pct = total ? ((got / total) * 100).toFixed(1) : '?'
          const speed = ((got - lastGot) / 1024 / 1024) / ((now - last) / 1000)
          process.stdout.write(` ${pct}% ${fmtSize(got)} ${speed.toFixed(1)}MB/s`)
          last = now
          lastGot = got
        }
      })
      await pipeline(stream, createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' }))
      renameSync(part, target)
      console.log(` 完成 ${fmtSize(statSync(target).size)}`)
      done.push(f)
    } catch (e) {
      console.log(` 失败: ${e.message}`)
      failed.push({ f, err: e.message })
    }
  }
})

// 回写本地路径，供清单页/后续使用
const byId = new Map(catalog.items.map((x) => [x.id, x]))
for (const f of done) {
  const it = byId.get(f.id)
  if (it) it.local = relPathOf(f)
}
catalog.downloaded = catalog.items.filter((x) => x.local).length
catalog.downloadedSize = catalog.items.filter((x) => x.local).reduce((s, x) => s + (x.size || 0), 0)
writeFileSync(VIDEOS_JSON, JSON.stringify(catalog, null, 2))
writeIndexHtml(catalog)

console.log(`\n完成 ${done.length} 个，失败 ${failed.length} 个；累计已下载 ${catalog.downloaded} 个 / ${fmtSize(catalog.downloadedSize)}`)
if (done.length) {
  console.log('平板取件（任选其一，把链接粘到平板浏览器）：')
  for (const f of done.slice(0, 20)) {
    console.log(`  http://127.0.0.1:3080/dl/.work/wps-dl/${encodeURI(relPathOf(f))}`)
  }
  if (open) console.log(`\n清单页: http://127.0.0.1:3080/dl/wps-videos.html`)
}
if (failed.length) process.exitCode = 1
