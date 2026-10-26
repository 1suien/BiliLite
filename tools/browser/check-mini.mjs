#!/usr/bin/env node
/**
 * 浏览器验收：笔记行按钮布局（去掉「跳转」，删除靠最右）+ 小窗播放的圆形入口 / 圆形气泡
 *
 * 用法：node tools/browser/check-mini.mjs [--port 4212] [--headed]
 *
 * 依赖 tools/browser 里的 playwright + chromium（同 check-notes.mjs）：
 *   - chromium 需要 chromium-libs 里的 aarch64 动态库（脚本自动注入 LD_LIBRARY_PATH）
 *   - 页面走 `?mock=1` 的 mock 桥（不联网、不登录）
 *
 * 覆盖：笔记行只剩删除按钮且在行最右 / 多行正文保留 / 小窗入口是正圆 /
 *       点入口出现 112×112 圆形气泡（右下角、含 video）/ 拖动改位置且不跳页 /
 *       点气泡回到视频页继续看 / × 能关闭 / 切到别的页面气泡常驻 / 无真实 console 错误
 *
 * 说明：无头 chromium 放不了 mock 视频（mock:// 被 CSP 拦），所以气泡里是「加载失败」态，
 *       这里只验证圆形、位置、交互与路由；真机播放画面需要装 APK 看。
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
const PORT = argPort >= 0 ? Number(argv[argPort + 1]) : 4212
const HEADED = argv.includes('--headed')
const BASE = `http://127.0.0.1:${PORT}/`
const OUT = process.env.CHECK_MINI_OUT || '/tmp/bililite-check-mini'
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

async function main() {
  if (!existsSync(OUT)) await import('node:fs').then((fs) => fs.mkdirSync(OUT, { recursive: true }))
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: APP,
    stdio: 'ignore',
    detached: true,
  })
  const browser = await chromium.launch({ headless: !HEADED, env: browserEnv() })
  try {
    if (!(await waitServer(BASE))) throw new Error(`vite preview 未在 ${PORT} 端口启动`)
    const ctx = await browser.newContext({ viewport: { width: 1220, height: 800 }, locale: 'zh-CN' })
    const page = await ctx.newPage()
    const errors = []
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    page.on('pageerror', (e) => errors.push(String(e && e.message)))

    const openNotes = async (bvid = 'BV1mock0001') => {
      await page.goto(`${BASE}?mock=1#/video/${bvid}`, { waitUntil: 'domcontentloaded' })
      await wait(1500)
      await page.locator('.tabs .tab', { hasText: '笔记' }).click()
      await page.locator('textarea.note-input').waitFor({ timeout: 10000 })
      await wait(400)
    }

    // ---------- 1. 笔记行：没有跳转按钮，删除在最右 ----------
    await openNotes()
    const ta = page.locator('textarea.note-input')
    await ta.fill('第一行\n第二行，看看删除按钮是不是在右边')
    await page.locator('.panel button.btn.primary', { hasText: '保存' }).click()
    await wait(800)
    const row = page.locator('.panel .field.note-row').first()
    check('笔记行存在', (await row.count()) === 1)
    const btns = await row.locator('button').count()
    check('笔记行只有一个按钮（只剩删除）', btns === 1, `按钮数 ${btns}`)
    const delTitle = await row.locator('button').first().getAttribute('title')
    check('那个按钮是删除', delTitle === '删除这条笔记', String(delTitle))
    const textBox = await row.locator('.ctrl').boundingBox()
    const delBox = await row.locator('button').first().boundingBox()
    check(
      '删除按钮在整行最右',
      !!textBox && !!delBox && delBox.x > textBox.x + textBox.width - 8,
      JSON.stringify({ textRight: textBox && textBox.x + textBox.width, delX: delBox && delBox.x }),
    )
    check('笔记正文多行保留', (await row.locator('.ctrl').innerText()).includes('\n'))
    await page.screenshot({ path: `${OUT}/1-notes-row.png` })

    // ---------- 2. 小窗播放入口是圆形 ----------
    const entry = page.locator('button.mini-entry')
    check('视频页有圆形小窗入口', (await entry.count()) === 1)
    const eb = await entry.boundingBox()
    const radius = await entry.evaluate((el) => getComputedStyle(el).borderRadius)
    check(
      '入口是正圆（宽=高、border-radius 50%）',
      !!eb && Math.abs(eb.width - eb.height) < 1 && radius.includes('50%'),
      JSON.stringify({ w: eb && eb.width, h: eb && eb.height, radius }),
    )
    await page.screenshot({ path: `${OUT}/2-entry.png` })

    // ---------- 3. 点入口 → 右下角出现圆形小气泡 ----------
    await entry.click()
    await page.locator('.mini-player').waitFor({ timeout: 10000 })
    await wait(1200)
    const bubble = page.locator('.mini-player')
    const bb = await bubble.boundingBox()
    const bRadius = await bubble.evaluate((el) => getComputedStyle(el).borderRadius)
    check(
      '小窗是正圆气泡（112×112，border-radius 50%）',
      !!bb && Math.abs(bb.width - 112) < 1 && Math.abs(bb.height - 112) < 1 && bRadius.includes('50%'),
      JSON.stringify({ w: bb && bb.width, h: bb && bb.height, radius: bRadius }),
    )
    check('气泡里有 video 元素', (await bubble.locator('video.mp-video').count()) === 1)
    check('气泡在右下方', !!bb && bb.x > (await page.evaluate(() => innerWidth)) / 2, JSON.stringify(bb))
    const before = await page.evaluate(() => location.hash)
    await page.screenshot({ path: `${OUT}/3-bubble.png` })

    // ---------- 4. 拖动：位置变化且不跳回视频页 ----------
    const oldPos = await bubble.evaluate((el) => ({ left: el.style.left, top: el.style.top }))
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2)
    await page.mouse.down()
    await page.mouse.move(bb.x + bb.width / 2 - 120, bb.y + bb.height / 2 - 80, { steps: 8 })
    await page.mouse.up()
    await wait(300)
    const newPos = await bubble.evaluate((el) => ({ left: el.style.left, top: el.style.top }))
    check('拖动后位置变了', JSON.stringify(oldPos) !== JSON.stringify(newPos), JSON.stringify({ oldPos, newPos }))
    check('拖动不会跳回视频页', (await page.evaluate(() => location.hash)) === before)

    // ---------- 5. 点气泡 → 回到播放页并继续看 ----------
    const b2 = await bubble.boundingBox()
    await page.mouse.click(b2.x + b2.width / 2, b2.y + b2.height / 2)
    await wait(1800)
    check('点气泡后气泡消失', (await page.locator('.mini-player').count()) === 0)
    check('点气泡后回到视频页', /#\/video\//.test(await page.evaluate(() => location.hash)), await page.evaluate(() => location.hash))
    await page.screenshot({ path: `${OUT}/4-back-to-video.png` })

    // ---------- 6. 关闭按钮可用 ----------
    await page.locator('button.mini-entry').click()
    await page.locator('.mini-player').waitFor({ timeout: 10000 })
    await wait(600)
    await page.locator('.mini-player .mp-close').click()
    await wait(400)
    check('点 × 能关掉小圆圈', (await page.locator('.mini-player').count()) === 0)

    // ---------- 7. 小圆圈在别的页面也常驻（跨页面） ----------
    await page.locator('button.mini-entry').click()
    await page.locator('.mini-player').waitFor({ timeout: 10000 })
    await wait(500)
    await page.locator('.side-nav a, .sidenav a, nav a').first().click().catch(() => {})
    await wait(1000)
    check('去别的页面后小圆圈还在', (await page.locator('.mini-player').count()) === 1)
    await page.screenshot({ path: `${OUT}/5-bubble-other-page.png` })

    const realErrors = errors.filter((e) => !/mock:\/\/|Content Security Policy|Fetch API cannot load mock/.test(e))
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
