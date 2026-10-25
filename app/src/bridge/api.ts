/**
 * B 站接口层（各业务接口 + 字段映射/裁剪）
 *
 * 还原自 reference/decompiled/js/index-jTHZJced.js（变量名 -> 语义后逐一对应）：
 *  - 1155-1268 行：登录（buvid / nav / 二维码 generate+poll / 恢复登录态 / 退出）
 *  - 1312-1442 行：视频详情 `bn/yn`、分 P `vn`、相关推荐 `En`、playurl `_n`（DASH 组装）
 *  - 1443-1521 行：搜索（视频 `Ln/Sn`、UP 主 `Ge`）
 *  - 1522-1581 行：首页推荐 `Tn`（rcmd）与热门/排行榜兜底 `Je`、卡片映射 `ce`
 *  - 1582-1657 行：收藏夹（`fe` 登录校验 / `Ye` / `Rn` 我创建的 / `Dn` 我收藏的 / `$n` 内容列表）
 *  - 1658-1849 行：UP 主（`Xe` 名片、`Hn` APP 投稿接口、`zn` web 投稿接口、`Qe` 合并、
 *                        `Jn` 最新投稿批量拉取、`pe/Gn` 时长换算、`Wn` APP 接口签名）
 *  - 1850-1906 行：关注列表 `Yn`、UP 解析 `Xn`
 *  - 1907-2062 行：弹幕 XML 解析 `ir/Ze`、拉取 `or`、在线人数 `sr`、字幕 `cr`、发弹幕 `lr`
 *
 * 约定：所有导出函数失败时抛 Error（由 handler 层统一加 needLogin / biliCode 标记）。
 */
import { buildUrl, biliError, getData, request } from './http'
import { state } from './state'
import { clearWbiCache, encWbi, md5Hex } from './wbi'
import type {
  DanmakuItem,
  FavFolder,
  FavResource,
  PlayUrl,
  SubtitleCue,
  SubtitleTrack,
  UpCardInfo,
  User,
  VideoCard,
  VideoDetail,
  VideoPage,
} from '@/types'

// ---------------------------------------------------------------------------
// 接口地址常量（逐字还原）
// ---------------------------------------------------------------------------

const VIEW_URL = 'https://api.bilibili.com/x/web-interface/view'
const PAGELIST_URL = 'https://api.bilibili.com/x/player/pagelist'
const PLAYURL_URL = 'https://api.bilibili.com/x/player/wbi/playurl'
const RELATED_URL = 'https://api.bilibili.com/x/web-interface/archive/related'
/** playurl 的 fnval：4048 = DASH + HDR + 4K + 杜比音频 + 杜比视界 + 8K + AV1 */
const FNVAL_ALL = 4048

const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/wbi/search/type'
const SEARCH_ORDER = new Set(['totalrank', 'click', 'pubdate', 'dm', 'stow'])

const RCMD_URL = 'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd'
const RANKING_URL = 'https://api.bilibili.com/x/web-interface/ranking/v2'
const POPULAR_URL = 'https://api.bilibili.com/x/web-interface/popular'

const FAV_CREATED_URL = 'https://api.bilibili.com/x/v3/fav/folder/created/list-all'
const FAV_COLLECTED_URL = 'https://api.bilibili.com/x/v3/fav/folder/collected/list'
const FAV_RESOURCE_URL = 'https://api.bilibili.com/x/v3/fav/resource/list'

const SPACE_SEARCH_URL = 'https://api.bilibili.com/x/space/wbi/arc/search'
const CARD_URL = 'https://api.bilibili.com/x/web-interface/card'
const FOLLOWINGS_URL = 'https://api.bilibili.com/x/relation/followings'
const APP_SPACE_URL = 'https://app.bilibili.com/x/v2/space/archive'

/** APP 接口（appkey 签名）用的 key/secret，与原构建一致（B 站安卓客户端公开值） */
const APP_KEY = '1d8b6e7d45233436'
const APP_SECRET = '560c52ccd288fed045859ed18bffd973'
/** APP 投稿接口要装成安卓客户端，否则会被风控 */
const APP_UA =
  'Mozilla/5.0 BiliDroid/8.0.0 (bbcallen@gmail.com) os/android model/Pixel mobi_app/android build/8000300 channel/bili innerVer/8000300 osVer/13'

/** 最新投稿缓存 / 有效期 5 分钟 / 并发数 4 */
const LATEST_CACHE = new Map<string, { at: number; perUp: number; items: any[] }>()
const LATEST_TTL = 5 * 60 * 1000
const LATEST_CONCURRENCY = 4

const DM_LIST_URL = 'https://api.bilibili.com/x/v1/dm/list.so'
const DM_COMMENT_BASE = 'https://comment.bilibili.com'
const DM_POST_URL = 'https://api.bilibili.com/x/v2/dm/post'
const PLAYER_WBI_URL = 'https://api.bilibili.com/x/player/wbi/v2'
const PLAYER_URL = 'https://api.bilibili.com/x/player/v2'
const ONLINE_URL = 'https://api.bilibili.com/x/player/online/total'

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'
const BUVID_URL = 'https://api.bilibili.com/x/frontend/finger/spi'
const QR_GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
const QR_POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
const LOGOUT_URL = 'https://passport.bilibili.com/login/exit/v2'

