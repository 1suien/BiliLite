#!/usr/bin/env node
/**
 * 浏览器验收：0.4.13 三项改动
 *
 * 1) 学习页不再有标题行 / 三张统计卡 / 导出 JSON / 清空按钮
 * 2) 提醒卡片贴屏幕最右下角；有卡片时右下角刷新浮钮让位
 * 3) 安卓下「写入 JSON 备份」不再被「请先选择备份目录」拦住（bili.platform 改成 android 模拟）
 * 4) 系统通知在浏览器里是 no-op（supported=false），不会报错
 *
 * 用法：node tools/browser/check-reminder13.mjs [--port 4220]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const APP = resolve(ROOT, 'app')
const argv = process.argv.slice(2)
const argPort = argv.indexOf('--port')
const PORT = argPort >= 0 ? Number(argv[argPort + 1]) : 4220
const BASE = `http://127.0.0.1:${PORT}/`
const OUT = process.env.CHECK_REMINDER_OUT || '/tmp/bililite-check-reminder13'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function browserEnv() {
  const env = { ...process.env }
  const libDir = resolve(ROOT, 'tools/browser/chromium-libs/root/usr/lib/aarch64-linux-gnu')
  const fontConf = resolve(ROOT, 'tools/browser/fonts.conf')
  if (existsSync(libDir)) env.LD_LIBRARY_PATH = [libDir, env.LD_LIBRARY_PATH].filter(Boolean).join(':')
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

/** mock 桥的设置：预置一个带提醒时间的专注目标，方便触发卡片 */
const MOCK_SETTINGS = {
  focusTasks: ['英语学习'],
  focusTargets: [
    { name: '英语学习', color: '#ff4d88', archived: 0, createdAt: 1700000000000, reminders: ['07:30'] },
  ],
  focusPresetsCleared: true,
}

