#!/usr/bin/env node
/**
 * 浏览器验收：设置页「打开 JSON 备份…」导入/恢复
 *
 * 用法：node tools/browser/check-backup.mjs [--port 4211]
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
const PORT = argPort >= 0 ? Number(argv[argPort + 1]) : 4211
const BASE = `http://127.0.0.1:${PORT}/`
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

const backup = {
  app: 'study-bili',
  version: '0.1.0',
  exportedAt: '2026-10-25T10:00:00.000Z',
  user: null,
  progress: [
    {
      key: 'BV1mock0002:181114',
      bvid: 'BV1mock0002',
      cid: 181114,
      title: '导入的进度',
      cover: '',
      upName: '导入UP',
      seconds: 42,
      duration: 300,
      completed: false,
      updatedAt: 1761386400000,
    },
  ],
  daily: [{ date: '2026-10-01', seconds: 3600, videos: 3 }],
  notes: [{ bvid: 'BV1mock0001', cid: 181112, at: 90000, text: '导入的笔记第一行\n导入的笔记第二行' }],
  shelf: [],
}

async function main() {
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: APP,
    stdio: 'ignore',
    detached: true,
  })
  const browser = await chromium.launch({ headless: true, env: browserEnv() })
  try {
    if (!(await waitServer(BASE))) throw new Error(`vite preview 未在 ${PORT} 端口启动`)
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 }, locale: 'zh-CN' })
    const page = await ctx.newPage()
    const errors = []
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    page.on('pageerror', (e) => errors.push(String(e && e.message)))

    await page.goto(`${BASE}?mock=1#/settings`, { waitUntil: 'domcontentloaded' })
    await wait(1500)

    // mock 平台（非安卓）仍显示备份目录行；安卓上这行会被替换成说明
    check('非安卓平台保留「备份目录」行', await page.getByText('备份目录', { exact: true }).isVisible())
    check('出现「恢复学习数据 / 打开 JSON 备份…」', await page.getByText('打开 JSON 备份…').isVisible())

    // 模拟安卓平台：备份目录行应换成「备份位置」说明（安卓没有真实目录选择）
    const goHash = async (h) => {
      await page.evaluate((x) => {
        location.hash = x
      }, h)
      await wait(900)
    }
    await page.evaluate(() => {
      Object.defineProperty(window.bili, 'platform', { get: () => 'android', configurable: true })
    })
    await goHash('#/home')
    await goHash('#/settings')
    const androidText = await page.locator('.panel .field', { hasText: '备份位置' }).count()
    const dirRow = await page.getByText('备份目录', { exact: true }).count()
    check('安卓下隐藏「备份目录」行、改显示「备份位置」', androidText === 1 && dirRow === 0, `备份位置 ${androidText} / 备份目录 ${dirRow}`)
    await page.evaluate(() => {
      Object.defineProperty(window.bili, 'platform', { get: () => 'mock', configurable: true })
    })
    await goHash('#/home')
    await goHash('#/settings')

    const hintBefore = await page.locator('.panel .field', { hasText: '导出学习数据' }).innerText()
    const num = (t) => {
      const m = /进度\s*(\d+)\s*条/.exec(t)
      return m ? Number(m[1]) : -1
    }
    const before = num(hintBefore)

    const fileInput = page.locator('input[type="file"][accept*="json"]')
    // 1) 坏文件：不是 JSON
    await fileInput.setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('not json') })
    await wait(800)
    check('非 JSON 文件被拒', (await page.locator('.toast.err').count()) > 0, await page.locator('.toasts').innerText())

    // 2) 正常备份 → 确认框 → 合并
    await fileInput.setInputFiles({
      name: 'bililite-learn-2026-10-25.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(backup, null, 2)),
    })
    await page.locator('.overlay .modal').waitFor({ timeout: 8000 })
    const sub = await page.locator('.overlay .modal').innerText()
    check('确认框列出备份内容', sub.includes('进度 1 条') && sub.includes('笔记 1 条'), sub.replace(/\n/g, ' | '))
    await page.locator('.overlay .modal .btn.danger').click()
    await wait(1200)
    const toast = await page.locator('.toast.ok').last().innerText()
    check('导入成功提示', /已恢复.*进度 \+1.*笔记 \+1/.test(toast), toast)

    // 设置页的「进度 N 条」是去重后的视频数，不适合验证条数；直接读 IndexedDB
    const idbCount = (table) =>
      page.evaluate(
        (t) =>
          new Promise((res) => {
            const req = indexedDB.open('study-bili')
            req.onsuccess = () => {
              const db = req.result
              const tx = db.transaction(t, 'readonly')
              const count = tx.objectStore(t).count()
              count.onsuccess = () => {
                const n = count.result
                db.close()
                res(n)
              }
            }
            req.onerror = () => res(-1)
          }),
        table,
      )
    const progRows = await idbCount('progress')
    check('进度表真的多了一条', progRows > before, `progress 行数 ${progRows}（页面显示视频数 ${before}）`)

    // 3) 导入的笔记出现在对应分P下
    await page.goto(`${BASE}?mock=1#/video/BV1mock0001`, { waitUntil: 'domcontentloaded' })
    await wait(1200)
    await page.locator('.tabs .tab', { hasText: '笔记' }).click()
    await page.locator('textarea.note-input').waitFor({ timeout: 10000 })
    const notesText = (await page.locator('.panel .field .ctrl').allInnerTexts()).join('\n')
    check(
      '导入的笔记按分P归位',
      notesText.includes('导入的笔记第一行') && notesText.includes('导入的笔记第二行'),
      notesText,
    )

    // 4) 重复导入不产生重复笔记
    await page.goto(`${BASE}?mock=1#/settings`, { waitUntil: 'domcontentloaded' })
    await wait(1000)
    await page.locator('input[type="file"][accept*="json"]').setInputFiles({
      name: 'again.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(backup)),
    })
    await page.locator('.overlay .modal').waitFor({ timeout: 8000 })
    await page.locator('.overlay .modal .btn.danger').click()
    await wait(1200)
    const toast2 = await page.locator('.toast.ok').last().innerText()
    check('重复导入笔记不翻倍', /笔记 \+0/.test(toast2), toast2)

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
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
