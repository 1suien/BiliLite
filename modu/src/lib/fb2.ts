import type { TxtChapter } from '@/db'

export interface Fb2Parsed {
  title: string
  author: string
  /** 归一化后的纯文本正文；包含每章标题行，章与章之间以换行分隔。导入时会被存成 UTF-8 字节，阅读器按 TXT 的方式渲染。 */
  text: string
  /** 章节在 text 里的字符偏移；第一条通常是书名/前言，若无标题则整本一章 */
  chapters: TxtChapter[]
  /** base64 data URL of the cover image extracted from <coverpage>, if any */
  coverDataUrl?: string
}

/** 内嵌图片上限：超过 3MB 的 <binary> 直接跳过，避免导入时吃掉几十 MB 内存 */
const MAX_BINARY_BYTES = 3 * 1024 * 1024
const XLINK_NS = 'http://www.w3.org/1999/xlink'

function localNameOf(el: Element): string {
  return el.localName || el.nodeName.split(':').pop() || ''
}

function childElements(el: Element): Element[] {
  const out: Element[] = []
  for (let i = 0; i < el.childNodes.length; i++) {
    const n = el.childNodes[i]
    if (n.nodeType === 1) out.push(n as Element)
  }
  return out
}

/** FB2 元素都在 fictionbook 命名空间里，统一按 localName 匹配，兼容带前缀的写法 */
function allLocal(root: Document | Element, local: string): Element[] {
  const nodes = root.getElementsByTagName('*')
  const out: Element[] = []
  for (let i = 0; i < nodes.length; i++) {
    if (localNameOf(nodes[i]) === local) out.push(nodes[i])
  }
  return out
}

function firstLocal(root: Document | Element | undefined, local: string): Element | undefined {
  return root ? allLocal(root, local)[0] : undefined
}

