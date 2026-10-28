#!/usr/bin/env node
/**
 * WPS 云盘小工具的公共底座（本机使用）
 *
 * - 复用 tools/wps/state.json 里的登录态（先跑 tools/wps/login.mjs 扫码）
 * - 提供：列出云盘文件树、取某个文件的下载直链
 * - 只读：只调用列表/下载接口，不删不改云盘里的文件
 */
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(resolve(ROOT, 'tools/browser/_resolver.cjs'))
const { chromium } = require('playwright')

export const WORK = resolve(ROOT, '.work')
export const STATE = resolve(ROOT, 'tools/wps/state.json')
export const DL_DIR = resolve(WORK, 'wps-dl')
export const VIDEOS_JSON = resolve(WORK, 'wps-videos.json')
/** 个人云盘的 groupid（登录后从 /api/v5/groups/ 拿到的“我的云文档”组） */
export const PERSONAL_GROUP = '2194913070'

export const VIDEO_RE = /\.(mp4|mkv|mov|m4v|avi|flv|ts|m3u8|webm|wmv|rmvb|rm|3gp|mpg|mpeg|ogv)$/i
export const AUDIO_RE = /\.(mp3|m4a|aac|flac|wav|ogg|opus)$/i

function browserEnv() {
  const env = { ...process.env }
  const libDir = resolve(ROOT, 'tools/browser/chromium-libs/root/usr/lib/aarch64-linux-gnu')
  if (existsSync(libDir)) env.LD_LIBRARY_PATH = [libDir, '/usr/lib/aarch64-linux-gnu'].join(':')
  env.FONTCONFIG_FILE = resolve(ROOT, 'tools/browser/fonts.conf')
  env.FONTCONFIG_PATH = resolve(ROOT, 'tools/browser')
  env.HOME = env.HOME || '/tmp/pw-home'
  return env
}

export function requireState() {
  if (!existsSync(STATE)) {
    console.error('没有登录态：先运行 node tools/wps/login.mjs 并扫码登录')
    process.exit(2)
  }
  return JSON.parse(readFileSync(STATE, 'utf8'))
}

/** 打开一个带登录态的浏览器上下文，用完自动关闭 */
export async function withContext(fn) {
  const state = requireState()
  mkdirSync(WORK, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    env: browserEnv(),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })
  const ctx = await browser.newContext({
    storageState: state,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  })
  // 先打开一次云盘首页：SSO 会顺带刷新 cookie，API 才认登录态
  const page = await ctx.newPage()
  await page.goto('https://drive.wps.cn/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(2500)
  try {
    return await fn(ctx)
  } finally {
    await browser.close().catch(() => {})
  }
}

const HDRS = { referer: 'https://www.kdocs.cn/' }

/** 列某个目录（parentid=0 是“我的云文档”根） */
export async function listFolder(ctx, parentid) {
  const url = `https://drive.kdocs.cn/api/v5/groups/${PERSONAL_GROUP}/files?parentid=${parentid}&offset=0&count=500`
  const r = await ctx.request.get(url, { headers: HDRS })
  if (r.status() !== 200) {
    throw new Error(`列目录失败 ${parentid}: HTTP ${r.status()} ${(await r.text()).slice(0, 120)}`)
  }
  const j = await r.json()
  return j.files || []
}

/** 取文件的下载直链（带签名，约十几分钟过期） */
export async function fileDownloadUrl(ctx, fileid) {
  const url = `https://drive.kdocs.cn/api/v5/groups/${PERSONAL_GROUP}/files/${fileid}/download?support_checksums=md5`
  const r = await ctx.request.get(url, { headers: HDRS })
  const j = await r.json().catch(() => ({}))
  if (r.status() !== 200 || !j.url) {
    throw new Error(`取下载地址失败 ${fileid}: HTTP ${r.status()} ${JSON.stringify(j).slice(0, 160)}`)
  }
  return { url: j.url, size: Number(j.fsize) || 0, checksums: j.checksums || {} }
}

