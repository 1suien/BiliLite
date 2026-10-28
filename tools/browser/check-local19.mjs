#!/usr/bin/env node
/**
 * 浏览器验收：本地页只保留「本地导入」（本机构建 0.4.19）
 *
 * 用法：node tools/browser/check-local19.mjs [--port 4225] [--headed]
 *
 * 0.4.19 按用户要求把本地页的入口收成一个「本地导入」：
 *   - 页头只剩「本地导入」，没有「打开文件 / 打开文件夹 / 扫描本机视频 / 检测 / 原生导入（实验）」；
 *   - 点「本地导入」走系统文件选择器（这里用 stub 的 pickFolder 代替真实文件选择），选中的视频入库；
 *   - 分享接收（App.vue 的 localShare）仍然可用；
 *   - 无真实 console error / pageerror。
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
const PORT = argPort >= 0 ? Number(argv[argPort + 1]) : 4225
const HEADED = argv.includes('--headed')
const BASE = `http://127.0.0.1:${PORT}/`
const OUT = process.env.CHECK_LOCAL19_OUT || '/tmp/bililite-check-local19'
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
  check('本地页能打开', (await page.locator('h1').first().innerText()).includes('本地'))

  // 清掉 mock 桥种入的演示本地视频（mock:// 故意不能播，会显示「文件不在了」）
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

  // 1) 入口只剩「本地导入」
  const importBtns = await page.locator('[data-local-import]').count()
  check('页头有「本地导入」按钮', importBtns >= 1, `${importBtns} 个`)
  const labels = await page.locator('.page-head button, .row button').allInnerTexts()
  const joined = labels.join('|')
  check('没有「打开文件」按钮', !joined.includes('打开文件'), joined.slice(0, 80))
  check('没有「打开文件夹」按钮', !joined.includes('打开文件夹'))
  check('没有「扫描本机视频」按钮', !joined.includes('扫描本机视频'))
  check('没有「检测」按钮', !/检测/.test(joined))
  check('没有「原生导入（实验）」按钮', !joined.includes('原生导入'))
  check('没有步骤日志', (await page.locator('[data-pick-trace]').count()) === 0)
  check('没有扫描弹层', (await page.locator('.scan-box').count()) === 0)
  await page.screenshot({ path: `${OUT}/1-local-only-import.png` })

  // 2) 点「本地导入」→ 选择器返回 3 个视频 → 入库
  await page.evaluate(() => {
    window.bili.local.pickFolder = async () => ({
      dir: '本机文件',
      entries: [
        { id: 'l19-1', path: '/data/user/0/com.bililite.app/files/local-media/本机测试 1.mp4', name: '本机测试 1.mp4', size: 32 * 1024 * 1024, mtime: Date.now(), mime: 'video/mp4', url: 'mock://l19-1' },
        { id: 'l19-2', path: '/data/user/0/com.bililite.app/files/local-media/本机测试 2.mp4', name: '本机测试 2.mp4', size: 31 * 1024 * 1024, mtime: Date.now(), mime: 'video/mp4', url: 'mock://l19-2' },
        { id: 'l19-3', path: '/data/user/0/com.bililite.app/files/local-media/本机测试 3.mp4', name: '本机测试 3.mp4', size: 30 * 1024 * 1024, mtime: Date.now(), mime: 'video/mp4', url: 'mock://l19-3' },
      ],
      truncated: false,
    })
  })
  await page.locator('[data-local-import]').first().click()
  await page.waitForSelector('.lrow', { timeout: 15000 })
  const rows = await page.locator('.lrow').count()
  check('「本地导入」选中的视频入库', rows >= 3, `${rows} 条`)
  await page.screenshot({ path: `${OUT}/2-local-imported.png` })

  // 3) 取消选择（entries 为空）不新增、不报错
  await page.evaluate(() => {
    window.bili.local.pickFolder = async () => ({ dir: '本机文件', entries: [], truncated: false })
  })
  await page.locator('[data-local-import]').first().click()
  await wait(500)
  const rowsAfter = await page.locator('.lrow').count()
  check('取消选择不新增条目', rowsAfter === rows, `${rows} → ${rowsAfter}`)

  // 4) 分享接收仍然可用（App.vue 只在安卓平台处理）
  await page.evaluate(() => {
    Object.defineProperty(window.bili, 'platform', { get: () => 'android', configurable: true })
  })
  await page.evaluate(() => {
    const b = window.bili
    b.local.sharedPending = async () => ({
      entries: [
        { id: 'share001', path: '/data/user/0/com.bililite.app/files/local-media/分享测试.mp4', name: '分享测试.mp4', size: 1234567, mtime: Date.now(), mime: 'video/mp4' },
      ],
      count: 1,
      skipped: [],
    })
    b.local.register = async (paths) => ({
      entries: [{ id: 'share001', path: paths[0], name: '分享测试.mp4', size: 1234567, mtime: Date.now(), url: 'mock://share001' }],
      missing: [],
    })
    window.dispatchEvent(new Event('localShare'))
  })
  await page.waitForFunction(() => location.hash.startsWith('#/local/share001'), { timeout: 15000 })
  check('收到分享后跳到播放页', (await page.evaluate(() => location.hash)) === '#/local/share001')

  const realErrors = errors.filter(
    (t) => !/mock:\/\/|Content Security Policy|Fetch API cannot load mock|_capacitor_file_|ERR_FILE_NOT_FOUND/.test(t),
  )
  check('无真实 console error / pageerror', realErrors.length === 0, realErrors.slice(0, 2).join(' | '))
} catch (e) {
  failed = true
  console.error('测试异常：', e && e.stack ? e.stack : e)
} finally {
  try {
    if (browser) await browser.close()
  } catch {}
  try {
    process.kill(-preview.pid, 'SIGKILL')
  } catch {}
}

const pass = results.filter((r) => r.ok).length
console.log(`\n${pass}/${results.length} 通过，截图在 ${OUT}`)
process.exit(failed || pass !== results.length ? 1 : 0)
