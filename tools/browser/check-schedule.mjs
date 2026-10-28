#!/usr/bin/env node
/**
 * 浏览器验收：课表（/schedule）+ 到点提醒卡片（本机构建 0.4.12）
 *
 * 用法：node tools/browser/check-schedule.mjs [--port 4218] [--headed]
 *
 * 覆盖：
 *   1. 侧栏有「课表」入口，点进去是周课表（7 列，今天那列高亮）
 *   2. 新建一门课：出现在对应星期的列里、今天列表里也有（如果建的是今天）
 *   3. 编辑课程：改名字/时间后卡片跟着变
 *   4. 关联 B 站视频：卡片上有「去视频」，点了能跳到播放页
 *   5. 删除课程：卡片消失
 *   6. 专注目标可以设多个提醒时间（弹层里加两个时间、能删掉一个）
 *   7. 到点后弹出右下角提醒卡片：专注提醒 / 课表提醒，点按钮能跳转
 *   8. 无真实 console 错误
 *
 * 说明：时间不靠系统时钟，用页面里的 `__remindCheck(now, day)` 探针把「现在」推到指定时刻。
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
const PORT = argPort >= 0 ? Number(argv[argPort + 1]) : 4218
const HEADED = argv.includes('--headed')
const BASE = `http://127.0.0.1:${PORT}/`
const OUT = process.env.CHECK_SCHEDULE_OUT || '/tmp/bililite-check-schedule'
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

/** 页面里执行：今天星期几（1-7） */
const todayWd = `(() => { const d = new Date(); return ((d.getDay() + 6) % 7) + 1 })()`

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

    await page.goto(`${BASE}?mock=1#/learn`, { waitUntil: 'domcontentloaded' })
    await wait(1500)

    // ---------- 1. 导航 + 周课表 ----------
    const nav = page.locator('.side-nav a', { hasText: '课表' })
    check('侧栏有「课表」入口', (await nav.count()) === 1)
    await nav.first().click()
    await wait(900)
    check('进入课表页', (await page.evaluate(() => location.hash)) === '#/schedule')
    check('课表有 7 列', (await page.locator('.sc-col').count()) === 7)
    const todayCol = page.locator('.sc-col.today')
    check('今天那一列有高亮', (await todayCol.count()) === 1)
    await page.screenshot({ path: `${OUT}/1-schedule-empty.png` })

    // ---------- 2. 新建课程（今天） ----------
    const wd = await page.evaluate(todayWd)
    await page.locator('button', { hasText: '添加课程' }).first().click()
    await page.locator('.sc-modal input[name="courseName"]').fill('高等数学')
    await page.locator('.sc-modal select[name="courseWeekday"]').selectOption(String(wd))
    await page.locator('.sc-modal input[name="courseStart"]').fill('09:00')
    await page.locator('.sc-modal input[name="courseEnd"]').fill('09:45')
    await page.locator('.sc-modal input[name="courseLocation"]').fill('教学楼 302')
    await page.locator('.sc-modal input[name="courseTeacher"]').fill('张老师')
    await page.locator('.sc-modal button[name="courseSave"]').click()
    await wait(900)
    check('新建后弹窗关闭', (await page.locator('.sc-modal').count()) === 0)
    check('今天列表出现新课程', (await page.locator('.sc-today-card', { hasText: '高等数学' }).count()) === 1)
    const colCards = page.locator('.sc-col').nth(wd - 1).locator('.sc-card')
    check('对应星期的列里也有这门课', (await colCards.filter({ hasText: '高等数学' }).count()) === 1)
    check('卡片显示时间 09:00–09:45', (await colCards.first().innerText()).includes('09:00'))
    await page.screenshot({ path: `${OUT}/2-schedule-created.png` })

    // ---------- 3. 编辑课程 ----------
    await colCards.first().click()
    await page.locator('.sc-modal input[name="courseName"]').fill('高数（改）')
    await page.locator('.sc-modal input[name="courseStart"]').fill('10:00')
    await page.locator('.sc-modal button[name="courseSave"]').click()
    await wait(900)
    const colText = await page.locator('.sc-col').nth(wd - 1).innerText()
    check('改名生效', colText.includes('高数（改）'))
    check('改时间生效（10:00）', colText.includes('10:00'))

    // ---------- 4. 关联 B 站视频 ----------
    await page.locator('.sc-col').nth(wd - 1).locator('.sc-card').first().click()
    await page.locator('.sc-modal input[name="courseBvid"]').fill('BV1mock0002')
    await page.locator('.sc-modal button[name="courseSave"]').click()
    await wait(900)
    const videoBtn = page.locator('.sc-col').nth(wd - 1).locator('.sc-tag', { hasText: '去视频' })
    check('课程卡片出现「去视频」', (await videoBtn.count()) === 1)
    await videoBtn.first().click()
    await wait(1200)
    check('点「去视频」跳到播放页', (await page.evaluate(() => location.hash)).includes('#/video/BV1mock0002'))
    await page.goBack()
    await wait(1000)

    // ---------- 5. 到点提醒：课表 ----------
    await page.locator('.sc-col').nth(wd - 1).locator('.sc-card').first().click()
    await page.locator('.sc-modal input[name="courseRemind"]').check()
    await page.locator('.sc-modal select[name="courseLead"]').selectOption('0')
    await page.locator('.sc-modal button[name="courseSave"]').click()
    await wait(900)
    // 把「现在」推到 10:05（课程 10:00 开始，到点提醒）
    await page.evaluate(() => window.__remindCheck('10:05'))
    await wait(500)
    const courseCard = page.locator('.reminder-card.kind-course')
    check('课表到点弹出右下角提醒卡片', (await courseCard.count()) === 1)
    check('课表卡片标题带课程名', (await courseCard.first().innerText()).includes('该上课了'))
    await page.screenshot({ path: `${OUT}/3-course-reminder.png` })
    await courseCard.first().locator('button', { hasText: '去看关联视频' }).click()
    await wait(1000)
    check('点课表提醒去关联视频', (await page.evaluate(() => location.hash)).includes('/video/BV1mock0002'))
    check('点完卡片消失', (await page.locator('.reminder-card.kind-course').count()) === 0)

    // ---------- 6. 专注目标多提醒时间 ----------
    await page.goto(`${BASE}?mock=1#/learn`, { waitUntil: 'domcontentloaded' })
    await wait(1500)
    // 先建一个专注目标
    await page.locator('button[title="新建目标"]').click()
    await page.locator('.ft-add input.input').fill('英语课')
    await page.locator('.ft-add button', { hasText: '添加' }).click()
    await wait(700)
    const row = page.locator('.ft-row', { hasText: '英语课' }).first()
    check('专注目标已创建', (await row.count()) === 1)
    // 打开提醒弹层，加两个时间
    await row.locator('button[aria-label="提醒时间"]').click()
    await page.locator('.ft-dialog input[type="time"]').fill('07:30')
    await page.locator('.ft-dialog button', { hasText: '添加时间' }).click()
    await wait(600)
    await page.locator('.ft-dialog input[type="time"]').fill('12:10')
    await page.locator('.ft-dialog button', { hasText: '添加时间' }).click()
    await wait(600)
    const chips = page.locator('.ft-dialog .ft-chip')
    check('提醒弹层里有 2 个时间', (await chips.count()) === 2)
    check('时间 chip 是 07:30 / 12:10', (await chips.allInnerTexts()).join(',').includes('07:30'))
    await page.screenshot({ path: `${OUT}/4-focus-reminders.png` })
    // 删掉一个
    await chips.first().locator('button').click()
    await wait(600)
    check('能删掉一个提醒时间', (await page.locator('.ft-dialog .ft-chip').count()) === 1)
    await page.locator('.ft-dialog button', { hasText: '完成' }).click()
    await wait(400)
    check('行尾提醒按钮显示数量 1', (await row.locator('.ft-remind-n').innerText()) === '1')

    // ---------- 7. 到点提醒：专注 ----------
    // 剩下的时间是 12:10，把「现在」推到 12:30
    await page.evaluate(() => window.__remindCheck('12:30'))
    await wait(600)
    const focusCard = page.locator('.reminder-card.kind-focus')
    check('专注目标到点弹出提醒卡片', (await focusCard.count()) === 1)
    check('专注卡片标题带目标名', (await focusCard.first().innerText()).includes('英语课'))
    await page.screenshot({ path: `${OUT}/5-focus-reminder.png` })
    await focusCard.first().locator('button', { hasText: '去专注' }).click()
    await wait(900)
    check('点专注提醒回到学习页', (await page.evaluate(() => location.hash)) === '#/learn')
    const probe = await page.evaluate(() => window.__remindProbe())
    check('探针能读到刚才的扫描结果', !!probe && probe.lastCheck.day, JSON.stringify(probe && probe.lastCheck))

    // ---------- 8. 删除课程 ----------
    await page.goto(`${BASE}?mock=1#/schedule`, { waitUntil: 'domcontentloaded' })
    await wait(1200)
    const before = await page.locator('.sc-card').count()
    await page.locator('.sc-col').nth(wd - 1).locator('.sc-card').first().click()
    await page.locator('.sc-modal button[name="courseDelete"]').click()
    await wait(700)
    await page.locator('.ovl .btn, .modal .btn').filter({ hasText: /确定|删除/ }).last().click().catch(() => {})
    await wait(900)
    check('删除课程后卡片少了', (await page.locator('.sc-card').count()) < before)

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
