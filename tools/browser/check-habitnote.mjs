#!/usr/bin/env node
/**
 * 浏览器验收：打卡心得 + 习惯提醒卡片（本机构建 0.4.12）
 *
 * 用法：node tools/browser/check-habitnote.mjs [--port 4219] [--headed]
 *
 * 覆盖：
 *   1. 点「打卡」先弹「打卡心得」弹窗（不是直接打卡）
 *   2. 心得可留空直接打卡 / 可填了再保存
 *   3. 打完卡按钮变「已打卡」，打卡日志里能看到这天和心得内容
 *   4. 刷新页面后心得还在（存进了 habitLogs.note）
 *   5. 到点后习惯提醒弹右下角卡片（不是一闪而过的 toast），点「去打卡」跳到这个习惯
 *   6. 无真实 console 错误
 *
 * 说明：时间用页面上的 `__habitRemindAt(now, day)` 探针推进，不依赖系统时钟。
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
const PORT = argPort >= 0 ? Number(argv[argPort + 1]) : 4219
const HEADED = argv.includes('--headed')
const BASE = `http://127.0.0.1:${PORT}/`
const OUT = process.env.CHECK_HABITNOTE_OUT || '/tmp/bililite-check-habitnote'
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

const NOTE = '今天读了 20 页，第三题有点卡'

async function main() {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: APP,
    stdio: 'ignore',
    detached: true,
  })
  const browser = await chromium.launch({ headless: !HEADED, env: browserEnv() })
  try {
    if (!(await waitServer(BASE))) throw new Error(`vite preview 未在 ${PORT} 端口启动`)
    const ctx = await browser.newContext({ viewport: { width: 1220, height: 900 }, locale: 'zh-CN' })
    const page = await ctx.newPage()
    const errors = []
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    page.on('pageerror', (e) => errors.push(String(e && e.message)))

    await page.goto(`${BASE}?mock=1#/habit`, { waitUntil: 'domcontentloaded' })
    await wait(1500)

    // ---------- 0. 建一个带提醒的习惯 ----------
    await page.locator('button', { hasText: '新建习惯' }).first().click()
    await page.locator('.modal input[name="name"]').fill('读书打卡测试')
    await page.locator('.modal input[name="targetDays"]').fill('100')
    await page.locator('.modal input[name="remindAt"]').fill('00:01')
    await page.locator('.modal input[name="remindOn"]').check()
    await page.locator('.modal button[name="save"]').click()
    await wait(900)
    const row = page.locator('.hb-row', { hasText: '读书打卡测试' }).first()
    check('习惯已创建', (await row.count()) === 1)
    const checkBtn = row.locator('button.hb-check')
    check('打卡按钮还是「打卡」', (await checkBtn.innerText()).trim() === '打卡')

    // ---------- 1. 习惯提醒：先测「还没打卡」时的到点卡片 ----------
    check('新建的习惯今天还没打卡', (await row.locator('button.hb-check').innerText()).trim() === '打卡')
    // 00:05 时只有「00:01 提醒」的这个习惯到点，mock 里自带的几个（20:00/21:30…）还没到
    await page.evaluate(() => window.__habitRemindAt && window.__habitRemindAt('00:05'))
    await wait(900)
    const ourCard = page.locator('.reminder-card.kind-habit', { hasText: '读书打卡测试' }).first()
    check('习惯到点弹出右下角提醒卡片', (await ourCard.count()) === 1)
    check('提醒卡片标题带习惯名', (await ourCard.innerText()).includes('该打卡了'))
    await page.screenshot({ path: `${OUT}/3-habit-reminder-card.png` })
    check('提醒卡片不会自己消失', (await page.locator('.reminder-card').count()) >= 1)
    await ourCard.locator('button', { hasText: '去打卡' }).click()
    await wait(900)
    check('点「去打卡」跳到习惯页并带上 h 参数', /#\/habit\?h=/.test(await page.evaluate(() => location.hash)), await page.evaluate(() => location.hash))
    check('点完卡片收起', (await page.locator('.reminder-card.kind-habit').count()) === 0)

    // ---------- 2. 点打卡 → 先弹打卡心得 ----------
    await page.locator('button', { hasText: '新建习惯' }).count() // 等页面稳定
    await wait(300)
    await page.locator('.hb-row', { hasText: '读书打卡测试' }).first().locator('button.hb-check').click()
    await wait(500)
    check('点打卡先弹「打卡心得」弹窗', (await page.locator('.modal h3', { hasText: '打卡心得' }).count()) === 1)
    check('弹窗里有心得输入框', (await page.locator('.modal textarea[name="checkinNote"]').count()) === 1)
    await page.screenshot({ path: `${OUT}/1-checkin-note-modal.png` })

    // ---------- 3. 填心得并保存 ----------
    await page.locator('.modal textarea[name="checkinNote"]').fill(NOTE)
    await page.locator('.modal button[name="checkin-save"]').click()
    await wait(1000)
    check('保存后弹窗关闭', (await page.locator('.modal h3', { hasText: '打卡心得' }).count()) === 0)
    const rowA = page.locator('.hb-row', { hasText: '读书打卡测试' }).first()
    check('打卡后按钮变「已打卡」', (await rowA.locator('button.hb-check').innerText()).trim() === '已打卡')
    const logText = await page.locator('.hb-logs').innerText()
    check('打卡日志里有这个习惯', logText.includes('读书打卡测试'))
    check('打卡日志里能看到心得', logText.includes('今天读了 20 页'), logText.slice(0, 200))
    await page.screenshot({ path: `${OUT}/2-checkin-log.png` })

    // ---------- 4. 刷新后心得还在 ----------
    await page.reload({ waitUntil: 'domcontentloaded' })
    await wait(1500)
    const rowB = page.locator('.hb-row', { hasText: '读书打卡测试' }).first()
    check('刷新后还是已打卡', (await rowB.locator('button.hb-check').innerText()).trim() === '已打卡')
    check('刷新后日志里心得还在', (await page.locator('.hb-logs').innerText()).includes('今天读了 20 页'))

    // ---------- 5. 心得也能留空（直接打卡） ----------
    await rowB.locator('button.hb-check').click() // 取消打卡
    await wait(900)
    const rowC = page.locator('.hb-row', { hasText: '读书打卡测试' }).first()
    check('再点一次取消打卡', (await rowC.locator('button.hb-check').innerText()).trim() === '打卡')
    await rowC.locator('button.hb-check').click()
    await wait(500)
    await page.locator('.modal button[name="checkin-bare"]').click()
    await wait(900)
    check('留空也能直接打卡', (await page.locator('.hb-row', { hasText: '读书打卡测试' }).first().locator('button.hb-check').innerText()).trim() === '已打卡')

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
