#!/usr/bin/env node
/**
 * 浏览器验收：本地「BV 下载」+ 专注提醒最多 10 个（本机构建 0.4.20）
 *
 * 用法：node tools/browser/check-local20.mjs [--port 4226] [--headed]
 *
 * 0.4.20 按用户要求做了两件事：
 *   1) 专注目标提醒时间上限 8 → 10（弹层里第 11 个会被拒绝并提示）；
 *   2) 本地页新增「BV 下载」：粘贴 BV/链接 → 解析出标题与分P → 下载成 MP4 存进 App 私有目录。
 *
 * 浏览器里没有原生下载能力，所以这里 stub 掉 `bili.video.downloadUrl` /
 * `bili.local.download` / `bili.local.onDownloadProgress`，只验 UI 与调用参数。
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
const PORT = argPort >= 0 ? Number(argv[argPort + 1]) : 4226
const HEADED = argv.includes('--headed')
const BASE = `http://127.0.0.1:${PORT}/`
const OUT = process.env.CHECK_LOCAL20_OUT || '/tmp/bililite-check-local20'
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

  // 预置一个带 10 个提醒时间的专注目标（验证上限）
  await page.addInitScript(() => {
    try {
      localStorage.setItem(
        'bililite.mock.settings',
        JSON.stringify({
          focusPresetsCleared: true,
          focusTasks: [],
          focusTargets: [
            {
              name: '英语学习',
              color: '#ff4d88',
              archived: 0,
              createdAt: 1700000000000,
              reminders: ['07:00', '08:00', '09:05', '10:05', '13:00', '14:00', '15:05', '16:05', '17:00', '18:00'],
            },
          ],
        }),
      )
    } catch {}
  })

  await page.goto(`${BASE}?mock=1#/local`, { waitUntil: 'networkidle' })
  await page.waitForSelector('h1', { timeout: 15000 })

  // 清掉 mock 桥种入的演示本地视频
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

  // 1) 页头有「BV 下载」
  check('页头有「BV 下载」按钮', (await page.locator('[data-bv-download]').count()) >= 1)

  // 2) stub 掉下载相关桥，并记录调用参数
  await page.evaluate(() => {
    window.__dl = { urls: [], downloads: [] }
    const b = window.bili
    b.video.view = async (bvid) => ({
      bvid,
      title: '用 100 天学会一门新语言，我做了什么',
      pages: [
        { cid: 181112, page: 1, part: '正片' },
        { cid: 181113, page: 2, part: '花絮 1' },
        { cid: 181114, page: 3, part: '花絮 2' },
      ],
    })
    b.video.pages = async () => [
      { cid: 181112, page: 1, part: '正片' },
      { cid: 181113, page: 2, part: '花絮 1' },
      { cid: 181114, page: 3, part: '花絮 2' },
    ]
    b.video.downloadUrl = async (bvid, cid, qn) => {
      window.__dl.urls.push({ bvid, cid, qn })
      return { url: `https://upos-sz-mirrorcos.bilivideo.com/${bvid}-${cid}.mp4`, size: 48 * 1024 * 1024, quality: 360, format: 'mp4', acceptQuality: [360] }
    }
    b.local.onDownloadProgress = async (cb) => {
      window.__dl.progress = cb
      return () => {}
    }
    b.local.download = async (options) => {
      window.__dl.downloads.push({ ...options })
      if (window.__dl.progress) {
        window.__dl.progress({ received: 12 * 1024 * 1024, total: 48 * 1024 * 1024 })
        await new Promise((r) => setTimeout(r, 150))
      }
      const name = options.name || 'downloaded.mp4'
      return {
        id: 'bv-dl-1',
        path: `/data/user/0/com.bililite.app/files/local-media/${name}`,
        name,
        size: 48 * 1024 * 1024,
        mtime: Date.now(),
        mime: 'video/mp4',
        url: 'mock://bv-dl-1',
      }
    }
  })

  // 3) 打开弹层、解析
  await page.locator('[data-bv-download]').first().click()
  await page.waitForSelector('.bv-box', { timeout: 10000 })
  check('BV 下载弹层能打开', (await page.locator('.bv-box').count()) === 1)
  await page.fill('[data-bv-input]', 'https://www.bilibili.com/video/BV1mock0001?share_source=copy')
  await page.locator('[data-bv-parse]').click()
  await page.waitForSelector('.bv-title', { timeout: 10000 })
  const title = await page.locator('.bv-title').innerText()
  check('解析出视频标题', title.includes('100 天'), title)
  const chipCount = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll('.bv-box button')).filter((b) => /^P\d/.test((b.textContent || '').trim()))
        .length,
  )
  check('解析出 3 个分P', chipCount === 3, `${chipCount} 个`)
  await page.evaluate(() => {
    const bs = Array.from(document.querySelectorAll('.bv-box button')).filter((b) => /^P\d/.test((b.textContent || '').trim()))
    bs[1].click()
  })
  const p2Active = await page.evaluate(() => {
    const bs = Array.from(document.querySelectorAll('.bv-box button')).filter((b) => /^P\d/.test((b.textContent || '').trim()))
    return bs[1] ? String(bs[1].className) : ''
  })
  check('选中 P2', p2Active.includes('primary'), p2Active)
  await wait(300)
  await page.screenshot({ path: `${OUT}/1-bv-parsed.png` })

  // 4) 下载
  await page.locator('[data-bv-start]').click()
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-bv-progress]')
    return el && /正在下载/.test(el.textContent || '')
  }, { timeout: 10000 })
  const progressText = await page.locator('[data-bv-progress]').innerText()
  check('下载时显示进度文案', /正在下载/.test(progressText), progressText)
  await page.waitForSelector('.lrow', { timeout: 15000 })
  await page.waitForFunction(() => !document.querySelector('.bv-box'), { timeout: 10000 })
  await wait(300)
  const dl = await page.evaluate(() => window.__dl)
  check('下载地址用的是 stub 返回的 url', String(dl.downloads[0]?.url || '').includes('bilivideo.com'), dl.downloads[0]?.url)
  check('文件名带 bvid 与分P', /BV1mock0001-P2-/.test(String(dl.downloads[0]?.name || '')), dl.downloads[0]?.name)
  const rowName = await page.locator('.lrow .t').first().innerText()
  check('下载完出现在本地列表', rowName.includes('BV1mock0001'), rowName)
  await page.screenshot({ path: `${OUT}/2-bv-downloaded.png` })

  // 5) 专注提醒上限 10：弹层里已有 10 个，再加第 11 个被拒
  await page.goto(`${BASE}?mock=1#/learn`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.ft-remind', { timeout: 15000 })
  const remindBtn = page.locator('.ft-remind').first()
  check('专注目标行有提醒入口', (await remindBtn.count()) >= 1)
  await remindBtn.click()
  await page.waitForSelector('.ft-dialog', { timeout: 10000 })
  const chips10 = await page.locator('.ft-dialog .ft-chip').count()
  check('弹层里列出 10 个提醒时间', chips10 === 10, `${chips10} 个`)
  await page.fill('.ft-dialog input[type="time"]', '19:30')
  await page.locator('.ft-dialog .btn.primary').first().click()
  await wait(600)
  const after = await page.locator('.ft-dialog .ft-chip').count()
  const toastText = await page.locator('.toast, .toasts, [data-toast]').allInnerTexts().catch(() => [])
  const bodyText = await page.evaluate(() => document.body.innerText)
  check('第 11 个提醒时间被拒绝', after === 10 && /最多 10 个提醒时间/.test(bodyText), `${after} 个`)
  await page.screenshot({ path: `${OUT}/3-remind-limit.png` })

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