function textOf(el: Element | undefined): string {
  return (el?.textContent || '')
    .replace(/\u00ad/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 取 <image l:href="#id"/> 的链接；xlink 前缀在 FB2 里几乎都是 l:，几种写法都兜一下 */
function hrefOf(el: Element | undefined): string {
  if (!el) return ''
  const href =
    el.getAttributeNS(XLINK_NS, 'href') ||
    el.getAttribute('l:href') ||
    el.getAttribute('xlink:href') ||
    el.getAttribute('href') ||
    ''
  return href.trim()
}

/**
 * FB2 常见编码是 UTF-8 / windows-1251，个别老文件是 UTF-16。
 * 先看 BOM，再读 XML 声明里的 encoding，最后依次尝试 UTF-8、windows-1251。
 */
function decodeXml(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  }
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 256)))
  const declared = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1]?.toLowerCase()
  if (declared && declared !== 'utf-8' && declared !== 'utf8') {
    try {
      return new TextDecoder(declared).decode(bytes)
    } catch {
      /* 不认识的编码，往下走 */
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    /* 不是 UTF-8，按俄文老书最常见的 windows-1251 再试 */
  }
  try {
    return new TextDecoder('windows-1251').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

function authorOf(titleInfo: Element | undefined): string {
  const author = firstLocal(titleInfo, 'author')
  if (!author) return ''
  const parts = ['first-name', 'middle-name', 'last-name']
    .map((n) => textOf(firstLocal(author, n)))
    .filter(Boolean)
  if (parts.length) return parts.join(' ')
  return textOf(firstLocal(author, 'nickname'))
}

/** 章节标题：把 <title> 里的每个 <p> 合成一行，避免标题自己占好几行 */
function titleLineOf(section: Element): string {
  const titleEl = childElements(section).find((el) => localNameOf(el) === 'title')
  if (!titleEl) return ''
  const parts: string[] = []
  for (const child of childElements(titleEl)) {
    const ln = localNameOf(child)
    if (ln !== 'p' && ln !== 'v' && ln !== 'subtitle') continue
    const t = textOf(child)
    if (t) parts.push(t)
  }
  return parts.length ? parts.join(' ') : textOf(titleEl)
}

/** 把一个块（p / poem / epigraph / cite ...）摊平成若干行；<title>、<image> 不占正文行 */
function flowLines(el: Element): string[] {
  const out: string[] = []
  const walk = (node: Element): void => {
    const ln = localNameOf(node)
    if (ln === 'p' || ln === 'v' || ln === 'subtitle' || ln === 'text-author' || ln === 'date') {
      const t = textOf(node)
      if (t) out.push(t)
      return
    }
    if (ln === 'empty-line') {
      out.push('')
      return
    }
    if (ln === 'title' || ln === 'image' || ln === 'binary' || ln === 'coverpage') return
    for (const child of childElements(node)) walk(child)
  }
  walk(el)
  return out
}

export async function parseFb2(buf: ArrayBuffer): Promise<Fb2Parsed> {
  const doc = new DOMParser().parseFromString(decodeXml(buf), 'application/xml')

  const parserError =
    doc.getElementsByTagName('parsererror')[0] ||
    (doc.documentElement && localNameOf(doc.documentElement) === 'parsererror' ? doc.documentElement : undefined)
  if (parserError || !doc.documentElement) {
    throw new Error('不是有效的 FB2 文件（XML 解析失败）')
  }
  const root = doc.documentElement
  if (localNameOf(root) !== 'FictionBook') {
    throw new Error('不是有效的 FB2 文件（缺少 FictionBook 根节点）')
  }

  // --- 元数据 ---
  const titleInfo = firstLocal(root, 'title-info')
  const bookTitle = textOf(firstLocal(titleInfo, 'book-title')) || textOf(firstLocal(root, 'book-title'))
  const author = authorOf(titleInfo)
  const title = bookTitle || '未命名'
  const prefaceTitle = bookTitle || '前言'

  // --- 内嵌图片：<binary id="..." content-type="...">base64</binary> ---
  const binaries = new Map<string, { mime: string; base64: string }>()
  for (const bin of allLocal(root, 'binary')) {
    const id = (bin.getAttribute('id') || '').trim()
    if (!id) continue
    const mime = (bin.getAttribute('content-type') || '').trim() || 'image/jpeg'
    if (!mime.startsWith('image/')) continue
    const base64 = (bin.textContent || '').replace(/\s+/g, '')
    if (!base64) continue
    // base64 长度按 3/4 折算成字节数，超限的图直接不收
    if (base64.length * 0.75 > MAX_BINARY_BYTES) continue
    binaries.set(id, { mime, base64 })
  }

  let coverDataUrl: string | undefined
  const coverpage = firstLocal(titleInfo, 'coverpage')
  const coverHref = hrefOf(coverpage ? firstLocal(coverpage, 'image') : undefined)
  if (coverHref) {
    const bin = binaries.get(coverHref.replace(/^#/, ''))
    if (bin) coverDataUrl = `data:${bin.mime};base64,${bin.base64}`
  }

  // --- 正文：按文档顺序拼接行，同时记录每章的字符偏移 ---
  const lines: string[] = []
  const chapters: TxtChapter[] = []
  let pos = 0
  let current: TxtChapter | null = null

  /** 追加一行；pos 始终等于 lines.join('\n') 的长度，偏移才能直接拿来 slice */
  function pushLine(line: string): void {
    if (lines.length) pos += 1
    lines.push(line)
    pos += line.length
    if (current) current.end = pos
  }

  function startChapter(name: string): void {
    const start = lines.length ? pos + 1 : 0
    current = { title: name, start, end: start }
    chapters.push(current)
  }

  const bodies = allLocal(root, 'body')
  // 注释之类带 name 的副 body 不参与正文，优先取第一个非 notes 的 body
  const body = bodies.find((b) => (b.getAttribute('name') || '').toLowerCase() !== 'notes') || bodies[0] || root

  function walkSection(section: Element): void {
    const heading = titleLineOf(section)
    if (heading) {
      startChapter(heading)
      pushLine(heading)
    } else if (!current) {
      // 全书都没有章节标题时，整本并成一章，标题用书名
      const only = bookTitle || '正文'
      startChapter(only)
      pushLine(only)
    }
    for (const child of childElements(section)) {
      const ln = localNameOf(child)
      if (ln === 'title') continue
      if (ln === 'section') walkSection(child)
      else for (const line of flowLines(child)) pushLine(line)
    }
  }

  // 第一个 section 之前的内容（题记、前言等）归到「书名/前言」一章
  const preface: string[] = []
  let started = false
  for (const child of childElements(body)) {
    if (localNameOf(child) === 'section') {
      if (!started && preface.some((l) => l.trim())) {
        startChapter(prefaceTitle)
        pushLine(prefaceTitle)
        for (const line of preface) pushLine(line)
      }
      started = true
      walkSection(child)
    } else if (started) {
      // section 之间的零散内容并到当前章末尾，保证偏移连续
      for (const line of flowLines(child)) pushLine(line)
    } else {
      preface.push(...flowLines(child))
    }
  }

  if (!chapters.length) {
    startChapter(prefaceTitle)
    pushLine(prefaceTitle)
    for (const line of preface) pushLine(line)
  }

  return { title, author, text: lines.join('\n'), chapters, coverDataUrl }
}
