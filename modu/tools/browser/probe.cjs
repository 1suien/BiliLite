#!/usr/bin/env node
/** 定向排查脚本：?seed=1 的导入失败原因与 TXT 分页测量 */
const fs = require('node:fs')
const { chromium } = require('playwright')

const LIBS = '/root/学习软件/tools/browser/chromium-libs/root/usr/lib/aarch64-linux-gnu'
const FONT_CONF = '/root/学习软件/tools/browser/fonts.conf'

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
  const browser = await chromium.launch({ env: browserEnv(), args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: 'zh-CN' })
  const page = await ctx.newPage()
  const logs = []
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  await page.goto(BASE + '?seed=1', { waitUntil: 'load' })
  await page.waitForSelector('.grid .card', { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(1500)

  // 1) 书架状态 + IndexedDB 里的书
  const shelf = await page.$$eval('.card .title', (els) => els.map((e) => e.textContent.trim()))
  console.log('shelf titles:', JSON.stringify(shelf))
  const dbbooks = await page.evaluate(async () => {
    const { db } = await import('/src/db/index.ts')
    const all = await db.books.toArray()
    return all.map((b) => ({ title: b.title, format: b.format, size: b.size, chapters: (b.chapters || []).length, pageCount: b.pageCount }))
  })
  console.log('db books:', JSON.stringify(dbbooks))

  // 2) 直接生成示例 PDF / EPUB，看哪一步炸
  const gen = await page.evaluate(async () => {
    const out = {}
    try {
      const m = await import('/src/lib/sample.ts')
      const buf = await m.buildSamplePdf()
      out.pdf = { type: buf.constructor.name, bytes: buf.byteLength, head: new TextDecoder().decode(new Uint8Array(buf).slice(0, 40)) }
      localStorage.setItem('probe.pdf', JSON.stringify(Array.from(new Uint8Array(buf))))
    } catch (e) {
      out.pdfError = String(e && (e.stack || e.message))
    }
    try {
      const m = await import('/src/lib/sample.ts')
      const buf = await m.buildSampleEpub()
      out.epub = { type: buf.constructor.name, bytes: buf.byteLength }
    } catch (e) {
      out.epubError = String(e && (e.stack || e.message))
    }
    return out
  })
  console.log('sample gen:', JSON.stringify(gen).slice(0, 1200))

  // 3) 用 pdfjs 解析刚生成的 PDF
  const parse = await page.evaluate(async () => {
    const arr = JSON.parse(localStorage.getItem('probe.pdf') || '[]')
    const data = new Uint8Array(arr)
    try {
      const pdf = await import('/src/lib/pdf.ts')
      const doc = await pdf.loadPdfDocument(data.buffer)
      return { pages: doc.numPages }
    } catch (e) {
      return { error: String(e && (e.stack || e.message)) }
    }
  })
  console.log('pdf parse:', JSON.stringify(parse).slice(0, 800))

  // 4) 打开 TXT（精确文本匹配）看分页测量
  await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.card'))
    const card = cards.find((c) => (c.querySelector('.title')?.textContent || '').trim() === '岛上灯塔')
    card && card.click()
  })
  await page.waitForSelector('.reflow-flow', { timeout: 20000 })
  await page.waitForTimeout(1500)
  const measure = await page.evaluate(() => {
    const view = document.querySelector('.reflow-view')
    const flow = document.querySelector('.reflow-flow')
    const mark = document.querySelector('[data-end]')
    const foot = document.querySelector('.footbar')
    const cs = flow ? getComputedStyle(flow) : null
    return {
      view: view ? { w: view.clientWidth, h: view.clientHeight } : null,
      flow: flow
        ? {
            clientW: flow.clientWidth,
            clientH: flow.clientHeight,
            scrollW: flow.scrollWidth,
            scrollH: flow.scrollHeight,
            padL: cs.paddingLeft,
            paddingTop: cs.paddingTop,
            paddingBottom: cs.paddingBottom,
            colW: cs.columnWidth,
            colGap: cs.columnGap,
            transform: cs.transform,
            fontSize: cs.fontSize,
            lineHeight: cs.lineHeight,
          }
        : null,
      markLeft: mark ? mark.offsetLeft : null,
      foot: foot ? foot.textContent.replace(/\s+/g, ' ').trim() : null,
    }
  })
  console.log('TXT measure:', JSON.stringify(measure, null, 1))

  await page.waitForTimeout(300)
  await page.screenshot({ path: '/tmp/shots/probe-txt.png' })
  console.log('--- console logs ---')
  for (const l of logs) console.log(l.slice(0, 500))
  await browser.close()
}

main().catch((e) => {
  console.error('PROBE FAILED:', e)
  process.exit(1)
})
