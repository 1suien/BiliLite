/**
 * 开发者用的 mock 数据桥
 *
 * 作用：在浏览器里（没有 Android 原生桥、没有 Electron 桌面桥的情况下）
 * 用假数据把 window.bili 装好，让整个 UI 能跑起来，便于：
 *   1. 开发时预览页面（`npm run dev` 后访问 `http://localhost:5173/?mock=1`）
 *   2. 与原始 APK 产物做同路由渲染对照（Playwright 注入同一份 mock，见 tools/verify-render.mjs）
 *
 * 这不是原工程的一部分，是还原过程中新增的**开发者工具**：
 * 原始应用只认 window.bili（安卓桥或 Electron 桥），这里用 mock 顶替。
 * 数据全部是编的，接口名/返回结构与 app/src/bridge/types.ts 的契约一致。
 */
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
import type { FavResourcesResult, FavResourceItem, WbiBridge, Paged } from './types'

/* ------------------------------------------------------------------ 工具 */

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** 生成一张 SVG 封面图（data URI），离线可用，不同标题颜色不同 */
export function cover(text: string, hue: number, w = 480, h = 270): string {
  const t = text.length > 14 ? text.slice(0, 14) + '…' : text
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue} 62% 42%)"/><stop offset="1" stop-color="hsl(${(hue + 48) % 360} 58% 24%)"/>
</linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/>
<circle cx="${w - 60}" cy="60" r="90" fill="rgba(255,255,255,.08)"/>
<circle cx="50" cy="${h - 20}" r="120" fill="rgba(0,0,0,.12)"/>
<text x="28" y="${h / 2}" font-family="system-ui, sans-serif" font-size="30" font-weight="700" fill="#fff" opacity=".95">${escapeXml(t)}</text>
<text x="28" y="${h / 2 + 40}" font-family="system-ui, sans-serif" font-size="18" fill="#fff" opacity=".6">BiliLite · mock</text>
</svg>`
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}

/** 头像（圆形 SVG） */
function avatar(name: string, hue: number, size = 120): string {
  const ch = name.slice(0, 1)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 120 120">
<defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 60% 55%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 55% 38%)"/></linearGradient></defs>
<circle cx="60" cy="60" r="60" fill="url(#a)"/>
<text x="60" y="78" text-anchor="middle" font-family="system-ui, sans-serif" font-size="48" font-weight="700" fill="#fff">${escapeXml(ch)}</text>
</svg>`
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}

function escapeXml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const rnd = (min: number, max: number) => Math.floor(min + Math.random() * (max - min + 1))
const hash = (s: string) => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/* -------------------------------------------------------------- 假数据源 */

interface FakeUp {
  mid: number
  name: string
  face: string
  sign: string
  fans: number
  archives: number
}

const UPs: FakeUp[] = [
  { mid: 10822885, name: '何同学', face: avatar('何', 12), sign: '我是何同学', fans: 12034567, archives: 128 },
  { mid: 517327498, name: '罗翔说刑法', face: avatar('罗', 205), sign: '用良知驾驭我们之所学', fans: 9876543, archives: 486 },
  { mid: 37663924, name: '硬核的半佛仙人', face: avatar('半', 150), sign: '致力于讲清每一个商业故事', fans: 7654321, archives: 312 },
  { mid: 946974, name: '影视飓风', face: avatar('影', 260), sign: '无限进步', fans: 8765432, archives: 512 },
  { mid: 14871346, name: '极客湾Geekerwan', face: avatar('极', 190), sign: '硬核数码评测', fans: 6543210, archives: 268 },
  { mid: 546195, name: '老番茄', face: avatar('番', 30), sign: '游戏区 UP 主', fans: 18900000, archives: 640 },
]

const TITLES = [
  '我花了三个月，把书桌改造成了这样',
  '刑法学第一讲：为什么我们需要刑法',
  '这些商业套路，你每天都在经历',
  '8K 摄影机拍出来的画面到底有多震撼',
  '一颗芯片的诞生：从沙子到 CPU',
  '高分游戏背后的设计哲学',
  '用 100 天学会一门新语言，我做对了什么',
  '现代操作系统到底是怎么调度进程的',
  '如何用费曼学习法记住任何知识',
  '一个视频讲清楚线性代数的本质',
  '为什么你总是静不下心来学习',
  '从零实现一个数据库：索引篇',
  '数学之美：傅里叶变换可视化',
  '如何高效地做笔记：我的 Obsidian 工作流',
  '每天一小时，三个月后我读完了 12 本书',
  'AI 时代还需要背单词吗',
]

