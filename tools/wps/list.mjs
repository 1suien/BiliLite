#!/usr/bin/env node
/**
 * 列出 WPS 云盘里的视频/音频（只读）
 *
 * 用法：node tools/wps/list.mjs [--max-depth 4] [--json]
 * 输出：.work/wps-videos.json（全部条目）、wps-videos.html（可在 /dl/wps-videos.html 打开）
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROOT, WORK, VIDEOS_JSON, VIDEO_RE, AUDIO_RE, withContext, walkFiles, fmtSize, writeIndexHtml } from './lib.mjs'

const argv = process.argv.slice(2)
const maxDepth = Number(argv[argv.indexOf('--max-depth') + 1] || 4) || 4
const asJson = argv.includes('--json')

const all = await withContext(async (ctx) => {
  const files = await walkFiles(ctx, { maxDepth, onDir: (p, n) => asJson || console.log(`  [${n}] ${p}`) })
  return files
})

const media = all.filter((f) => VIDEO_RE.test(f.name) || AUDIO_RE.test(f.name))
media.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'))
const videos = media.filter((f) => VIDEO_RE.test(f.name))
const audios = media.filter((f) => AUDIO_RE.test(f.name))
const totalSize = media.reduce((s, f) => s + f.size, 0)

const payload = {
  at: Date.now(),
  root: '我的云文档',
  count: media.length,
  videos: videos.length,
  audios: audios.length,
  totalSize,
  items: media.map((f) => ({ ...f, kind: VIDEO_RE.test(f.name) ? 'video' : 'audio' })),
}
writeFileSync(VIDEOS_JSON, JSON.stringify(payload, null, 2))

const indexPath = writeIndexHtml(payload)

console.log(`\n共 ${payload.items.length} 个视频/音频（视频 ${payload.videos}、音频 ${payload.audios}），合计 ${fmtSize(totalSize)}`)
console.log('清单:', VIDEOS_JSON)
console.log('清单页（浏览器打开）: http://127.0.0.1:3080/dl/wps-videos.html')
