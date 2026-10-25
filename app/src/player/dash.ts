/**
 * 自研 DASH / MSE 播放内核
 *
 * 还原自 reference/decompiled/js/dash-C8KLxT-Q.js（约 1040 行）。
 * 原实现不是第三方库，是一套手写的 MediaSource 流式播放器：
 *
 *  1. 选轨：从 playurl 返回的 dash.video[] 里按「编码优先级 avc1 > hev1/hvc1 > av01」
 *     + 分辨率 + 带宽排序挑一条；audio 优先 mp4a，其次 opus。
 *  2. 建流：new MediaSource() + addSourceBuffer(video/mp4;codecs=... + audio/mp4;codecs=...)，
 *     用 URL.createObjectURL 赋给 <video>.src，等待 sourceopen 后开始 append。
 *  3. 拉流：先去服务端 range 探测 MP4 的 sidx（分段索引），算出起播时间点对应的字节偏移，
 *     再用 `Range: bytes=N-` 从该偏移续拉；sidX 不可用时退化为「从 0 顺序拉 + 缓冲到位再跳」。
 *     数据按 512KB（视频）/128KB（音频）攒批 append，缓冲超前 45s 就暂停拉取（背压）。
 *  4. 跳转：seeking 时若目标不在已缓冲区间，直接重开一次 MediaSource 从新位置续流。
 *  5. 容错：element error 自动重连（最多 2 次）、QuotaExceededError 时淘汰旧缓冲、
 *     首包超时自动换备份线路、ms.duration 未知时用 durationHint/已缓冲长度收尾。
 *  6. 兜底：整段流（durl/直链）直接给 <video>；flv/ts 直链交给 mpegts.js（原实现动态 import）。
 *
 * ---------------------------------------------------------------------------
 * 对外接口（MiniPlayer 按这个接口调用，签名不可变）：
 *   createDashPlayer(video, hooks) -> DashPlayer
 * 说明：hooks 里 onTime / onState / onError / onBuffer 是约定必须的 4 个；
 * 其余（onStatus/onDuration/onEnded/onTracks）是原内核本来就有的回调，标成可选，
 * VideoView 用到，MiniPlayer 不用也不会报错。DashPlayer 上的 setMuted /
 * setDurationHint / stat 同理，都是可选扩展，不影响既有调用。
 */
import type { PlayUrl } from '@/types'

/* ------------------------------- 对外类型 ------------------------------- */

export interface DashPlayerHooks {
  /** 播放进度（秒）：timeupdate 触发，duration 为 0 时表示未知 */
  onTime?: (current: number, duration: number) => void
  /** 播放状态；waiting 时 message 里带缓冲文案，error 时带错误文案 */
  onState?: (
    state: 'playing' | 'paused' | 'waiting' | 'ended' | 'error',
    message?: string,
  ) => void
  /** 致命错误（拉流失败 / 编码不支持 / 重连次数用尽） */
  onError?: (e: Error) => void
  /** 已缓冲百分比 0~100（原内核没有这个回调，这里由 buffered 区间算出） */
  onBuffer?: (pct: number) => void

  /** 状态栏文案（"缓冲中…" / "正在跳转…" / 空串表示清空） */
  onStatus?: (text: string) => void
  /** 时长变化 */
  onDuration?: (duration: number) => void
  /** 播放结束 */
  onEnded?: () => void
  /** 选中的轨道（切清晰度时用于回显当前 qn） */
  onTracks?: (tracks: { video: DashTrack; audio: DashTrack }) => void
}

/** 失败/直链形态的入参（flv/ts/mp4 直链） */
export interface DashDirectSource {
  url: string
  type?: 'flv' | 'ts' | 'mp4' | string
  live?: boolean
}

export interface DashLoadOptions {
  /** 起播秒数（断点续播 / 切清晰度时保留进度） */
  startTime?: number
  volume?: number
  muted?: boolean
  /** 默认 true；false 时只 load 不 play */
  autoplay?: boolean
  /** 已知总时长（秒）：MediaSource 时长未知时先写上，进度条会立刻正确 */
  durationHint?: number
}

export interface DashTrack {
  id: number
  url: string
  backup?: string[]
  codecs?: string
  mimeType?: string
  width?: number
  height?: number
  bandwidth?: number
  frameRate?: string
}

export interface DashStat {
  t0: number
  tResp: number
  tFirst: number
  host: string
  vBytes: number
  aBytes: number
}

export interface DashPlayer {
  /** 底层 <video> 元素（进度/音量/倍速都由它承载） */
  readonly media: HTMLVideoElement
  /** 装载播放地址：DASH（MSE）或直链（mpegts.js / 原生 <video>） */
  load(src: PlayUrl | DashDirectSource, opts?: DashLoadOptions): Promise<void>
  play(): void
  pause(): void
  seek(sec: number): void
  setVolume(v: number): void
  setRate(v: number): void
  /** 切换清晰度：从当前 playurl 的候选轨里重新选轨并重新 load（不改网络请求） */
  setQuality?(qn: number): Promise<void>
  destroy(): void

  /* ---- 可选扩展（VideoView 用；MiniPlayer 不需要） ---- */
  setMuted?(muted: boolean): void
  setDurationHint?(sec: number): void
  readonly stat?: DashStat
}

/* ------------------------------- 常量 ------------------------------- */

/** 首次 range 探测的字节数（MP4 的 sidx 一般在大文件头部 64KB 内） */
const PROBE_BYTES = 65536
/** 前向缓冲高水位（秒）：超过就暂停拉流，避免内存/额度爆掉 */
const BUFFER_AHEAD = 45
/** 视频攒批大小 / 音频攒批大小 */
const VIDEO_CHUNK = 512 * 1024
const AUDIO_CHUNK = 128 * 1024
/** 攒批最长等待（毫秒），到点强制 append */
const FLUSH_MS = 300
/** 首包超时（毫秒）：超时就取消这条线路换下一条 */
const FIRST_CHUNK_TIMEOUT = 8000
/** 每次 fetch 的超时（毫秒） */
const FETCH_TIMEOUT = 8000
/** 等 sourceopen / updateend 的超时 */
const EVENT_TIMEOUT = 8000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 调试日志（原实现就是这样，异常时静默） */
function log(...args: any[]) {
  try {
    console.log('[dash]', ...args)
  } catch {}
}

/* ------------------------------- 小工具 ------------------------------- */

