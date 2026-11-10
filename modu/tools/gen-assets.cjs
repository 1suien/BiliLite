#!/usr/bin/env node
/**
 * 墨读 Android 图标 / 启动图生成器（开发工具，不参与 APK 运行）
 *
 * 用无头 Chromium 把设计稿按各密度精确渲染成 PNG，直接写进
 * android/app/src/main/res/ 对应目录，取代 Capacitor 默认的绿色图标。
 *
 * 运行：
 *   NODE_PATH=/root/学习软件/tools/browser/node_modules node tools/gen-assets.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

const LIBS = '/root/学习软件/tools/browser/chromium-libs/root/usr/lib/aarch64-linux-gnu'
const FONT_CONF = '/root/学习软件/tools/browser/fonts.conf'
const RES = '/root/readawre/app/android/app/src/main/res'

const PAPER = '#f6f1e6'
const INK = '#2c4536'
const MUTED = '#7a7266'
const GOLD = '#c9922f'

function browserEnv() {
  const env = { ...process.env }
  if (fs.existsSync(LIBS)) env.LD_LIBRARY_PATH = [LIBS, env.LD_LIBRARY_PATH, '/usr/lib/aarch64-linux-gnu'].filter(Boolean).join(':')
  if (fs.existsSync(FONT_CONF)) {
    env.FONTCONFIG_FILE = FONT_CONF
    env.FONTCONFIG_PATH = '/root/学习软件/tools/browser'
  }
  env.HOME = env.HOME || '/tmp/pw-home'
  return env
}

/** 书本 + 月亮的标志 */
function glyph(size, color = INK) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <circle cx="79" cy="19" r="6.5" fill="${GOLD}"/>
    <path d="M50 80 C 37 73 21 73 13 78 L 13 25 C 21 20 37 20 50 27 C 63 20 79 20 87 25 L 87 78 C 79 73 63 73 50 80 Z"
          fill="${color}"/>
    <path d="M50 27 L 50 80" stroke="${PAPER}" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M22 66 C 30 62 40 62 47 66" stroke="${PAPER}" stroke-width="2.2" opacity="0.55" fill="none" stroke-linecap="round"/>
    <path d="M78 66 C 70 62 60 62 53 66" stroke="${PAPER}" stroke-width="2.2" opacity="0.55" fill="none" stroke-linecap="round"/>
  </svg>`
}

function iconPage(size, mode) {
  const bgRound = mode === 'round' ? 'border-radius:50%;' : ''
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}
    .card{position:absolute;inset:0;${bgRound}
      background:radial-gradient(120% 120% at 22% 12%, #fdf9f0 0%, ${PAPER} 46%, #eae0cc 100%);
      display:flex;align-items:center;justify-content:center;}
    .g{display:block;filter:drop-shadow(0 2px 3px rgba(60,48,30,.18))}
  </style></head><body><div class="card"><span class="g">${glyph(Math.round(size * 0.72))}</span></div></body></html>`
}

function foregroundPage(size) {
  const g = Math.round(size * 0.55)
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}
    .wrap{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
    .g{display:block}
  </style></head><body><div class="wrap"><span class="g">${glyph(g)}</span></div></body></html>`
}

function splashPage(w, h) {
  const base = Math.min(w, h)
  const g = Math.round(base * 0.2)
  const titleSize = Math.round(base * 0.072)
  const tagSize = Math.round(base * 0.026)
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;background:${PAPER};overflow:hidden}
    .wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0}
    .title{font-family:"Noto Serif CJK SC","Songti SC",serif;font-weight:600;color:${INK};
      font-size:${titleSize}px;letter-spacing:.16em;margin-top:${Math.round(base * 0.045)}px}
    .tag{font-family:"Noto Sans CJK SC",system-ui,sans-serif;color:${MUTED};
      font-size:${tagSize}px;letter-spacing:.24em;margin-top:${Math.round(base * 0.022)}px}
  </style></head><body><div class="wrap">${glyph(g)}<div class="title">墨 读</div><div class="tag">离线阅读 · TXT / EPUB / PDF</div></div></body></html>`
}

async function shot(page, html, w, h, file, transparent = false) {
  await page.setViewportSize({ width: w, height: h })
  await page.setContent(html, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(60)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  await page.screenshot({ path: file, omitBackground: transparent })
  console.log('  wrote', path.relative(RES, file), `(${w}x${h})`)
}

async function main() {
  const browser = await chromium.launch({ env: browserEnv(), args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ deviceScaleFactor: 1 })

  const mipmaps = [
    ['mdpi', 48, 108],
    ['hdpi', 72, 162],
    ['xhdpi', 96, 216],
    ['xxhdpi', 144, 324],
    ['xxxhdpi', 192, 432],
  ]
  for (const [d, iconSize, fgSize] of mipmaps) {
    await shot(page, iconPage(iconSize, 'legacy'), iconSize, iconSize, path.join(RES, `mipmap-${d}/ic_launcher.png`))
    await shot(page, iconPage(iconSize, 'round'), iconSize, iconSize, path.join(RES, `mipmap-${d}/ic_launcher_round.png`), true)
    await shot(page, foregroundPage(fgSize), fgSize, fgSize, path.join(RES, `mipmap-${d}/ic_launcher_foreground.png`), true)
  }

  const splashes = [
    ['drawable-port-mdpi', 320, 480],
    ['drawable-port-hdpi', 480, 800],
    ['drawable-port-xhdpi', 720, 1280],
    ['drawable-port-xxhdpi', 960, 1600],
    ['drawable-port-xxxhdpi', 1280, 1920],
    ['drawable-land-mdpi', 480, 320],
    ['drawable-land-hdpi', 800, 480],
    ['drawable-land-xhdpi', 1280, 720],
    ['drawable-land-xxhdpi', 1600, 960],
    ['drawable-land-xxxhdpi', 1920, 1280],
    ['drawable', 480, 320],
  ]
  for (const [dir, w, h] of splashes) {
    await shot(page, splashPage(w, h), w, h, path.join(RES, dir, 'splash.png'))
  }

  await browser.close()
  console.log('assets done')
}

main().catch((e) => {
  console.error('GEN FAILED:', e)
  process.exit(1)
})