/** 二维码轮询 code -> 语义（原构建 `on`） */
const QR_STATUS: Record<number, 'success' | 'expired' | 'scanned' | 'waiting'> = {
  0: 'success',
  86038: 'expired',
  86090: 'scanned',
  86101: 'waiting',
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/**
 * 图片地址修正：还原 `b()`
 * `//i0.hdslb.com/...` -> `https://...`；http 也升级成 https。
 */
export function fixImageUrl(url?: string | null): string {
  if (!url) return ''
  if (url.startsWith('//')) return 'https:' + url
  if (url.startsWith('http://')) return 'https://' + url.slice(7)
  return url
}

/** 搜索结果里的 HTML 实体与标签清理：还原 `X()` */
export function stripTags(text?: string | null): string {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
}

/** XML/HTML 实体表：还原 `Te` */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** 弹幕/字幕文本的实体解码（支持 &#123; 与 &#x1F600;）：还原 `Ze()` */
export function decodeEntities(text: string): string {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : all
    }
    return ENTITIES[name] !== undefined ? ENTITIES[name] : all
  })
}

/** "12:34" / "1:02:03" / 秒数 -> 秒：还原 `pe()` */
function parseClock(value: any): number {
  const parts = String(value || '')
    .split(':')
    .map((x) => Number(x) || 0)
  if (parts.length >= 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] || 0
}

/** 秒 -> "mm:ss" / "h:mm:ss"：还原 `Gn()` */
function secToClock(value: any): string {
  const total = Math.max(0, Math.floor(Number(value) || 0))
  const pad = (x: number) => String(x).padStart(2, '0')
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/**
 * 视频卡片的兼容别名
 *
 * 原实现用 `play` / `author` / `upper` 这类字段名，渲染层 types.ts 的 VideoCard 用
 * `view` / `upName`。这里两个名字都写一份（不删原字段），保证两种写法都能取到值。
 */
function withCardAliases<T extends Record<string, any>>(card: T): T {
  const out: any = { ...card }
  if (out.view == null && out.play != null) out.view = out.play
  if (out.upName == null && out.author) out.upName = out.author
  if (out.upName == null && out.upper) out.upName = out.upper
  if (out.upMid == null && out.mid != null) out.upMid = out.mid
  if (out.upMid == null && out.upperMid != null) out.upMid = out.upperMid
  if (out.danmaku == null && out.comment != null) out.danmaku = out.comment
  return out as T
}

// ---------------------------------------------------------------------------
// 登录：buvid / nav / 二维码 / 恢复 / 退出
// ---------------------------------------------------------------------------

/**
 * 取 buvid3（并顺手写 buvid4）：还原 `q()`
 *
 * 新设备没有 buvid 时很多接口会 412 风控，所以每次启动/搜索前都会确保拿到。
 * force = true 时强制重取（遇到 -352/-412 时用）。
 */
export async function getBuvid(force = false): Promise<string> {
  if (!force && state.cookies.buvid3) return state.cookies.buvid3
  try {
    const data = await getData<any>(BUVID_URL)
    if (data) {
      if (data.b_3) state.cookies.buvid3 = data.b_3
      if (data.b_4) state.cookies.buvid4 = data.b_4
      state.persist()
    }
  } catch (e: any) {
    console.warn('[auth] buvid 获取失败：', e && e.message)
  }
  return state.cookies.buvid3 || ''
}

/** nav 接口返回的 data -> 渲染层 User：还原 `Xt()` */
function mapUser(raw: any): User {
  return {
    mid: raw && raw.mid,
    uname: raw && raw.uname,
    face: fixImageUrl(raw && raw.face),
    level: (raw && raw.level_info && raw.level_info.current_level) || 0,
    coins: (raw && raw.money) || 0,
    vip: (raw && raw.vipStatus) === 1,
  }
}

/**
 * 判定 nav 接口的登录态：还原 `Yt()`
 *
 * - code 0 + data.isLogin：已登录（user）
 * - code -101 或 code 0 + isLogin === false：游客（guest）
 * - 其他（网络/风控）：transient，保留本地登录态，提示稍后重试
 */
function classifyLogin(
  payload: any,
  httpStatus = 200,
): { kind: 'user'; data: any } | { kind: 'guest' } | { kind: 'transient'; code?: number; message: string } {
  const code = payload && typeof payload.code === 'number' ? payload.code : undefined
  const data = payload && payload.data
  if (code === 0 && data && data.isLogin) return { kind: 'user', data }
  if (code === -101 || (code === 0 && data && data.isLogin === false)) return { kind: 'guest' }
  const message =
    (payload && payload.message) || `登录态校验失败（code ${code === undefined ? httpStatus : code}）`
  return { kind: 'transient', code, message }
}

/**
 * 拉一次 nav 拿用户信息：还原 `ze()`
 *
 * 返回 null 表示游客；transient 错误会抛 Error（带 `transient` 标记）。
 */
export async function fetchNavUser(): Promise<User | null> {
  const res = await request(NAV_URL)
  const kind = classifyLogin(res.json || {}, res.status)
  if (kind.kind === 'user') return mapUser(kind.data)
  if (kind.kind === 'guest') return null
  throw biliError(kind.message, { transient: true, biliCode: kind.code })
}

/** 从扫码成功返回的 url 的 query 里提取登录 Cookie：还原 `nn()` */
function applyLoginCookies(url?: string | null): void {
  if (!url) return
  try {
    const parsed = new URL(url)
    for (const key of ['DedeUserID', 'DedeUserID__ckMd5', 'SESSDATA', 'bili_jct']) {
      const value = parsed.searchParams.get(key)
      if (value) state.cookies[key] = value
    }
    state.persist()
  } catch {
    // url 不是合法地址：忽略（登录本身已经成功）
  }
}

/** 生成登录二维码：还原 `rn()` */
export async function qrGenerate(): Promise<{ url: string; qrcodeKey: string }> {
  await getBuvid()
  const data = await getData<any>(QR_GENERATE_URL)
  return { url: data.url, qrcodeKey: data.qrcode_key }
}

/**
 * 轮询扫码结果：还原 `sn()`
 *
 * 成功后从返回 url 里拿 4 个 Cookie，再调 nav 补用户信息（nav 失败不影响登录）。
 */
export async function qrPoll(key: string): Promise<{
  status: 'waiting' | 'scanned' | 'expired' | 'success' | 'error'
  message?: string
  user?: User | null
}> {
  const res = await request(QR_POLL_URL, {
    params: { qrcode_key: key, source: 'main-fe-header' },
    timeout: 12000,
  })
  const payload = res.json || {}
  const data = payload.data || {}
  const status = QR_STATUS[data.code] || 'error'

  if (status === 'success') {
    applyLoginCookies(data.url)
    let user: User | null = null
    try {
      user = await fetchNavUser()
    } catch (e: any) {
      console.warn('[auth] 登录后校验暂失败（登录仍有效）：', e && e.message)
    }
    if (user) state.setUser(user)
    return { status: 'success', user: user || state.user || null }
  }

  return { status, message: data.message || payload.message || '' }
}

/**
 * 恢复登录态：还原 `an()`
 *
 * 本地有 SESSDATA/user 时才校验；最多试 2 次（第一次失败等 600ms 重试），
 * 两次都失败时保留登录态并标记 stale（弱网/风控不想把用户踢下线）。
 */
export async function restoreSession(): Promise<{
  loggedIn: boolean
  user: User | null
  stale?: boolean
  message?: string
}> {
  await getBuvid()
  if (!state.isLoggedIn()) return { loggedIn: false, user: null }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const user = await fetchNavUser()
      if (user) {
        state.setUser(user)
        return { loggedIn: true, user }
      }
      state.clearAuth()
      return { loggedIn: false, user: null }
    } catch (e: any) {
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 600))
        continue
      }
      console.warn('[auth] 登录态校验失败，保留登录：', e && e.message)
      return { loggedIn: true, user: state.user || null, stale: true, message: e && e.message }
    }
  }
  return { loggedIn: true, user: state.user || null, stale: true }
}