/** 等 SourceBuffer 的 updateend（或 error），超时也放行 */
function waitUpdate(sb: SourceBuffer, timeout = 5000): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      sb.removeEventListener('updateend', finish)
      sb.removeEventListener('error', finish)
      resolve()
    }
    const timer = setTimeout(finish, timeout)
    sb.addEventListener('updateend', finish)
    sb.addEventListener('error', finish)
  })
}

/** 合并多个 Uint8Array */
function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/** 等一个事件（超时 reject） */
function waitEvent(target: EventTarget, name: string, timeout = EVENT_TIMEOUT): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false
    const onFire = () => {
      if (done) return
      done = true
      cleanup()
      resolve()
    }
    const timer = setTimeout(() => {
      if (done) return
      done = true
      cleanup()
      reject(new Error(`${name} 超时`))
    }, timeout)
    function cleanup() {
      clearTimeout(timer)
      target.removeEventListener(name, onFire)
    }
    target.addEventListener(name, onFire, { once: true })
  })
}

/** 轨道地址（兼容 url / baseUrl / base_url 三种写法） */
function trackUrl(t: any): string {
  return t && (t.url || t.baseUrl || t.base_url)
}

/** 轨道备份地址 */
function trackBackup(t: any): string[] {
  if (!t) return []
  const list = t.backup || t.backupUrl || t.backup_url || []
  return Array.isArray(list) ? list.filter(Boolean) : [list].filter(Boolean)
}

/** 编码优先级：avc1 最省电、兼容性最好 */
function codecRank(t: any): number {
  const codecs = String(t.codecs || '')
  return codecs.startsWith('avc1')
    ? 0
    : codecs.startsWith('hev1') || codecs.startsWith('hvc1')
      ? 1
      : codecs.startsWith('av01')
        ? 2
        : 3
}

/** 选视频轨：优先匹配指定 qn，其次按编码/分辨率/带宽排序取第一条 */
function pickVideoTrack(videos: any[] = [], qn = 0): DashTrack | undefined {
  const usable = [...videos].filter((v) => trackUrl(v))
  if (!usable.length) return undefined
  const want = Number(qn) || 0
  const matched = want ? usable.filter((v) => Number(v.id) === want) : []
  return (matched.length ? matched : usable).sort(
    (a, b) =>
      codecRank(a) - codecRank(b) ||
      (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0) ||
      (b.bandwidth || 0) - (a.bandwidth || 0),
  )[0]
}

/** 选音频轨：优先 mp4a（浏览器都能解），没有才退回 opus */
function pickAudioTrack(audios: any[] = []): DashTrack | undefined {
  const mp4a = [...audios].filter((a) => trackUrl(a) && /mp4a/i.test(String(a.codecs || '')))
  return (mp4a.length
    ? mp4a
    : [...audios].filter((a) => trackUrl(a) && /opus/i.test(String(a.codecs || '')))
  ).sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0]
}

/**
 * 候选地址列表：主地址优先，其次备线。
 * mcdn 节点是临时缓存节点，容易 403/404，排到最后再试。
 */
function trackUrls(t: any): string[] {
  if (!t) return []
  const urls = [trackUrl(t), ...trackBackup(t)].filter(Boolean) as string[]
  const isMcdn = (u: string) => /\.mcdn\.bilivideo\.cn/i.test(String(u))
  const normal = urls.filter((u) => !isMcdn(u))
  const mcdn = urls.filter(isMcdn)
  return normal.length ? [...normal, ...mcdn] : urls
}

/** 解析 MP4 头部的 sidx（分段索引），拿不到就是 null（退化成顺序拉） */
function parseSidx(bytes: Uint8Array): {
  refs: { size: number; dur: number }[]
  timescale: number
  initEnd: number
  firstOffset: number
} | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  let found: { offset: number; size: number; headerSize: number } | null = null
  // 先遍历顶层 box（跳过 ftyp/moov/free…）找 sidx
  while (at + 8 <= bytes.byteLength) {
    let size = view.getUint32(at)
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7])
    let headerSize = 8
    if (size === 1) {
      // 64 位长度
      if (at + 16 > bytes.byteLength) return null
      size = view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12)
      headerSize = 16
    } else if (size === 0) {
      // 延伸到文件末尾
      size = bytes.byteLength - at
    }
    if (type === 'sidx') {
      found = { offset: at, size, headerSize }
      break
    }
    if (size <= 0) return null
    at += size
  }
  if (!found || found.offset + found.size > bytes.byteLength) return null

  const body = new DataView(bytes.buffer, bytes.byteOffset + found.offset + found.headerSize)
  const version = body.getUint8(0)
  let p = 4
  p += 4 // reference_ID
  const timescale = body.getUint32(p)
  p += 4
  let firstOffset = 0
  if (version === 0) {
    p += 4 // earliest_presentation_time
    firstOffset = body.getUint32(p)
    p += 4
  } else {
    p += 8
    firstOffset = Number(body.getBigUint64(p))
    p += 8
  }
  p += 2 // reserved
  const count = body.getUint16(p)
  p += 2

  const refs: { size: number; dur: number }[] = []
  const limit = Math.min(body.byteLength, found.size - found.headerSize)
  for (let i = 0; i < count && p + 12 <= limit; i++) {
    const refSize = body.getUint32(p)
    p += 4
    const refDur = body.getUint32(p)
    p += 4
    p += 4 // sap
    refs.push({ size: refSize & 0x7fffffff, dur: refDur })
  }
  return !refs.length || !timescale ? null : { refs, timescale, initEnd: found.offset + found.size, firstOffset }
}

/** 把「第几秒」换算成「文件字节偏移」（用于从起播点续拉） */
function sidxOffset(
  sidx: { refs: { size: number; dur: number }[]; timescale: number; initEnd: number; firstOffset: number } | null,
  sec: number,
): number {
  if (!sidx) return 0
  const target = Math.max(0, sec) * sidx.timescale
  let acc = 0
  let bytes = 0
  for (const r of sidx.refs) {
    if (acc + r.dur > target) break
    acc += r.dur
    bytes += r.size
  }
  return sidx.initEnd + sidx.firstOffset + bytes
}

/* ------------------------------- 入参归一化 ------------------------------- */

interface DashPayload {
  mode: 'dash' | 'durl'
  quality: number
  acceptQuality: number[]
  dash: { duration?: number; video: DashTrack[]; audio: DashTrack[] } | null
  durl: { url: string; backup?: string[] }[]
  /** 直链形态的类型提示（flv/ts/mp4） */
  type?: string
  live?: boolean
}

