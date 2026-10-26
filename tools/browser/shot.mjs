#!/usr/bin/env node
/**
 * 浏览器验收脚本（还原工程新增的开发者工具，不属于原 APK）
 *
 * 用途：用 Playwright 无头 Chromium 打开应用（mock 数据桥模式），
 * 遍历所有路由，收集控制台错误 / 页面异常 / 关键 DOM 标记，并截图，供还原度对照。
 *
 * 用法：
 *   1) 先构建：cd app && npm run build
 *   2) node tools/browser/shot.mjs [baseUrl]
 *      baseUrl 默认 http://127.0.0.1:4199（脚本自己起 `vite preview` 时用这个端口）
 *
 * 输出：/root/学习软件/reference/screenshots/<route>.png 与截图同名 .json 报告
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const APP = resolve(ROOT, 'app')
const OUT = resolve(ROOT, 'reference/screenshots')
const PORT = 4199
const BASE = process.argv[2] || `http://127.0.0.1:${PORT}/`

/** 路由 → 截图名（mock 数据里会有对应内容） */
const ROUTES = [
  ['学习', '#/learn'],
  ['搜索', '#/search?q=线性代数'],
  ['播放', '#/video/BV1mock0001'],
  ['收藏', '#/fav'],
  ['收藏夹', '#/fav/123456'],
  ['学习', '#/learn'],
  ['习惯', '#/habit'],
  ['本地', '#/local'],
  ['本播', '#/local/demo-local-0'],
  ['UP管理', '#/ups'],
  ['UP主', '#/up/14871346'],
  ['设置', '#/settings'],
]

function startPreview() {
  const p = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: APP,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  p.stdout.setEncoding('utf8')
  p.stderr.setEncoding('utf8')
  return p
}

async function waitServer(url, timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok || r.status === 404) return true
    } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}

/**
 * 本机没有 root 权限安装 Chromium 的系统依赖，所以把 .deb 解到本地目录，
 * 通过 LD_LIBRARY_PATH / FONTCONFIG_FILE 让无头 Chromium 跑起来（见 README 的「浏览器验收」一节）。
 */
function browserEnv() {
  const libDir = resolve(ROOT, 'tools/browser/chromium-libs/root/usr/lib/aarch64-linux-gnu')
  const fontConf = resolve(ROOT, 'tools/browser/fonts.conf')
  const env = { ...process.env }
  if (existsSync(libDir)) {
    env.LD_LIBRARY_PATH = [libDir, env.LD_LIBRARY_PATH, '/usr/lib/aarch64-linux-gnu'].filter(Boolean).join(':')
  }
  if (existsSync(fontConf)) {
    env.FONTCONFIG_FILE = fontConf
    env.FONTCONFIG_PATH = resolve(ROOT, 'tools/browser')
  }
  env.HOME = env.HOME || '/tmp/pw-home'
  return env
}

/** 等页面稳定：网络空闲 + 一小段动画时间 */
async function settle(page, ms = 900) {
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(ms)
}

const main = async () => {
  mkdirSync(OUT, { recursive: true })
  let preview = null
  if (!process.argv[2]) {
    preview = startPreview()
    const ok = await waitServer(BASE)
    if (!ok) {
      console.error('[shot] vite preview 未能启动')
      preview.kill()
      process.exitCode = 1
      return
    }
  }

  const browser = await chromium.launch({ env: browserEnv() })
  const results = []
  try {
    for (const [label, hash] of ROUTES) {
      const ctx = await browser.newContext({
        // 这个 App 是「平板/桌面」布局（侧栏常驻、没有响应式断点），所以用横屏尺寸验收
        viewport: { width: 1180, height: 820 },
        deviceScaleFactor: 1.5,
        isMobile: false,
        hasTouch: true,
        locale: 'zh-CN',
      })
      const page = await ctx.newPage()
      const errors = []
      page.on('console', m => {
        if (m.type() === 'error') errors.push('[console] ' + m.text())
      })
      page.on('pageerror', e => errors.push('[pageerror] ' + (e && e.message)))
      page.on('requestfailed', r => {
        const u = r.url()
        // 外链图片/字体在无网环境失败是预期的（mock 数据用 data URI，正常不会出现）
        if (!/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(u)) return
        errors.push('[requestfailed] ' + u + ' ' + (r.failure() && r.failure().errorText))
      })

      const url = BASE.replace(/\/$/, '/') + (process.argv[2] ? '' : '') + '?mock=1' + hash
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await settle(page)
      // 二次路由（hash 已包含，但确保 router 完成懒加载）
      await page.waitForTimeout(400)

      const info = await page.evaluate(() => {
        const app = document.querySelector('#app')
        const txt = (app ? app.textContent : '') || ''
        return {
          title: document.title,
          htmlLen: (app ? app.innerHTML : '').length,
          textLen: txt.trim().length,
          textHead: txt.replace(/\s+/g, ' ').trim().slice(0, 160),
          hasSide: !!document.querySelector('.side'),
          hasNav: !!document.querySelector('.nav, .nav-item'),
          cards: document.querySelectorAll('.card, .video-card, .uprow, .habit-card, .local-row').length,
          imgs: document.querySelectorAll('img').length,
          empty: !!document.querySelector('.empty, .empty-block'),
        }
      })

      const file = resolve(OUT, label + '.png')
      await page.screenshot({ path: file, fullPage: true })
      const rec = { label, hash, url, ...info, errors }
      results.push(rec)
      console.log(`[shot] ${label} ${'#/'.padEnd(18)} 文本 ${info.textLen} 字 / 元素 ${info.htmlLen} / 卡片 ${info.cards} / 错误 ${errors.length}`)
      if (errors.length) errors.slice(0, 6).forEach(e => console.log('        ' + e.slice(0, 300)))
      await ctx.close()
    }
  } finally {
    await browser.close()
    if (preview) preview.kill()
  }

  writeFileSync(resolve(OUT, '_report.json'), JSON.stringify(results, null, 2))
  const bad = results.filter(r => r.errors.length || r.textLen < 10)
  console.log(`\n[shot] 共 ${results.length} 个路由，可疑 ${bad.length} 个；报告 ${resolve(OUT, '_report.json')}`)
  if (bad.length) process.exitCode = 1
}

main().catch(e => {
  console.error(e)
  process.exitCode = 1
})
