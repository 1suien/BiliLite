import type { TxtChapter } from '@/db'

/** 常见中文章节标题；也兼容 Chapter N / CHAPTER N */
const HEADING_RE =
  /^[ \t\u3000]*((?:第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章节回卷篇部集]|Chapter\s+[0-9IVXLCDM]+|CHAPTER\s+[0-9IVXLCDM]+|序章|楔子|引子|前言|后记|尾声|终章|番外(?:篇)?)(?:[^\n]{0,38}))[ \t\u3000]*$/gm

/**
 * 解码纯文本：优先 UTF-8（fatal 模式，遇到非法字节就换），
 * 失败则按 GB18030（兼容 GBK/GB2312，中文 TXT 最常见的编码），最后兜底 UTF-8 宽松解码。
 */
export function decodeText(buf: ArrayBuffer): string {
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
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    /* 不是 UTF-8，往下走 */
  }
  try {
    return new TextDecoder('gb18030').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** 把正文按章节标题切开；没识别到标题就按 6000 字左右切「节」，保证一页一页能翻 */
export function parseTxtChapters(raw: string, bookTitle: string): TxtChapter[] {
  const text = raw.replace(/\r\n?/g, '\n').replace(/\u0000/g, '')

  const matches: { index: number; title: string }[] = []
  HEADING_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = HEADING_RE.exec(text))) {
    const title = (m[1] || '').replace(/\s+/g, ' ').trim()
    if (!title) continue
    matches.push({ index: m.index, title: title.length > 34 ? title.slice(0, 34) + '…' : title })
  }

  // 标题太少就不当分章书处理（避免把正文里零星的「前言」误判成章）
  if (matches.length >= 2) {
    const chapters: TxtChapter[] = []
    const head = text.slice(0, matches[0].index).trim()
    if (head.length > 20) {
      chapters.push({ title: '开始', start: 0, end: matches[0].index })
    }
    for (let i = 0; i < matches.length; i++) {
      chapters.push({
        title: matches[i].title,
        start: matches[i].index,
        end: i + 1 < matches.length ? matches[i + 1].index : text.length,
      })
    }
    return chapters
  }

  // 没有章节：按 6000 字左右切成「第 N 节」，在换行处断开
  const chunks: TxtChapter[] = []
  let start = 0
  let idx = 1
  while (start < text.length) {
    let end = Math.min(text.length, start + 6000)
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end)
      if (nl > start + 2000) end = nl + 1
    }
    chunks.push({ title: text.length <= 6000 && chunks.length === 0 ? bookTitle : `第 ${idx} 节`, start, end })
    start = end
    idx++
  }
  if (!chunks.length) chunks.push({ title: bookTitle, start: 0, end: text.length })
  return chunks
}

/** 当前章节的纯文本按段落拆好，再交给阅读器渲染成 <p> */
export function chaptersOf(text: string): string[] {
  return text.split('\n')
}

/** 把一段纯文本转成安全的段落 HTML */
export function textToHtml(text: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const lines = text.split('\n')
  let html = ''
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    html += `<p>${esc(t)}</p>`
  }
  return html
}