function normTrack(t: any, audio = false): DashTrack {
  return {
    id: Number(t && t.id) || 0,
    url: String(trackUrl(t) || ''),
    backup: trackBackup(t),
    codecs: String((t && t.codecs) || ''),
    mimeType: String((t && t.mimeType) || (audio ? 'audio/mp4' : 'video/mp4')),
    width: Number(t && t.width) || 0,
    height: Number(t && t.height) || 0,
    bandwidth: Number(t && t.bandwidth) || 0,
    frameRate: (t && t.frameRate) || '',
  }
}

/** durl（整段流）列表归一化 */
function normDurl(list: any[] = []): { url: string; backup?: string[] }[] {
  return Array.isArray(list)
    ? list
        .map((d) => ({ url: String(trackUrl(d) || ''), backup: trackBackup(d) }))
        .filter((d) => d.url)
    : []
}

/**
 * 把各种形态的播放地址统一成内部结构。要同时兼容：
 *  A. 数据桥原始形态（安卓/桌面桥就是这么返回的）：
 *     { mode:'dash', quality, acceptQuality, dash:{ duration(毫秒), video:[{id,url,backup,codecs,width,height,bandwidth}], audio:[…] }, durl:[{url,backup}] }
 *  B. 类型声明里的形态（types.ts 的 PlayUrl）：
 *     { quality, duration(秒), videos:[{id,baseUrl,backupUrl,codecs}], audios:[…] }
 *  C. 直链：{ url, type:'flv'|'ts'|'mp4', live }
 */
function normalizeSource(src: any): DashPayload {
  if (!src) throw new Error('没有可用的播放地址（可能是版权限制或需要登录）')

  const rawDash = src.dash && typeof src.dash === 'object' ? src.dash : null
  if (rawDash && Array.isArray(rawDash.video) && rawDash.video.length) {
    return {
      mode: 'dash',
      quality: Number(src.quality) || 0,
      acceptQuality: Array.isArray(src.acceptQuality) ? src.acceptQuality : [],
      dash: {
        // 数据桥给的 duration 是毫秒
        duration: Number(rawDash.duration) || 0,
        video: rawDash.video.map((t: any) => normTrack(t)),
        audio: (rawDash.audio || []).map((t: any) => normTrack(t, true)),
      },
      durl: normDurl(src.durl),
    }
  }

  if (Array.isArray(src.videos) && src.videos.length) {
    return {
      mode: 'dash',
      quality: Number(src.quality) || 0,
      acceptQuality: Array.isArray(src.acceptQuality) ? src.acceptQuality : [],
      dash: {
        // 类型声明里 duration 是秒，内部统一按毫秒存
        duration: (Number(src.duration) || 0) * 1000,
        video: src.videos.map((t: any) => normTrack(t)),
        audio: (src.audios || []).map((t: any) => normTrack(t, true)),
      },
      durl: [],
    }
  }

  // 直链（flv/ts 交给 mpegts.js，其余直接喂 <video>）
  // types.ts 里 dash 是 boolean 标记，别把它当成轨道对象
  if (src.url && !(src.dash && typeof src.dash === 'object')) {
    return {
      mode: 'durl',
      quality: Number(src.quality) || 0,
      acceptQuality: [],
      dash: null,
      durl: [{ url: String(src.url) }],
      type: src.type,
      live: !!src.live,
    }
  }

  const durl = normDurl(src.durl)
  if (durl.length) {
    return {
      mode: 'durl',
      quality: Number(src.quality) || 0,
      acceptQuality: [],
      dash: null,
      durl,
      type: src.type,
    }
  }

  throw new Error('没有可用的播放地址（可能是版权限制或需要登录）')
}

/* ------------------------------- 播放内核 ------------------------------- */

class DashKernel implements DashPlayer {
  /** 底层 video 元素 */
  readonly video: HTMLVideoElement
  readonly hooks: DashPlayerHooks

  /** 每次 load/重连自增：异步流程用它判断「这次任务是否已经过期」 */
  private gen = 0
  private destroyed = false
  private mediaSource: MediaSource | null = null
  private objectUrl = ''
  private videoBuffer: SourceBuffer | null = null
  private audioBuffer: SourceBuffer | null = null
  private tracks: { video: DashTrack; audio: DashTrack } | null = null
  private vMime = ''
  private aMime = ''
  /** 总时长（秒）：优先用 MediaSource/元素，其次用 playurl 里的 dash.duration */
  private duration = 0
  private durationHint = 0
  private ready = false
  private restarting = false
  private recovering = false
  private recoveries = 0
  /** 进行中的请求（destroy 时全部 abort） */
  private aborts = new Set<AbortController>()
  /** 是否退化成「从 0 顺序拉」 */
  private usedFallbackFromZero = false
  private bufferingMsg = false
  private statusAt = 0
  /** 「用户是想播的」标记：load(autoplay) 时置位，MiniPlayer 也会直接写它 */
  wasPlaying = false
  private payload: DashPayload | null = null
  /** mpegts.js 实例（flv/ts 兜底） */
  private flv: any = null
  private appendLogged: Record<string, boolean> = {}
  private bound: Record<string, EventListener> = {}

  /** 拉流/首帧统计（安卓端调试行用） */
  stat: DashStat = { t0: 0, tResp: 0, tFirst: 0, host: '', vBytes: 0, aBytes: 0 }

  constructor(video: HTMLVideoElement, hooks: DashPlayerHooks = {}) {
    this.video = video
    this.hooks = hooks
    this.attach()
  }

  /** 对外暴露的 <video>（MiniPlayer/VideoView 都从这里拿） */
  get media(): HTMLVideoElement {
    return this.video
  }

  /* ----------------------------- 元素事件 ----------------------------- */

  private attach() {
    const el = this.video
    const on = (name: string, fn: EventListener) => {
      el.addEventListener(name, fn)
      this.bound[name] = fn
    }

    on('timeupdate', () => {
      this.hooks.onTime?.(el.currentTime, this.getDuration())
      this.emitBuffer()
    })
    // 原内核的 onProgress/onDuration 都映射到 onTime/onDuration 上
    on('durationchange', () => {
      const d = this.getDuration()
      this.hooks.onDuration?.(d)
      this.hooks.onTime?.(el.currentTime, d)
    })
    on('loadedmetadata', () => this.hooks.onDuration?.(this.getDuration()))
    on('progress', () => this.emitBuffer())
    on('seeking', () => this.onSeeking())
    on('ended', () => {
      this.hooks.onEnded?.()
      this.hooks.onState?.('ended')
    })
    on('play', () => this.hooks.onState?.('playing'))
    on('playing', () => this.hooks.onState?.('playing'))
    on('pause', () => this.hooks.onState?.('paused'))
    on('waiting', () => this.hooks.onState?.('waiting', '缓冲中…'))
    on('error', () => {
      if (!this.ready || this.restarting || this.destroyed) return
      const err = el.error
      const text = err ? `code=${err.code}${err.message ? ' ' + err.message : ''}` : 'unknown'
      log('media element error', text)
      this.recoverFromElementError(text)
    })
  }