function makeVideo(i: number, opts: { upName?: string; upMid?: number; title?: string } = {}): VideoCard {
  const up = UPs[i % UPs.length]
  const title = opts.title || TITLES[i % TITLES.length]
  return {
    bvid: 'BV1' + String(1000000 + i * 7919).slice(0, 6) + 'x7' + String(i).padStart(2, '0'),
    title,
    cover: cover(title, (hash(title) + i * 37) % 360),
    upMid: opts.upMid ?? up.mid,
    upName: opts.upName ?? up.name,
    duration: rnd(90, 2400),
    pubdate: Math.floor(Date.now() / 1000) - i * 86400 - rnd(0, 86400),
    view: rnd(1000, 3000000),
    danmaku: rnd(10, 30000),
  }
}

function makeVideoList(from: number, count: number, opts: { titleSeed?: string; upName?: string; upMid?: number } = {}) {
  const list: VideoCard[] = []
  for (let i = 0; i < count; i++) {
    const base = makeVideo(from + i)
    const title = opts.titleSeed ? `${opts.titleSeed} · 第 ${from + i + 1} 集` : base.title
    list.push({
      ...base,
      title,
      cover: cover(title, (hash(title) + from * 13) % 360),
      upName: opts.upName ?? base.upName,
      upMid: opts.upMid ?? base.upMid,
    })
  }
  return list
}

/** 视频详情：bvid -> 详情；不在列表里的 bvid 也能通过它反查（确定性生成） */
const detailCache = new Map<string, VideoDetail>()
function makeDetail(bvid: string): VideoDetail {
  const hit = detailCache.get(bvid)
  if (hit) return hit
  const seed = hash(bvid)
  const up = UPs[seed % UPs.length]
  const title = TITLES[seed % TITLES.length]
  const pages: VideoPage[] = Array.from({ length: 3 + (seed % 3) }, (_, i) => ({
    cid: 100000 + (seed % 90000) + i,
    page: i + 1,
    part: i === 0 ? 'P1 正片' : `P${i + 1} 花絮 ${i}`,
    title: i === 0 ? '正片' : `花絮 ${i}`,
    duration: rnd(300, 1500),
  }))
  const detail: VideoDetail = {
    aid: 100000 + (seed % 900000),
    bvid,
    cid: pages[0].cid,
    title,
    desc:
      '这是 mock 数据生成的视频简介。\n\n用于在没有原生桥的浏览器环境里预览 BiliLite 的界面与交互，' +
      '内容与真实 B 站无关。参数、简介、推荐等都由本地确定性生成。',
    cover: cover(title, seed % 360),
    pubdate: Math.floor(Date.now() / 1000) - (seed % 30) * 86400,
    duration: pages.reduce((a, p) => a + p.duration, 0),
    tname: '知识',
    owner: { mid: up.mid, name: up.name, face: up.face },
    stat: {
      view: rnd(10000, 5000000),
      danmaku: rnd(100, 50000),
      like: rnd(1000, 300000),
      coin: rnd(100, 100000),
      favorite: rnd(100, 200000),
      reply: rnd(10, 20000),
    },
    pages,
  }
  detailCache.set(bvid, detail)
  return detail
}

/** 收藏夹 */
const FAV_FOLDERS: FavFolder[] = [
  { id: 101, title: '默认收藏夹', media_count: 42, cover: cover('默认收藏夹', 200) },
  { id: 102, title: '学习资料', media_count: 18, cover: cover('学习资料', 150) },
  { id: 103, title: '稍后再看', media_count: 7, cover: cover('稍后再看', 30) },
]
const FAV_COLLECTED: FavFolder[] = [
  { id: 201, title: '前端工程化收藏', media_count: 56, cover: cover('前端工程化', 260) },
  { id: 202, title: '纪录片/科普', media_count: 23, cover: cover('纪录片', 190) },
]

