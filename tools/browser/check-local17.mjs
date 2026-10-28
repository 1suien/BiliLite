#!/usr/bin/env node
/**
 * 浏览器验收：本地「打开文件」改用系统选择器 + 步骤日志（本机构建 0.4.17）
 *
 * 用法：node tools/browser/check-local17.mjs [--port 4223] [--headed]
 *
 * 背景：0.4.15/0.4.16 的「打开文件」在真机上点了没反应（0.4.16 的原生 SAF 在这台平板上打不开），
 * 而同一台机器「打开文件夹」一直正常。0.4.17 把「打开文件」直接改成和「打开文件夹」同一条
 * WebView `<input type=file>` 路径，原生导入降级成诊断行里的实验按钮，并在页面上留一行步骤日志。
 *
 * 浏览器里验证 JS 侧：
 *   - 安卓下显示诊断行；「打开文件」走 pickFolder 这条能用的路
 *   - 点「打开文件」→ 弹选择器（mock 直接返回）→ 入库 + 步骤日志「③ 已加入 N 个」
 *   - 取消时步骤日志写「已取消」
 *   - 「原生导入（实验）」失败时把原因写到页面（红字 + 步骤日志），不崩
 *   - 原生导入成功时步骤日志写「已用原生导入加入 N 个」
 *   - 非安卓平台不显示诊断行
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
const PORT = argPort >= 0 ? Number(argv[argPort + 1]) : 4223
const HEADED = argv.includes('--headed')
const BASE = `http://127.0.0.1:${PORT}/`
const OUT = process.env.CHECK_LOCAL17_OUT || '/tmp/bililite-check-local17'
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

  // 模拟成安卓（mock 桥的 platform 是 getter）
  await page.evaluate(() => {
    Object.defineProperty(window.bili, 'platform', { get: () => 'android', configurable: true })
  })
  await page.evaluate(() => {
    location.hash = '#/learn'
  })
  await wait(300)
  await page.evaluate(() => {
    location.hash = '#/local'
  })
  await page.waitForSelector('h1', { timeout: 15000 })
  await wait(300)

  // mock：pickFolder 直接返回 1 条视频（就是真机上「打开文件夹」能用的那条路）
  const makeEntries = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: `t${i + 1}`,
      path: `/mock/课程视频/本地测试 ${i + 1}.mp4`,
      name: `本地测试 ${i + 1}.mp4`,
      size: 32 * 1024 * 1024,
      mtime: Date.now(),
      dir: '本机文件',
      url: `mock://local/t${i + 1}`,
    }))
  await page.evaluate((entries) => {
    window.bili.local.pickFolder = async () => ({ dir: '本机文件', entries })
    window.bili.local.pickFiles = async () => ({ canceled: true, entries: [] })
  }, makeEntries(1))

  // 1) 安卓下显示诊断行 + 两个按钮
  const diagRow = await page.locator('[data-pick-trace], .page-head ~ .row.muted').count()
  const sysBtn = await page.getByRole('button', { name: '系统选择器', exact: true }).count()
  const nativeBtn = await page.getByRole('button', { name: '原生导入（实验）', exact: true }).count()
  check('安卓下显示诊断行与两个入口', diagRow > 0 && sysBtn > 0 && nativeBtn > 0, `trace=${diagRow} sys=${sysBtn} native=${nativeBtn}`)

  // 2) 「打开文件」走 pickFolder → 入库 + 步骤日志
  await page.getByRole('button', { name: '打开文件', exact: true }).first().click()
  await wait(1200)
  const trace1 = await page.locator('[data-pick-trace]').innerText()
  const count1 = await page.evaluate(
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
  check('「打开文件」用系统选择器并入库', count1 === 1, `行数=${count1}`)
  check('步骤日志写出「已加入 1 个」', /已加入 1 个本地视频/.test(trace1), trace1)
  await page.screenshot({ path: `${OUT}/1-file-via-picker.png` })

  // 3) 取消时不报错，日志写已取消
  await page.evaluate(() => {
    window.bili.local.pickFolder = async () => ({ canceled: true, entries: [] })
  })
  await page.getByRole('button', { name: '打开文件', exact: true }).first().click()
  await wait(800)
  const trace2 = await page.locator('[data-pick-trace]').innerText()
  check('取消时步骤日志写「已取消」', /已取消/.test(trace2), trace2)

  // 4) 原生导入（实验）失败 → 页面写出原因（不崩）
  await page.evaluate(() => {
    window.bili.local.pickNative = async () => {
      throw new Error('测试：插件不可用')
    }
  })
  await page.getByRole('button', { name: '原生导入（实验）', exact: true }).click()
  await wait(900)
  const trace3 = await page.locator('[data-pick-trace]').innerText()
  const body3 = await page.locator('body').innerText()
  check('原生导入失败时日志写出原因', /原生导入失败：.*插件不可用/.test(trace3), trace3)
  check('原生导入失败时页面红字可见', /原生导入失败/.test(body3))
  await page.screenshot({ path: `${OUT}/2-native-fail.png` })

  // 5) 原生导入（实验）成功 → 入库 + 日志
  await page.evaluate((entries) => {
    window.bili.local.pickNative = async () => ({ entries })
  }, makeEntries(2))
  await page.getByRole('button', { name: '原生导入（实验）', exact: true }).click()
  await wait(1200)
  const trace4 = await page.locator('[data-pick-trace]').innerText()
  check('原生导入成功时日志写「已用原生导入加入 2 个」', /已用原生导入加入 2 个/.test(trace4), trace4)
  await page.screenshot({ path: `${OUT}/3-native-ok.png` })

  // 6) 非安卓：诊断行不出现
  const page2 = await browser.newPage({ viewport: { width: 1220, height: 800 } })
  await page2.goto(`${BASE}?mock=1#/local`, { waitUntil: 'networkidle' })
  await page2.waitForSelector('h1', { timeout: 15000 })
  await wait(300)
  const diagRow2 = await page2.locator('[data-pick-trace]').count()
  const sysBtn2 = await page2.getByRole('button', { name: '系统选择器', exact: true }).count()
  check('非安卓平台不显示诊断行', diagRow2 === 0 && sysBtn2 === 0, `trace=${diagRow2} sys=${sysBtn2}`)

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