/** 递归遍历，返回所有文件（含 path） */
export async function walkFiles(ctx, { parentid = 0, path = '', depth = 0, maxDepth = 4, onDir } = {}) {
  const out = []
  const files = await listFolder(ctx, parentid)
  if (onDir) onDir(path || '/', files.length)
  for (const f of files) {
    const p = path + '/' + f.fname
    if (f.ftype === 'folder') {
      if (depth < maxDepth) {
        out.push(...(await walkFiles(ctx, { parentid: f.id, path: p, depth: depth + 1, maxDepth, onDir })))
      }
      continue
    }
    out.push({
      id: String(f.id),
      name: f.fname,
      path: p,
      dir: path || '/',
      size: Number(f.fsize) || 0,
      mtime: Number(f.mtime) || 0,
      ctime: Number(f.ctime) || 0,
      groupid: String(f.groupid || ''),
    })
  }
  return out
}

/** 生成 /dl/wps-videos.html 清单页（已下载的带取件链接） */
export function writeIndexHtml(catalog) {
  const groups = new Map()
  for (const f of catalog.items || []) {
    if (!groups.has(f.dir)) groups.set(f.dir, [])
    groups.get(f.dir).push(f)
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const rows = [...groups.entries()]
    .map(([dir, items]) => {
      const size = items.reduce((s, x) => s + (x.size || 0), 0)
      const links = items
        .map((f) => {
          const local = f.local ? `/dl/.work/wps-dl/${encodeURI(f.local)}` : ''
          return `<div class="row"><span class="name">${esc(f.name)}<small>${esc(f.dir)}</small></span>
          <span class="size">${fmtSize(f.size)}</span>
          ${local ? `<a class="dl" href="${local}" download>下载到平板</a>` : '<span class="pending">未下载</span>'}</div>`
        })
        .join('\n')
      return `<details ${dir === '/' || items.some((x) => x.local) ? 'open' : ''}><summary>${esc(dir)} · ${items.length} 个 · ${fmtSize(size)}</summary>${links}</details>`
    })
    .join('\n')
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>WPS 云盘视频（本机工具）</title>
<style>
:root{color-scheme:dark}body{margin:0;background:#0f1115;color:#e8eaf0;font:14px/1.6 -apple-system,system-ui,"Noto Sans CJK SC",sans-serif;padding:16px 18px 60px}
h1{font-size:18px;margin:0 0 6px}p.muted{color:#98a2b3;font-size:13px;margin:0 0 14px}
details{background:#171a21;border:1px solid #262b36;border-radius:10px;margin:8px 0;padding:8px 12px}
summary{cursor:pointer;font-weight:600}
.row{display:flex;gap:10px;align-items:center;padding:6px 2px;border-top:1px solid #21262f}
.row .name{flex:1;word-break:break-all}.row .name small{display:block;color:#98a2b3;font-size:12px}
.row .size{color:#98a2b3;white-space:nowrap}
a.dl{background:#ff6b9d;color:#111;text-decoration:none;font-weight:600;padding:3px 10px;border-radius:999px;white-space:nowrap}
.pending{color:#6b7280;white-space:nowrap}
</style></head><body>
<h1>WPS 云盘视频（本机工具生成）</h1>
<p class="muted">共 ${(catalog.items || []).length} 个，已下载 ${catalog.downloaded || 0} 个（${fmtSize(catalog.downloadedSize || 0)}）。
生成时间 ${new Date(catalog.at || Date.now()).toLocaleString('zh-CN')}。带「下载到平板」的直接点；其余先在电脑上跑
<code>node tools/wps/download.mjs --match 关键字</code> 下载。</p>
${rows}</body></html>`
  writeFileSync(resolve(ROOT, 'wps-videos.html'), html)
  return resolve(ROOT, 'wps-videos.html')
}

/** 从 BV/分享链接里抠出 BV 号（仅用于打印，不联网） */
export function fmtSize(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = Number(n) || 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}