function favResources(mediaId: number, pn: number): FavResourceItem[] {
  const n = mediaId % 2 === 0 ? 12 : 8
  return Array.from({ length: n }, (_, i) => {
    const v = makeVideo(mediaId + i * 7, { title: `${FAV_FOLDERS.find(f => f.id === mediaId)?.title || '收藏夹'} · 视频 ${i + 1 + (pn - 1) * n}` })
    const card: FavResourceItem = {
      id: v.bvid ? Number(String(v.bvid).replace(/\D/g, '').slice(-9)) : i + 1,
      bvid: v.bvid,
      title: v.title,
      cover: v.cover,
      intro: '',
      duration: v.duration || 0,
      favTime: Math.floor(Date.now() / 1000) - i * 3600,
      pubtime: v.pubdate,
      upper: v.upName || '未知 UP',
      upperMid: v.upMid ?? 0,
      cntInfo: { play: v.view || 0 },
      // 兼容别名
      upName: v.upName || '未知 UP',
      upMid: v.upMid ?? 0,
      pubdate: v.pubdate,
      view: v.view || 0,
    }
    return card
  })
}

/** 弹幕：按 6 分钟一个分段（与 B 站接口一致），每条都是确定性生成的 */
function danmakuSegment(cid: number, segment: number): DanmakuItem[] {
  const seed = hash(String(cid) + ':' + segment)
  const texts = [
    '来了来了',
    '这期做得真好',
    '前排',
    '学到了',
    '这个知识点考试要考',
    '讲得太清楚了',
    '已三连',
    '收藏了慢慢看',
    'hhhhh',
    '老师好',
    '这段重要，记笔记',
    '感谢分享',
  ]
  return Array.from({ length: 60 }, (_, i) => ({
    time: ((seed + i * 37) % 360000) / 1000,
    mode: i % 11 === 0 ? 5 : 1,
    size: 25,
    color: i % 7 === 0 ? 0xff6699 : 0xffffff,
    text: texts[(seed + i * 13) % texts.length],
  }))
}

/** 字幕 */
function subtitleTracks(bvid: string): SubtitleTrack[] {
  const cues: SubtitleCue[] = [
    { from: 0, to: 3.2, content: '大家好，欢迎来到这一期的视频。' },
    { from: 3.2, to: 7.5, content: '今天我们要聊的是一个特别有意思的话题。' },
    { from: 7.5, to: 12, content: '在开始之前，先简单介绍一下背景。' },
    { from: 12, to: 16.8, content: '这是 mock 数据生成的字幕，用于验证字幕渲染。' },
    { from: 16.8, to: 21, content: '字幕的字号、背景、位置都可以在设置里调整。' },
  ]
  return [
    { lan: 'zh-CN', lanDoc: '中文（自动生成）', items: cues },
    {
      lan: 'en-US',
      lanDoc: 'English',
      items: cues.map((c, i) => ({ ...c, content: `Mock subtitle line ${i + 1} for ${bvid}.` })),
    },
  ]
}

/* -------------------------------------------------- 设置（用 localStorage 持久化） */

const SETTINGS_KEY = 'bililite.mock.settings'
const DEFAULT_SETTINGS: Record<string, any> = {
  theme: 'dark',
  accent: '#fb7299',
  defaultQuality: 80,
  autoNext: true,
  seekStep: 5,
  backupPath: '',
  playerVolume: 0.8,
  hideDanmakuArea: false,
  autoMark: true,
  autoCheckin: true,
  playbackRate: 1,
  danmakuOn: true,
  danmakuOpacity: 0.9,
  danmakuArea: 1,
  autoHideCtl: true,
  navOrder: [],
  subAuto: false,
  subFontSize: 22,
  subBg: true,
  subBottom: 8,
  focusTasks: [],
  focusTargets: [],
}

function readSettings(): Record<string, any> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    /* 忽略 */
  }
  return { ...DEFAULT_SETTINGS }
}
function writeSettings(next: Record<string, any>) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
  } catch {
    /* 忽略 */
  }
}

const MOCK_USER: User = {
  mid: 10001,
  uname: '学习者小张',
  face: avatar('学', 320),
  level: 5,
  coins: 328,
  vip: true,
}
const LOGIN_KEY = 'bililite.mock.loggedIn'
const isLoggedIn = () => localStorage.getItem(LOGIN_KEY) !== '0'

let qrPollCount = 0

/* ------------------------------------------------------------- mock 桥本体 */

