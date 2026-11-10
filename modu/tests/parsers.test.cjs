#!/usr/bin/env node
/**
 * FB2 / CBZ 解析器自测（开发工具，不进 APK）
 *
 * 运行：
 *   cd /root/readawre/app
 *   NODE_PATH=/root/学习软件/tools/browser/node_modules node tests/parsers.test.cjs
 *
 * 做法：连上已经在跑的 vite dev server，用 page.evaluate 直接 import 源码里的 TS 模块
 *       （vite 会即时编译），把夹具以 base64 塞进浏览器再还原成 ArrayBuffer。
 * 依赖：playwright（复用 /root/学习软件/tools/browser/node_modules）
 */
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')
const JSZip = require('jszip')

const LIBS = '/root/学习软件/tools/browser/chromium-libs/root/usr/lib/aarch64-linux-gnu'
const FONT_CONF = '/root/学习软件/tools/browser/fonts.conf'
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173/'
const FIXTURES = path.resolve(__dirname, 'fixtures')

function browserEnv() {
  const env = { ...process.env }
  if (fs.existsSync(LIBS)) {
    env.LD_LIBRARY_PATH = [LIBS, env.LD_LIBRARY_PATH, '/usr/lib/aarch64-linux-gnu'].filter(Boolean).join(':')
  }
  if (fs.existsSync(FONT_CONF)) {
    env.FONTCONFIG_FILE = FONT_CONF
    env.FONTCONFIG_PATH = '/root/学习软件/tools/browser'
  }
  env.HOME = env.HOME || '/tmp/pw-home'
  return env
}

let passed = 0
let failed = 0

function check(name, ok, detail) {
  if (ok) {
    passed++
    console.log('PASS  ' + name)
  } else {
    failed++
    console.log('FAIL  ' + name + (detail === undefined ? '' : '  -> ' + detail))
  }
}