/** 退出登录（先尽力通知服务端，再清本地）：还原 `cn()` */
export async function logoutSession(): Promise<{ loggedIn: boolean }> {
  try {
    if (state.cookies.bili_jct) {
      await request(LOGOUT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `biliCSRF=${encodeURIComponent(state.cookies.bili_jct)}`,
      })
    }
  } catch (e: any) {
    console.warn('[auth] 退出接口失败（忽略）：', e && e.message)
  }
  state.clearAuth()
  return { loggedIn: false }
}

// ---------------------------------------------------------------------------
// 视频：详情 / 分 P / 相关推荐 / 播放地址
// ---------------------------------------------------------------------------

/** 详情接口返回 -> VideoDetail：还原 `bn()` */
function mapVideoDetail(data: any): any {
  const pages = (data.pages || []).map((p: any) => ({
    cid: p.cid,
    page: p.page,
    part: p.part,
    title: p.part || p.title || `P${p.page}`,
    duration: p.duration,
  }))
  return {
    aid: data.aid,
    bvid: data.bvid,
    cid: data.cid,
    title: data.title,
    desc: data.desc || '',
    cover: fixImageUrl(data.pic),
    pubdate: data.pubdate,
    duration: data.duration,
    tname: data.tname || '',
    owner: {
      mid: data.owner && data.owner.mid,
      name: (data.owner && data.owner.name) || '',
      face: fixImageUrl(data.owner && data.owner.face),
    },
    stat: {
      view: (data.stat && data.stat.view) || 0,
      danmaku: (data.stat && data.stat.danmaku) || 0,
      like: (data.stat && data.stat.like) || 0,
      coin: (data.stat && data.stat.coin) || 0,
      favorite: (data.stat && data.stat.favorite) || 0,
      reply: (data.stat && data.stat.reply) || 0,
    },
    // 没有 pages 时用主 cid 兜底，保证播放器至少有一个分 P
    pages: pages.length
      ? pages
      : [
          {
            cid: data.cid,
            page: 1,
            part: data.title,
            title: data.title,
            duration: data.duration,
          },
        ],
  }
}

/** 视频详情：还原 `yn()` */
export async function viewVideo(bvid: string): Promise<VideoDetail> {
  const data = await getData<any>(VIEW_URL, { params: { bvid } })
  return mapVideoDetail(data)
}

/** 分 P 列表：还原 `vn()` */
export async function videoPages(bvid: string): Promise<VideoPage[]> {
  const list = (await getData<any[]>(PAGELIST_URL, { params: { bvid } })) || []
  return list.map((p: any) => ({
    cid: p.cid,
    page: p.page,
    part: p.part,
    title: p.part || p.title || `P${p.page}`,
    duration: p.duration,
  }))
}

/**
 * 相关推荐：还原 `En()`
 * 注意原实现这里映射的是 `play`（不是 view），保留原字段名。
 */
