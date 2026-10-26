#!/usr/bin/env node
/**
 * 浏览器验收：退出播放页后再次播放，要能接着上一次的进度（本机构建 0.4.11）
 *
 * 用法：node tools/browser/check-resume.mjs [--port 4217] [--headed]
 *
 * 背景（用户报告）：
 *   「播放退出后再次播放无法继续上一次的进度」
 * 根因：
 *   1) 离开播放页时 onBeforeUnmount 里 flushProgress() 用的 bvid 来自 route.params，
 *      而这时路由已经切走、params.bvid 变成空串，learn.save() 把这种脏数据直接丢弃——
 *      于是最后那段播放位置没落库，再次播放只能退回到上一次「每 5 秒定时保存」的旧位置（或从 0 开始）。
 *   2) 从播放页离开会自动缩成小窗气泡（0.4.8），再次打开同一条视频时页面只显示
 *      「视频正在小窗播放」的占位、不播放，看起来也像进度丢了。
 *
 * 这里用 canvas + MediaRecorder 录一段真实 webm 顶替 mock:// 播放地址（无头 chromium 放不了 mock://），
 * 然后真实走「播放 → 点左侧导航离开 → 从学习进度重新打开」的路径，断言：
 *   - 离开时进度真的写进 IndexedDB（这是本次修复的核心）
 *   - 气泡开着时重新打开同一条视频：气泡收掉、本页直接续播，不再是占位画面
 *   - 关掉气泡后再重新打开：从保存的进度续播
 *   - 无真实 console 错误 / pageerror
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
const PORT = argPort >= 0 ? Number(argv[argPort + 1]) : 4217
const HEADED = argv.includes('--headed')
const BASE = `http://127.0.0.1:${PORT}/`
const OUT = process.env.CHECK_RESUME_OUT || '/tmp/bililite-check-resume'
const BVID = 'BV1mock0001'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function browserEnv() {
  const env = { ...process.env }
  const libDir = resolve(ROOT, 'tools/browser/chromium-libs/root/usr/lib/aarch64-linux-gnu')
  const fontConf = resolve(ROOT, 'tools/browser/fonts.conf')
  if (existsSync(libDir)) env.LD_LIBRARY_PATH = [libDir, env.LD_LIBRARY_PATH, '/usr/lib/aarch64-linux-gnu'].filter(Boolean).join(':')
  if (existsSync(fontConf)) { env.FONTCONFIG_FILE = fontConf; env.FONTCONFIG_PATH = resolve(ROOT, 'tools/browser') }
  env.HOME = env.HOME || '/tmp/pw-home'
  return env
}

async function waitServer(url, timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true } catch {}
    await wait(300)
  }
  return false
}

/** 页面里造一段 20 秒的真实 webm，并把 mock 桥的 playurl 换成它（生产代码里没有测试开关） */
const INIT = () => {
  const media = (async () => {
    const c = document.createElement('canvas')
    c.width = 320
    c.height = 180
    const g = c.getContext('2d')
    let i = 0
    const timer = setInterval(() => {
      i += 1
      g.fillStyle = `hsl(${(i * 24) % 360},70%,42%)`
      g.fillRect(0, 0, 320, 180)
      g.fillStyle = '#fff'
      g.font = 'bold 28px sans-serif'
      g.fillText('resume test ' + (i / 10).toFixed(1) + 's', 24, 104)
    }, 100)
    const stream = c.captureStream(10)
    const rec = new MediaRecorder(stream)
    const chunks = []
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
    const stopped = new Promise((r) => (rec.onstop = r))
    rec.start()
    await new Promise((r) => setTimeout(r, 20000))
    rec.stop(); clearInterval(timer)
    await stopped
    return URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }))
  })()
  window.__testMedia = media
  let installed
  Object.defineProperty(window, 'bili', {
    configurable: true,
    get: () => installed,
    set: (nv) => {
      const orig = nv && nv.video && nv.video.playurl
      if (orig) {
        nv.video.playurl = async function (...args) {
          const p = await orig.apply(this, args)
          const url = await window.__testMedia
          return { ...p, videos: [], audios: [], url, type: 'webm' }
        }
      }
      installed = nv
    },
  })
}

/** 读 IndexedDB 里这条视频的进度行（按 updatedAt 取最新一条） */
const readProgress = (bvid) => new Promise((res) => {
  const q = indexedDB.open('study-bili')
  q.onsuccess = () => {
    const db = q.result
    const rows = []
    const tx = db.transaction('progress', 'readonly')
    const req = tx.objectStore('progress').openCursor()
    req.onsuccess = () => {
      const cur = req.result
      if (!cur) { db.close(); rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); res(rows[0] || null); return }
      const v = cur.value
      if (String(v.bvid) === String(bvid)) rows.push({ key: v.key, cid: v.cid, page: v.page, seconds: v.seconds, duration: v.duration, completed: v.completed, updatedAt: v.updatedAt })
      cur.continue()
    }
  }
  q.onerror = () => res(null)
})

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
}

