#!/usr/bin/env node
/**
 * 浏览器验收：专注目标不再「自带」默认四个（本机构建 0.4.10）
 *
 * 用法：node tools/browser/check-focusdefaults.mjs [--port 4215] [--headed]
 *
 * 覆盖：
 *   - 全新安装（没有任何设置）打开学习页 → 专注目标面板为空（「还没有目标」）、坚持中 0
 *   - 面板里没有「恢复默认」入口（旧版四个预设的还原按钮已删）
 *   - 旧版本留下的「阅读/刷题/看课/整理笔记」四个预设 → 升级后一次性清掉，
 *     且写 focusPresetsCleared=true（之后不再清）
 *   - 用户自己加的目标：保存后存在，刷新后不会被迁移逻辑误删
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
const PORT = argPort >= 0 ? Number(argv[argPort + 1]) : 4215
const HEADED = argv.includes('--headed')
const BASE = `http://127.0.0.1:${PORT}/`
const LEARN = `${BASE}?mock=1#/learn`
const OUT = process.env.CHECK_FOCUS_OUT || '/tmp/bililite-check-focus'
const SETTINGS_KEY = 'bililite.mock.settings'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** 旧版本首次启动会写进设置里的四个预设（与 settings.ts 迁移逻辑里的 legacy 对应） */
const LEGACY_PRESETS = ['阅读', '刷题', '看课', '整理笔记'].map((name, i) => ({
  name,
  color: ['blue', 'cyan', 'purple', 'orange'][i],
  archived: false,
  createdAt: 1760000000000 + i,
}))

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

const readSettings = (page) =>
  page.evaluate((key) => {
    try {
      return JSON.parse(localStorage.getItem(key) || '{}')
    } catch {
      return {}
    }
  }, SETTINGS_KEY)

const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: APP,
  stdio: 'ignore',
  detached: true,
})
mkdirSync(OUT, { recursive: true })
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

  // 0) 全新安装：清掉 mock 设置，重新打开学习页
  await page.goto(LEARN, { waitUntil: 'domcontentloaded' })
  await page.evaluate((key) => localStorage.removeItem(key), SETTINGS_KEY)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await wait(1500)

  const emptyText = await page.evaluate(() => {
    const el = document.querySelector('.ft-empty')
    return el ? el.innerText : ''
  })
  check('全新安装：专注目标面板是空态', emptyText.includes('还没有目标'), emptyText.replace(/\s+/g, ' ').trim())

  const tabsText = await page.evaluate(() => {
    const el = document.querySelector('.ft-tabs')
    return el ? el.innerText.replace(/\s+/g, ' ').trim() : ''
  })
  check('全新安装：坚持中 0 / 已归档 0', /坚持中\s*0/.test(tabsText) && /已归档\s*0/.test(tabsText), tabsText)

  const resetBtns = await page.evaluate(() => ({
    byTitle: document.querySelectorAll('[title="恢复默认目标"]').length,
    byText: Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').includes('恢复默认')),
    byAria: document.querySelectorAll('[aria-label="恢复默认目标"]').length,
  }))
  check(
    '面板里没有「恢复默认」入口',
    resetBtns.byTitle === 0 && resetBtns.byAria === 0 && !resetBtns.byText,
    JSON.stringify(resetBtns),
  )
  const freshSettings = await readSettings(page)
  check(
    '全新安装：不写入任何目标',
    !Array.isArray(freshSettings.focusTargets) || freshSettings.focusTargets.length === 0,
    `focusTargets=${JSON.stringify((freshSettings.focusTargets || []).map((t) => t && t.name))}`,
  )

  // 1) 旧版本留下的四个预设 → 升级后一次性清掉，并写 focusPresetsCleared
  await page.evaluate(
    ({ key, targets }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          focusTargets: targets,
          focusTasks: targets.map((t) => t.name),
        }),
      )
    },
    { key: SETTINGS_KEY, targets: LEGACY_PRESETS },
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await wait(1500)

  const afterMigrate = await readSettings(page)
  const migratedTargets = Array.isArray(afterMigrate.focusTargets) ? afterMigrate.focusTargets : []
  check(
    '旧版四预设升级后被清空',
    migratedTargets.length === 0,
    `focusTargets=${JSON.stringify(migratedTargets.map((t) => t && t.name))}`,
  )
  check('迁移标记 focusPresetsCleared = true', afterMigrate.focusPresetsCleared === true)
  const migrateEmpty = await page.evaluate(() => {
    const el = document.querySelector('.ft-empty')
    return el ? el.innerText : ''
  })
  check('迁移后面板是空态', migrateEmpty.includes('还没有目标'), migrateEmpty.replace(/\s+/g, ' ').trim())
  await page.screenshot({ path: `${OUT}/1-empty-targets.png` })

  // 2) 用户自己加一个目标 → 保存，刷新后不会被误删
  await page.click('[title="新建目标"]')
  await wait(300)
  await page.fill('.ft-add input', '英语课')
  await page.click('.ft-add .btn.primary')
  await wait(800)
  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.ft-row .ft-name')).map((el) => (el.textContent || '').trim()),
  )
  check('加目标后出现在列表里', rows.includes('英语课'), rows.join(' / '))

  await page.reload({ waitUntil: 'domcontentloaded' })
  await wait(1500)
  const rows2 = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.ft-row .ft-name')).map((el) => (el.textContent || '').trim()),
  )
  const afterReload = await readSettings(page)
  check('刷新后自己加的目标还在', rows2.includes('英语课'), rows2.join(' / '))
  check(
    '刷新后没有被迁移逻辑误删',
    Array.isArray(afterReload.focusTargets) && afterReload.focusTargets.length === 1,
    `focusTargets=${JSON.stringify((afterReload.focusTargets || []).map((t) => t && t.name))}`,
  )
  await page.screenshot({ path: `${OUT}/2-user-target.png` })

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

const okCount = results.filter((r) => r.ok).length
console.log(`\n${okCount}/${results.length} 通过，截图在 ${OUT}`)
process.exit(failed || okCount !== results.length ? 1 : 0)
