#!/usr/bin/env node
/**
 * 浏览器验收：视频笔记「按分P独立 + 回车换行」
 *
 * 用法：node tools/browser/check-notes.mjs [--port 4210] [--headed]
 *
 * 依赖 tools/browser 里的 playwright + chromium（与 shot.mjs 同一套）：
 *   - chromium 需要 chromium-libs 里的 aarch64 动态库（脚本自动注入 LD_LIBRARY_PATH）
 *   - 页面走 `?mock=1` 的 mock 桥（不联网、不登录），mock 视频每个 bvid 有 3–5 个分P
 *
 * 覆盖：回车换行不保存 / 保存写入 / 多行保留 / 保存后清空 / 切 P 后笔记独立 /
 *       切回原 P 能看到自己的笔记 / 换视频看不到别人的笔记 / 无真实 console 错误
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
const PORT = argPort >= 0 ? Number(argv[argPort + 1]) : 4210
const HEADED = argv.includes('--headed')
const BASE = `http://127.0.0.1:${PORT}/`
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** chromium 的动态库与字体（仓库里自带了一份 aarch64 依赖，见 tools/browser/chromium-libs） */
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
  // detached + 独立进程组：结束时能把 npx → vite 整组杀掉，否则 vite 会拖住 node 不退出
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: APP,
    stdio: 'ignore',
    detached: true,
  })
  const browser = await chromium.launch({ headless: !HEADED, env: browserEnv() })
  try {
    if (!(await waitServer(BASE))) throw new Error(`vite preview 未在 ${PORT} 端口启动`)

    const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 }, locale: 'zh-CN' })
    const page = await ctx.newPage()
    const errors = []
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    page.on('pageerror', (e) => errors.push(String(e && e.message)))

    /** 进视频页 → 点开「笔记」tab（切 P 后组件会重建，tab 会回到「简介」，需要再点一次） */
    const openNotes = async (bvid) => {
      await page.goto(`${BASE}?mock=1#/video/${bvid}`, { waitUntil: 'domcontentloaded' })
      await wait(1200)
      await page.locator('.tabs .tab', { hasText: '笔记' }).click()
      await page.locator('textarea.note-input').waitFor({ timeout: 10000 })
    }
    const noteCount = () => page.locator('.tabs .tab', { hasText: '笔记' }).innerText()
    const noteRows = () => page.locator('.panel .field .ctrl').count()

    // 1) 回车换行、不保存
    await openNotes('BV1mock0001')
    const ta = page.locator('textarea.note-input')
    await ta.click()
    await ta.type('第一行')
    await page.keyboard.press('Enter')
    await ta.type('第二行')
    check('回车插入换行而不是保存', (await ta.inputValue()) === '第一行\n第二行')
    check('回车后没有写入笔记', /0/.test(await noteCount()), await noteCount())

    // 2) 点「保存」落库，多行原文保留
    await page.locator('.panel button.btn.primary', { hasText: '保存' }).click()
    await wait(600)
    check('点「保存」写入 1 条', /1/.test(await noteCount()), await noteCount())
    const saved = await page.locator('.panel .field .ctrl').first().innerText()
    check('多行笔记原文保留', saved.includes('第一行') && saved.includes('第二行'), JSON.stringify(saved))
    check('保存后输入框清空', (await ta.inputValue()) === '')

    // 3) 切到 P2：笔记独立
    const pills = page.locator('button.page-pill')
    await pills.nth(1).click()
    await wait(1500)
    await openNotesAgain()
    check('切到 P2 后笔记为 0 条', /0/.test(await noteCount()) && (await noteRows()) === 0, `${await noteCount()} / 行数 ${await noteRows()}`)

    // 4) P2 写一条，切回 P1 只看到 P1 自己的
    await page.locator('textarea.note-input').fill('P2 的笔记')
    await page.locator('.panel button.btn.primary', { hasText: '保存' }).click()
    await wait(600)
    await pills.nth(0).click()
    await wait(1500)
    await openNotesAgain()
    const p1 = await page.locator('.panel .field .ctrl').first().innerText()
    check('切回 P1 仍是 P1 自己的笔记', p1.includes('第一行') && !p1.includes('P2 的笔记'), JSON.stringify(p1))

    // 5) 换视频：看不到上一个视频的笔记
    await openNotes('BV1mock0002')
    check('换视频后看不到上一个视频的笔记', /0/.test(await noteCount()) && (await noteRows()) === 0, `${await noteCount()} / 行数 ${await noteRows()}`)

    // mock 播放器的 mock:// 地址会被 CSP 拦截，属浏览器预览环境噪音，不计入错误
    const realErrors = errors.filter((e) => !/mock:\/\/|Content Security Policy|Fetch API cannot load mock/.test(e))
    check('无真实 console error / pageerror', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

    /** 切 P 后 route.fullPath 变化会让整页组件重建：重新点开「笔记」tab 并等输入框出现 */
    async function openNotesAgain() {
      await page.locator('.tabs .tab', { hasText: '笔记' }).click()
      await page.locator('textarea.note-input').waitFor({ timeout: 10000 })
      await wait(800)
    }
  } finally {
    await browser.close().catch(() => {})
    try {
      process.kill(-preview.pid, 'SIGKILL')
    } catch {
      preview.kill('SIGKILL')
    }
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
