#!/usr/bin/env node
/**
 * 浏览器验收：课表（0.4.29 起的时间块版）
 *
 * 用法：node tools/browser/check-schedule.mjs [--port 4219] [--headed]
 *
 * 覆盖：
 *   1. 课表页能打开，今日/全周可切
 *   2. 「从表格粘贴」：识别四列文本、选星期、生成时段
 *   3. 今日时间轴按 早晨/上午/下午/晚上 分组，最近一项有状态
 *   4. 点时间轴一条能打开右侧抽屉，改名保存后时间轴跟着变
 *   5. 标记完成 / 撤销（data-status 跟着变）
 *   6. 全周 7 列、今天那列高亮
 *   7. 没有真实 console 错误
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

/** 页面里的「现在」：早点/上午一句，方便断言「进行中」 */
const planText = (() => {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const hhmm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
  const cur = now.getHours() * 60 + now.getMinutes()
  const s1 = Math.max(0, cur - 25)
  const e1 = cur + 17
  const s2 = cur + 25
  const e2 = cur + 35
  const s3 = cur + 40
  const e3 = cur + 85
  return [
    `06:00 06:15 跟读 学习`,
    `07:00 07:45 新三 学习`,
    `07:45 08:00 冥想 休息`,
    `${hhmm(s1)} ${hhmm(e1)} 新三 学习`,
    `${hhmm(s2)} ${hhmm(e2)} 冥想 休息`,
    `${hhmm(s3)} ${hhmm(e3)} 新三 学习`,
  ].join('\n')
})()

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

    await page.goto(`${BASE}?mock=1#/schedule`, { waitUntil: 'domcontentloaded' })
    await wait(1500)

    // ---------- 1. 页面骨架 ----------
    check('课表页打开', (await page.locator('.schedule-page').count()) === 1)
    check('有 今日/全周 切换', (await page.locator('.sc-seg button').count()) === 2)
    check('空状态提示「今天还没有计划」', (await page.locator('.sc-empty').count()) === 1)
    await page.screenshot({ path: `${OUT}/1-empty.png` })

    // ---------- 2. 从表格粘贴 ----------
    await page.locator('button[title="从表格粘贴"]').click()
    await wait(300)
    check('打开粘贴弹层', (await page.locator('.paste-modal').count()) === 1)
    await page.locator('textarea[name="pasteText"]').fill(planText)
    await wait(300)
    const previewCount = await page.locator('.paste-preview .pv').count()
    check('粘贴后能预览识别结果', previewCount >= 3, `pv=${previewCount}`)
    // 默认就加到「今天」，不再点星期（点一下会把今天摘掉）
    await wait(200)
    await page.locator('.paste-modal button', { hasText: '生成' }).click()
    await wait(900)
    check('生成后粘贴弹层关闭', (await page.locator('.paste-modal').count()) === 0)

    // ---------- 3. 今日视图 ----------
    check('现在卡片存在', (await page.locator('.now-card').count()) === 1)
    check('现在卡片是进行中（覆盖当前时刻）', (await page.locator('.now-card .chip-now', { hasText: '现在进行中' }).count()) === 1)
    const items = page.locator('.tl-item')
    const itemCount = await items.count()
    check('今日时间轴有 6 项', itemCount === 6, `items=${itemCount}`)
    check('时间轴有分组标题（早晨/上午/下午/晚上）', (await page.locator('.tl-sec').count()) >= 2)
    check('进行中那项有 data-status=doing', (await page.locator('.tl-item[data-status="doing"]').count()) === 1)
    check('右栏有今日进度', (await page.locator('.sc-aside .sc-card', { hasText: '今日进度' }).count()) === 1)
    await page.screenshot({ path: `${OUT}/2-today.png` })

    // ---------- 4. 编辑抽屉 ----------
    await page.locator('.tl-item', { hasText: '冥想' }).first().click()
    await wait(300)
    check('点时间轴打开抽屉', (await page.locator('.drawer').count()) === 1)
    await page.locator('.drawer input[name="slotName"]').fill('冥想放松')
    await page.locator('.drawer button', { hasText: '保存' }).click()
    await wait(700)
    check('保存后抽屉关闭', (await page.locator('.drawer').count()) === 0)
    check('时间轴显示新名字', (await page.locator('.tl-item', { hasText: '冥想放松' }).count()) === 1)
    await page.screenshot({ path: `${OUT}/3-edited.png` })

    // ---------- 5. 撤销完成标记 ----------
    const doneBefore = await page.locator('.tl-item[data-status="done"]').count()
    check('过去的时段按时间标记为已完成', doneBefore >= 1, `done=${doneBefore}`)
    await page.locator('.tl-item[data-status="done"] .tl-check').first().click()
    await wait(400)
    const doneAfter = await page.locator('.tl-item[data-status="done"]').count()
    check('点 ✓ 撤销后变回待开始', doneAfter === doneBefore - 1, `done=${doneAfter}`)

    // ---------- 6. 全周 ----------
    await page.locator('.sc-seg button', { hasText: '全周' }).click()
    await wait(500)
    check('全周 7 列', (await page.locator('.wk-col').count()) === 7)
    check('今天那一列高亮', (await page.locator('.wk-col.today').count()) === 1)
    check('全周里有生成的时段块', (await page.locator('.wk-blk').count()) >= 6)
    await page.screenshot({ path: `${OUT}/4-week.png` })

    // ---------- 7. 无报错 ----------
    check('无 console 错误', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    try {
      process.kill(-preview.pid)
    } catch {}
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed，截图在 ${OUT}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('检查脚本异常：', e && e.message)
  process.exit(2)
})
