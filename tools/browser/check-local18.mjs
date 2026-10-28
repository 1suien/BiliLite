#!/usr/bin/env node
/**
 * 浏览器验收：扫描本机视频并导入（本机构建 0.4.18）
 *
 * 用法：node tools/browser/check-local18.mjs [--port 4224] [--headed]
 *
 * 背景：WPS 网盘里的云文件没法「分享到其他应用」（0.4.15 的分享接收路径用不上），
 * 0.4.18 加了两条兜底：① 分享入口放宽（SEND 支持 application/octet-stream）；
 * ② 本地页新增「扫描本机视频」（安卓 MediaStore）——先在 WPS 里把视频下载到平板，
 * 再从这里勾选导入，文件复制进 App 私有目录。
 *
 * 浏览器里验证 JS 侧（mock 桥返回 4 条假视频）：
 *   - 本地页有「扫描本机视频」按钮 → 点开弹层列出扫到的视频
 *   - 「全选」→ 已选 4 个；导入后写入 IndexedDB 4 条、弹层关闭
 *   - 有不是音视频的文件时提示「已跳过」
 *   - 扫描失败（权限被拒等）只弹错误提示，不崩
 *   - 无真实 console error / pageerror
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const APP = resolve(ROOT, 'app')
const argv = process.argv.slice(2)
const argPort = argv.indexOf('--port')
const PORT = argPort >= 0 ? Number(argv[argPort + 1]) : 4224
const HEADED = argv.includes('--headed')
const BASE = `http://127.0.0.1:${PORT}/`
const OUT = process.env.CHECK_LOCAL18_OUT || '/tmp/bililite-check-local18'
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
      if (r.ok) return
    } catch {
      /* retry */
    }
    await wait(250)
  }
  throw new Error(`preview 没起来: ${url}`)
}

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
}

function countLocals(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('study-bili')
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('locals')
          const rq = tx.objectStore('locals').count()
          rq.onsuccess = () => resolve(rq.result)
          rq.onerror = () => resolve(-1)
        }
        req.onerror = () => resolve(-1)
      }),
  )
}

const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: APP,
  stdio: 'ignore',
  detached: true,
})
let browser
let failed = false

try {
  mkdirSync(OUT, { recursive: true })
  await waitServer(BASE)
  browser = await chromium.launch({ headless: !HEADED, env: browserEnv() })
  const page = await browser.newPage({ viewport: { width: 1220, height: 800 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })

  await page.goto(`${BASE}?mock=1#/local`, { waitUntil: 'networkidle' })
  await page.waitForSelector('h1', { timeout: 15000 })
  // 清掉 mock 种入的演示本地视频，导入结果才干净
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('study-bili')
        req.onsuccess = () => {
          const db = req.result
          try {
            const tx = db.transaction('locals', 'readwrite')
            tx.objectStore('locals').clear()
            tx.oncomplete = () => resolve(true)
            tx.onerror = () => resolve(false)
          } catch {
            resolve(false)
          }
        }
        req.onerror = () => resolve(false)
      }),
  )
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('h1', { timeout: 15000 })
  await page.evaluate(() => {
    Object.defineProperty(window.bili, 'platform', { get: () => 'android', configurable: true })
  })
  await wait(300)

  // 1) 有「扫描本机视频」按钮
  const scanBtn = page.locator('[data-scan-open]').first()
  check('本地页有「扫描本机视频」入口', (await scanBtn.count()) > 0)

  // 2) 打开弹层 → 列出 4 条 mock 视频
  await scanBtn.click()
  await page.waitForSelector('.scan-box', { timeout: 8000 })
  const listed = await page.locator('.scan-item').count()
  const headText = await page.locator('.scan-head').innerText()
  check('弹层列出扫描到的视频', listed === 4 && /扫描到 4 个/.test(headText), `${listed} 条 · ${headText.replace(/\n/g, ' ')}`)
  await page.screenshot({ path: `${OUT}/1-scan-list.png` })

  // 3) 全选 → 已选 4
  await page.locator('.scan-tools input[type=checkbox]').check()
  await wait(200)
  const pickedAll = await page.locator('.scan-tools').innerText()
  check('「全选」后显示已选 4 个', /已选 4 个/.test(pickedAll), pickedAll.replace(/\n/g, ' '))

  // 4) 导入 → 写入 4 条 + 弹层关闭
  await page.locator('[data-scan-import]').click()
  await wait(1200)
  const count1 = await countLocals(page)
  const boxOpen = await page.locator('.scan-box').count()
  const body1 = await page.locator('body').innerText()
  check('导入选中后写入 4 条本地视频', count1 === 4, `行数=${count1}`)
  check('导入后弹层关闭', boxOpen === 0, `scan-box=${boxOpen}`)
  check('页面提示已加入 4 个', /已加入 4 个本地视频/.test(body1))
  await page.screenshot({ path: `${OUT}/2-scan-imported.png` })

  // 5) 非音视频文件被跳过 → 提示「已跳过」
  await page.evaluate(() => {
    window.bili.local.scanVideos = async () => ({
      items: [
        { uri: 'content://mock/9', name: '课程资料.zip', size: 1024, mtime: Date.now(), dir: 'Download', mime: 'application/zip' },
      ],
      count: 1,
    })
    window.bili.local.importSelected = async () => ({
      entries: [],
      skipped: [{ name: '课程资料.zip' }],
      count: 0,
    })
  })
  await page.locator('[data-scan-open]').first().click()
  await page.waitForSelector('.scan-box', { timeout: 8000 })
  await page.locator('.scan-item input[type=checkbox]').first().check()
  await page.locator('[data-scan-import]').click()
  await wait(1000)
  const body2 = await page.locator('body').innerText()
  check('非音视频文件提示「已跳过」', /已跳过/.test(body2), body2.split('\n').filter((x) => /跳过/.test(x)).join(' '))

  // 6) 扫描失败只提示、不崩
  await page.evaluate(() => {
    window.bili.local.scanVideos = async () => {
      throw new Error('测试：没有读媒体的权限')
    }
  })
  await page.locator('[data-scan-open]').first().click()
  await wait(800)
  const body3 = await page.locator('body').innerText()
  const box3 = await page.locator('.scan-box').count()
  check('扫描失败时只提示错误、页面不崩', /没有读媒体的权限/.test(body3) && (await page.locator('h1').count()) > 0, `scan-box=${box3}`)

  // 7) 无真实 console error（过滤 mock:// 与 CSP 噪音）
  const real = errors.filter(
    (e) => !/mock:\/\/|Content Security Policy|Fetch API cannot load mock|Failed to load resource/i.test(e),
  )
  check('无真实 console error / pageerror', real.length === 0, real.slice(0, 3).join(' | '))

  const pass = results.filter((r) => r.ok).length
  console.log(`\n${pass}/${results.length} 通过，截图在 ${OUT}`)
  if (pass !== results.length) failed = true
} catch (e) {
  console.error('检查脚本自身出错：', e)
  failed = true
} finally {
  if (browser) await browser.close().catch(() => {})
  try {
    process.kill(-preview.pid, 'SIGKILL')
  } catch {
    /* ignore */
  }
}

process.exit(failed ? 1 : 0)