/** 创建 mock 桥对象（不改 window，便于测试/注入） */
export function createMockBridge(): WbiBridge {
  return {
    platform: 'mock',

    async ping() {
      await delay(10)
      return { ok: true, platform: 'mock', time: Date.now() }
    },

    auth: {
      async restore() {
        await delay(120)
        if (!isLoggedIn()) return { loggedIn: false, user: null }
        return { loggedIn: true, user: MOCK_USER }
      },
      async qrGenerate() {
        await delay(150)
        qrPollCount = 0
        return { url: 'https://passport.bilibili.com/mock/qr?key=mock-key', qrcodeKey: 'mock-key' }
      },
      async qrPoll() {
        await delay(400)
        qrPollCount++
        if (qrPollCount === 1) return { status: 'waiting', message: '请使用 B 站客户端扫码' }
        if (qrPollCount === 2) return { status: 'scanned', message: '已扫码，请在手机上确认' }
        localStorage.setItem(LOGIN_KEY, '1')
        return { status: 'success', user: MOCK_USER }
      },
      async logout() {
        await delay(100)
        localStorage.setItem(LOGIN_KEY, '0')
        return { ok: true }
      },
    },

    home: {
      async feed(page = 1): Promise<Paged<VideoCard>> {
        await delay(220)
        const items = makeVideoList((page - 1) * 12, 12)
        return { items, page, hasMore: page < 5 }
      },
      async popular(page = 1): Promise<Paged<VideoCard>> {
        await delay(200)
        return { items: makeVideoList(100 + (page - 1) * 12, 12, { titleSeed: '热门' }), page, hasMore: page < 5 }
      },
    },

    search: {
      async videos(keyword: string, page = 1, order = 'totalrank'): Promise<Paged<VideoCard>> {
        await delay(260)
        const list = makeVideoList((page - 1) * 12, 12, { titleSeed: keyword || '搜索结果' })
        return { items: list, page, total: 300, hasMore: page < 5 }
      },
      async ups(keyword: string, page = 1): Promise<Paged<any>> {
        await delay(220)
        const items = UPs.filter(u => !keyword || u.name.includes(keyword) || keyword === 'mock').map(u => ({
          mid: u.mid,
          name: u.name,
          face: u.face,
          sign: u.sign,
          fans: u.fans,
        }))
        const list = items.length ? items : UPs.map(u => ({ mid: u.mid, name: u.name, face: u.face, sign: u.sign, fans: u.fans }))
        return { items: list, page, total: list.length, hasMore: false }
      },
    },

    video: {
      async view(bvid: string) {
        await delay(240)
        return makeDetail(bvid)
      },
      async pages(bvid: string) {
        await delay(120)
        return makeDetail(bvid).pages
      },
      async playurl(bvid: string, cid: any, qn: number): Promise<PlayUrl> {
        await delay(320)
        const d = makeDetail(bvid)
        // 注意：mock 没有真实媒体流，播放器会进入错误状态——这是预期行为，
        // 页面其它部分（信息、分 P、弹幕、推荐、进度记录）仍然可以验证。
        return {
          quality: qn,
          duration: d.duration,
          dash: true,
          videos: [
            { id: 80, baseUrl: 'mock://video/1080p', bandwidth: 3000000, codecs: 'avc1.640032', width: 1920, height: 1080, mimeType: 'video/mp4' },
            { id: 64, baseUrl: 'mock://video/720p', bandwidth: 1500000, codecs: 'avc1.64001F', width: 1280, height: 720, mimeType: 'video/mp4' },
          ],
          audios: [{ id: 30280, baseUrl: 'mock://audio/192k', bandwidth: 192000, codecs: 'mp4a.40.2', mimeType: 'audio/mp4' }],
        }
      },
      async related(bvid: string) {
        await delay(180)
        const seed = hash(bvid)
        return makeVideoList(seed % 50, 8)
      },
      async danmaku(cid: any, segment = 1) {
        await delay(150)
        const items = danmakuSegment(Number(cid) || 1, segment)
        return { items, count: items.length, segment }
      },
      async online(bvid: string, cid: any) {
        await delay(120)
        const total = 200 + (hash(String(cid) + bvid) % 4800)
        return { total, count: total }
      },
      async subtitle(bvid: string, cid: any) {
        await delay(140)
        return { list: subtitleTracks(bvid) }
      },
      async sendDanmaku(payload: any) {
        await delay(200)
        if (!isLoggedIn()) {
          const err: any = new Error('发送弹幕需要先登录')
          err.needLogin = true
          throw err
        }
        return { ok: true, dmid: String(Date.now()) }
      },
    },

    up: {
      async info(mid: any): Promise<UpCardInfo> {
        await delay(200)
        const u = UPs.find(x => String(x.mid) === String(mid)) || UPs[0]
        return { mid: u.mid, name: u.name, face: u.face, sign: u.sign, fans: u.fans, archives: u.archives }
      },
      async videos(mid: any, pn = 1, keyword?: string): Promise<Paged<VideoCard>> {
        await delay(220)
        const u = UPs.find(x => String(x.mid) === String(mid)) || UPs[0]
        const list = makeVideoList((pn - 1) * 12, 12, {
          titleSeed: keyword ? `${u.name} · ${keyword}` : u.name,
          upName: u.name,
          upMid: u.mid,
        })
        return { items: list, page: pn, total: u.archives, hasMore: pn < 3 }
      },
      async resolve(query: string) {
        await delay(180)
        const m = String(query).match(/(\d{2,})/)
        const u = UPs.find(x => x.name.includes(String(query).trim())) || UPs[(hash(String(query)) % UPs.length)]
        return { mid: m ? Number(m[1]) : u.mid, name: u.name }
      },
      async latest(mids: (string | number)[], perUp = 3) {
        await delay(320)
        const items: VideoCard[] = []
        for (const mid of mids) {
          const u = UPs.find(x => String(x.mid) === String(mid))
          if (!u) continue
          for (let i = 0; i < perUp; i++) {
            const v = makeVideo(hash(String(mid)) % 40 + i, { upName: u.name, upMid: u.mid, title: `${u.name} 的最新视频 ${i + 1}` })
            items.push(v)
          }
        }
        return { items }
      },
      async followings(pn = 1, ps = 20) {
        await delay(260)
        const items = UPs.map(u => ({ mid: u.mid, uname: u.name, face: u.face, sign: u.sign }))
        return { items, page: pn, total: items.length, hasMore: false }
      },
    },

    fav: {
      async folders() {
        await delay(220)
        if (!isLoggedIn()) {
          const err: any = new Error('获取收藏夹需要先登录')
          err.needLogin = true
          throw err
        }
        return { created: FAV_FOLDERS, collected: FAV_COLLECTED }
      },
      async resources(mediaId: any, pn = 1): Promise<FavResourcesResult> {
        await delay(240)
        const id = Number(mediaId) || 101
        const folder = [...FAV_FOLDERS, ...FAV_COLLECTED].find(f => f.id === id)
        const medias = favResources(id, pn)
        return {
          info: {
            id,
            title: folder?.title || '收藏夹',
            mediaCount: folder?.media_count ?? 42,
            media_count: folder?.media_count ?? 42,
            cover: folder?.cover,
          },
          medias,
          hasMore: pn < 3,
          items: medias,
          page: pn,
          total: folder?.media_count ?? 42,
        }
      },
    },

    settings: {
      async get() {
        await delay(40)
        return readSettings()
      },
      async patch(patch: any) {
        await delay(40)
        const next = { ...readSettings(), ...patch }
        writeSettings(next)
        return next
      },
    },

    sys: {
      async openExternal(url: string) {
        await delay(30)
        console.info('[mock] openExternal:', url)
        return { ok: true, url }
      },
      async pickFile() {
        await delay(60)
        return '本机（导出时用系统面板选保存位置）'
      },
      async revealPath(path: string) {
        await delay(30)
        console.info('[mock] revealPath:', path)
        return { ok: true }
      },
      async pickSubtitle() {
        await delay(200)
        return ['/mock/字幕示例.srt']
      },
      async readSubtitle(path: string) {
        await delay(120)
        const text = '1\n00:00:00,000 --> 00:00:03,000\n这是本地字幕示例。\n\n2\n00:00:03,500 --> 00:00:07,000\n由 mock 桥接生成。\n'
        const bytes = new TextEncoder().encode(text)
        return { path, name: path.split('/').pop() || 'subtitle.srt', size: bytes.length, bytes }
      },
      pathForFile(file?: any) {
        return `/mock/${file?.name || 'file'}`
      },
    },

    backup: {
      async write(dir: string, name: string, text: string) {
        await delay(120)
        const path = `${dir || '/mock/backup'}/${name}`
        // 浏览器里没法真的写文件，退化成一次下载，方便验证导出的 JSON 内容
        try {
          const blob = new Blob([text], { type: 'application/json' })
          const a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = name
          a.click()
          setTimeout(() => URL.revokeObjectURL(a.href), 3000)
        } catch {
          /* 忽略 */
        }
        console.info('[mock] backup.write:', path, text.length, 'bytes')
        return path
      },
    },

    local: {
      async pickFiles() {
        await delay(260)
        return { entries: makeLocalEntries(3) }
      },
      /** 浏览器预览没有原生导入，走 mock 条目（0.4.15） */
      async pickNative() {
        await delay(260)
        return { entries: makeLocalEntries(3) }
      },
      async diagnose() {
        return { openDocument: false, getContent: false, sdk: 0, mediaDir: '' }
      },
      async sharedPending() {
        await delay(40)
        return { entries: [], count: 0 }
      },
      /** 浏览器预览用假数据模拟「扫描本机视频」（0.4.18） */
      async scanVideos(limit = 200) {
        await delay(280)
        const names = ['线性代数 第 3 讲.mkv', '英语听力 Unit 5.mp4', '计算机网络 实验课.mov', '操作系统导论 第 1 讲.mp4']
        const items = names.map((name, i) => ({
          uri: `content://mock/media/${i + 1}`,
          name,
          size: (30 + i * 2) * 1024 * 1024,
          mtime: Date.now() - i * 3600 * 1000,
          duration: 45 * 60 * 1000,
          dir: i % 2 ? 'Download/WPS' : 'Movies',
          mime: i === 1 ? 'audio/mp4' : 'video/mp4',
        }))
        return { items: items.slice(0, limit), count: items.length }
      },
      async importSelected(uris: string[]) {
        await delay(240)
        return { entries: makeLocalEntries(Math.max(1, (uris || []).length)) }
      },
      async probe(paths: string[]) {
        await delay(60)
        return { entries: makeLocalEntries(paths.length || 1), missing: [] }
      },
      async discard(path: string) {
        await delay(40)
        console.info('[mock] local.discard:', path)
        return { ok: true }
      },
      async storageInfo() {
        await delay(40)
        return { dir: '/mock/local-media', count: 0, bytes: 0 }
      },
      async pickFolder() {
        await delay(260)
        return { entries: makeLocalEntries(5), dir: '/mock/课程视频' }
      },
      async register(paths: string[]) {
        await delay(120)
        return { entries: makeLocalEntries(paths.length || 1), missing: [] }
      },
      async remove(id: string) {
        await delay(60)
        console.info('[mock] local.remove:', id)
        return { ok: true }
      },
      async reveal(path: string) {
        await delay(40)
        console.info('[mock] local.reveal:', path)
        return { ok: true }
      },
    },
  }
}