async function main() {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: APP, stdio: 'ignore', detached: true, env: { ...process.env },
  })
  preview.unref()
  let browser
  try {
    if (!(await waitServer(BASE))) throw new Error('vite preview 没起来')
    browser = await chromium.launch({ env: browserEnv(), args: ['--autoplay-policy=no-user-gesture-required'], headless: !HEADED })
    const page = await browser.newPage({ viewport: { width: 1220, height: 800 } })
    const realErrors = []
    page.on('console', (m) => {
      const t = m.text()
      if (m.type() === 'error' && !/mock:\/\/|Content Security Policy|Fetch API cannot load mock/.test(t)) realErrors.push(t)
    })
    page.on('pageerror', (e) => realErrors.push('pageerror: ' + e.message))
    await page.addInitScript(INIT)

    const videoState = () => page.evaluate(() => {
      const v = document.querySelector('.watch video')
      return v ? { t: Number(v.currentTime.toFixed(2)), paused: v.paused, dur: Number((v.duration || 0).toFixed(2)), src: (v.currentSrc || '').slice(0, 12) } : null
    })
    const hash = () => page.evaluate(() => location.hash)

    // 1) 打开播放页，等真正播起来
    await page.goto(`${BASE}?mock=1#/video/${BVID}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => {
      const v = document.querySelector('.watch video')
      return v && !v.paused && v.currentTime > 4.5 && (v.duration || 0) > 15
    }, null, { timeout: 60000 }).catch(() => {})
    const playing = await videoState()
    check('直链能真播放（离开前已播 > 4.5s）', !!playing && playing.t > 4.5 && !playing.paused, playing ? `${playing.t}s / ${playing.dur}s` : 'null')
    const leftAt = playing ? playing.t : 0

    // 2) 点左侧导航离开播放页（会自动缩成小窗气泡）
    await page.locator('.side .nav-item').filter({ hasText: '学习' }).first().click()
    await wait(1500)
    check('离开后出现小窗气泡', (await page.locator('.mini-player').count()) === 1)
    const savedAfterLeave = await page.evaluate(readProgress, BVID)
    check(
      '离开时进度已写进本地数据库（本次修复的核心）',
      !!savedAfterLeave && Math.abs(Number(savedAfterLeave.seconds) - leftAt) < 1.5,
      savedAfterLeave ? `库里 ${Number(savedAfterLeave.seconds).toFixed(2)}s / 离开时 ${leftAt.toFixed(2)}s` : 'null',
    )

    // 3) 气泡还开着时，从学习页「学习进度」点开同一条视频：应收回本页并续播
    await page.locator('.rowitem').first().click()
    await wait(1200)
    await page.waitForFunction(() => {
      const v = document.querySelector('.watch video')
      return v && !v.paused && v.currentTime > 0
    }, null, { timeout: 15000 }).catch(() => {})
    await wait(800)
    const reA = await videoState()
    const hashA = await hash()
    const placeholderA = await page.evaluate(() => {
      const m = document.querySelector('.player-msg')
      return m ? m.innerText.replace(/\s+/g, ' ').trim() : ''
    })
    check('气泡开着时重新打开同一条视频：路由回到播放页', /#\/video\//.test(hashA), hashA)
    check('气泡开着时重新打开同一条视频：气泡已被收回、不再只显示占位', (await page.locator('.mini-player').count()) === 0 && !/视频正在小窗播放/.test(placeholderA), placeholderA)
    check(
      '续播位置接上了离开时的进度',
      !!reA && reA.t >= leftAt - 1.5 && reA.t <= leftAt + 12,
      reA ? `重新打开后 ${reA.t}s / 离开时 ${leftAt.toFixed(2)}s` : 'null',
    )
    await page.screenshot({ path: `${OUT}/1-resume-with-bubble.png` })

    // 4) 再离开一次 → 关掉气泡 → 从学习进度重新打开：从库里保存的进度续播
    await page.locator('.side .nav-item').filter({ hasText: '学习' }).first().click()
    await wait(1500)
    const bubble = page.locator('.mini-player')
    if (await bubble.count()) {
      const bubbleAt = await bubble.locator('video.mp-video').evaluate((v) => Number(v.currentTime.toFixed(2)))
      await bubble.locator('.mp-close').click()
      await wait(600)
      check('关掉气泡后气泡消失', (await page.locator('.mini-player').count()) === 0, `关闭前 ${bubbleAt}s`)
    } else {
      check('关掉气泡后气泡消失', false, '气泡没出现')
    }
    const savedBefore = await page.evaluate(readProgress, BVID)
    await page.locator('.rowitem').first().click()
    await wait(1200)
    await page.waitForFunction(() => {
      const v = document.querySelector('.watch video')
      return v && !v.paused && v.currentTime > 0
    }, null, { timeout: 15000 }).catch(() => {})
    await wait(800)
    const reB = await videoState()
    const savedAt = savedBefore ? Number(savedBefore.seconds) : 0
    check(
      '关掉气泡后重新打开：从库里保存的进度续播',
      !!reB && savedAt > 0 && reB.t >= savedAt - 1.5 && reB.t <= savedAt + 12,
      reB ? `重新打开后 ${reB.t}s / 库里 ${savedAt.toFixed(2)}s` : 'null',
    )
    await page.screenshot({ path: `${OUT}/2-resume-no-bubble.png` })

    check('无真实 console error / pageerror', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

    const failed = results.filter((r) => !r.ok)
    console.log(`\n${results.length - failed.length}/${results.length} 通过，截图在 ${OUT}`)
    if (failed.length) {
      for (const f of failed) console.log('  未通过：' + f.name)
      process.exitCode = 1
    }
  } finally {
    if (browser) await browser.close().catch(() => {})
    try { process.kill(-preview.pid, 'SIGKILL') } catch {}
  }
}

main().catch((e) => { console.error('FAIL', e); process.exitCode = 1 })
