#!/usr/bin/env node
/**
 * 浏览器验收：离开播放页时视频自动缩成右下角小圆圈并暂停（本机定制 0.4.8）
 *
 * 用法：node tools/browser/check-automini.mjs [--port 4213] [--headed]
 *
 * 依赖 tools/browser 里的 playwright + chromium（同 check-mini.mjs）：
 *   - chromium 需要 chromium-libs 里的 aarch64 动态库（脚本自动注入 LD_LIBRARY_PATH）
 *   - 页面走 `?mock=1` 的 mock 桥（不联网、不登录）；`&badstream=1` 时保留 mock 的坏流，用来验证「拉流失败不弹小窗」
 *
 * 说明：mock 桥给的播放地址是 mock://（无头 chromium 放不了）。这里在页面里用 canvas + MediaRecorder
 *       录一段真实的 webm，再把 mock 桥的 playurl 改写成这段直链，于是播放器真能出画面/时长、能验证
 *       「离开→暂停小窗」「点回来→自动继续播放」；生产代码里没有任何测试专用开关。
 *
 * 覆盖：播放页点左侧导航 → 出现圆形气泡 / 气泡视频暂停 / 暂停徽标 / 记住进度 / 气泡常驻别的页面 /
 *       点气泡回播放页且自动继续播放 / 同页换分P 不弹气泡 / 换视频 不弹气泡 /
 *       手动圆形入口仍然可用 / 拉流失败的视频离开不弹气泡 / 无真实 console 错误
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const APP = resolve(ROOT, 'app')
const argv = process.argv.slice(2)
const argPort = argv.indexOf('--port')
const PORT = argPort >= 0 ? Number(argv[argPort + 1]) : 4213
const HEADED = argv.includes('--headed')
const BASE = `http://127.0.0.1:${PORT}/`
const OUT = process.env.CHECK_AUTOMINI_OUT || '/tmp/bililite-check-automini'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function browserEnv() {
  const env = { ...process.env }
  const libDir = resolve(ROOT, 'tools/browser/chromium-libs/root/usr/lib/aarch64-linux-gnu')
  const fontConf = resolve(ROOT, 'tools/browser/fonts.conf')
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

async function waitServer(url, timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok || r.status === 404) return true
    } catch {}
    await wait(300)
  }
  return false
}

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
}

/** 在任何页面脚本之前：造一段能真播的 webm 直链，并接管 mock 桥的 playurl */
const INIT = () => {
  // 1) canvas + MediaRecorder 录 3 秒视频，得到 blob: 直链（无头 chromium 没有 mock:// 解码器）
  const media = (async () => {
    const c = document.createElement('canvas')
    c.width = 320
    c.height = 180
    const g = c.getContext('2d')
    let i = 0
    const timer = setInterval(() => {
      i += 1
      g.fillStyle = `hsl(${(i * 24) % 360},70%,42%)`
      g.fillRect(0, 0, 320, 180)
      g.fillStyle = '#fff'
      g.font = 'bold 28px sans-serif'
      g.fillText('test ' + (i / 10).toFixed(1) + 's', 24, 104)
    }, 100)
    const stream = c.captureStream(10)
    const rec = new MediaRecorder(stream)
    const chunks = []
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data)
    }
    const stopped = new Promise((r) => (rec.onstop = r))
    rec.start()
    await new Promise((r) => setTimeout(r, 3000))
    rec.stop()
    clearInterval(timer)
    await stopped
    return URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }))
  })()
  window.__testMedia = media
  // 2) 接管 window.bili：把 playurl 换成直链（badstream=1 时保留原来的 mock:// 坏流）
  let installed
  Object.defineProperty(window, 'bili', {
    configurable: true,
    get: () => installed,
    set: (nv) => {
      const orig = nv && nv.video && nv.video.playurl
      if (orig && nv.video && !location.search.includes('badstream=1')) {
        nv.video.playurl = async function (...args) {
          const p = await orig.apply(this, args)
          const url = await window.__testMedia
          return { ...p, videos: [], audios: [], url, type: 'webm' }
        }
      }
      installed = nv
    },
  })
}