/** 本地视频条目（浏览器里没有真实文件，url 用 mock 协议，列表能渲染但播放会失败） */
function makeLocalEntries(n: number) {
  const names = [
    '操作系统导论 第 1 讲.mp4',
    '线性代数 第 3 讲.mkv',
    '英语听力 Unit 5.mp4',
    '计算机网络 实验课.mov',
    'Python 数据分析实战.mp4',
  ]
  return Array.from({ length: n }, (_, i) => ({
    id: 'mock-local-' + i,
    path: `/mock/课程视频/${names[i % names.length]}`,
    name: names[i % names.length],
    dir: '/mock/课程视频',
    ext: names[i % names.length].split('.').pop(),
    size: 30 * 1024 * 1024 + i * 1024 * 1024,
    mtime: Date.now() - i * 86400000,
    mime: 'video/mp4',
    url: 'mock://local/' + i,
    addedAt: Date.now() - i * 3600000,
    seconds: 0,
    duration: 1200 + i * 300,
  }))
}

/** 把 mock 桥装到 window.bili 上 */
export function installMockBridge(): void {
  // demoCover：给 dev/seed.ts 等演示数据复用的封面生成器（导出别名）
  ;(window as any).bili = createMockBridge()
  console.info(
    '%c[mock] 已启用 mock 数据桥（不是真实 B 站接口）',
    'color:#fb7299;font-weight:600',
  )
}