function checkEqual(name, actual, expected) {
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

async function main() {
  for (const f of ['sample.fb2', 'sample.cbz']) {
    if (!fs.existsSync(path.join(FIXTURES, f))) throw new Error('缺少夹具：tests/fixtures/' + f)
  }

  const browser = await chromium.launch({
    env: browserEnv(),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  })

  try {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      locale: 'zh-CN',
    })
    const page = await ctx.newPage()
    const logs = []
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
    page.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`))

    await page.goto(BASE, { waitUntil: 'load' })
    await page.waitForFunction(() => !!document.querySelector('#app'), null, { timeout: 30000 })

    const fb2B64 = fs.readFileSync(path.join(FIXTURES, 'sample.fb2')).toString('base64')
    const cbzB64 = fs.readFileSync(path.join(FIXTURES, 'sample.cbz')).toString('base64')

    // 额外造一个 1/2/10 的包，专门验证「自然序」不是字典序（字典序会排成 1,10,2）
    const onePxPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const naturalZip = new JSZip()
    naturalZip.file('10.png', onePxPng)
    naturalZip.file('2.png', onePxPng)
    naturalZip.file('ComicInfo.txt', 'pages: 3')
    naturalZip.file('1.png', onePxPng)
    const naturalB64 = (await naturalZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })).toString('base64')
    const badXmlB64 = Buffer.from('<FictionBook><body><section>', 'utf8').toString('base64')

    // 全书一个 section 标题都没有：按「若无标题则整本一章」应当只产出一章
    const noTitleB64 = Buffer.from(
      `<?xml version="1.0" encoding="utf-8"?>
<FictionBook>
  <description><title-info><book-title>无题之书</book-title></title-info></description>
  <body>
    <section><p>第一段落，没有小节标题。</p><empty-line/><p>第二段落。</p></section>
    <section><p>另一个 section，也没有标题。</p></section>
  </body>
</FictionBook>`,
      'utf8',
    ).toString('base64')

    const data = await page.evaluate(
      async ({ fb2B64, cbzB64, naturalB64, badXmlB64, noTitleB64 }) => {
        const toBuffer = (b64) => {
          const s = atob(b64)
          const bytes = new Uint8Array(s.length)
          for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)
          return bytes.buffer
        }
        const out = { fb2: null, cbz: null, natural: null, fb2Error: '', errors: [] }

        try {
          const { parseFb2 } = await import('/src/lib/fb2.ts')
          const parsed = await parseFb2(toBuffer(fb2B64))
          out.fb2 = {
            title: parsed.title,
            author: parsed.author,
            text: parsed.text,
            chapters: parsed.chapters,
            slices: parsed.chapters.map((c) => parsed.text.slice(c.start, c.end)),
            cover: parsed.coverDataUrl || '',
            coverLength: (parsed.coverDataUrl || '').length,
          }
          // 故意喂一段没闭合的 XML：应当抛中文错误，而不是静默返回空书
          try {
            await parseFb2(toBuffer(badXmlB64))
          } catch (e) {
            out.fb2Error = (e && e.message) || String(e)
          }
          const untitled = await parseFb2(toBuffer(noTitleB64))
          out.untitled = {
            chapters: untitled.chapters,
            slices: untitled.chapters.map((c) => untitled.text.slice(c.start, c.end)),
            text: untitled.text,
          }
        } catch (e) {
          out.errors.push('fb2: ' + ((e && e.message) || String(e)))
        }

        try {
          const { openCbz } = await import('/src/lib/cbz.ts')
          const book = await openCbz(toBuffer(cbzB64))
          const url0 = await book.pageUrl(0)
          // 缓存命中应返回同一个 URL
          const url0Again = await book.pageUrl(0)
          const blob = await fetch(url0).then((r) => r.blob())
          let outOfRange = ''
          try {
            await book.pageUrl(99)
          } catch (e) {
            outOfRange = (e && e.message) || String(e)
          }
          out.cbz = {
            pageCount: book.pageCount,
            pages: book.pages,
            url0,
            url0Again,
            blobSize: blob.size,
            blobType: blob.type,
            cover: book.coverDataUrl || '',
            coverLength: (book.coverDataUrl || '').length,
            outOfRange,
          }

          const natural = await openCbz(toBuffer(naturalB64))
          out.natural = { pageCount: natural.pageCount, pages: natural.pages }
        } catch (e) {
          out.errors.push('cbz: ' + ((e && e.message) || String(e)))
        }

        return out
      },
      { fb2B64, cbzB64, naturalB64, badXmlB64, noTitleB64 },
    )

    if (data.errors.length) console.log('模块内错误：\n  ' + data.errors.join('\n  '))
    check('两个模块都能被浏览器加载并执行', data.errors.length === 0, data.errors.join('; '))

    // ==================== FB2 ====================
    console.log('\n[FB2]')
    const fb2 = data.fb2
    check('parseFb2 返回了结果', !!fb2)
    if (fb2) {
      checkEqual('书名', fb2.title, '星海拾遗')
      check('作者非空', !!fb2.author && fb2.author.length > 0, JSON.stringify(fb2.author))
      check('章节数 >= 2', fb2.chapters.length >= 2, '实际 ' + fb2.chapters.length)
      const titles = fb2.chapters.map((c) => c.title)
      check(
        '章节标题包含「第一章 出发」和「第二章 星图」',
        titles.includes('第一章 出发') && titles.some((t) => t.startsWith('第二章 星图')),
        JSON.stringify(titles),
      )
      checkEqual('多行 <title> 合并成一行标题', titles[2], '第二章 星图 The Star Chart')

      const badSlice = fb2.chapters.findIndex((c, i) => !c.title || !fb2.slices[i].startsWith(c.title))
      check('每章切片都以自己的标题行开头', badSlice < 0, badSlice >= 0 ? `第 ${badSlice} 章：${JSON.stringify(fb2.slices[badSlice].slice(0, 40))}` : '')

      const first = fb2.chapters[0]
      check('首章是书名/前言', !!first && first.title === fb2.title, first && first.title)
      check('首章偏移从 0 开始', !!first && first.start === 0, first && first.start)

      let monotonic = true
      for (let i = 1; i < fb2.chapters.length; i++) {
        if (fb2.chapters[i].start < fb2.chapters[i - 1].end) monotonic = false
      }
      check('章节偏移单调不重叠', monotonic)
      check(
        '最后一章覆盖到正文末尾',
        fb2.chapters.length > 0 && fb2.chapters[fb2.chapters.length - 1].end === fb2.text.length,
        `end=${fb2.chapters.length && fb2.chapters[fb2.chapters.length - 1].end} text=${fb2.text.length}`,
      )

      check('正文长度合理（200–200000）', fb2.text.length > 200 && fb2.text.length < 200000, String(fb2.text.length))
      check('保留了 <empty-line/> 产生的空行', fb2.text.includes('\n\n'))
      check('正文含中文与英文', /[\u4e00-\u9fa5]/.test(fb2.text) && /[A-Za-z]{4,}/.test(fb2.text))
      check('题记进入了正文', fb2.text.includes('献给所有在夜里读书的人'))
      check('封面是 data:image/ URL', fb2.cover.startsWith('data:image/'), fb2.cover.slice(0, 32))
      check('封面 base64 非空', fb2.coverLength > 100, String(fb2.coverLength))
      check('坏 XML 会抛中文错误', data.fb2Error.includes('不是有效的 FB2 文件'), data.fb2Error)
    }

    // ==================== 无标题 FB2 ====================
    console.log('\n[FB2 无标题]')
    const untitled = data.untitled
    check('无标题 FB2 也能解析', !!untitled)
    if (untitled) {
      checkEqual('整本并成一章', untitled.chapters.length, 1)
      check('首章偏移为 0', untitled.chapters[0].start === 0, String(untitled.chapters[0].start))
      check('首章切片以标题行开头', untitled.slices[0].startsWith(untitled.chapters[0].title), JSON.stringify(untitled.slices[0].slice(0, 32)))
      check('两个 section 的正文都保留', untitled.text.includes('第一段落') && untitled.text.includes('另一个 section'))
      check('空行保留', untitled.text.includes('\n\n'))
    }

    // ==================== CBZ ====================
    console.log('\n[CBZ]')
    const cbz = data.cbz
    check('openCbz 返回了结果', !!cbz)
    if (cbz) {
      checkEqual('页数', cbz.pageCount, 3)
      check('页面按自然序排列', JSON.stringify(cbz.pages) === JSON.stringify(['1.png', '2.png', '3.png']), JSON.stringify(cbz.pages))
      check('pageUrl(0) 返回 blob: URL', cbz.url0.startsWith('blob:'), cbz.url0)
      check('pageUrl(0) 第二次命中缓存（同一 URL）', cbz.url0Again === cbz.url0)
      check('blob URL 能取到真实图片字节', cbz.blobSize > 0 && cbz.blobType.startsWith('image/'), `${cbz.blobType} ${cbz.blobSize}B`)
      check('越界页会 reject', !!cbz.outOfRange, cbz.outOfRange)
      check('封面是 data:image/ URL', cbz.cover.startsWith('data:image/'), cbz.cover.slice(0, 32))
      check('封面已缩到 320px（不是原图直出）', cbz.cover.startsWith('data:image/jpeg;base64,') && cbz.coverLength < 30000, `${cbz.cover.slice(0, 24)}… ${cbz.coverLength}B`)
    }

    // 自然序 + 非图片文件过滤
    console.log('\n[CBZ 自然序]')
    check('1/2/10 按数字顺序而不是字典序', JSON.stringify(data.natural?.pages) === JSON.stringify(['1.png', '2.png', '10.png']), JSON.stringify(data.natural?.pages))
    check('非图片文件被忽略', data.natural?.pageCount === 3, String(data.natural?.pageCount))

    if (logs.length) {
      const interesting = logs.filter((l) => /error|failed|pageerror/i.test(l))
      if (interesting.length) console.log('\n浏览器日志（错误类）：\n  ' + interesting.slice(0, 10).join('\n  '))
    }
  } finally {
    await browser.close()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) process.exitCode = 1
}

main().catch((e) => {
  console.error('测试脚本异常：', e)
  process.exitCode = 1
})
