#!/usr/bin/env node
/**
 * 墨读 web 端验收脚本（开发工具，不进 APK）
 *
 * 运行：
 *   cd /root/readawre/app && npm run dev -- --port 5173 --strictPort   # 另开终端
 *   NODE_PATH=/root/学习软件/tools/browser/node_modules node tools/browser/check.cjs
 *
 * 依赖：playwright（复用 /root/学习软件/tools/browser/node_modules）
 *       + /root/学习软件/tools/browser/chromium-libs 里的共享库与中文字体
 * 输出：/tmp/shots/*.png
 */
const fs = require('node:fs')
const { chromium } = require('playwright')

const LIBS = '/root/学习软件/tools/browser/chromium-libs/root/usr/lib/aarch64-linux-gnu'
const FONT_CONF = '/root/学习软件/tools/browser/fonts.conf'
const OUT = '/tmp/shots'

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

async function main() {
  const BASE = process.argv[2] || 'http://127.0.0.1:5173/'
  // PROD=1 时对 dist 产物做验收（无 /src 模块、?seed=1 不生效，改为点按钮灌示例书）
  const PROD = process.env.PROD === '1'
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
  const logs = []
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  page.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`))

  const shots = []
  const shot = async (name) => {
    await page.screenshot({ path: `${OUT}/${name}.png` })
    shots.push(name)
    console.log('  shot:', name)
  }
  const vp = { width: 390, height: 844 }
  const clickZone = async (zone) => {
    const x = zone === 'left' ? vp.width * 0.12 : zone === 'right' ? vp.width * 0.88 : vp.width * 0.5
    await page.mouse.click(x, vp.height * 0.55)
    await page.waitForTimeout(260)
  }
  const footText = async () =>
    await page.$eval('.footbar', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => null)
  const topbarVisible = async () => (await page.$('.topbar')) !== null
  /** 保证工具栏可见（中间点击是 toggle，所以要按当前状态决定） */
  const ensureChrome = async () => {
    for (let i = 0; i < 4; i++) {
      if (await topbarVisible()) return true
      await clickZone('center')
    }
    return await topbarVisible()
  }
  const openBook = async (title) => {
    const cards = await page.$$('.card')
    for (const c of cards) {
      const t = await c.$eval('.title', (e) => e.textContent.trim())
      if (t === title) {
        await c.click()
        return true
      }
    }
    return false
  }
  const backToShelf = async () => {
    await ensureChrome()
    await page.click('.topbar .tb-btn:first-child')
    await page.waitForSelector('.shelf', { timeout: 15000 })
    await page.waitForTimeout(600)
  }
  const fail = (msg) => {
    throw new Error('ASSERT: ' + msg)
  }
  const assert = (cond, msg) => {
    if (!cond) fail(msg)
    console.log('  ok:', msg)
  }

  try {
    if (PROD) {
      await page.goto(BASE, { waitUntil: 'load' })
      await page.waitForSelector('.shelf', { timeout: 30000 })
      await page.waitForTimeout(500)
      const have = await page.$$eval('.grid .card', (e) => e.length).catch(() => 0)
      if (!have) {
        await page.click('button[title="放入示例书"]')
        console.log('  (prod) 点击「放入示例书」')
      }
    } else {
      await page.goto(BASE + '?seed=1', { waitUntil: 'load' })
    }
    // 等到 3 本示例书全部灌入
    await page.waitForFunction(() => document.querySelectorAll('.grid .card').length >= 3, null, { timeout: 45000 })
    await page.waitForTimeout(700)
    const titles = await page.$$eval('.card .title', (els) => els.map((e) => e.textContent.trim()))
    console.log('shelf titles:', JSON.stringify(titles))
    assert(titles.length === 3, '示例书架有 3 本书')
    assert(titles.includes('MoDu 示例 PDF'), 'PDF 示例书已导入')
    await shot('01-shelf')

    // ============ 长文本分页压力测试（合成书，仅 dev） ============
    console.log('[长文本分页]')
    if (PROD) {
      console.log('  (prod) 跳过：生产包不含 /src 模块，示例 TXT/EPUB 已覆盖多页与目录')
    } else {
    await page.evaluate(async () => {
      const { importBuffer } = await import('/src/lib/import.ts')
      const cols = ['第一章 起风', '第二章 落雨', '第三章 归航', '第四章 灯塔']
      const paras = [
        '海面上浮起一层薄薄的白雾，把远处的礁石和守着礁石的灯塔都吞了进去。林舟把窗推开一条缝，潮气立刻涌进来，带着咸味和铁锈味。他数着雾里传来的钟声，一声，两声，到第七声的时候停了，海面重新安静下来。',
        '他每天做的事都很像：擦灯罩，记日志，检查油量，然后坐在门口等补给船。岛上没有别人，只有一只黑猫陪着他。猫不太叫，喜欢蹲在栏杆上看海，看得比人还专注，好像海里有它认识的东西。',
        '傍晚风转向了，云压得很低。他把晾在外面的衣服收进来，把窗一扇一扇关好。灯亮起来的时候，光柱慢慢地扫过海面，像一只手在黑暗里摸索。他站了一会儿，忽然觉得这光也是在摸他自己。',
        '有时候他会想，如果有人在对面岸上看见这盏灯，会不会以为岛上还有人等着他。这个念头让他心里暖了一下，又很快凉下去。他知道没有人等，也知道自己暂时还不想回去。',
      ]
      let text = ''
      for (let c = 0; c < cols.length; c++) {
        text += cols[c] + '\n\n'
        for (let p = 0; p < 9; p++) text += `（${cols[c].slice(0, 2)}·第${p + 1}段）` + paras[p % paras.length] + '\n\n'
      }
      const buf = new TextEncoder().encode(text)
      await importBuffer('长夜手记.txt', buf.buffer, 'text/plain')
    })
    await page.waitForFunction(() => document.querySelectorAll('.grid .card').length >= 4, null, { timeout: 20000 })
    await page.waitForTimeout(400)
    await shot('02-shelf-with-long-book')

    assert(await openBook('长夜手记'), '打开合成的长文本')
    await page.waitForSelector('.reflow-flow', { timeout: 20000 })
    await page.waitForTimeout(1200)
    let f = await footText()
    console.log('  long book footer:', f)
    const firstPages = Number(String(f).split('/')[1]?.match(/\d+/)?.[0] || 0)
    assert(firstPages >= 2, `长文本每章多页（pages=${firstPages}）`)
    await shot('03-long-page1')

    // 连续翻页：页码应递增
    const seq = []
    for (let i = 0; i < 6; i++) {
      await clickZone('right')
      await page.waitForTimeout(200)
      seq.push(await footText())
    }
    console.log('  flip seq:', JSON.stringify(seq))
    assert(seq[0] !== f, '右区点击可以翻页')
    await shot('04-long-after-flips')

    // 目录跳章
    await ensureChrome()
    await page.click('.tb-actions .tb-btn:nth-child(1)')
    await page.waitForTimeout(400)
    const tocCount = await page.$$eval('.toc-item', (els) => els.length)
    console.log('  toc items:', tocCount)
    assert(tocCount === 4, '长文本目录有 4 章')
    await shot('05-toc')
    await page.click('.toc-item:nth-child(3)')
    await page.waitForTimeout(700)
    const afterJump = await page.$eval('.tb-title strong', (e) => e.textContent.trim()).catch(() => '')
    console.log('  chapter after toc jump:', afterJump)
    assert(afterJump.includes('三章') || afterJump.includes('第 3'), '目录跳转到第三章')
    await shot('06-long-chapter3')
    await backToShelf()
    }

    // ============ TXT 示例书 ============
    console.log('[示例 TXT]')
    assert(await openBook('岛上灯塔'), '打开示例 TXT')
    await page.waitForSelector('.reflow-flow', { timeout: 20000 })
    await page.waitForTimeout(900)
    console.log('  txt footer:', await footText())
    await shot('07-txt')
    await ensureChrome()
    await shot('08-txt-chrome')

    // 设置：夜间主题 + 字号加大
    const tbBtns = await page.$$('.tb-actions .tb-btn')
    await tbBtns[tbBtns.length - 1].click()
    await page.waitForSelector('.settings-sheet', { timeout: 10000 })
    await page.waitForTimeout(400)
    await shot('09-settings')
    const plus = await page.$$('.stepper .step')
    await plus[plus.length - 1].click()
    await plus[plus.length - 1].click()
    await page.waitForTimeout(500)
    await page.click('.themes .theme-dot:nth-child(4)')
    await page.waitForTimeout(600)
    await page.evaluate(() => document.querySelector('.scrim')?.click())
    await page.waitForTimeout(700)
    const theme = await page.$eval('.reader', (e) => e.getAttribute('data-rtheme'))
    const fs2 = await page.$eval('.reflow-flow', (e) => getComputedStyle(e).fontSize).catch(() => '')
    console.log('  theme/font:', theme, fs2)
    assert(theme === 'night', '夜间主题已生效')
    assert(parseFloat(fs2) > 19, '字号加大已生效')
    await shot('10-night')

    // 主题持久化：回书架再进
    await backToShelf()
    assert(await openBook('岛上灯塔'), '再次打开 TXT')
    await page.waitForSelector('.reflow-flow', { timeout: 20000 })
    await page.waitForTimeout(800)
    const theme2 = await page.$eval('.reader', (e) => e.getAttribute('data-rtheme'))
    assert(theme2 === 'night', '阅读设置持久化（IndexedDB）')
    // 恢复默认主题
    await ensureChrome()
    const tbs = await page.$$('.tb-actions .tb-btn')
    await tbs[tbs.length - 1].click()
    await page.waitForTimeout(500)
    await page.click('.themes .theme-dot:nth-child(1)')
    await page.waitForTimeout(400)
    await page.evaluate(() => document.querySelector('.scrim')?.click())
    await page.waitForTimeout(500)
    await backToShelf()

    // ============ EPUB ============
    console.log('[示例 EPUB]')
    assert(await openBook('岛上灯塔（EPUB 示例）'), '打开示例 EPUB')
    await page.waitForSelector('.reflow-flow', { timeout: 20000 })
    await page.waitForTimeout(1500)
    console.log('  epub footer:', await footText())
    await shot('11-epub')
    // 第二章带内嵌插图，跳到第二章检查图片解密
    await ensureChrome()
    await page.click('.tb-actions .tb-btn:nth-child(1)')
    await page.waitForTimeout(400)
    const epubToc = await page.$$eval('.toc-item', (els) => els.length)
    console.log('  epub toc items:', epubToc)
    assert(epubToc === 4, 'EPUB 目录有 4 章')
    await shot('12-epub-toc')
    await page.click('.toc-item:nth-child(2)')
    await page.waitForTimeout(1500)
    const imgState = await page.$$eval('.reflow-flow img', (els) =>
      els.map((i) => ({ w: i.naturalWidth, h: i.naturalHeight, src: i.getAttribute('src')?.slice(0, 16) })),
    )
    console.log('  epub images:', JSON.stringify(imgState))
    assert(imgState.length > 0, 'EPUB 插图已解出')
    assert(imgState.every((i) => i.w > 0), 'EPUB 插图加载成功')
    await shot('13-epub-image')
    await backToShelf()

    // ============ PDF ============
    console.log('[示例 PDF]')
    assert(await openBook('MoDu 示例 PDF'), '打开示例 PDF')
    await page.waitForSelector('.pdf-page canvas', { timeout: 30000 })
    await page.waitForTimeout(1500)
    console.log('  pdf footer:', await footText())
    const cv = await page.$eval('.pdf-page canvas', (c) => ({ w: c.width, h: c.height }))
    console.log('  pdf canvas:', JSON.stringify(cv))
    assert(cv.w > 0, 'PDF 页面已渲染到 canvas')
    await shot('14-pdf')
    // 放大
    const pdfBtns = await page.$$('.footbar .fb-btn')
    console.log('  pdf foot buttons:', pdfBtns.length)
    await pdfBtns[pdfBtns.length - 2]?.click() // A+
    await page.waitForTimeout(1200)
    await shot('15-pdf-zoom')
    // 滚动到后面
    await page.evaluate(() => {
      const el = document.querySelector('.pdf-scroll')
      if (el) el.scrollTop = el.scrollHeight * 0.45
    })
    await page.waitForTimeout(1500)
    console.log('  pdf footer after scroll:', await footText())
    await shot('16-pdf-scrolled')
    // PDF 目录（outline）
    await ensureChrome()
    const pdfTb = await page.$$('.tb-actions .tb-btn')
    console.log('  pdf topbar buttons:', pdfTb.length)
    if (pdfTb.length) {
      await pdfTb[0].click()
      await page.waitForTimeout(500)
      const pdfToc = await page.$$eval('.toc-item', (e) => e.length).catch(() => 0)
      console.log('  pdf toc items:', pdfToc)
      await shot('17-pdf-toc')
      await page.evaluate(() => document.querySelector('.scrim')?.click())
      await page.waitForTimeout(400)
    }
    await backToShelf()

    await page.waitForTimeout(600)
    await shot('18-shelf-final')
    const cards = await page.$$eval('.card', (els) =>
      els.map((c) => ({
        title: c.querySelector('.title')?.textContent.trim(),
        meta: c.querySelector('.meta')?.textContent.replace(/\s+/g, ' ').trim(),
        bar: c.querySelector('.bar i')?.getAttribute('style') || '',
      })),
    )
    console.log('final shelf:', JSON.stringify(cards, null, 1))
    console.log('ALL CHECKS PASSED')
  } catch (e) {
    console.error('CHECK FAILED:', e.message)
    await page.screenshot({ path: `${OUT}/zz-failure.png` }).catch(() => {})
    process.exitCode = 1
  } finally {
    console.log('--- browser console (' + logs.length + ') ---')
    for (const l of logs.slice(-40)) console.log(l.slice(0, 600))
    await browser.close()
  }
}

main().catch((e) => {
  console.error('LAUNCH FAILED:', e)
  process.exit(1)
})
