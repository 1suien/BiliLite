#!/usr/bin/env node
/**
 * 浏览器验收：首页已整个删除（本机构建 0.4.9）
 *
 * 用法：node tools/browser/check-nohome.mjs [--port 4214] [--headed]
 *
 * 覆盖：
 *   - 打开根路径 `?mock=1` → 自动重定向到 `#/learn`（学习页）
 *   - 直接访问 `#/` 同样进 `#/learn`
 *   - 旧地址 `#/home` 落到兜底路由后也进 `#/learn`
 *   - 左侧导航没有「首页」，仍有 学习 / 习惯 / 本地
 *   - 学习页能正常渲染（有「学习」标题）
 *   - 播放页仍能直接打开（删首页没弄坏路由）
 *   - 无真实 console error / pageerror
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
const PORT = argPort >= 0 ? Number(argv[argPort + 1]) : 4214
const HEADED = argv.includes('--headed')
const BASE = `http://127.0.0.1:${PORT}/`
const OUT = process.env.CHECK_NOHOME_OUT || '/tmp/bililite-check-nohome'
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
  await waitServer(BASE)
  browser = await chromium.launch({ headless: !HEADED, env: browserEnv() })
  const page = await browser.newPage({ viewport: { width: 1220, height: 800 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    if (/mock:\/\/|Content Security Policy|Fetch API cannot load mock|ERR_FAILED|Failed to load resource/i.test(t)) return
    errors.push(t)
  })

  // 1) 根路径 → #/learn
  await page.goto(`${BASE}?mock=1`, { waitUntil: 'domcontentloaded' })
  await wait(1200)
  const hash1 = await page.evaluate(() => location.hash)
  check('根路径自动进学习页', hash1 === '#/learn', hash1)
  await page.screenshot({ path: `${OUT}/learn-landing.png` })

  // 2) 左侧导航：没有「首页」
  const labels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.side .nav-item')).map((el) => el.textContent.trim()),
  )
  check('左侧导航没有「首页」', !labels.includes('首页'), labels.join(' / '))
  check(
    '左侧导航仍有 学习 / 习惯 / 本地',
    ['学习', '习惯', '本地'].every((x) => labels.some((l) => l.startsWith(x))),
  )
  check('导航第一项是「学习」', (labels[0] || '').startsWith('学习'), labels[0] || '')

  // 3) 旧地址 #/home → #/learn
  await page.goto(`${BASE}?mock=1#/home`, { waitUntil: 'domcontentloaded' })
  await wait(900)
  const hash2 = await page.evaluate(() => location.hash)
  check('旧地址 #/home 落到学习页', hash2 === '#/learn', hash2)

  // 4) 直接访问 #/ 也进学习页
  await page.goto(`${BASE}?mock=1#/`, { waitUntil: 'domcontentloaded' })
  await wait(900)
  const hash3 = await page.evaluate(() => location.hash)
  check('直接访问 #/ 进学习页', hash3 === '#/learn', hash3)

  // 5) 学习页渲染正常
  const learnText = await page.evaluate(() => document.body.innerText)
  check('学习页正常渲染（含「学习」与统计）', learnText.includes('学习') && learnText.includes('本周专注'))

  // 6) 播放页仍能直接打开
  await page.goto(`${BASE}?mock=1#/video/BV1mock0001`, { waitUntil: 'domcontentloaded' })
  await wait(1200)
  const hash4 = await page.evaluate(() => location.hash)
  const videoText = await page.evaluate(() => document.body.innerText)
  check('播放页仍能直接打开', hash4.startsWith('#/video/') && videoText.includes('正在播放'), hash4)

  // 7) 搜索页能打开（学习页空态「去搜索找视频」的目标路由）
  await page.goto(`${BASE}?mock=1#/search`, { waitUntil: 'domcontentloaded' })
  await wait(900)
  check('搜索页能打开', (await page.evaluate(() => location.hash)) === '#/search')

  await page.screenshot({ path: `${OUT}/learn-as-home.png` })
  check('无真实 console error / pageerror', errors.length === 0, errors.slice(0, 2).join(' | '))
} catch (e) {
  failed = true
  console.error('ERROR', e)
} finally {
  if (browser) await browser.close()
  try {
    process.kill(-preview.pid, 'SIGKILL')
  } catch {
    /* ignore */
  }
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} 通过，截图在 ${OUT}`)
process.exit(failed || passed !== results.length ? 1 : 0)