  private detach() {
    for (const [name, fn] of Object.entries(this.bound)) this.video.removeEventListener(name, fn)
    this.bound = {}
  }

  /** 已缓冲百分比（扩展：原内核没有 onBuffer） */
  private emitBuffer() {
    if (!this.hooks.onBuffer) return
    const total = this.getDuration()
    if (!total) return
    try {
      const buffered = this.video.buffered
      if (!buffered.length) return
      const end = buffered.end(buffered.length - 1)
      this.hooks.onBuffer(Math.min(100, Math.max(0, (end / total) * 100)))
    } catch {}
  }

  /* ----------------------------- 基础读写 ----------------------------- */

  /** 有效总时长：元素报不出来就退回 playurl 里的 duration */
  getDuration(): number {
    const d = this.video.duration
    return Number.isFinite(d) && d > 0 ? d : this.duration || 0
  }

  /** 已知时长（秒）：MediaSource 时长未知时先写死）
   *  原实现：VideoView 在 load 之前调用，让进度条立刻正确 */
  setDurationHint(sec: number) {
    const v = Number(sec)
    if (!Number.isFinite(v) || v <= 0) return
    this.durationHint = v
    const ms = this.mediaSource
    if (ms && ms.duration === Infinity && this.saneSeconds(v)) {
      try {
        ms.duration = v
        log('duration set from hint', v)
      } catch {}
    }
  }

  private saneSeconds(v: number): boolean {
    return Number.isFinite(v) && v > 3 && v < 86400
  }

  /* ----------------------------- load ----------------------------- */

  async load(src: PlayUrl | DashDirectSource, opts: DashLoadOptions = {}): Promise<void> {
    const startTime = Math.max(0, opts.startTime || 0)
    this.destroyed = false
    this.ready = false
    this.recoveries = 0
    const payload = normalizeSource(src)
    this.payload = payload
    this.duration = payload.dash ? (payload.dash.duration || 0) / 1000 : 0
    this.stat = { t0: performance.now(), tResp: 0, tFirst: 0, host: '', vBytes: 0, aBytes: 0 }
    if (opts.durationHint) this.setDurationHint(opts.durationHint)
    if (opts.volume != null) this.video.volume = Math.min(1, Math.max(0, opts.volume))
    if (opts.muted != null) this.video.muted = !!opts.muted

    if (payload.mode === 'dash' && payload.dash && payload.dash.video.length) {
      log(
        'load: dash',
        'start=' + startTime,
        'videoTracks=' + payload.dash.video.length,
        'audioTracks=' + (payload.dash.audio || []).length,
      )
      await this.openDash(payload, startTime)
    } else if (payload.durl.length) {
      log('load: durl', 'start=' + startTime)
      this.openDirect(payload.durl[0].url, startTime, payload.type)
    } else {
      throw new Error('没有可用的播放地址（可能是版权限制或需要登录）')
    }

    if (opts.autoplay !== false) {
      this.wasPlaying = true
      try {
        await this.video.play()
      } catch {
        // 浏览器自动播放被拦截：不当作错误，交给 UI 提示点击
        this.wasPlaying = false
        this.hooks.onState?.('paused', '自动播放被拦截，点击画面开始播放')
      }
    }
  }

  /** 直链：flv/ts 用 mpegts.js，其它直接喂 <video> */
  private openDirect(url: string, startTime: number, type?: string) {
    if (!url) {
      this.hooks.onError?.(new Error('没有可用的播放地址（可能是版权限制或需要登录）'))
      return
    }
    const hint = String(type || '').toLowerCase()
    const isFlvOrTs = hint === 'flv' || hint === 'ts' || /\.(flv|ts)(\?|$)/i.test(url)
    if (!isFlvOrTs) {
      this.status('使用直连流播放')
      this.video.src = url
      this.ready = true
      if (startTime > 0.5) {
        const jump = () => {
          this.video.currentTime = startTime
          this.video.removeEventListener('loadedmetadata', jump)
        }
        this.video.addEventListener('loadedmetadata', jump)
      }
      return
    }

    // 原实现这里是 `import('./mpegts-*.js')`（Vite 把 mpegts.js 拆成独立 chunk），
    // 源码里直接动态 import 包即可，效果一样：不进主包，只有 flv/ts 才加载。
    import('mpegts.js')
      .then((mod: any) => {
        const mpegts = mod.default || mod
        if (!mpegts.getFeatureList || !mpegts.getFeatureList().mseLivePlayback) {
          throw new Error('当前环境不支持 FLV 播放')
        }
        this.flv && this.flv.destroy()
        const player = mpegts.createPlayer({
          type: 'flv',
          url,
          isLive: false,
          hasAudio: true,
        })
        player.attachMediaElement(this.video)
        player.load()
        this.flv = player
        this.ready = true
        if (startTime > 0.5) this.video.currentTime = startTime
      })
      .catch((e: any) => this.hooks.onError?.(e))
  }

