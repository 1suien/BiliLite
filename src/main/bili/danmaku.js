/**
 * 弹幕 / 字幕 / 在线人数 / 发弹幕。
 *
 * 弹幕走的还是老接口 `x/v1/dm/list.so`（返回一段 XML，匿名就能拿），
 * 比 protobuf 的 `x/v2/dm/web/seg.so` 好解析；失败时退回 `comment.bilibili.com/<cid>.xml`。
 */
import { api, request, buildUrl, fixUrl } from './http.js'
import { store } from '../store.js'

const DM_LIST = 'https://api.bilibili.com/x/v1/dm/list.so'
const DM_XML_FALLBACK = 'https://comment.bilibili.com'
const DM_POST = 'https://api.bilibili.com/x/v2/dm/post'
const PLAYER_V2 = 'https://api.bilibili.com/x/player/v2'
const ONLINE_TOTAL = 'https://api.bilibili.com/x/player/online/total'

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name] !== undefined ? ENTITIES[name] : whole
  })
}

/** 解析弹幕 XML：`<d p="时间,模式,字号,颜色,...">内容</d>` */
export function parseDanmakuXml(xml, limit = 4000) {
  const items = []
  const re = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g
  let m
  while ((m = re.exec(xml))) {
    const parts = m[1].split(',')
    if (parts.length < 4) continue
    const time = Number(parts[0])
    const mode = Number(parts[1]) || 1
    const size = Number(parts[2]) || 25
    const color = Number(parts[3]) || 16777215
    const text = decodeEntities(m[2]).trim()
    if (!Number.isFinite(time) || !text) continue
    items.push({ time, mode, size, color, text })
    if (items.length >= limit) break
  }
  items.sort((a, b) => a.time - b.time)
  return items
}

/** 拉一段弹幕（segment_index 从 1 开始，每段 6 分钟） */
export async function fetchDanmaku(cid, segment = 1) {
  if (!cid) throw new Error('缺少 cid')
  const seg = Math.max(1, Math.floor(segment) || 1)
  const urls = [buildUrl(DM_LIST, { oid: cid, type: 1, segment_index: seg })]
  // 回退地址一次返回全部弹幕，只在第一段用，避免重复
  if (seg === 1) urls.push(`${DM_XML_FALLBACK}/${cid}.xml`)

  let lastErr = null
  for (const url of urls) {
    try {
      const res = await request(url, { timeout: 25000, headers: { Accept: 'text/xml,application/xml,*/*' } })
      const text = res.text || ''
      if (!/<d\s+p=/.test(text)) {
        if (res.json && res.json.code) {
          const err = new Error(res.json.message || '弹幕接口返回错误')
          err.biliCode = res.json.code
          throw err
        }
        return { items: [], count: 0, segment: seg, source: 'empty' }
      }
      const items = parseDanmakuXml(text)
      return { items, count: items.length, segment: seg, source: 'xml' }
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr || new Error('弹幕加载失败')
}

/** 同时在线人数（拿不到就当 0，不报错） */
export async function fetchOnlineTotal(bvid, cid) {
  if (!bvid || !cid) return { total: 0, count: 0 }
  try {
    const data = await api(ONLINE_TOTAL, { params: { bvid, cid } })
    const count = Number(data && data.count) || 0
    const total = Number(data && data.total) || count
    return { total, count }
  } catch {
    return { total: 0, count: 0 }
  }
}

/** 字幕列表 + 内容（未登录时多数视频为空） */
export async function fetchSubtitle(bvid, cid) {
  if (!bvid || !cid) return { list: [] }
  const data = await api(PLAYER_V2, { params: { bvid, cid } })
  const subs = (data && data.subtitle && data.subtitle.subtitles) || []
  const list = []
  for (const s of subs.slice(0, 5)) {
    const url = fixUrl(s.subtitle_url)
    if (!url) continue
    try {
      const res = await request(url, { timeout: 15000 })
      const body = res.json || {}
      const items = ((body && body.body) || [])
        .map((x) => ({
          from: Number(x.from) || 0,
          to: Number(x.to) || 0,
          content: decodeEntities(String(x.content || '')).trim()
        }))
        .filter((x) => x.content)
      if (items.length) list.push({ lan: s.lan, lanDoc: s.lan_doc || s.lan, items })
    } catch {
      /* 单个字幕失败就跳过 */
    }
  }
  return { list }
}

/** 发一条弹幕（需要登录，用 bili_jct 做 csrf） */
export async function sendDanmaku({ bvid, cid, msg, progress, mode = 1, color = 16777215, fontsize = 25 }) {
  const csrf = store.state.cookies && store.state.cookies.bili_jct
  if (!csrf) {
    const err = new Error('发送弹幕需要先登录')
    err.needLogin = true
    throw err
  }
  const text = String(msg || '').trim()
  if (!text) throw new Error('弹幕内容不能为空')
  if (text.length > 100) throw new Error('弹幕最多 100 个字')
  const form = new URLSearchParams({
    bvid: bvid || '',
    oid: String(cid || ''),
    type: '1',
    mode: String(mode),
    msg: text,
    progress: String(Math.max(0, Math.round(Number(progress) || 0))),
    color: String(color),
    fontsize: String(fontsize),
    pool: '0',
    rnd: String(Math.floor(Date.now() / 1000)),
    csrf: String(csrf)
  })
  const res = await request(DM_POST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    timeout: 15000
  })
  const json = res.json
  if (!json) throw new Error(`弹幕接口返回非 JSON（HTTP ${res.status}）`)
  if (json.code !== 0) {
    const err = new Error(json.message || `发送失败（code ${json.code}）`)
    err.biliCode = json.code
    if (json.code === -101 || json.code === -400) err.needLogin = true
    throw err
  }
  return json.data || {}
}
