#!/usr/bin/env node
/**
 * 浏览器验收：本地导入的原生失败回退 + 诊断（本机构建 0.4.16）
 *
 * 用法：node tools/browser/check-local16.mjs [--port 4222] [--headed]
 *
 * 0.4.15 真机上「打开文件」没反应（同一台机器「打开文件夹」正常）。
 * 0.4.16 的处理：原生导入失败时自动回退 WebView 文件选择器，并把失败原因显示在页面上，
 * 另加「检测」按钮显示系统文档选择器到底可不可用。
 *
 * 浏览器里验证 JS 侧：
 *   - 安卓下「本地」页显示原生导入说明 + 「检测」按钮
 *   - 点「检测」能拿到 mock 桥的诊断结果
 *   - 让 `pickNative` 抛错 → 自动回退 `<input type=file>` 并且页面显示失败原因
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
const PORT = argPort >= 0 ? Number(argv[argPort + 1]) : 4222
const HEADED = argv.includes('--headed')
const BASE = `http://127.0.0.1:${PORT}/`
const OUT = process.env.CHECK_LOCAL16_OUT || '/tmp/bililite-check-local16'
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

  // 模拟成安卓（mock 桥的 platform 是 getter，改掉即可）
  await page.evaluate(() => {
    Object.defineProperty(window.bili, 'platform', { get: () => 'android', configurable: true })
  })
  // 改 platform 不会触发 Vue 重渲染：来回切一次路由让本地页重新挂载
  await page.evaluate(() => {
    location.hash = '#/learn'
  })
  await wait(300)
  await page.evaluate(() => {
    location.hash = '#/local'
  })
  await page.waitForSelector('h1', { timeout: 15000 })
  await wait(300)

  const diagLine = await page
    .locator('div.row.muted')
    .filter({ hasText: '原生导入' })
    .first()
    .innerText()
    .catch(() => '')
  check('安卓下显示原生导入说明', /原生导入/.test(diagLine), diagLine.replace(/\s+/g, ' ').slice(0, 60))

  await page.getByRole('button', { name: '检测' }).first().click()
  await wait(400)
  const afterDiag = await page
    .locator('div.row.muted')
    .filter({ hasText: '系统文档选择器' })
    .first()
    .innerText()
    .catch(() => '')
  check('「检测」显示系统选择器可用性', /系统文档选择器：可用|系统文档选择器：不可用/.test(afterDiag), afterDiag.replace(/\s+/g, ' ').slice(0, 80))
  await page.screenshot({ path: `${OUT}/1-native-diag.png` })

  // 让原生导入抛错：应当自动回退到 WebView 选择器，并在页面上写出失败原因
  await page.evaluate(() => {
    const local = window.bili.local
    Object.defineProperty(local, 'pickNative', {
      configurable: true,
      value: async () => {
        throw new Error('测试：插件不可用')
      },
    })
  })
  await page.getByRole('button', { name: '打开文件', exact: true }).first().click()
  await page.waitForSelector('.lrow', { timeout: 15000 })
  const rows = await page.locator('.lrow').count()
  check('原生失败后自动回退系统文件选择器', rows >= 3, `${rows} 条`)

  const errLine = await page
    .locator('div.row.muted')
    .filter({ hasText: '原生导入失败' })
    .first()
    .innerText()
    .catch(() => '')
  check(
    '页面上写出了原生失败原因',
    /原生导入失败：测试：插件不可用（已回退系统文件选择器）/.test(errLine.replace(/\s+/g, ' ')),
    errLine.replace(/\s+/g, ' ').slice(0, 90),
  )
  await page.screenshot({ path: `${OUT}/2-native-fallback.png` })

  const realErrors = errors.filter(
    (e) => !/mock:\/\/|Content Security Policy|Fetch API cannot load mock|ERR_FAILED|CONNECTION_REFUSED/.test(e),
  )
  check('无真实 console error / pageerror', realErrors.length === 0, realErrors.slice(0, 2).join(' | '))
} catch (e) {
  failed = true
  console.error('脚本异常：', e && e.message)
} finally {
  if (browser) await browser.close().catch(() => {})
  try {
    process.kill(-preview.pid, 'SIGKILL')
  } catch {
    /* ignore */
  }
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} 通过，截图在 ${OUT}`)
process.exit(failed || passed !== results.length ? 1 : 0)