  /** DASH：建 MediaSource、选轨、开流 */
  private async openDash(payload: DashPayload, startTime: number) {
    const gen = ++this.gen
    this.teardownMedia()
    this.usedFallbackFromZero = false

    const videoTrack = pickVideoTrack(payload.dash?.video, payload.quality)
    const audioTrack = pickAudioTrack(payload.dash?.audio || [])
    if (!videoTrack) throw new Error('没有可用的视频轨')
    if (!audioTrack) throw new Error('没有浏览器可解码的音轨（该视频可能只有杜比/无损音频）')

    const vMime = `video/mp4; codecs="${videoTrack.codecs}"`
    if (typeof window.MediaSource === 'undefined') throw new Error('当前环境不支持 MediaSource')
    if (!window.MediaSource.isTypeSupported(vMime)) {
      throw new Error(`当前环境不支持该视频编码（${videoTrack.codecs}）`)
    }

    this.tracks = { video: videoTrack, audio: audioTrack }
    this.hooks.onTracks?.(this.tracks)
    this.vMime = vMime
    this.aMime = `audio/mp4; codecs="${audioTrack.codecs}"`
    log(
      'picked quality',
      'want=' + (Number(payload.quality) || 0),
      'got=' + (videoTrack.id || '?'),
      (videoTrack.width || '?') + 'x' + (videoTrack.height || '?'),
      Math.round((videoTrack.bandwidth || 0) / 1e3) + 'kbps',
    )

    if (!(await this.setupMedia(gen))) return

    const videoUrls = trackUrls(videoTrack)
    const audioUrls = trackUrls(audioTrack)
    // 流是后台拉着的：不要 await，等首块数据回来就可以起播
    this.startStreams(gen, startTime, videoUrls, audioUrls).catch((e: any) => {
      if (gen === this.gen && !this.destroyed) {
        log('streaming failed', e && e.message)
        this.hooks.onError?.(e)
      }
    })

    const got = await this.waitFirstBuffer(gen, EVENT_TIMEOUT)
    if (gen !== this.gen || this.destroyed) return
    if (!got) log('load: 首段数据超时，仍按后台流继续')
    this.ready = true

    if (startTime > 0.5) {
      if (this.usedFallbackFromZero) {
        // 顺序拉的情况下，等缓冲区盖住起播点再跳
        this.jumpWhenBuffered(startTime, gen).catch(() => {})
      } else {
        try {
          this.video.currentTime = startTime
        } catch {}
      }
    }
    this.hooks.onDuration?.(this.getDuration())
    this.status('')
  }

