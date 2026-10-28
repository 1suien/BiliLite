#!/usr/bin/env node
/**
 * WPS 登录（本机小工具）：无头 Chromium 打开 https://account.wps.cn/login，
 * 轮询页面上的「微信扫码登录」二维码地址，直接把二维码图片下载到仓库根
 * wps-login-qr.png（不依赖截图，稳定得多），供用户在对话里扫码。
 * 登录成功后把登录态存到 tools/wps/state.json，供 list/download 复用。
 * 账号密码不经过本工具。
 *
 * 用法：node tools/wps/login.mjs      （前台跑；Ctrl-C 结束）
 */
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(resolve(ROOT, 'tools/browser/_resolver.cjs'))
const { chromium } = require('playwright')

const PROFILE = resolve(ROOT, 'tools/wps/profile')
const STATE = resolve(ROOT, 'tools/wps/state.json')
const WORK = resolve(ROOT, '.work')
const QR = resolve(ROOT, 'wps-login-qr.jpg')
const STATUS = resolve(WORK, 'wps-login-status.json')
const LOGIN_URL = 'https://account.wps.cn/login'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function browserEnv() {
  const env = { ...process.env }
  const libDir = resolve(ROOT, 'tools/browser/chromium-libs/root/usr/lib/aarch64-linux-gnu')
  if (existsSync(libDir)) env.LD_LIBRARY_PATH = [libDir, '/usr/lib/aarch64-linux-gnu'].join(':')
  env.FONTCONFIG_FILE = resolve(ROOT, 'tools/browser/fonts.conf')
  env.FONTCONFIG_PATH = resolve(ROOT, 'tools/browser')
  env.HOME = env.HOME || '/tmp/pw-home'
  return env
}
function status(obj) {
  mkdirSync(WORK, { recursive: true })
  writeFileSync(STATUS, JSON.stringify({ at: Date.now(), ...obj }, null, 2))
}

mkdirSync(WORK, { recursive: true })
mkdirSync(PROFILE, { recursive: true })
if (existsSync(STATE)) {
  status({ state: 'already', hasState: true })
  console.log('已有登录态:', STATE)
  process.exit(0)
}

let ctx = null
let page = null
let lastErr = ''

async function ensurePage() {
  if (ctx) return
  ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    env: browserEnv(),
    viewport: { width: 1000, height: 1000 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled'],
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  })
  page = ctx.pages()[0] || (await ctx.newPage())
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
    lastErr = 'goto: ' + e.message.split('\n')[0]
  })
  await wait(4500)
}

async function dropPage() {
  try { await ctx?.close() } catch {}
  ctx = null
  page = null
}

let lastSrc = ''
let shots = 0
const MINUTES = Number(process.argv[2] || 20)
const started = Date.now()
let logged = false

while (Date.now() - started < MINUTES * 60 * 1000) {
  try {
    await ensurePage()
    const cookies = await ctx.cookies().catch(() => [])
    if (cookies.some((c) => c.name === 'wps_sid' && c.value && c.value.length > 10)) {
      logged = true
      break
    }
    const src = await page.evaluate(() => {
      const imgs = Array.from(document.images).map((i) => i.getAttribute('src') || '')
      return imgs.find((s) => /qrcode\.qwps\.cn|wxmp/.test(s)) || ''
    })
    if (src && src !== lastSrc) {
      const abs = src.startsWith('//') ? 'https:' + src : src
      const res = await fetch(abs, { headers: { referer: 'https://account.wps.cn/' } })
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length > 2000) {
          writeFileSync(QR, buf)
          shots++
          lastSrc = src
        }
      }
    } else if (!src) {
      // 二维码没出来 / 过期了：点页面上的刷新按钮
      await page
        .evaluate(() => {
          const els = Array.from(document.querySelectorAll('a,button,div,span'))
          const hit = els.find((el) => el.children.length === 0 && /刷新|失效|重新获取/.test((el.textContent || '').trim()))
          if (hit) hit.click()
        })
        .catch(() => {})
      lastErr = 'qr image not found'
    }
    status({ state: 'waiting-scan', url: page.url(), shots, src: lastSrc.slice(0, 56), err: lastErr })
  } catch (e) {
    lastErr = (e.message || '').split('\n')[0]
    await dropPage()
  }
  await wait(2000)
}

if (logged) {
  await ctx.storageState({ path: STATE })
  await page.screenshot({ path: resolve(WORK, 'wps-logged-in.png') }).catch(() => {})
  status({ state: 'logged-in', url: page.url(), shots })
  console.log('登录成功，登录态已保存:', STATE)
  await wait(300)
  await dropPage()
  process.exit(0)
}
status({ state: 'timeout', url: page?.url?.() || '', shots, err: lastErr })
console.log(`等待扫码超时（${MINUTES} 分钟）`)
await dropPage()
process.exit(1)