export async function videoRelated(bvid: string): Promise<VideoCard[]> {
  const list = (await getData<any[]>(RELATED_URL, { params: { bvid } })) || []
  return list.map((item: any) =>
    withCardAliases({
      bvid: item.bvid,
      title: item.title,
      cover: fixImageUrl(item.pic),
      upName: item.owner && item.owner.name,
      upMid: item.owner && item.owner.mid,
      play: (item.stat && item.stat.view) || 0,
      duration: item.duration,
      pubdate: item.pubdate,
    }),
  )
}

/** 播放地址数组过滤：只保留有 url 的项：还原 `ke()` */
function pickStreams(list: any, mapper: (item: any) => any): any[] {
  return Array.isArray(list) ? list.map(mapper).filter((item) => item.url) : []
}

/**
 * 播放地址（DASH 优先）：还原 `_n()`
 *
 * 参数：qn 清晰度（默认 80 = 1080P），fnval 4048 让服务端返回 DASH，
 * 同时还要 fnver=0 / fourk=1 / platform=pc / high_quality=1 才会给高码率。
 * 返回结构保持原样（mode/dash.video/dash.audio/durl），并附加一份
 * types.ts 里的 videos/audios 别名。
 */
export async function videoPlayurl(bvid: string, cid: any, qn = 80): Promise<PlayUrl> {
  const params = await encWbi({
    bvid,
    cid,
    qn,
    fnver: 0,
    fnval: FNVAL_ALL,
    fourk: 1,
    platform: 'pc',
    high_quality: 1,
  })
  const data = await getData<any>(PLAYURL_URL, { params })
  const dash = data.dash

  const result: any = {
    mode: dash ? 'dash' : 'durl',
    quality: data.quality,
    acceptQuality: data.accept_quality || [],
    acceptDescription: data.accept_description || [],
    supportFormats: (data.support_formats || []).map((f: any) => ({
      quality: f.quality,
      label: f.new_description || f.display_desc || f.format,
      codecs: f.codecs,
    })),
    dash: dash
      ? {
          duration: dash.duration,
          video: pickStreams(dash.video, (v: any) => {
            const url = fixImageUrl(v.baseUrl || v.base_url)
            const backup = (v.backupUrl || v.backup_url || []).map(fixImageUrl)
            // url/backup 是原实现字段；baseUrl/backupUrl 是 types.ts 的字段名
            return {
              id: v.id,
              url,
              baseUrl: url,
              backup,
              backupUrl: backup,
              codecs: v.codecs,
              mimeType: v.mimeType || 'video/mp4',
              width: v.width,
              height: v.height,
              bandwidth: v.bandwidth,
              frameRate: v.frameRate,
            }
          }),
          audio: pickStreams(dash.audio, (a: any) => {
            const url = fixImageUrl(a.baseUrl || a.base_url)
            const backup = (a.backupUrl || a.backup_url || []).map(fixImageUrl)
            return {
              id: a.id,
              url,
              baseUrl: url,
              backup,
              backupUrl: backup,
              codecs: a.codecs,
              mimeType: a.mimeType || 'audio/mp4',
              bandwidth: a.bandwidth,
            }
          }),
        }
      : null,
    durl: (data.durl || []).map((d: any) => ({
      url: fixImageUrl(d.url),
      backup: (d.backup_url || []).map(fixImageUrl),
      size: d.size,
      length: d.length,
    })),
  }

  // —— 兼容别名（渲染层 types.ts 的 PlayUrl 用 videos/audios/duration）——
  result.videos = result.dash ? result.dash.video : []
  result.audios = result.dash ? result.dash.audio : []
  result.duration = result.dash ? result.dash.duration : result.durl[0] && result.durl[0].length
  result.url = result.durl[0] && result.durl[0].url
  return result as PlayUrl
}

// ---------------------------------------------------------------------------
// 搜索：视频 / UP 主
// ---------------------------------------------------------------------------

/** 搜索视频卡片映射：还原 `Sn()` */
function mapSearchVideo(item: any): any {
  return withCardAliases({
    bvid: item.bvid,
    aid: item.aid,
    title: stripTags(item.title),
    cover: fixImageUrl(item.pic),
    upName: item.author,
    upMid: item.mid,
    play: item.play,
    danmaku: item.video_review,
    duration: item.duration,
    pubdate: item.pubdate,
    tag: stripTags(item.tag),
  })
}

/**
 * 搜索视频：还原 `Ln()`
 *
 * order 只允许 totalrank/click/pubdate/dm/stow（原实现用 Set 过滤）。
 * 遇到 -403（WBI 密钥过期）会清缓存重签一次。
 */
export async function searchVideos(
  keyword: string,
  page = 1,
  order = 'totalrank',
): Promise<any> {
  await getBuvid()
  const params = {
    search_type: 'video',
    keyword,
    page,
    page_size: 30,
    order: SEARCH_ORDER.has(order) ? order : 'totalrank',
  }

  let data: any
  try {
    data = await getData<any>(SEARCH_URL, { params: await encWbi(params) })
  } catch (e: any) {
    if (e.biliCode === -403) {
      clearWbiCache()
      data = await getData<any>(SEARCH_URL, { params: await encWbi(params) })
    } else {
      throw e
    }
  }

  const items = (data.result || []).filter((item: any) => item.bvid).map(mapSearchVideo)
  return {
    keyword,
    page,
    pages: data.numPages || 1,
    total: data.numResults || items.length,
    items,
  }
}