async function main() {
  if (!existsSync(OUT)) await import('node:fs').then((fs) => fs.mkdirSync(OUT, { recursive: true }))
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: APP,
    stdio: 'ignore',
    detached: true,
  })
  const browser = await chromium.launch({
    headless: !HEADED,
    env: browserEnv(),
    args: ['--autoplay-policy=no-user-gesture-required'],
  })
  try {
    if (!(await waitServer(BASE))) throw new Error(`vite preview 未在 ${PORT} 端口启动`)
    const ctx = await browser.newContext({ viewport: { width: 1220, height: 800 }, locale: 'zh-CN' })
    const page = await ctx.newPage()
    const errors = []
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    page.on('pageerror', (e) => errors.push(String(e && e.message)))
    await page.addInitScript(INIT)

    const videoEl = () => page.locator('.player-stage video')
    const hash = () => page.evaluate(() => location.hash)
    const navTo = async (label) => {
      await page.locator('.side .nav-item', { hasText: label }).first().click()
      await wait(900)
    }
    const playingAt = async (min = 0.2, timeout = 25000) => {
      await page.waitForFunction(
        (m) => {
          const v = document.querySelector('.player-stage video')
          return !!v && !v.paused && v.currentTime > m
        },
        min,
        { timeout },
      )
    }

    // ---------- 1. 正常播放的视频：离开播放页 → 自动小窗 + 暂停 ----------
    await page.goto(`${BASE}?mock=1#/video/BV1mock0001`, { waitUntil: 'domcontentloaded' })
    await playingAt(1.2)
    const leftAt = await videoEl().evaluate((v) => v.currentTime)
    check('测试用直链能真播放（离开前已播 > 1.2s）', leftAt > 1.2, `${leftAt.toFixed(2)}s`)

    await navTo('学习')
    await page.locator('.mini-player').waitFor({ timeout: 10000 })
    await wait(1200)
    const bubble = page.locator('.mini-player')
    check('点左侧导航离开播放页 → 自动出现小窗气泡', (await bubble.count()) === 1)
    check('离开后路由已不是播放页', /#\/learn/.test(await hash()), await hash())
    check('气泡里有 video', (await bubble.locator('video.mp-video').count()) === 1)

    const bv = bubble.locator('video.mp-video')
    const bubblePaused = await bv.evaluate((v) => v.paused)
    check('气泡里的视频是暂停状态', bubblePaused === true)
    check('气泡显示暂停徽标（pause 图标）', (await bubble.locator('.mp-badge rect').count()) === 2)
    const bubbleAt = await bv.evaluate((v) => v.currentTime)
    check('气泡停在离开时的进度', bubbleAt > 0.5, `${bubbleAt.toFixed(2)}s / 离开时 ${leftAt.toFixed(2)}s`)
    check('气泡在右下角', await bubble.evaluate((el) => el.getBoundingClientRect().left > innerWidth / 2))
    await page.screenshot({ path: `${OUT}/1-auto-bubble-paused.png` })

    // ---------- 2. 点气泡 → 回播放页自动继续播放 ----------
    await bubble.locator('.mp-tap').click()
    await wait(2200)
    check('点气泡回到播放页', /#\/video\/BV1mock0001/.test(await hash()), await hash())
    check('回到播放页后气泡消失', (await page.locator('.mini-player').count()) === 0)
    await playingAt(0.1, 20000).catch(() => {})
    const resumed = await page
      .waitForFunction(
        () => {
          const v = document.querySelector('.player-stage video')
          return !!v && !v.paused && v.currentTime > 0.1
        },
        null,
        { timeout: 20000 },
      )
      .then(() => true)
      .catch(() => false)
    check('回到播放页后自动继续播放', resumed)
    await page.screenshot({ path: `${OUT}/2-back-resumed.png` })

    // ---------- 3. 同页换分P 不弹气泡 ----------
    await page.locator('.page-pill').nth(1).click()
    await wait(1800)
    check('同页换分P 不弹气泡', (await page.locator('.mini-player').count()) === 0)
    check('换分P 后仍在播放页（p=2）', /#\/video\/BV1mock0001\?p=2/.test(await hash()), await hash())

    // ---------- 4. 换视频 不弹气泡 ----------
    await page.evaluate(() => {
      location.hash = '#/video/BV1mock0002'
    })
    await wait(2000)
    check('换到另一个视频不弹气泡', (await page.locator('.mini-player').count()) === 0)

    // ---------- 5. 手动圆形入口仍然可用 ----------
    await page.goto(`${BASE}?mock=1#/video/BV1mock0001`, { waitUntil: 'domcontentloaded' })
    await playingAt(0.3)
    await page.locator('button.mini-entry').click()
    await page.locator('.mini-player').waitFor({ timeout: 10000 })
    await wait(600)
    check('手动圆形入口仍然能开小窗', (await page.locator('.mini-player').count()) === 1)
    await page.locator('.mini-player .mp-close').click()
    await wait(500)
    check('点 × 能关掉气泡', (await page.locator('.mini-player').count()) === 0)

    // ---------- 6. 拉流失败的视频：离开时不弹气泡 ----------
    await page.goto(`${BASE}?mock=1&badstream=1#/video/BV1mock0001`, { waitUntil: 'domcontentloaded' })
    await wait(3000)
    await navTo('学习')
    await wait(1200)
    check('拉流失败的视频离开时不弹气泡', (await page.locator('.mini-player').count()) === 0)
    await page.screenshot({ path: `${OUT}/3-badstream-no-bubble.png` })

    const realErrors = errors.filter((e) => !/mock:\/\/|Content Security Policy|Fetch API cannot load mock|Failed to load resource/.test(e))
    check('无真实 console error / pageerror', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
  } finally {
    await browser.close().catch(() => {})
    try {
      process.kill(-preview.pid, 'SIGKILL')
    } catch {
      preview.kill('SIGKILL')
    }
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过，截图在 ${OUT}/`)
  if (failed.length) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
