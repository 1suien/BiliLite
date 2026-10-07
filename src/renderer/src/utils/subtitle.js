/**
 * 本地字幕解析：SRT / WebVTT / ASS(SSA) → [{ from, to, content }]
 *
 * 只做「够用」的解析，不追求完整规范，但要求不乱码、不错行：
 *  - 时间是「秒」为单位的数字（可带小数），与在线字幕（B 站 json）保持同一个数据结构，
 *    这样播放器里 activeCc 那套二分查找对两种字幕都能直接用；
 *  - SRT / VTT 的时间行都认 `00:00:01,200 --> 00:00:04,000`（逗号/点、小时可省）；
 *  - VTT 忽略 WEBVTT / NOTE / STYLE / REGION 块，时间行后面的 `line:90% align:middle` 也忽略；
 *  - ASS 走 [Events] 段的 Format + Dialogue，剥掉 `{\...}` 覆盖标签、`\N` 变换行、按 [Format] 的字段顺序取值
 *    （Text 是最后一个字段，里面可能带逗号，所以不能简单 split(',')）。
 */

export const SUB_EXTS = ['srt', 'vtt', 'ass', 'ssa']

/** 取小写扩展名（不含点）；没有扩展名时返回空串 */
export function subExt(name) {
  const m = /\.([A-Za-z0-9]+)\s*$/.exec(String(name || ''))
  return m ? m[1].toLowerCase() : ''
}

/** 是不是我们认得的字幕文件名 */
export function isSubtitleFile(name) {
  return SUB_EXTS.includes(subExt(name))
}

/**
 * 把字节解成文本：先当 UTF-8 解（严格模式，解不通就说明不是 UTF-8），
 * 再退 GB18030（中文 .srt 最常见的另一种编码），最后兜底 UTF-8 宽松解码。
 */
export function decodeSubtitleBytes(bytes) {
  let buf = bytes
  if (buf instanceof ArrayBuffer) buf = new Uint8Array(buf)
  if (!buf || typeof buf.length !== 'number') return ''
  // 去 BOM：UTF-8 EF BB BF / UTF-16 LE FF FE（UTF-16 交给 TextDecoder 自己认）
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    /* 不是合法 UTF-8，换 GB18030 */
  }
  try {
    return new TextDecoder('gb18030').decode(buf)
  } catch {
    return new TextDecoder('utf-8').decode(buf)
  }
}

/** `1:02:03.45` / `00:02:03,450` / `02:03.4` → 秒（解不出返回 null） */
export function parseSubTime(str) {
  const s = String(str == null ? '' : str).trim()
  if (!s) return null
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(s)
  if (!m) return null
  const h = m[1] ? Number(m[1]) : 0
  const min = Number(m[2])
  const sec = Number(m[3])
  const frac = m[4] ? Number(m[4].padEnd(3, '0')) / 1000 : 0 // ASS 是厘秒，补成毫秒
  return h * 3600 + min * 60 + sec + frac
}

/** 清掉字幕文本里的标签：HTML（VTT 的 <b>/<i>/<v xx>）、ASS 的 {\...}、转义与换行 */
function cleanText(raw) {
  let s = String(raw == null ? '' : raw)
  s = s.replace(/\{[^}]*\}/g, '') // ASS 覆盖标签
  s = s.replace(/<\/?[A-Za-z][^>]*>/g, '') // VTT/SRT 内联标签
  s = s.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ')
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  return s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

function pushItem(items, from, to, text) {
  if (from == null || to == null) return
  if (!(to > from)) return
  const content = cleanText(text)
  if (!content) return
  items.push({ from, to, content })
}

/** SRT / WebVTT：按空行切块，块里含 `-->` 的那行是时间行，其余是文本 */
function parseSrtLike(text) {
  const items = []
  const blocks = String(text)
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split('\n')
    // VTT 的头与注释块
    const head = (lines[0] || '').trim()
    if (/^WEBVTT/i.test(head) || /^NOTE\b/i.test(head) || /^STYLE\b/i.test(head) || /^REGION\b/i.test(head)) continue
    const ti = lines.findIndex((l) => l.includes('-->'))
    if (ti < 0) continue
    const [left, rightRaw] = lines[ti].split('-->')
    const right = (rightRaw || '').trim().split(/\s+/)[0] // 丢掉 line:90% align:middle 这类设置
    const from = parseSubTime(left)
    const to = parseSubTime(right)
    pushItem(items, from, to, lines.slice(ti + 1).join('\n'))
  }
  return items
}

/** ASS/SSA：[Events] 段里按 Format 给的字段顺序读 Dialogue */
function parseAss(text) {
  const items = []
  const lines = String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
  let inEvents = false
  let fields = null
  for (const raw of lines) {
    const line = raw.trim()
    if (/^\[/.test(line)) {
      inEvents = /^\[events\]$/i.test(line)
      continue
    }
    if (!inEvents) continue
    const fm = /^Format\s*:\s*(.+)$/i.exec(line)
    if (fm) {
      fields = fm[1].split(',').map((x) => x.trim().toLowerCase())
      continue
    }
    const dm = /^Dialogue\s*:\s*(.+)$/i.exec(line)
    if (!dm || !fields) continue
    // Text 是最后一个字段，本身可能含逗号 → 只切前 n-1 个逗号
    const parts = []
    let rest = dm[1]
    for (let i = 0; i < fields.length - 1; i++) {
      const c = rest.indexOf(',')
      if (c < 0) break
      parts.push(rest.slice(0, c))
      rest = rest.slice(c + 1)
    }
    parts.push(rest)
    const get = (name) => {
      const i = fields.indexOf(name)
      return i >= 0 && i < parts.length ? parts[i] : ''
    }
    pushItem(items, parseSubTime(get('start')), parseSubTime(get('end')), get('text'))
  }
  return items
}

/**
 * 解析字幕文本。ext 只用来判断走哪条分支（ass/ssa → ASS，其余 → SRT/VTT），
 * 认不出来时按内容嗅探（含 `[Events]` 且含 `Dialogue:` 就当 ASS）。
 * @returns {{format: string, items: Array<{from:number,to:number,content:string}>}}
 */
export function parseSubtitle(text, ext = '') {
  const body = String(text == null ? '' : text).replace(/^\uFEFF/, '')
  const e = String(ext || '').toLowerCase()
  const assLike = e === 'ass' || e === 'ssa' || (!e && /\[events\]/i.test(body) && /^\s*dialogue\s*:/im.test(body))
  const items = assLike ? parseAss(body) : parseSrtLike(body)
  items.sort((a, b) => a.from - b.from || a.to - b.to)
  return { format: assLike ? 'ass' : 'srt', items }
}