/** 搜索 UP 主：还原 `Ge()` */
export async function searchUps(keyword: string, page = 1): Promise<any> {
  await getBuvid()
  const data = await getData<any>(SEARCH_URL, {
    params: await encWbi({
      search_type: 'bili_user',
      keyword,
      page,
      page_size: 20,
    }),
  })
  const items = (data.result || []).map((item: any) => ({
    mid: item.mid,
    name: stripTags(item.uname),
    face: fixImageUrl(item.upic),
    fans: item.fans,
    videos: item.videos,
    sign: stripTags(item.usign),
    level: item.level,
  }))
  return {
    keyword,
    page,
    pages: data.numPages || 1,
    total: data.numResults || items.length,
    items,
  }
}

// ---------------------------------------------------------------------------
// 首页：推荐 / 热门 / 排行榜
// ---------------------------------------------------------------------------

/** 通用视频卡片映射（推荐/热门/排行榜共用）：还原 `ce()` */
function mapFeedCard(item: any): any {
  const owner = item.owner || {}
  const stat = item.stat || {}
  return withCardAliases({
    bvid: item.bvid,
    aid: item.aid,
    cid: item.cid,
    title: item.title,
    cover: fixImageUrl(item.pic),
    upName: owner.name || item.author,
    upMid: owner.mid || item.mid,
    play: stat.view != null ? stat.view : item.play,
    danmaku: stat.danmaku != null ? stat.danmaku : item.video_review,
    duration: item.duration,
    pubdate: item.pubdate,
    reason: item.rcmd_reason && item.rcmd_reason.content,
  })
}

/**
 * 首页推荐：还原 `Tn()`
 *
 * 先走推荐接口（ps=12，需要 WBI 签名 + buvid）；推荐挂掉（-403 风控）
 * 就清 WBI 缓存并退回热门/排行榜，保证首页永远有内容。
 */
export async function homeFeed(page = 1): Promise<any> {
  await getBuvid()
  const params = {
    web_location: 1430650,
    feed_version: 'V8',
    fresh_type: 4,
    ps: 12,
    fresh_idx: page,
    fresh_idx_1h: page,
    fetch_row: page,
  }
  try {
    const data = await getData<any>(RCMD_URL, { params: await encWbi(params) })
    const items = (data.item || []).filter((item: any) => item.bvid).map(mapFeedCard)
    if (items.length) return { source: 'recommend', items }
  } catch (e: any) {
    if (e.biliCode === -403) clearWbiCache()
  }
  return homePopular(page)
}

/** 热门 / 排行榜兜底：还原 `Je()` */
export async function homePopular(page = 1): Promise<any> {
  try {
    const data = await getData<any>(POPULAR_URL, {
      params: { pn: page, ps: 20, web_location: 333.934 },
    })
    return { source: 'popular', items: (data.list || []).map(mapFeedCard) }
  } catch {
    const data = await getData<any>(RANKING_URL, { params: { rid: 0, type: 'all' } })
    return { source: 'ranking', items: (data.list || []).map(mapFeedCard) }
  }
}

// ---------------------------------------------------------------------------
// 收藏夹
// ---------------------------------------------------------------------------

/** 收藏功能前置校验：没登录直接抛 needLogin：还原 `fe()` */
function requireLoginForFav(): User {
  const user = state.user
  if (!user || !state.isLoggedIn()) {
    throw biliError('请先扫码登录后再使用收藏功能', { needLogin: true })
  }
  return user
}

/** 收藏夹条目映射：还原 `Ye()` */
function mapFavFolder(item: any): any {
  return {
    id: item.id,
    fid: item.fid,
    mid: item.mid,
    title: item.title,
    cover: fixImageUrl(item.cover),
    mediaCount: item.media_count,
    media_count: item.media_count,
    attr: item.attr,
    isDefault: item.id === item.mid,
  }
}

/** 我创建的收藏夹：还原 `Rn()` */
async function favCreated(): Promise<any[]> {
  const user = requireLoginForFav()
  const data = await getData<any>(FAV_CREATED_URL, {
    params: { up_mid: user.mid, web_location: 333.1387 },
  })
  return ((data && data.list) || []).map(mapFavFolder)
}

/** 我收藏的（别人创建的）收藏夹：还原 `Dn()` */
async function favCollected(): Promise<any[]> {
  const user = requireLoginForFav()
  const data = await getData<any>(FAV_COLLECTED_URL, {
    params: { up_mid: user.mid, pn: 1, ps: 20, web_location: 333.1387 },
  })
  return ((data && data.list) || []).map(mapFavFolder)
}

/** 收藏夹列表（创建 + 收藏）：还原 handler `fav:folders` */
export async function favFolders(): Promise<{ created: FavFolder[]; collected: FavFolder[] }> {
  return { created: await favCreated(), collected: await favCollected() }
}

/**
 * 收藏夹内容：还原 `$n()`
 *
 * 原实现返回 {info, hasMore, medias}；这里额外挂一个 items（同 medias），
 * 方便按 types.ts 的 `Paged<FavResource>` 写法读取。
 */
