#!/usr/bin/env node
/**
 * 墨读 web 端验收脚本（开发工具，不进 APK）
 *
 * 运行：
 *   cd /root/readawre && NODE_PATH=/root/学习软件/tools/browser/node_modules node tools/browser/check.cjs
 *   （需要 app 的 vite dev server 在 127.0.0.1:5173 运行）
 *
 * 依赖：playwright（复用 /root/学习软件/tools/browser/node_modules）
 *       + /root/学习软件/tools/browser/chromium-libs 里的共享库与中文字体
 * 输出：/tmp/shots/*.png
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { chromium } = require('playwright')

const LIBS = '/root/学习软件/tools/browser/chromium-libs/root/usr/lib/aarch64-linux-gnu'
const FONT_CONF = '/root/学习软件/tools/browser/fonts.conf'
const OUT = '/tmp/shots'
const FIX = path.resolve(__dirname, '../../app/tests/fixtures')

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

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  — ' + extra : ''}`)
}

/** 用隐藏页渲染两页「银河画集」并压成 CBZ，给验收截图用 */
async function makeDemoCbz(ctx, jszipPath) {
  const JSZip = require(jszipPath)
  const p = await ctx.newPage()
  await p.setViewportSize({ width: 820, height: 1180 })
  const pages = []
  for (let i = 1; i <= 3; i++) {
    await p.setContent(`<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;background:#0d1220;color:#e8e2d4;font-family:Georgia,'Noto Serif CJK SC',serif}
      .page{position:relative;width:820px;height:1180px;overflow:hidden;background:
        radial-gradient(120% 90% at 20% 0%, #17233f 0%, #0b0f1a 55%, #05070c 100%)}
      .stars{position:absolute;inset:0;background-image:radial-gradient(#d9e2ff 1px,transparent 1.4px);
        background-size:46px 46px;opacity:.35}
      .moon{position:absolute;left:470px;top:150px;width:250px;height:250px;border-radius:50%;
        background:radial-gradient(circle at 38% 34%, #fdf6e3, #cbb98e 62%, #7c6a45);box-shadow:0 0 90px #d8c79c80}
      .hill{position:absolute;left:-40px;right:-40px;bottom:-80px;height:420px;border-radius:50% 50% 0 0;background:#070b14}
      .cap{position:absolute;left:60px;top:56px;font-size:20px;letter-spacing:.3em;opacity:.7}
      .chap{position:absolute;left:60px;top:120px;font-size:56px;font-weight:600;letter-spacing:.08em}
      .line{position:absolute;left:60px;top:200px;width:120px;height:2px;background:#cbb98e;opacity:.8}
      .no{position:absolute;right:60px;bottom:56px;font-size:18px;letter-spacing:.24em;opacity:.6}
      .body{position:absolute;left:70px;bottom:330px;right:90px;font-size:26px;line-height:1.9;color:#d8d2c0}
    </style>
    <div class="page"><div class="stars"></div><div class="moon"></div><div class="hill"></div>
      <div class="cap">银河画集 · VOL.1</div>
      <div class="chap">夜航</div><div class="line"></div>
      <div class="body">${
        i === 1
          ? '船沿着星图的缝隙向前，\n灯塔在身后缩成一颗小小的光。'
          : i === 2
          ? '“你听见了吗？”她问。\n海面之下，有另一种潮声。'
          : '他们把灯挂在桅杆上，\n像把一整片夜空带回了家。'
      }</div>
      <div class="no">${String(i).padStart(2, '0')} / 03</div>
    </div>`)
    pages.push(await p.screenshot({ type: 'png' }))
  }
  await p.close()
  const zip = new JSZip()
  pages.forEach((buf, i) => zip.file(`page-${String(i + 1).padStart(2, '0')}.png`, buf))
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function main() {
  const BASE = process.argv[2] || 'http://127.0.0.1:5173/'
  fs.mkdirSync(OUT, { recursive: true })

  const browser = await chromium.launch({
    env: browserEnv(),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  })
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('[console] ' + m.text())
  })
  page.on('requestfailed', (r) => errors.push('[requestfailed] ' + r.url() + ' ' + r.failure()?.errorText))

  const shot = async (name) => {
    await page.screenshot({ path: `${OUT}/${name}.png` })
    console.log('  shot:', name)
  }
  const wait = (ms) => page.waitForTimeout(ms)
  const goto = async (hash = '') => {
    await page.goto(BASE + hash, { waitUntil: 'domcontentloaded' })
    await wait(400)
  }
  const pill = async () => {
    for (let i = 0; i < 4; i++) {
      if (await page.locator('.pill').count()) return
      await page.locator('.stage').click({ position: { x: 195, y: 700 } }).catch(() => {})
      await wait(480)
    }
  }
  const closeSheets = async () => {
    for (let i = 0; i < 4; i++) {
      const scrim = page.locator('.scrim').last()
      if (await scrim.count()) await scrim.click({ position: { x: 10, y: 10 } }).catch(() => {})
      await wait(150)
    }
  }

  // ---------- 书架 ----------
  console.log('\n[1] 书架')
  await goto('?seed=1')
  await page.waitForFunction(() => document.querySelectorAll('.card').length >= 3, null, { timeout: 30000 })
  await wait(900)
  let cards = await page.locator('.card').count()
  check('示例书已灌入（≥3 本）', cards >= 3, `${cards} 本`)
  check('顶部 tabs', (await page.locator('.hh-tab.on').innerText()) === '书架')
  await shot('shelf')

  // 书架 / 智能助理 切换
  await page.locator('.hh-tab', { hasText: '智能助理' }).click()
  await page.waitForSelector('.agent', { timeout: 8000 })
  check('智能助理欢迎页', (await page.locator('.agent .welcome h1').innerText()) === '智能助理')
  check('欢迎页四个建议', (await page.locator('.agent .sug').count()) === 4)
  await shot('agent')
  await page.locator('.hh-tab', { hasText: '书架' }).click()
  await page.waitForSelector('.shelf', { timeout: 8000 })
  await page.waitForFunction(() => document.querySelectorAll('.card').length >= 3, null, { timeout: 15000 })
  await wait(500)

  const openByText = async (t) => {
    await page.locator(`.card[aria-label*="${t}"]`).first().click()
    await page.waitForSelector('.reader', { timeout: 15000 })
    await wait(1200)
  }
  const backToShelf = async () => {
    await page.locator('.tb[aria-label="返回"]').click()
    await page.waitForSelector('.shelf', { timeout: 10000 })
    await wait(600)
  }

  // ---------- TXT 阅读 ----------
  console.log('\n[2] TXT 阅读页')
  await openByText('岛上灯塔')
  check('阅读页已打开', (await page.locator('.reflow-flow').count()) > 0)
  check('读数 chip 常驻', await page.locator('.chip').isVisible())
  await wait(3400) // chrome 自动隐藏
  check('浮动工具条自动隐藏', (await page.locator('.pill').count()) === 0)
  check('读数 chip 在沉浸态可见', await page.locator('.chip').isVisible())
  await shot('txt-reading')
  await page.locator('.stage').click({ position: { x: 195, y: 700 } })
  await wait(500)
  check('点击中间唤出工具条', await page.locator('.pill').isVisible())
  await shot('reading-tools')

  // 翻页
  const chipMain = () => page.locator('.chip .num').first().innerText()
  const before = await chipMain()
  await page.locator('.pb[aria-label="下一页"]').click({ force: true })
  await wait(700)
  const after = await chipMain()
  check('翻页生效', before !== after, `${before} → ${after}`)

  // ---------- 手感：书眉 / 跟手翻页 / 进度拖动 ----------
  console.log('\n[2b] 阅读手感')
  const hideChrome = async () => {
    for (let i = 0; i < 8; i++) {
      if (!(await page.locator('.pill').count())) return
      await page.locator('.stage').click({ position: { x: 195, y: 700 } })
      await wait(420)
    }
  }
  await hideChrome()
  const runHead = await page.locator('.run-head').innerText().catch(() => '')
  check('沉浸态书眉（书名 · 章节）', runHead.includes('岛上灯塔') && runHead.length > 5, runHead)
  const folio = await page.locator('.run-foot .folio').innerText().catch(() => '')
  check('页脚页码', /^\d+ \/ \d+$/.test(folio.trim()), folio.trim())

  // 用 CDP 触摸事件模拟手指拖拽翻页
  const cdp = await ctx.newCDPSession(page)
  const touch = (type, x, y) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    })
  const dragBefore = await chipMain()
  const [curPage, totalPage] = dragBefore.split('/').map((x) => parseInt(x.trim(), 10))
  const forward = curPage < totalPage // 在最后一页就往回拖，避免拖到书尾
  const fromX = forward ? 320 : 90
  const toX = forward ? 140 : 300
  await touch('touchStart', fromX, 600)
  for (let i = 1; i <= 9; i++) {
    await touch('touchMove', fromX + ((toX - fromX) * i) / 9, 600)
    await wait(16)
  }
  await touch('touchEnd', toX, 600)
  await wait(600)
  const dragAfter = await chipMain()
  check('跟手拖拽翻页', dragBefore !== dragAfter, `${dragBefore} → ${dragAfter}`)

  // 按住页脚进度线拖到 90% 附近
  await pill()
  await wait(250)
  const box = await page.locator('.scrub').boundingBox()
  if (box) {
    const y = box.y + box.height / 2
    await page.mouse.move(box.x + 6, y)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.9, y, { steps: 8 })
    await page.mouse.up()
    await wait(700)
    const nums = (await chipMain()).split('/').map((x) => parseInt(x.trim(), 10))
    check('进度拖动跳页', nums.length === 2 && nums[0] >= nums[1] - 1, `读到 ${nums.join(' / ')}`)
  } else {
    check('进度拖动跳页', false, '找不到 .scrub')
  }

  // ---------- 目录 ----------
  console.log('\n[3] 目录')
  await pill()
  await page.locator('.pb[aria-label="目录"]').click({ force: true })
  await page.waitForSelector('.toc-item', { timeout: 5000 })
  const tocCount = await page.locator('.toc-item').count()
  check('目录有章节', tocCount > 0, `${tocCount} 章`)
  await shot('toc')
  await page.locator('.toc-item').nth(Math.min(1, tocCount - 1)).click()
  await wait(900)
  check('跳章后目录关闭', (await page.locator('.toc-item').count()) === 0)

  // ---------- 设置 / 夜间 ----------
  console.log('\n[4] 阅读外观')
  await pill()
  await page.locator('.pb[aria-label="阅读外观"]').click({ force: true })
  await page.waitForSelector('.settings-sheet', { timeout: 5000 })
  await shot('settings')
  await page.locator('.themes .theme-dot').nth(3).click()
  await wait(500)
  check('夜间主题生效', (await page.locator('.reader').getAttribute('data-rtheme')) === 'night')
  await closeSheets()
  await wait(400)
  await shot('night')
  // 切回纸白
  await pill()
  await page.locator('.pb[aria-label="阅读外观"]').click({ force: true })
  await page.locator('.themes .theme-dot').nth(0).click()
  await wait(300)
  await closeSheets()

  // ---------- 逐句聚焦 ----------
  console.log('\n[5] 逐句聚焦')
  await pill()
  await page.locator('.pb[aria-label="逐句聚焦"]').click({ force: true })
  await wait(900)
  check('聚焦模式 class 生效', (await page.locator('.reflow-flow.is-focus').count()) > 0)
  check('当前句高亮', (await page.locator('.reflow-flow .sent.is-current').count()) === 1)
  const chipFocus = await page.locator('.chip').innerText()
  check('chip 切换为句读数', /句/.test(chipFocus), chipFocus.replace(/\n/g, ' '))
  await shot('focus')
  const curBefore = await page.locator('.sent.is-current').first().getAttribute('data-si')
  await page.keyboard.press('ArrowRight')
  await wait(500)
  const curAfter = await page.locator('.sent.is-current').first().getAttribute('data-si')
  check('方向键逐句前进', curBefore !== curAfter, `${curBefore} → ${curAfter}`)
  await page.locator('.stage').click({ position: { x: 360, y: 500 } })
  await wait(400)
  check('右侧点击仍是逐句', (await page.locator('.sent.is-current').count()) === 1)
  await page.locator('.pb[aria-label="逐句聚焦"]').click({ force: true })
  await wait(500)
  check('可退出聚焦模式', (await page.locator('.reflow-flow.is-focus').count()) === 0)

  // ---------- 选中划线 ----------
  console.log('\n[6] 选中 + 划线 + 笔记')
  await page.evaluate(() => {
    const p = Array.from(document.querySelectorAll('.reflow-flow p')).find((el) => (el.textContent || '').trim().length > 40)
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    let node = null
    let n
    while ((n = walker.nextNode())) {
      if ((n.textContent || '').trim().length > 12) {
        node = n
        break
      }
    }
    const range = document.createRange()
    range.setStart(node, 2)
    range.setEnd(node, Math.min(node.textContent.length, 30))
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await page.waitForSelector('.sel-bar', { timeout: 5000 })
  check('选中浮条出现', await page.locator('.sel-bar').isVisible())
  await shot('selection')
  await page.locator('.sel-bar .colors .dot').first().click()
  await wait(800)
  check('划线已渲染', (await page.locator('.reflow-flow mark.hl').count()) > 0)
  await pill()
  await page.locator('.pb[aria-label="笔记"]').click({ force: true })
  await page.waitForSelector('.notes-sheet', { timeout: 5000 })
  const noteItems = await page.locator('.notes-sheet .item').count()
  check('笔记面板列出划线', noteItems > 0, `${noteItems} 条`)
  await shot('notes')
  await closeSheets()

  await page.locator('.reflow-flow mark.hl').first().click({ force: true })
  await wait(600)
  check('点击划线出现操作浮条', (await page.locator('.mark-pop').count()) > 0)
  await page.locator('.mark-pop .sb.danger').click({ force: true })
  await wait(600)
  check('删除划线', (await page.locator('.reflow-flow mark.hl').count()) === 0)

  // ---------- 阅读统计 ----------
  console.log('\n[7] 阅读统计')
  if ((await page.locator('.tb[aria-label="返回"]').count()) === 0) await pill()
  await backToShelf()
  await wait(900)
  await shot('shelf-progress')
  await page.locator('.hh-menu').click()
  await page.waitForSelector('.drawer', { timeout: 5000 })
  await wait(350)
  check('筛选抽屉打开', (await page.locator('.drawer .chips .chip').count()) > 0)
  await shot('drawer')
  await page.locator('.drawer .link-row', { hasText: '阅读统计' }).click()
  await page.waitForSelector('.stats', { timeout: 8000 })
  await wait(700)
  check('统计页打开', await page.locator('.hero').isVisible())
  check('7 天柱状图', (await page.locator('.chart .col').count()) === 7)
  const hero = await page.locator('.hero .big').innerText()
  check('总时长有记录', hero.trim().length > 0, hero)
  await shot('stats')
  await page.locator('.head .icon[aria-label="返回"]').click()
  await page.waitForSelector('.shelf', { timeout: 8000 })
  await wait(500)

  // ---------- 导入 FB2 / CBZ ----------
  console.log('\n[8] FB2 / CBZ 导入')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modu-e2e-'))
  const fb2 = path.join(tmp, '星海拾遗.fb2')
  const cbz = path.join(tmp, '银河画集.cbz')
  fs.copyFileSync(path.join(FIX, 'sample.fb2'), fb2)
  const demoCbz = await makeDemoCbz(ctx, path.join(__dirname, '../../app/node_modules/jszip'))
  fs.writeFileSync(cbz, demoCbz)
  await page.locator('input.file-input').setInputFiles([fb2, cbz])
  await wait(2500)
  check('FB2 已导入', (await page.locator('.card[aria-label*="星海拾遗"]').count()) > 0)
  check('CBZ 已导入', (await page.locator('.card[aria-label*="银河画集"]').count()) > 0)
  await shot('shelf-all')

  await openByText('星海拾遗')
  check('FB2 正文渲染', (await page.locator('.reflow-flow p').count()) > 0)
  await shot('fb2')

  await backToShelf()
  await page.locator('.card[aria-label*="银河画集"]').first().click()
  await page.waitForSelector('.comic', { timeout: 10000 })
  await page.locator('.comic img.page').first().waitFor({ timeout: 8000 })
  await wait(700)
  check('CBZ 漫画页渲染', await page.locator('.comic img.page').first().isVisible())
  await shot('comic')
  const comicChip = await page.locator('.chip').innerText()
  check('漫画页码 chip', /\//.test(comicChip), comicChip.replace(/\n/g, ' '))
  await backToShelf()

  // ---------- PDF ----------
  console.log('\n[9] PDF')
  await openByText('MoDu 示例 PDF')
  await page.waitForSelector('canvas', { timeout: 15000 })
  await wait(1500)
  check('PDF 页面渲染', (await page.locator('canvas').count()) > 0)
  await shot('pdf')
  if (await page.locator('.tb[aria-label="返回"]').count()) await backToShelf()

  // ---------- 控制台错误 ----------
  console.log('\n[10] 控制台')
  const real = errors.filter((e) => !/favicon|404 \(Not Found\)|pdf\.worker/.test(e))
  check('无页面异常', real.length === 0, real.slice(0, 3).join(' | '))

  await browser.close()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
  if (failed.length) {
    for (const f of failed) console.log('  FAILED:', f.name, f.extra)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