  /** 等首个缓冲出现（说明有数据了） */
  private async waitFirstBuffer(gen: number, timeout: number): Promise<boolean> {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      if (gen !== this.gen || this.destroyed) return false
      const vsb = this.videoBuffer
      const asb = this.audioBuffer
      if ((vsb && vsb.buffered && vsb.buffered.length) || (asb && asb.buffered && asb.buffered.length)) {
        return true
      }
      await sleep(120)
    }
    return false
  }

  /**
   * 起流：起播点 > 1s 时先用 sidx 探测字节偏移，尝试「从中间续拉」；
   * 失败就重建 MediaSource，退回「从 0 顺序拉 + 缓冲到位再跳」。
   */
  private async startStreams(gen: number, startTime: number, videoUrls: string[], audioUrls: string[]) {
    const needsSeek = startTime > 1
    let vProbe: { urls: string[]; offset: number; initBytes: Uint8Array } | null = null
    let aProbe: typeof vProbe = null

    if (needsSeek) {
      ;[vProbe, aProbe] = await Promise.all([
        this.probeRanged('video', videoUrls, gen, startTime),
        this.probeRanged('audio', audioUrls, gen, startTime),
      ])
    }

    if (vProbe && aProbe && gen === this.gen && !this.destroyed) {
      log('ranged start', 'v=' + vProbe.offset, 'a=' + aProbe.offset)
      const [vOk, aOk] = await Promise.all([
        this.streamRanged('video', vProbe, gen),
        this.streamRanged('audio', aProbe, gen),
      ])
      if (vOk && aOk && gen === this.gen && !this.destroyed) {
        this.settleDuration()
        this.wasPlaying && this.ensurePlaying(gen).catch(() => {})
        return
      }
      if (
        gen !== this.gen ||
        this.destroyed ||
        ((this.usedFallbackFromZero = true),
        log('ranged stream failed, 重建缓冲后从 0 顺序拉', 'v=' + vOk, 'a=' + aOk),
        !(await this.recreateMedia(gen)))
      ) {
        return
      }
    } else if (needsSeek) {
      this.usedFallbackFromZero = true
      log('ranged unusable, 从 0 顺序拉', 'v=' + !!vProbe, 'a=' + !!aProbe)
    }
    if (needsSeek) this.usedFallbackFromZero = true

    const both = Promise.all([
      this.streamFrom('video', videoUrls, gen, 0),
      this.streamFrom('audio', audioUrls, gen, 0),
    ])
    this.wasPlaying && this.ensurePlaying(gen).catch(() => {})
    if (needsSeek && gen === this.gen && !this.destroyed) {
      this.jumpWhenBuffered(startTime, gen).catch(() => {})
    }
    await both
    this.settleDuration()
    if (needsSeek && gen === this.gen && !this.destroyed) {
      this.jumpWhenBuffered(startTime, gen).catch(() => {})
    }
  }

  /** 自动播放兜底：偶发 NotAllowedError 时重试几次 */
  private async ensurePlaying(gen: number, tries = 6) {
    for (let i = 0; i < tries; i++) {
      if (gen !== this.gen || this.destroyed || (this.video && !this.video.paused)) return
      try {
        await this.video.play()
        log('ensurePlaying ok', 'try=' + i)
        return
      } catch (e: any) {
        log('ensurePlaying retry', 'try=' + i, e && e.message)
        await sleep(400)
      }
    }
  }

  /** 元素报错时自动重连（最多 2 次，从当前时间点恢复） */
  private async recoverFromElementError(text: string) {
    if (this.destroyed || this.restarting || this.recovering) return
    if (this.recoveries >= 2) {
      log('element error 重试上限已到', text)
      this.hooks.onError?.(new Error(`播放出错（${text}）`))
      return
    }
    this.recoveries += 1
    this.recovering = true
    const payload = this.payload
    const at = Math.floor(this.video ? this.video.currentTime : 0)
    const wasPlaying = this.wasPlaying
    log('element error → 自动重连', text, 'at=' + at, 'try=' + this.recoveries)
    try {
      await sleep(600)
      if (this.destroyed || !payload) return
      this.wasPlaying = wasPlaying
      await this.openDash(payload, at > 2 ? at : 0)
      if (wasPlaying) await this.ensurePlaying(this.gen, 6)
      log('自动重连完成', 'at=' + at)
    } catch (e: any) {
      log('自动重连失败', e && e.message)
    } finally {
      this.recovering = false
    }
  }

  /** 建 MediaSource + 两个 SourceBuffer */
  private async setupMedia(gen: number): Promise<boolean> {
    this.mediaSource = new MediaSource()
    this.objectUrl = URL.createObjectURL(this.mediaSource)
    this.video.src = this.objectUrl
    await waitEvent(this.mediaSource, 'sourceopen', EVENT_TIMEOUT)

    if (this.destroyed || gen !== this.gen || !this.mediaSource || this.mediaSource.readyState !== 'open') {
      log('abort after sourceopen', 'destroyed=' + this.destroyed, 'gen=' + gen, 'cur=' + this.gen)
      return false
    }

    log('sourceopen ok, readyState=' + this.mediaSource.readyState)
    this.videoBuffer = this.mediaSource.addSourceBuffer(this.vMime)
    this.videoBuffer.mode = 'segments'
    this.audioBuffer = null
    if (this.aMime && window.MediaSource.isTypeSupported(this.aMime)) {
      try {
        this.audioBuffer = this.mediaSource.addSourceBuffer(this.aMime)
        this.audioBuffer.mode = 'segments'
      } catch {
        // 音轨加不进去就只播视频（原实现同样静默降级）
        this.audioBuffer = null
      }
    }
    this.status('缓冲中…')

    // 时长：已知就写死，未知先设 Infinity，等缓冲够了再收尾
    const dur = this.saneSeconds(this.duration)
      ? this.duration
      : this.saneSeconds(this.durationHint)
        ? this.durationHint
        : Infinity
    try {
      this.mediaSource.duration = dur
      log('ms.duration =', dur === Infinity ? 'Infinity(待收尾修正)' : dur)
    } catch {}
    return true
  }

  /** 重建 MediaSource（续流失败时回退到从 0 顺序拉） */
  private async recreateMedia(gen: number): Promise<boolean> {
    if (gen !== this.gen || this.destroyed) return false
    log('重建 MediaSource（续流失败，回退到从 0 顺序拉）')
    this.teardownMedia()
    try {
      return await this.setupMedia(gen)
    } catch (e: any) {
      log('recreateMedia failed', e && e.message)
      return false
    }
  }

  /** 时长还是 Infinity 时，用缓冲末端的秒数收尾（否则进度条/跳转都不准） */
  private settleDuration() {
    const ms = this.mediaSource
    if (!ms || this.destroyed || ms.duration !== Infinity) return
    let end = 0
    for (const sb of [this.videoBuffer, this.audioBuffer]) {
      if (!sb) continue
      try {
        if (sb.buffered.length) end = Math.max(end, sb.buffered.end(sb.buffered.length - 1))
      } catch {}
    }
    if (end > 0) {
      try {
        ms.duration = end
        log('duration settled from buffered', end)
      } catch (e: any) {
        log('duration settle failed', e && e.message, end)
      }
    }
  }

  /** 用一次 range 请求拿 sidx，算出续拉偏移 */
  private async probeRanged(
    kind: 'video' | 'audio',
    urls: string[],
    gen: number,
    startTime: number,
  ): Promise<{ urls: string[]; offset: number; initBytes: Uint8Array } | null> {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]
      try {
        let res = await this.fetchBytes(url, 0, PROBE_BYTES - 1, gen)
        if (!res) {
          log('ranged probe miss', 'no-response', url.slice(0, 70))
          continue
        }
        log('ranged probe', 'status=' + res.status, 'bytes=' + res.bytes.length, url.slice(0, 70))
        if (res.status !== 206) continue

        let sidx = parseSidx(res.bytes)
        if (sidx) {
          log('ranged sidx', 'refs=' + sidx.refs.length, 'initEnd=' + sidx.initEnd)
        } else {
          // 头 64KB 里没有 sidx，再要 512KB 试一次
          res = await this.fetchBytes(url, 0, PROBE_BYTES * 8 - 1, gen)
          if (!res || res.status !== 206) continue
          sidx = parseSidx(res.bytes)
          log(
            'ranged re-probe',
            'bytes=' + res.bytes.length,
            sidx ? 'refs=' + sidx.refs.length : 'no-sidx',
          )
        }
        if (!sidx) continue
        return { urls: urls.slice(i), offset: sidxOffset(sidx, startTime), initBytes: res.bytes.subarray(0, sidx.initEnd) }
      } catch (e: any) {
        log('ranged try failed', url.slice(0, 60), (e && e.message) || String(e))
      }
    }
    return null
  }

  /** 先 append init 段（moov 之前的头），再从偏移处续流 */
  private async streamRanged(
    kind: 'video' | 'audio',
    probe: { urls: string[]; offset: number; initBytes: Uint8Array },
    gen: number,
  ): Promise<boolean> {
    if (!(await this.append(kind, probe.initBytes, gen))) {
      log('ranged init append failed', kind)
      return false
    }
    const ok = await this.streamFrom(kind, probe.urls, gen, probe.offset)
    log('ranged stream', kind, 'offset=' + probe.offset, 'ok=' + ok, 'url=' + String(probe.urls[0]).slice(0, 60))
    return ok
  }

  /** 从 offset 起顺序拉一条轨（读流 → 攒批 → append，带回压/换线路） */
  private async streamFrom(
    kind: 'video' | 'audio',
    urls: string[],
    gen: number,
    offset: number,
  ): Promise<boolean> {
    let lastError: any = null
    let lastUrl = ''
    let appended = false

    for (const url of urls) {
      if (gen !== this.gen || this.destroyed) return appended
      const abort = new AbortController()
      this.aborts.add(abort)
      let firstTimer: any = null
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
          signal: abort.signal,
        })
        if (!this.stat.tResp) {
          this.stat.tResp = Math.round(performance.now() - this.stat.t0)
          try {
            this.stat.host = new URL(url).host
          } catch {}
        }
        log('streamFrom', kind, 'offset=' + offset, 'status=' + res.status, 'url=' + url.slice(0, 90))

        // 服务端不认 Range（返回 200 整段）时换下一条线路，否则会从头播
        if (offset > 0 && res.status !== 206) {
          log('streamFrom range 被忽略，换线路', kind, 'status=' + res.status, 'offset=' + offset)
          this.aborts.delete(abort)
          try {
            res.body && (await res.body.cancel())
          } catch {}
          continue
        }
        if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`)
        if (!res.body) throw new Error('响应没有可读流')

        const reader = res.body.getReader()
        let got = 0
        const chunkLimit = kind === 'video' ? VIDEO_CHUNK : AUDIO_CHUNK
        let pending: Uint8Array[] = []
        let pendingBytes = 0
        let pendingSince = 0
        let reads = 0

        const flush = async () => {
          if (!pending.length) return true
          const bytes = concatBytes(pending, pendingBytes)
          pending = []
          pendingBytes = 0
          pendingSince = 0
          const ok = await this.append(kind, bytes, gen)
          if (ok) appended = true
          return ok
        }

        // 首包超时：说明这条线路拉不动，abort 掉换下一条
        firstTimer = setTimeout(() => {
          if (got) return
          log('streamFrom 首包超时，换线路', kind, 'url=' + String(url).slice(0, 60))
          try {
            abort.abort()
          } catch {}
        }, FIRST_CHUNK_TIMEOUT)

        for (;;) {
          if (gen !== this.gen || this.destroyed) {
            try {
              await reader.cancel()
            } catch {}
            return appended
          }
          // 背压：缓冲够超前就等一会儿再读
          while (this.ahead(kind) > BUFFER_AHEAD && gen === this.gen && !this.destroyed) {
            if (!(await flush())) return appended
            await sleep(220)
          }

          const { done, value } = await reader.read()
          if (done) break
          if (!value || !value.byteLength) continue

          if (firstTimer) {
            clearTimeout(firstTimer)
            firstTimer = null
          }
          if (!pendingSince) pendingSince = Date.now()
          pending.push(value)
          pendingBytes += value.byteLength
          got += value.byteLength
          reads += 1
          // 攒够一批 / 首批 / 超过 300ms 就 append
          if (reads === 1 || pendingBytes >= chunkLimit || Date.now() - pendingSince >= FLUSH_MS) {
            if (!(await flush())) return appended
          }

          // 顺序拉的兜底模式：给用户一个「已加载 X MB」的进度提示
          if (kind === 'video' && this.usedFallbackFromZero && offset === 0) {
            const stalling = !this.video || this.video.readyState < 3 || this.video.paused
            const now = Date.now()
            if (stalling) {
              if (now - (this.statusAt || 0) > 500) {
                this.statusAt = now
                this.bufferingMsg = true
                this.status('缓冲中… 已加载 ' + Math.round(got / 1048576) + 'MB')
              }
            } else if (this.bufferingMsg) {
              this.bufferingMsg = false
              this.status('')
            }
          }
        }
        if (await flush()) this.aborts.delete(abort)
        return appended
      } catch (e: any) {
        this.aborts.delete(abort)
        if (firstTimer) {
          clearTimeout(firstTimer)
          firstTimer = null
        }
        lastError = e
        lastUrl = url
        if (gen !== this.gen || this.destroyed) return appended
        // 换下一条线路继续
      }
    }

    // 所有线路都失败：报错给 UI
    if (!appended && lastError && gen === this.gen && !this.destroyed) {
      let host = ''
      try {
        host = new URL(lastUrl).host
      } catch {}
      this.hooks.onError?.(new Error(`拉流失败：${lastError.message}${host ? ` @${host}` : ''}`))
    }
    return appended
  }

  /** append 到对应 SourceBuffer（处理 updating / 配额淘汰 / 重试） */
  private async append(kind: 'video' | 'audio', bytes: Uint8Array, gen: number): Promise<boolean> {
    const pick = () => (kind === 'video' ? this.videoBuffer : this.audioBuffer)
    const sb = pick()
    if (!sb || gen !== this.gen || this.destroyed) return false

    while (sb.updating) {
      if (gen !== this.gen || this.destroyed || sb !== pick()) return false
      await waitUpdate(sb, 3000)
    }

    let ok = false
    for (let attempt = 0; ; attempt++) {
      try {
        // TS 5.7 起 Uint8Array<ArrayBufferLike> 不再直接兼容 BufferSource，运行时仍是同一段内存
        sb.appendBuffer(bytes as unknown as BufferSource)
        ok = true
        break
      } catch (e: any) {
        const quota = e && e.name === 'QuotaExceededError'
        log('appendBuffer threw', kind, 'len=' + bytes.byteLength, e && e.name, e && e.message, 'attempt=' + attempt)
        if (!quota || attempt >= 2 || gen !== this.gen || this.destroyed) return false
        log('quota exceeded → evict', kind, 'attempt=' + attempt)
        await this.evict(Math.max(10, BUFFER_AHEAD + 15 - attempt * 20))
        if (gen !== this.gen || this.destroyed || sb !== pick()) return false
        for (; sb.updating; ) {
          if (gen !== this.gen || this.destroyed || sb !== pick()) return false
          await waitUpdate(sb, 3000)
        }
      }
    }
    if (!ok) return false

    await waitUpdate(sb, 5000)
    if (this.stat) {
      if (!this.stat.tFirst) this.stat.tFirst = Math.round(performance.now() - this.stat.t0)
      if (kind === 'video') this.stat.vBytes += bytes.byteLength
      else this.stat.aBytes += bytes.byteLength
    }
    if (!this.appendLogged[kind]) {
      this.appendLogged[kind] = true
      log('first append ok', kind, 'len=' + bytes.byteLength, 'buffered=' + this.bufferedText())
    }
    return true
  }

  /** 调试用：把已缓冲区间打印成文本 */
  private bufferedText(): string {
    try {
      const b = this.videoBuffer ? this.videoBuffer.buffered : null
      if (!b || !b.length) return 'empty'
      const out: string[] = []
      for (let i = 0; i < b.length; i++) out.push(b.start(i).toFixed(1) + '~' + b.end(i).toFixed(1))
      return out.join(',')
    } catch {
      return 'err'
    }
  }

  /** 淘汰缓冲区：只留 [当前-5s, 当前+keepAhead] */
  private async evict(keepAhead = BUFFER_AHEAD + 15) {
    const now = this.video.currentTime || 0
    const from = now - 5
    const to = now + keepAhead
    for (const sb of [this.videoBuffer, this.audioBuffer]) {
      if (!sb || this.destroyed) continue
      if (sb.updating) await waitUpdate(sb, 3000)
      let ranges: [number, number][] = []
      try {
        const b = sb.buffered
        for (let i = 0; i < b.length; i++) ranges.push([b.start(i), b.end(i)])
      } catch {
        continue
      }
      const remove: [number, number][] = []
      for (const [s, e] of ranges) {
        if (e <= from || s > to) remove.push([s, e])
        else if (s < from) remove.push([s, Math.min(from, e)])
      }
      for (const [s, e] of remove) {
        if (this.destroyed) break
        if (sb.updating) await waitUpdate(sb, 3000)
        try {
          sb.remove(s, e)
        } catch {}
      }
      if (sb.updating) await waitUpdate(sb, 3000)
    }
  }

  /** 当前播放点之后已缓冲多少秒 */
  private ahead(kind: 'video' | 'audio' | 'any'): number {
    const sb =
      kind === 'audio' ? this.audioBuffer : kind === 'video' ? this.videoBuffer : this.videoBuffer || this.audioBuffer
    if (!sb) return 0
    try {
      const b = sb.buffered
      if (!b.length) return 0
      const now = this.video.currentTime || 0
      for (let i = 0; i < b.length; i++) {
        if (now >= b.start(i) - 1 && now <= b.end(i) + 30) return b.end(i) - now
      }
      return Math.max(0, b.end(b.length - 1) - now)
    } catch {
      return 0
    }
  }

  /** 目标时间点是否已在 <video> 的缓冲里 */
  private isBuffered(sec: number, tol = 0.4): boolean {
    try {
      const b = this.video.buffered
      for (let i = 0; i < b.length; i++) {
        if (sec >= b.start(i) - tol && sec <= b.end(i) - 0.25) return true
      }
    } catch {}
    return false
  }

  /** 等目标时间点进缓冲后再跳（顺序拉兜底模式用） */
  private async jumpWhenBuffered(sec: number, gen: number) {
    for (let i = 0; i < 160; i++) {
      if (gen !== this.gen || this.destroyed) return
      if (this.isBuffered(sec)) {
        try {
          this.video.currentTime = sec
        } catch {}
        return
      }
      await sleep(120)
    }
  }

  /** 跳转：目标不在缓冲里就重开 MediaSource 从新位置续流 */
  private async onSeeking() {
    if (!this.ready || this.restarting || this.destroyed) return
    const at = this.video.currentTime
    const total = this.getDuration()
    if (this.saneSeconds(total) && at > total - 0.4) {
      // 跳到末尾会直接触发 ended，夹到末尾前 0.4s
      log('seek 超出总时长，夹到末尾', at, '->', Math.max(0, total - 0.4))
      this.video.currentTime = Math.max(0, total - 0.4)
      return
    }
    if (this.isBuffered(at)) return

    const resume = !this.video.paused || this.wasPlaying
    this.restarting = true
    this.status('正在跳转…')
    const payload = this.payload
    try {
      if (payload) await this.openDash(payload, at)
      // 重开流后音量/状态要还原
      const vol = this.video.volume
      this.video.volume = vol
      if (resume) {
        this.wasPlaying = true
        await this.ensurePlaying(this.gen, 6)
      }
    } catch (e: any) {
      this.hooks.onError?.(e)
    } finally {
      this.restarting = false
    }
  }

  /** range 请求固定区间（探测 sidx 用） */
  private async fetchBytes(
    url: string,
    from: number,
    to: number,
    gen: number,
  ): Promise<{ status: number; bytes: Uint8Array } | null> {
    const abort = new AbortController()
    this.aborts.add(abort)
    const timer = setTimeout(() => {
      try {
        abort.abort()
      } catch {}
    }, FETCH_TIMEOUT)
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Range: `bytes=${from}-${to}` },
        signal: abort.signal,
      })
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`)
      const want = to - from + 1
      // 服务器无视 Range 时只读需要的那段就取消
      if (res.status !== 206 && res.body) {
        const reader = res.body.getReader()
        const chunks: Uint8Array[] = []
        let got = 0
        while (got < want) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          got += value.byteLength
        }
        try {
          await reader.cancel()
        } catch {}
        return gen !== this.gen ? null : { status: res.status, bytes: concatBytes(chunks, got) }
      }
      const bytes = new Uint8Array(await res.arrayBuffer())
      return gen !== this.gen ? null : { status: res.status, bytes }
    } finally {
      clearTimeout(timer)
      this.aborts.delete(abort)
    }
  }

  private status(text: string) {
    this.hooks.onStatus?.(text)
  }

  /* ----------------------------- 对外操作 ----------------------------- */

  play() {
    this.wasPlaying = true
    return this.video.play().catch(() => {})
  }

  pause() {
    this.wasPlaying = false
    this.video.pause()
  }

  seek(sec: number) {
    const at = Math.max(0, Math.min(sec, this.getDuration() || sec))
    try {
      this.video.currentTime = at
    } catch {}
  }

  setVolume(v: number) {
    this.video.volume = Math.min(1, Math.max(0, v))
  }

  setMuted(muted: boolean) {
    this.video.muted = !!muted
  }

  setRate(v: number) {
    const rate = Number(v)
    if (!Number.isFinite(rate) || rate <= 0) return
    try {
      this.video.playbackRate = rate
    } catch {}
  }

  /** 切清晰度：在同一次 playurl 的候选轨里重新选轨 + 重新 load（不重新请求接口） */
  async setQuality(qn: number) {
    const payload = this.payload
    if (!payload || payload.mode !== 'dash' || !payload.dash) {
      throw new Error('当前播放的不是 DASH 流，无法切换清晰度')
    }
    const want = Number(qn) || 0
    const has = (payload.dash.video || []).some((t) => Number(t.id) === want)
    if (!has) throw new Error(`当前播放地址里没有 ${want} 这一档，请重新获取播放地址`)
    payload.quality = want
    const at = this.video.currentTime || 0
    const wasPlaying = this.wasPlaying
    await this.openDash(payload, at)
    this.wasPlaying = wasPlaying
    if (wasPlaying) await this.ensurePlaying(this.gen, 6)
  }

  /** 拆掉当前流（保留元素） */
  teardownMedia() {
    for (const a of this.aborts) {
      try {
        a.abort()
      } catch {}
    }
    this.aborts.clear()

    if (this.flv) {
      try {
        this.flv.destroy()
      } catch {}
      this.flv = null
    }

    for (const sb of [this.videoBuffer, this.audioBuffer]) {
      if (!sb) continue
      try {
        if (this.mediaSource && this.mediaSource.readyState === 'open' && !sb.updating) {
          this.mediaSource.removeSourceBuffer(sb)
        }
      } catch {}
    }
    this.videoBuffer = null
    this.audioBuffer = null

    try {
      if (this.mediaSource && this.mediaSource.readyState === 'open') this.mediaSource.endOfStream()
    } catch {}
    this.mediaSource = null

    if (this.objectUrl) {
      try {
        URL.revokeObjectURL(this.objectUrl)
      } catch {}
      this.objectUrl = ''
    }
    try {
      if (this.video.getAttribute('src')) {
        this.video.removeAttribute('src')
        this.video.load()
      }
    } catch {}

    this.ready = false
    this.usedFallbackFromZero = false
    this.bufferingMsg = false
    this.statusAt = 0
  }

  destroy() {
    this.destroyed = true
    this.gen++
    this.detach()
    this.teardownMedia()
  }
}

/** 创建播放内核（唯一入口，与 MiniPlayer 约定一致） */
export function createDashPlayer(video: HTMLVideoElement, hooks: DashPlayerHooks = {}): DashPlayer {
  return new DashKernel(video, hooks)
}