export async function favResources(mediaId: any, pn = 1, ps = 20): Promise<any> {
  requireLoginForFav()
  const data = await getData<any>(FAV_RESOURCE_URL, {
    params: {
      media_id: mediaId,
      pn,
      ps,
      keyword: '',
      order: 'mtime',
      type: 0,
      tid: 0,
      platform: 'web',
    },
  })
  const info = data.info || {}
  const medias = (data.medias || []).map((item: any) => {
    const card: any = {
      id: item.id,
      bvid: item.bvid,
      aid: item.id,
      title: item.title,
      cover: fixImageUrl(item.cover),
      intro: item.intro,
      duration: item.duration,
      upper: item.upper && item.upper.name,
      upperMid: item.upper && item.upper.mid,
      favTime: item.fav_time,
      pubtime: item.pubtime,
      cntInfo: item.cnt_info || {},
    }
    // 兼容别名：types.ts 的 FavResource 用 upName/upMid/pubdate/view
    card.upName = card.upper
    card.upMid = card.upperMid
    card.pubdate = card.pubtime
    card.view = card.cntInfo.play
    return card
  })
  return {
    info: {
      id: info.id,
      title: info.title,
      mediaCount: info.media_count,
      media_count: info.media_count,
      cover: fixImageUrl(info.cover),
    },
    hasMore: !!data.has_more,
    medias,
    items: medias,
    page: pn,
    total: info.media_count || medias.length,
  }
}

// ---------------------------------------------------------------------------
// UP 主
// ---------------------------------------------------------------------------

/** UP 名片：还原 `Xe()` */
export async function upInfo(mid: any): Promise<UpCardInfo> {
  const data = await getData<any>(CARD_URL, { params: { mid, photo: false } })
  const card = data.card || {}
  const info: any = {
    mid: card.mid,
    name: card.name,
    face: fixImageUrl(card.face),
    fans: card.fans,
    sign: card.sign,
    // 原实现给的是等级；types.ts 用 archives 表示投稿数，两个都带上
    level: card.level_info && card.level_info.current_level,
    videos: card.videos,
    archives: card.videos,
  }
  return info as UpCardInfo
}