async function main() {
  if (!existsSync(resolve(APP, 'dist/index.html'))) {
    console.error('缺少 app/dist，先跑 npm run build')
    process.exit(1)
  }
  mkdirSync(OUT, { recursive: true })
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: APP,
    stdio: 'ignore',
    detached: true,
    env: process.env,
  })
  const ok = await waitServer(BASE)
  if (!ok) {
    console.error('preview 起不来')
    process.exit(1)
  }

  const browser = await chromium.launch({ env: browserEnv() })
  const errors = []
  try {
    const page = await browser.newPage({ viewport: { width: 1220, height: 800 } })
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    await page.addInitScript(
      (s) => {
        try {
          if (!localStorage.getItem('bililite.mock.settings')) {
            localStorage.setItem('bililite.mock.settings', JSON.stringify(s))
          }
        } catch {}
      },
      MOCK_SETTINGS,
    )

    /* ------------------ 1) 学习页顶部被删掉的部分 ------------------ */
    await page.goto(`${BASE}?mock=1#/learn`, { waitUntil: 'domcontentloaded' })
    await wait(1400)
    check('学习页没有标题行', (await page.locator('.page-head').count()) === 0)
    check('学习页没有三张统计卡', (await page.locator('.stat-grid').count()) === 0 && (await page.locator('.stat').count()) === 0)
    const bodyText = await page.locator('.panel').first().innerText()
    check('学习页不再出现「导出 JSON」', !(await page.locator('.scroll').innerText()).includes('导出 JSON'))
    check('学习页不再出现「清空」按钮', (await page.locator('.scroll button', { hasText: '清空' }).count()) === 0)
    check('学习页「今日习惯 / 专注目标」还在', bodyText.includes('今日习惯') || bodyText.includes('专注目标'), bodyText.slice(0, 40))

    /* ------------------ 2) 提醒卡片位置 + 浮钮让位 ------------------ */
    const chk = await page.evaluate(() => window.__remindCheck && window.__remindCheck('12:30'))
    await wait(600)
    const cardCount = await page.locator('.reminder-card').count()
    check('到了设定的时间会弹提醒卡片', cardCount > 0, JSON.stringify(chk))
    const geo = await page.evaluate(() => {
      const el = document.querySelector('.reminder-card')
      if (!el) return null
      const r = el.getBoundingClientRect()
      const floatEl = document.querySelector('.page-float')
      return {
        right: Math.round(window.innerWidth - r.right),
        bottom: Math.round(window.innerHeight - r.bottom),
        w: Math.round(r.width),
        floatDisplay: floatEl ? getComputedStyle(floatEl).display : 'none',
        bodyClass: document.body.className,
      }
    })
    check('提醒卡片贴在屏幕最右下角', !!geo && geo.right >= 0 && geo.right <= 20 && geo.bottom >= 0 && geo.bottom <= 20, JSON.stringify(geo))
    check('有卡片时右下角刷新浮钮让位', !!geo && geo.floatDisplay === 'none' && geo.bodyClass.includes('has-reminder'), JSON.stringify(geo))
    await page.screenshot({ path: `${OUT}/0-reminder-corner.png` })
    await page.locator('.reminder-card .btn', { hasText: '知道了' }).first().click()
    await wait(400)
    const floatBack = await page.evaluate(() => {
      const el = document.querySelector('.page-float')
      return { count: document.querySelectorAll('.reminder-card').length, display: el ? getComputedStyle(el).display : 'none' }
    })
    check('关掉卡片后浮钮恢复', floatBack.count === 0 && floatBack.display !== 'none', JSON.stringify(floatBack))
    await page.screenshot({ path: `${OUT}/1-learn-no-head.png` })

    /* ------------------ 3) 系统通知在浏览器里是 no-op ------------------ */
    const native = await page.evaluate(() => {
      const s = window.__remindNative && window.__remindNative()
      return s || null
    })
    check('浏览器里系统通知为 no-op（supported=false）', !!native && native.supported === false, JSON.stringify(native))

    /* ------------------ 4) 安卓下导出备份不再被目录拦住 ------------------ */
    await page.evaluate(() => {
      const b = window.bili
      if (b) Object.defineProperty(b, 'platform', { configurable: true, get: () => 'android' })
    })
    await page.locator('.side .nav-item', { hasText: '设置' }).click()
    await wait(1200)
    const dataPanel = page.locator('.panel', { hasText: '数据' }).first()
    check('安卓下不显示「备份目录」行', !(await dataPanel.innerText()).includes('备份目录'), (await dataPanel.innerText()).slice(0, 60))
    // 清掉之前的 toast，避免干扰判断
    await wait(4200)
    await page.locator('button', { hasText: '写入 JSON 备份' }).first().click()
    await wait(1200)
    const toasts = await page.locator('.toast').allInnerTexts()
    const okToast = toasts.find((t) => t.includes('已写入')) || ''
    const errToast = toasts.find((t) => t.includes('请先选择备份目录')) || ''
    check('安卓下点「写入 JSON 备份」能导出', okToast.length > 0 && errToast.length === 0, toasts.join(' | ') || '(无 toast)')
    await page.screenshot({ path: `${OUT}/2-settings-android-export.png` })

    /* ------------------ 5) 设置页「提醒」区（测试通知 / 通知设置） ------------------ */
    const remindPanel = page.locator('.panel', { hasText: '系统通知' }).first()
    check('设置页有「提醒」区', (await remindPanel.count()) === 1)
    const remindText = await remindPanel.innerText().catch(() => '')
    check('「提醒」区有两个按钮', remindText.includes('测试通知') && remindText.includes('通知设置'), remindText.slice(0, 80))
    // 浏览器里点「测试通知」应该提示「只在安卓 APK 里生效」
    await wait(4200)
    await page.locator('button', { hasText: '测试通知' }).first().click()
    await wait(600)
    const testToast = (await page.locator('.toast').allInnerTexts()).join(' | ')
    check('浏览器里点测试通知给出正确提示', /只在安卓/.test(testToast), testToast || '(无 toast)')
    await page.screenshot({ path: `${OUT}/3-settings-remind-section.png` })

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
  console.log(`\n${results.length - failed.length}/${results.length} 通过，截图在 ${OUT}`)
  if (failed.length) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
