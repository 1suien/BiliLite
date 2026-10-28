#!/usr/bin/env node
/**
 * 浏览器验收：本地导入改原生 + 分享接收（本机构建 0.4.15）
 *
 * 用法：node tools/browser/check-local15.mjs [--port 4221] [--headed]
 *
 * 原生部分（SAF 选择器 / 收到 WPS 分享）在浏览器里跑不了，这里验证的是 JS 侧：
 *   - 安卓下「打开文件」走 `local.pickNative()`（mock 桥返回条目）→ 列表能出来
 *   - 收到分享（`window.dispatchEvent(new Event('localShare'))`）→ 入库 + 跳到 /local/:id
 *   - 移除原生导入的文件时会提示「会同时删掉 App 里保存的这份文件」
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
const PORT = argPort >= 0 ? Number(argv[argPort + 1]) : 4221
const HEADED = argv.includes('--headed')
const BASE = `http://127.0.0.1:${PORT}/`
const OUT = process.env.CHECK_LOCAL15_OUT || '/tmp/bililite-check-local15'
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
  const title = await page.locator('h1').first().innerText()
  check('本地页能打开', title.includes('本地'), title)

  // mock 桥会种入 3 条演示本地视频（mock:// 故意不能播，会显示「文件不在了」），
  // 这里先把它们清掉，保证截图与实际导入结果干净。
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

  // 1) 模拟成安卓 + 原生导入
  await page.evaluate(() => {
    Object.defineProperty(window.bili, 'platform', { get: () => 'android', configurable: true })
  })
  await page.getByRole('button', { name: '打开文件', exact: true }).first().click()
  await page.waitForSelector('.lrow', { timeout: 15000 })
  const rows = await page.locator('.lrow').count()
  const names = await page.locator('.lrow').allInnerTexts()
  check('安卓下「打开文件」走原生导入', rows >= 3, `${rows} 条`)
  check('导入的视频出现在列表里', names.some((t) => t.includes('操作系统导论')), names[0]?.split('\n')[0])
  await page.screenshot({ path: `${OUT}/1-local-native-import.png` })

  // 2) 移除确认文案：原生文件会一起删
  await page.evaluate(() => {
    const btn = document.querySelector('.lrow [aria-label="从列表移除"]')
    if (btn) btn.click()
  })
  await wait(400)
  const confirmText = await page.evaluate(() => {
    const el = document.querySelector('.overlay .modal')
    return el ? el.textContent || '' : document.body.innerText.slice(0, 500)
  })
  check(
    '移除原生导入的文件会提示一起删除',
    /同时删掉 App 里保存的这份文件/.test(confirmText),
    confirmText.replace(/\s+/g, ' ').slice(0, 60),
  )
  // 关掉确认框（点「取消」）
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.overlay .modal button'))
    const cancel = btns.find((b) => /取消/.test(b.textContent || ''))
    if (cancel) cancel.click()
  })
  await wait(300)

  // 3) 收到分享：App.vue 的 localShare 处理 → 入库 + 跳播放页
  await page.evaluate(() => {
    const b = window.bili
    b.local.sharedPending = async () => ({
      entries: [
        {
          id: 'share001',
          path: '/data/user/0/com.bililite.app/files/local-media/分享测试.mp4',
          name: '分享测试.mp4',
          size: 1234567,
          mtime: Date.now(),
          mime: 'video/mp4',
        },
      ],
      count: 1,
    })
    b.local.register = async (paths) => ({
      entries: [
        {
          id: 'share001',
          path: paths[0],
          name: '分享测试.mp4',
          size: 1234567,
          mtime: Date.now(),
          url: 'mock://share001',
        },
      ],
      missing: [],
    })
    window.dispatchEvent(new Event('localShare'))
  })
  await page.waitForFunction(() => location.hash.startsWith('#/local/share001'), { timeout: 15000 })
  const hash = await page.evaluate(() => location.hash)
  check('收到分享后跳到播放页', hash === '#/local/share001', hash)
  const inDb = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('study-bili')
        req.onsuccess = () => {
          const db = req.result
          try {
            const tx = db.transaction('locals', 'readonly')
            const get = tx.objectStore('locals').get('share001')
            get.onsuccess = () => resolve(!!get.result)
            get.onerror = () => resolve(false)
          } catch {
            resolve(false)
          }
        }
        req.onerror = () => resolve(false)
      }),
  )
  check('分享进来的视频已入库', inDb === true, String(inDb))
  await wait(600)
  await page.screenshot({ path: `${OUT}/2-share-received.png` })
  // 再回「本地」列表看一眼（浏览器里 mock url 播不了，播放页会显示格式不支持；列表能证明已入库）
  await page.goto(`${BASE}?mock=1#/local`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.lrow', { timeout: 15000 })
  const shareRow = await page.locator('.lrow').filter({ hasText: '分享测试.mp4' }).count()
  check('分享的视频出现在本地列表里', shareRow >= 1, String(shareRow))
  await page.screenshot({ path: `${OUT}/3-local-after-share.png` })

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