/** APP 接口签名（appkey + ts + md5(secret)）：还原 `Wn()` */
function signAppParams(params: Record<string, any>): Record<string, any> {
  const withMeta = { ...params, appkey: APP_KEY, ts: Math.round(Date.now() / 1000) }
  const query = Object.keys(withMeta)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(withMeta[key])}`)
    .join('&')
  return { ...withMeta, sign: md5Hex(query + APP_SECRET) }
}

/** APP 投稿接口：还原 `Hn()`（比 web 接口稳，不需要 WBI） */
async function upVideosApp(mid: any, pn = 1, ps = 30, keyword = ''): Promise<any> {
  const params: Record<string, any> = {
    vmid: mid,
    pn,
    ps,
    order: 'pubdate',
    mobi_app: 'android',
    platform: 'android',
    build: 8000300,
    device: 'phone',
  }
  if (keyword) params.keyword = keyword

  const data = await getData<any>(APP_SPACE_URL, {
    params: signAppParams(params),
    headers: { 'User-Agent': APP_UA, Referer: 'https://app.bilibili.com/' },
  })
  const list = data.item || []
  return {
    source: 'app',
    page: { count: data.count || 0, pn, ps },
    items: list.map((item: any) => {
      const aid = item.param ? Number(item.param) : item.aid
      const duration = item.duration || parseClock(item.length)
      return withCardAliases({
        bvid: item.bvid,
        aid,
        cid: item.first_cid || null,
        title: item.title,
        cover: fixImageUrl(item.cover),
        play: item.play,
        comment: item.danmaku,
        pubdate: item.ctime,
        length: item.length || secToClock(duration),
        duration,
        description: item.desc || '',
      })
    }),
  }
}

/** Web 投稿接口（WBI）：还原 `zn()`，遇 -352/-412 重取 buvid，-403 重签一次 */
async function upVideosWeb(mid: any, pn = 1, ps = 30, keyword = ''): Promise<any> {
  const params = {
    mid,
    pn,
    ps,
    tid: 0,
    keyword,
    order: 'pubdate',
    platform: 'web',
    web_location: 1550101,
    order_avoided: true,
  }

  let data: any
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      data = await getData<any>(SPACE_SEARCH_URL, { params: await encWbi(params) })
      break
    } catch (e: any) {
      const code = e && e.biliCode
      if (attempt === 0 && (code === -352 || code === -412)) {
        await getBuvid(true)
        await new Promise((resolve) => setTimeout(resolve, 600))
        continue
      }
      if (attempt === 0 && code === -403) {
        clearWbiCache()
        await new Promise((resolve) => setTimeout(resolve, 300))
        continue
      }
      throw e
    }
  }

  const list = (data.list && data.list.vlist) || []
  return {
    source: 'web',
    page: data.page || {},
    items: list.map((item: any) =>
      withCardAliases({
        bvid: item.bvid,
        aid: item.aid,
        cid: null,
        title: item.title,
        cover: fixImageUrl(item.pic),
        play: item.play,
        comment: item.comment,
        pubdate: item.created,
        length: item.length,
        duration: parseClock(item.length),
        description: item.description,
      }),
    ),
  }
}

/**
 * UP 投稿列表：还原 `Qe()`
 * 有搜索词时只能走 web 接口；否则先试 APP 接口，失败再退 web（并优先报 APP 的错误）。
 */
export async function upVideos(mid: any, pn = 1, ps = 30, keyword = ''): Promise<any> {
  let appError: any = null
  if (!keyword) {
    try {
      return await upVideosApp(mid, pn, ps, keyword)
    } catch (e) {
      appError = e
    }
  }
  try {
    return await upVideosWeb(mid, pn, ps, keyword)
  } catch (e) {
    throw appError || e
  }
}

/**
 * 批量拉多个 UP 的最新投稿（UP 管理页用）：还原 `Jn()`
 *
 * - mids 去重、转字符串、最多 60 个；perUp 限制 1~12（默认 2）
 * - 5 分钟内、且缓存时的 perUp >= 本次 perUp 时直接用缓存
 * - 4 个并发worker 抢队列，单个 UP 失败只记 errors，不影响整体
 */
export async function upLatest(
  mids: (string | number)[],
  perUp = 2,
  opts: { cache?: boolean } = {},
): Promise<any> {
  const ids = [...new Set((Array.isArray(mids) ? mids : []).map(String).filter(Boolean))].slice(0, 60)
  const count = Math.max(1, Math.min(Number(perUp) || 2, 12))
  const useCache = opts.cache !== false
  const items: any[] = []
  const errors: { mid: string; message: string }[] = []
  let cursor = 0

  async function fetchOne(mid: string): Promise<any[]> {
    const cached = LATEST_CACHE.get(mid)
    if (useCache && cached && Date.now() - cached.at < LATEST_TTL && cached.perUp >= count) {
      return cached.items
    }
    const result = await upVideos(mid, 1, count)
    const list = (result.items || []).map((item: any) => ({
      bvid: item.bvid,
      aid: item.aid,
      title: item.title,
      cover: item.cover,
      play: item.play,
      pubdate: item.pubdate,
      duration: item.duration || parseClock(item.length),
      upMid: Number(mid),
    }))
    LATEST_CACHE.set(mid, { at: Date.now(), perUp: count, items: list })
    return list
  }

  async function worker(): Promise<void> {
    while (cursor < ids.length) {
      const mid = ids[cursor]
      cursor += 1
      try {
        const list = await fetchOne(mid)
        for (const item of list) items.push(item)
      } catch (e: any) {
        errors.push({ mid, message: (e && e.message) || String(e) })
      }
    }
  }

  const workers = Math.min(LATEST_CONCURRENCY, ids.length)
  await Promise.all(Array.from({ length: workers }, worker))
  items.sort((a, b) => (b.pubdate || 0) - (a.pubdate || 0))
  return { items, errors, total: ids.length, fetchedAt: Date.now() }
}

/**
 * 关注列表（导入用）：还原 `Yn()`
 * 未登录直接抛 needLogin；-403/-352 时去掉 WBI 参数重试一次。
 */
export async function upFollowings(mid: any, pn = 1, ps = 50): Promise<any> {
  if (!mid) {
    throw biliError('需要先扫码登录才能导入 B 站关注列表', { needLogin: true })
  }
  const params = {
    vmid: String(mid),
    pn,
    ps,
    order: 'desc',
    order_type: 'attention',
  }

  let data: any
  try {
    data = await getData<any>(FOLLOWINGS_URL, { params: await encWbi(params) })
  } catch (e: any) {
    if (e.biliCode === -403 || e.biliCode === -352) {
      data = await getData<any>(FOLLOWINGS_URL, { params })
    } else {
      throw e
    }
  }

  const list = data.list || []
  return {
    page: pn,
    total: data.total || list.length,
    items: list.map((item: any) => ({
      mid: item.mid,
      name: item.uname,
      uname: item.uname,
      face: fixImageUrl(item.face),
      sign: item.sign,
      fans: item.fans,
      official: (item.official_verify && item.official_verify.desc) || '',
    })),
  }
}

/**
 * 把「UID / 空间链接 / 昵称」解析成 UP 主：还原 `Xn()`
 * 优先按 mid 查名片；查不到再用搜索的第一个结果。
 */
export async function upResolve(query: string): Promise<any> {
  const text = String(query || '').trim()
  if (!text) throw new Error('请输入 UP 主的 UID、空间主页链接或昵称')

  const bySpace = /space\.bilibili\.com\/(\d+)/.exec(text)
  const mid = bySpace ? bySpace[1] : /^\d{1,12}$/.test(text) ? text : ''

  if (mid) {
    try {
      const info = await upInfo(mid)
      if (info && info.mid) return info
    } catch {
      // 名片接口失败：继续走搜索
    }
  }

  const found = await searchUps(text, 1)
  const first = found.items && found.items[0]
  if (!first) throw new Error('没有找到这个 UP 主，换个 UID 或昵称试试')
  return {
    mid: first.mid,
    name: first.name,
    face: first.face,
    fans: first.fans,
    sign: first.sign,
    level: first.level,
    videos: first.videos,
  }
}

// ---------------------------------------------------------------------------
// 弹幕 / 在线人数 / 字幕
// ---------------------------------------------------------------------------

/**
 * 解析弹幕 XML：还原 `ir()`
 *
 * `<d p="时间,模式,字号,颜色,...">文本</d>`，最多 4000 条，按时间排序。
 */
export function parseDanmakuXml(xml: string, limit = 4000): DanmakuItem[] {
  const items: DanmakuItem[] = []
  const re = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(xml))) {
    const parts = match[1].split(',')
    if (parts.length < 4) continue
    const time = Number(parts[0])
    const mode = Number(parts[1]) || 1
    const size = Number(parts[2]) || 25
    const color = Number(parts[3]) || 16777215
    const text = decodeEntities(match[2]).trim()
    if (!Number.isFinite(time) || !text) continue
    items.push({ time, mode, size, color, text })
    if (items.length >= limit) break
  }
  items.sort((a, b) => a.time - b.time)
  return items
}

/**
 * 拉弹幕：还原 `or()`
 *
 * 先走 `/x/v1/dm/list.so?oid=&type=1&segment_index=`，第 1 段失败再试
 * `comment.bilibili.com/{cid}.xml`。返回 {items,count,segment,source}。
 */
export async function videoDanmaku(
  cid: any,
  segment = 1,
): Promise<{ items: DanmakuItem[]; count: number; segment: number; source: string }> {
  if (!cid) throw new Error('缺少 cid')
  const index = Math.max(1, Math.floor(segment) || 1)
  const urls = [buildUrl(DM_LIST_URL, { oid: cid, type: 1, segment_index: index })]
  if (index === 1) urls.push(`${DM_COMMENT_BASE}/${cid}.xml`)

  let lastError: any = null
  for (const url of urls) {
    try {
      const res = await request(url, {
        timeout: 25000,
        headers: { Accept: 'text/xml,application/xml,*/*' },
      })
      const text = res.text || ''
      if (!/<d\s+p=/.test(text)) {
        // 不是弹幕 XML：可能是错误 JSON（比如视频不存在 / 需要登录）
        if (res.json && res.json.code) {
          throw biliError(res.json.message || '弹幕接口返回错误', { biliCode: res.json.code })
        }
        return { items: [], count: 0, segment: index, source: 'empty' }
      }
      const items = parseDanmakuXml(text)
      return { items, count: items.length, segment: index, source: 'xml' }
    } catch (e) {
      lastError = e
    }
  }
  throw lastError || new Error('弹幕加载失败')
}

/** 在线人数（同看人数）：还原 `sr()`，失败静默返回 0 */
export async function videoOnline(bvid: string, cid: any): Promise<{ total: number; count: number }> {
  if (!bvid || !cid) return { total: 0, count: 0 }
  try {
    const data = await getData<any>(ONLINE_URL, { params: { bvid, cid } })
    const count = Number(data && data.count) || 0
    return { total: Number(data && data.total) || count, count }
  } catch {
    return { total: 0, count: 0 }
  }
}

/** 播放器信息（含字幕列表）：还原 `ar()`，WBI 版失败退回老接口 */
async function playerInfo(bvid: string, cid: any): Promise<any> {
  try {
    const params = await encWbi({ bvid, cid })
    return await getData<any>(PLAYER_WBI_URL, { params })
  } catch {
    return await getData<any>(PLAYER_URL, { params: { bvid, cid } })
  }
}

/**
 * 字幕：还原 `cr()`
 *
 * 先拿播放器信息里的 subtitle.subtitles（最多 5 条），
 * 再逐条拉 JSON（body[] -> {from,to,content}），空字幕轨会被丢掉。
 */
export async function videoSubtitle(
  bvid: string,
  cid: any,
): Promise<{ list: SubtitleTrack[] }> {
  if (!bvid || !cid) return { list: [] }
  const info = await playerInfo(bvid, cid)
  const tracks = (info && info.subtitle && info.subtitle.subtitles) || []
  const list: SubtitleTrack[] = []

  for (const track of tracks.slice(0, 5)) {
    const url = fixImageUrl(track.subtitle_url)
    if (!url) continue
    try {
      const res = await request(url, { timeout: 15000 })
      const payload = res.json || {}
      const cues: SubtitleCue[] = ((payload && payload.body) || [])
        .map((cue: any) => ({
          from: Number(cue.from) || 0,
          to: Number(cue.to) || 0,
          content: decodeEntities(String(cue.content || '')).trim(),
        }))
        .filter((cue: SubtitleCue) => cue.content)
      if (cues.length) list.push({ lan: track.lan, lanDoc: track.lan_doc || track.lan, items: cues })
    } catch {
      // 单条字幕拉失败：跳过，不影响其它语种
    }
  }
  return { list }
}

export interface SendDanmakuPayload {
  bvid?: string
  cid?: any
  msg?: string
  progress?: number
  mode?: number
  color?: number
  fontsize?: number
}

/**
 * 发弹幕：还原 `lr()`
 *
 * 前置：必须有 bili_jct（csrf）-> 否则 needLogin；内容非空且 ≤100 字。
 * 表单 POST 到 /x/v2/dm/post，-101/-400 也标记 needLogin。
 */
export async function sendDanmaku(payload: SendDanmakuPayload): Promise<any> {
  const {
    bvid,
    cid,
    msg,
    progress,
    mode = 1,
    color = 16777215,
    fontsize = 25,
  } = payload || ({} as SendDanmakuPayload)

  const csrf = state.cookies && state.cookies.bili_jct
  if (!csrf) throw biliError('发送弹幕需要先登录', { needLogin: true })

  const text = String(msg || '').trim()
  if (!text) throw new Error('弹幕内容不能为空')
  if (text.length > 100) throw new Error('弹幕最多 100 个字')

  const body = new URLSearchParams({
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
    csrf: String(csrf),
  })

  const res = await request(DM_POST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    timeout: 15000,
  })
  const data = res.json
  if (!data) throw new Error(`弹幕接口返回非 JSON（HTTP ${res.status}）`)
  if (data.code !== 0) {
    throw biliError(data.message || `发送失败（code ${data.code}）`, {
      biliCode: data.code,
      needLogin: data.code === -101 || data.code === -400,
    })
  }
  return data.data || {}
}
