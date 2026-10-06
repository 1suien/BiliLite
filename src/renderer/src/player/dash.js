/**
 * B 站 DASH / durl 播放核心（MediaSource + fMP4）。
 *
 * 为什么不用 <video src>：B 站 DASH 的视频流与音频流是分离的两个 fMP4，必须自己
 * 用 MSE 合成；并且 CDN 需要 Referer / CORS 头（由主进程 webRequest 注入）。
 *
 * 关键设计：
 *  - 视频轨优先选 avc1（兼容性最好），音频轨只接受 mp4a(AAC)，避免 ec-3/fLaC。
 *  - 用 sidx 索引做「按时间定位」：先 append init 段，再以 Range 请求从目标
 *    字节偏移续传，因此可以从中途进度直接开始，不必先下载前半小时。
 *  - 缓冲超前超过 30s 时暂停拉流，低于 12s 恢复；避免一次性把整集吞进内存。
 *  - 拖到缓冲范围外时整条重建（teardown + 重新 open），简单且不会错位。
 */

const HEAD_PROBE_BYTES = 65536
// 缓冲目标：留足余量减少 underrun（网络抖动时不会马上卡住），同时不至于把整集吞进内存
const AHEAD_MAX = 45
const AHEAD_MIN = 18

// 网络 chunk 只有几十 KB，逐个 appendBuffer 会让解复用/解码频繁中断（表现为卡顿）；
// 攒到阈值或等待超过 BATCH_MS 再合并成一次 append。首块立即 append，保证起播快。
const BATCH_VIDEO_BYTES = 512 * 1024
const BATCH_AUDIO_BYTES = 128 * 1024
const BATCH_MS = 300

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 调试日志：冒烟测试通过主进程 console-message 捕获，便于无 GUI 环境定位起流问题 */
const dbg = (...args) => {
  try {
    console.log('[dash]', ...args)
  } catch {
    /* ignore */
  }
}

function waitUpdate(sb, timeout = 5000) {
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

function concatBytes(list, total) {
  if (list.length === 1) return list[0]
  const out = new Uint8Array(total)
  let at = 0
  for (const b of list) {
    out.set(b, at)
    at += b.byteLength
  }
  return out
}

function waitEvent(target, name, timeout = 8000) {
  return new Promise((resolve, reject) => {
    let done = false
    const ok = () => {
      if (done) return
      done = true
      cleanup()
      resolve()
    }
    const bad = (e) => {
      if (done) return
      done = true
      cleanup()
      reject(e instanceof Error ? e : new Error(`${name} 失败`))
    }
    const timer = setTimeout(() => {
      if (done) return
      done = true
      cleanup()
      reject(new Error(`${name} 超时`))
    }, timeout)
    function cleanup() {
      clearTimeout(timer)
      target.removeEventListener(name, ok)
    }
    target.addEventListener(name, ok, { once: true })
  })
}

/* ── 轨道选择 ───────────────────────────────────────────── */
// 主进程已把播放地址归一化成 { url, backup, codecs, ... }；这里兼容原始 API 的 baseUrl/base_url 字段
function trackUrl(t) {
  return t && (t.url || t.baseUrl || t.base_url)
}

function trackBackups(t) {
  if (!t) return []
  const b = t.backup || t.backupUrl || t.backup_url || []
  return Array.isArray(b) ? b.filter(Boolean) : [b].filter(Boolean)
}

function videoRank(t) {
  const c = String(t.codecs || '')
  if (c.startsWith('avc1')) return 0
  if (c.startsWith('hev1') || c.startsWith('hvc1')) return 1
  if (c.startsWith('av01')) return 2
  return 3
}

/**
 * 选视频轨：先按「本次实际下发的画质」（payload.quality）过滤，再按编码兼容性（avc1 优先）、
 * 再按分辨率降序、最后按带宽降序。
 *
 * 为什么必须先按 id 过滤：playurl 里同一编码可能带 1080P+/1080P/720P/480P/360P 多条轨，
 * 只看带宽会永远挑到最高那条 —— 用户选了 720P 却在拉 1080P+（实测日志 avc1.640033 ≈ 1080P+，
 * 而 UI 显示「当前 720P」），解码压力大、更容易卡顿。
 * 为什么分辨率优先于带宽：实测有视频 360P 的 bandwidth（872kbps）反而高于 480P（851kbps），
 * 纯按带宽排会挑到更糊的那条。
 */
export function pickVideoTrack(tracks = [], preferQuality = 0) {
  const usable = [...tracks].filter((t) => trackUrl(t))
  if (!usable.length) return undefined
  const wanted = Number(preferQuality) || 0
  const matched = wanted ? usable.filter((t) => Number(t.id) === wanted) : []
  const pool = matched.length ? matched : usable
  return pool.sort(
    (a, b) =>
      videoRank(a) - videoRank(b) ||
      (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0) ||
      (b.bandwidth || 0) - (a.bandwidth || 0)
  )[0]
}

export function pickAudioTrack(tracks = []) {
  const usable = [...tracks].filter((t) => trackUrl(t) && /mp4a/i.test(String(t.codecs || '')))
  const pool = usable.length ? usable : [...tracks].filter((t) => trackUrl(t) && /opus/i.test(String(t.codecs || '')))
  return pool.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0]
}

function trackUrls(t) {
  if (!t) return []
  return [trackUrl(t), ...trackBackups(t)].filter(Boolean)
}

/* ── sidx 解析（用于按时间定位） ────────────────────────── */
function parseSidx(head) {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  let offset = 0
  let box = null
  while (offset + 8 <= head.byteLength) {
    let size = view.getUint32(offset)
    const type = String.fromCharCode(head[offset + 4], head[offset + 5], head[offset + 6], head[offset + 7])
    let headerSize = 8
    if (size === 1) {
      if (offset + 16 > head.byteLength) return null
      size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12)
      headerSize = 16
    } else if (size === 0) {
      size = head.byteLength - offset
    }
    if (type === 'sidx') {
      box = { offset, size, headerSize }
      break
    }
    if (size <= 0) return null
    offset += size
  }
  if (!box || box.offset + box.size > head.byteLength) return null

  // body 的第一段是 fullbox 头（version 1 字节 + flags 3 字节），必须先跳过去，
  // 否则后面整体错位 4 字节、reference_count 会读到 reserved 的 0，永远解析不出片段表。
  const body = new DataView(head.buffer, head.byteOffset + box.offset + box.headerSize)
  const version = body.getUint8(0)
  let p = 4 // version + flags
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
  const refs = []
  const bodyEnd = Math.min(body.byteLength, box.size - box.headerSize)
  for (let i = 0; i < count && p + 12 <= bodyEnd; i++) {
    const w0 = body.getUint32(p)
    p += 4
    const dur = body.getUint32(p)
    p += 4
    p += 4
    refs.push({ size: w0 & 0x7fffffff, dur })
  }
  if (!refs.length || !timescale) return null
  return { refs, timescale, initEnd: box.offset + box.size, firstOffset }
}

function sidxByteOffsetForTime(sidx, seconds) {
  if (!sidx) return 0
  const target = Math.max(0, seconds) * sidx.timescale
  let acc = 0
  let bytes = 0
  for (const r of sidx.refs) {
    if (acc + r.dur > target) break
    acc += r.dur
    bytes += r.size
  }
  return sidx.initEnd + sidx.firstOffset + bytes
}

/* ── 播放器 ─────────────────────────────────────────────── */
export class DashPlayer {
  constructor(el, hooks = {}) {
    this.el = el
    this.hooks = hooks
    this.gen = 0
    this.destroyed = false
    this.ms = null
    this.objectUrl = ''
    this.vsb = null
    this.asb = null
    this.tracks = null
    this.duration = 0
    this.durationHint = 0
    this.ready = false
    this.restarting = false
    this.recovering = false
    this.recoveries = 0
    this.aborts = new Set()
    this.usedFallbackFromZero = false
    this.bufferingMsg = false // 当前是否正显示「缓冲中…」提示（用来及时清掉）
    this.statusAt = 0
    this.wantTime = 0
    this.bound = {}
    this.attach()
  }

  /* --- 事件 --- */
  attach() {
    const el = this.el
    const on = (name, fn) => {
      el.addEventListener(name, fn)
      this.bound[name] = fn
    }
    on('timeupdate', () => this.hooks.onProgress && this.hooks.onProgress(el.currentTime, this.getDuration()))
    on('durationchange', () => this.hooks.onDuration && this.hooks.onDuration(this.getDuration()))
    on('loadedmetadata', () => this.hooks.onDuration && this.hooks.onDuration(this.getDuration()))
    on('seeking', () => this.onSeeking())
    on('ended', () => this.hooks.onEnded && this.hooks.onEnded())
    on('play', () => this.hooks.onState && this.hooks.onState('playing'))
    // MSE 欠载恢复后 Chromium 只补发 `playing`（不会再来一次 `play`）：漏掉它会让 UI 认为
    // 「还没开始播」，从此一直挂着「缓冲中…」遮罩，即使画面早就在正常播放。
    on('playing', () => this.hooks.onState && this.hooks.onState('playing'))
    on('pause', () => this.hooks.onState && this.hooks.onState('paused'))
    on('waiting', () => this.hooks.onState && this.hooks.onState('waiting'))
    on('error', () => {
      // 重建流时清空 src 会触发一次空错误，这里忽略
      if (!this.ready || this.restarting || this.destroyed) return
      const e = el.error
      const detail = e ? `code=${e.code}${e.message ? ' ' + e.message : ''}` : 'unknown'
      dbg('media element error', detail)
      // 元素一旦进入 error 状态，后续 appendBuffer 全部会抛 InvalidStateError（画面直接冻住），
      // 所以先尝试自动重连（换一条线路重建流），重试上限用尽才把错误抛给界面。
      this.recoverFromElementError(detail)
    })
  }

  detach() {
    for (const [name, fn] of Object.entries(this.bound)) this.el.removeEventListener(name, fn)
    this.bound = {}
  }

  getDuration() {
    const d = this.el.duration
    if (Number.isFinite(d) && d > 0) return d
    return this.duration || 0
  }

  get currentTime() {
    return this.el.currentTime || 0
  }

  /* --- 生命周期 --- */
  /**
   * 由页面告知「确信的总时长（秒）」。playurl 里的 dash.duration 偶尔是垃圾值（例如 1000ms），
   * 页面会用投稿信息里的时长兜底，这里拿它当第二选择，避免 MSE 被错误时长锁死。
   */
  setDurationHint(sec) {
    const n = Number(sec)
    if (!Number.isFinite(n) || n <= 0) return
    this.durationHint = n
    const ms = this.ms
    if (ms && ms.duration === Infinity && this.saneSeconds(n)) {
      try {
        ms.duration = n
        dbg('duration set from hint', n)
      } catch {
        /* ignore */
      }
    }
  }

  saneSeconds(sec) {
    return Number.isFinite(sec) && sec > 3 && sec < 86400
  }

  async load(payload, opts = {}) {
    const start = Math.max(0, opts.startTime || 0)
    this.destroyed = false
    this.ready = false
    this.recoveries = 0
    this.payload = payload
    this.duration = payload && payload.dash ? (payload.dash.duration || 0) / 1000 : 0

    if (opts.volume != null) this.el.volume = Math.min(1, Math.max(0, opts.volume))
    if (opts.muted != null) this.el.muted = Boolean(opts.muted)

    if (payload && payload.mode === 'dash' && payload.dash && payload.dash.video && payload.dash.video.length) {
      dbg('load: dash', 'start=' + start, 'videoTracks=' + payload.dash.video.length, 'audioTracks=' + (payload.dash.audio || []).length)
      await this.openDash(payload, start)
    } else if (payload && payload.durl && payload.durl.length) {
      dbg('load: durl', 'start=' + start)
      this.openDirect(payload.durl[0].url, start)
    } else {
      throw new Error('没有可用的播放地址（可能是版权限制或需要登录）')
    }

    if (opts.autoplay !== false) {
      this.wasPlaying = true
      try {
        await this.el.play()
      } catch {
        this.wasPlaying = false
        this.hooks.onState && this.hooks.onState('blocked')
      }
    }
  }

  openDirect(url, start) {
    this.status('使用直连流播放')
    const isFlv = /\.flv(\?|$)/i.test(url)
    if (!isFlv) {
      this.el.src = url
      this.ready = true
      if (start > 0.5) {
        const seek = () => {
          this.el.currentTime = start
          this.el.removeEventListener('loadedmetadata', seek)
        }
        this.el.addEventListener('loadedmetadata', seek)
      }
      return
    }
    // flv 回退：走 mpegts.js
    import('mpegts.js')
      .then((mod) => {
        const mpegts = mod.default || mod
        if (!mpegts.getFeatureList || !mpegts.getFeatureList().mseLivePlayback) {
          throw new Error('当前环境不支持 FLV 播放')
        }
        if (this.flv) this.flv.destroy()
        const p = mpegts.createPlayer({ type: 'flv', url, isLive: false, hasAudio: true })
        p.attachMediaElement(this.el)
        p.load()
        this.flv = p
        this.ready = true
        if (start > 0.5) this.el.currentTime = start
      })
      .catch((err) => this.hooks.onError && this.hooks.onError(err))
  }

  async openDash(payload, start) {
    const gen = ++this.gen
    this.teardownMedia()
    this.usedFallbackFromZero = false

    const video = pickVideoTrack(payload.dash.video, payload.quality)
    const audio = pickAudioTrack(payload.dash.audio || [])
    if (!video) throw new Error('没有可用的视频轨')
    if (!audio) throw new Error('没有浏览器可解码的音轨（该视频可能只有杜比/无损音频）')

    const vMime = `video/mp4; codecs="${video.codecs}"`
    if (typeof window.MediaSource === 'undefined') throw new Error('当前环境不支持 MediaSource')
    if (!window.MediaSource.isTypeSupported(vMime)) throw new Error(`当前环境不支持该视频编码（${video.codecs}）`)

    this.tracks = { video, audio }
    if (this.hooks.onTracks) this.hooks.onTracks(this.tracks)
    dbg('tracks', 'v=' + video.codecs, 'a=' + audio.codecs, 'vSupported=' + window.MediaSource.isTypeSupported(vMime), 'aSupported=' + window.MediaSource.isTypeSupported(`audio/mp4; codecs="${audio.codecs}"`))
    dbg(
      'picked quality',
      'want=' + (Number(payload.quality) || 0),
      'got=' + (video.id || '?'),
      (video.width || '?') + 'x' + (video.height || '?'),
      Math.round((video.bandwidth || 0) / 1000) + 'kbps',
      'candidates=' + (payload.dash.video || []).map((t) => t.id + ':' + (t.width || '?') + 'x' + (t.height || '?')).join(',')
    )
    this.vMime = vMime
    this.aMime = `audio/mp4; codecs="${audio.codecs}"`
    if (!(await this.setupMedia(gen))) return

    const vUrls = trackUrls(video)
    const aUrls = trackUrls(audio)

    // 起流不阻塞 load()：一边拉一边播。只等首段数据进来就返回，
    // 否则 load() 要等整条视频拉完才 resolve —— 学习计时器/状态文案都会被卡死。
    const streaming = this.startStreams(gen, start, vUrls, aUrls)
    streaming.catch((err) => {
      if (gen === this.gen && !this.destroyed) {
        dbg('streaming failed', err && err.message)
        this.hooks.onError && this.hooks.onError(err)
      }
    })

    const got = await this.waitFirstBuffer(gen, 8000)
    if (gen !== this.gen || this.destroyed) return
    if (!got) dbg('load: 首段数据超时，仍按后台流继续')
    this.ready = true

    if (start > 0.5) {
      if (this.usedFallbackFromZero) {
        // 不阻塞 load()：等缓冲到位后再跳
        this.jumpWhenBuffered(start, gen).catch(() => {})
      } else {
        try {
          this.el.currentTime = start
        } catch {
          /* 允许失败，播放从头开始 */
        }
      }
    }
    this.hooks.onDuration && this.hooks.onDuration(this.getDuration())
    this.status('')
  }

  /** 等 SourceBuffer 里出现第一段数据（最多 timeout ms），让 load() 尽快返回 */
  async waitFirstBuffer(gen, timeout) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      if (gen !== this.gen || this.destroyed) return false
      const vsb = this.vsb
      const asb = this.asb
      if ((vsb && vsb.buffered && vsb.buffered.length) || (asb && asb.buffered && asb.buffered.length)) return true
      await sleep(120)
    }
    return false
  }

  /**
   * 起流：优先「按时间定位 + Range 续传」（长视频续播/拖动进度条不用先把前面几十 MB 拉完）。
   * 但必须音视频一起成功：只有一条轨定位到中途、另一条从 0 顺序拉，当前播放位置就缺一半数据，
   * 播放会直接卡住 —— 所以任一轨定位失败就两条一起从 0 顺序拉。
   */
  async startStreams(gen, start, vUrls, aUrls) {
    const needSeek = start > 1
    // 重建 MediaSource / SourceBuffer 都会把元素退回暂停态，所以恢复播放以 `this.wasPlaying` 为准
    // （play()/load 自动播放会置 true，pause() 置 false —— 用户主动暂停就不该被自动拉回播放）
    let vPlan = null
    let aPlan = null
    if (needSeek) {
      ;[vPlan, aPlan] = await Promise.all([
        this.probeRanged('video', vUrls, gen, start),
        this.probeRanged('audio', aUrls, gen, start)
      ])
    }
    if (vPlan && aPlan && gen === this.gen && !this.destroyed) {
      dbg('ranged start', 'v=' + vPlan.offset, 'a=' + aPlan.offset)
      const [vOk, aOk] = await Promise.all([this.streamRanged('video', vPlan, gen), this.streamRanged('audio', aPlan, gen)])
      if (vOk && aOk && gen === this.gen && !this.destroyed) {
        this.settleDuration()
        if (this.wasPlaying) this.ensurePlaying(gen).catch(() => {})
        return
      }
      if (gen !== this.gen || this.destroyed) return
      // 续流中途才失败（例如 CDN 对中段 Range 临时回 200/416）：SourceBuffer 里已经留下 init 段或半截
      // 数据，直接接着从 0 顺序 append 会重复 init、时间轴打架 → 连 MediaSource 一起换新的再从 0 拉。
      // 先立起 usedFallbackFromZero，openDash 那边据此改走 jumpWhenBuffered（它在 waitFirstBuffer 之后读这个标志）。
      this.usedFallbackFromZero = true
      dbg('ranged stream failed, 重建缓冲后从 0 顺序拉', 'v=' + vOk, 'a=' + aOk)
      if (!(await this.recreateMedia(gen))) return
    } else if (needSeek) {
      this.usedFallbackFromZero = true
      dbg('ranged unusable, 从 0 顺序拉', 'v=' + !!vPlan, 'a=' + !!aPlan)
    }
    if (needSeek) this.usedFallbackFromZero = true
    const streams = Promise.all([this.streamFrom('video', vUrls, gen, 0), this.streamFrom('audio', aUrls, gen, 0)])
    // streamFrom 要等整条轨拉完才 resolve，所以恢复播放/跳转都不能等它：
    // 缓冲被重建后元素是暂停态，这里立刻把它拉回播放（只有之前在播才拉，用户暂停着拖进度条不该自动开播）。
    if (this.wasPlaying) this.ensurePlaying(gen).catch(() => {})
    if (needSeek && gen === this.gen && !this.destroyed) this.jumpWhenBuffered(start, gen).catch(() => {})
    await streams
    this.settleDuration()
    // 回退到从 0 顺序拉时，等缓冲覆盖到目标位置再跳过去（同上，重复调用无害）
    if (needSeek && gen === this.gen && !this.destroyed) this.jumpWhenBuffered(start, gen).catch(() => {})
  }

  /** 缓冲被重建后元素会退回暂停态；只要之前是在播就把它拉回播放（play() 可能被 Interrupted 拒绝，重试几次） */
  async ensurePlaying(gen, tries = 6) {
    for (let i = 0; i < tries; i++) {
      if (gen !== this.gen || this.destroyed) return
      if (this.el && !this.el.paused) return
      try {
        await this.el.play()
        dbg('ensurePlaying ok', 'try=' + i)
        return
      } catch (err) {
        dbg('ensurePlaying retry', 'try=' + i, err && err.message)
        await sleep(400)
      }
    }
  }

  /**
   * 媒体元素报错后的自动恢复：`<video>` 一旦进入 error 状态，appendBuffer 会一直抛
   * `InvalidStateError: The HTMLMediaElement.error attribute is not null`，画面就永久冻住。
   * 这里从当前进度（太靠前就从头）重建一次流，最多重试 2 次，仍失败才把错误抛给界面。
   */
  async recoverFromElementError(detail) {
    if (this.destroyed || this.restarting || this.recovering) return
    if (this.recoveries >= 2) {
      dbg('element error 重试上限已到', detail)
      this.hooks.onError && this.hooks.onError(new Error(`播放出错（${detail}）`))
      return
    }
    this.recoveries += 1
    this.recovering = true
    const payload = this.payload
    const at = Math.floor(this.el ? this.el.currentTime : 0)
    const wasPlaying = !!this.wasPlaying
    dbg('element error → 自动重连', detail, 'at=' + at, 'try=' + this.recoveries)
    try {
      await sleep(600)
      if (this.destroyed || !payload) return
      this.wasPlaying = wasPlaying
      await this.openDash(payload, at > 2 ? at : 0)
      if (wasPlaying) await this.ensurePlaying(this.gen, 6)
      dbg('自动重连完成', 'at=' + at)
    } catch (err) {
      dbg('自动重连失败', err && err.message)
    } finally {
      this.recovering = false
    }
  }

  /**
   * 建 MediaSource + SourceBuffer，并把时长先定下来。
   * MSE 必须先有 duration 才会进 HAVE_METADATA；但若时长是垃圾值（小到不可能，例如 1000ms），
   * Chromium 会把超出该时长的帧全部丢掉（buffered 一直 empty、画面永远「缓冲中…」）。
   * 所以：payload 时长合理才用 → 否则用页面给的 hint → 都不合理就先给 Infinity，
   * 等整条轨拉完后由 settleDuration() 用 buffered 末尾修回真实时长。
   */
  async setupMedia(gen) {
    this.ms = new MediaSource()
    this.objectUrl = URL.createObjectURL(this.ms)
    this.el.src = this.objectUrl
    await waitEvent(this.ms, 'sourceopen', 8000)
    if (this.destroyed || gen !== this.gen || !this.ms || this.ms.readyState !== 'open') {
      dbg('abort after sourceopen', 'destroyed=' + this.destroyed, 'gen=' + gen, 'cur=' + this.gen)
      return false
    }
    dbg('sourceopen ok, readyState=' + this.ms.readyState)

    this.vsb = this.ms.addSourceBuffer(this.vMime)
    this.vsb.mode = 'segments'
    this.asb = null
    if (this.aMime && window.MediaSource.isTypeSupported(this.aMime)) {
      try {
        this.asb = this.ms.addSourceBuffer(this.aMime)
        this.asb.mode = 'segments'
      } catch {
        this.asb = null
      }
    }
    this.status('缓冲中…')
    const dur = this.saneSeconds(this.duration) ? this.duration : this.saneSeconds(this.durationHint) ? this.durationHint : Infinity
    try {
      this.ms.duration = dur
      dbg('ms.duration =', dur === Infinity ? 'Infinity(待收尾修正)' : dur)
    } catch {
      /* ignore */
    }
    return true
  }

  /**
   * 整个换一个新的 MediaSource。
   * 不能只换 SourceBuffer：Chromium 对「同一个 MediaSource 上创建过的 SourceBuffer 总数」有上限
   * （`removeSourceBuffer` 不会把额度还回来，实测再 add 会报 `This MediaSource has reached the limit of
   * SourceBuffer objects it can handle`），所以续流失败要整条重来时只能连 MediaSource 一起换。
   */
  async recreateMedia(gen) {
    if (gen !== this.gen || this.destroyed) return false
    dbg('重建 MediaSource（续流失败，回退到从 0 顺序拉）')
    this.teardownMedia()
    try {
      return await this.setupMedia(gen)
    } catch (err) {
      dbg('recreateMedia failed', err && err.message)
      return false
    }
  }

  /**
   * 收尾修正 MediaSource.duration。
   *
   * Chromium 的 MSE 需要 `MediaSource.duration` 才会进入 HAVE_METADATA；有的视频（fMP4 分段，
   * init 段里没写时长）不设这个值就会**永远卡在 readyState 0**：缓冲都涨到 30s 了画面还是「缓冲中…」。
   * 拿不到 playurl 时长时先给 `Infinity` 保证能起播，整条轨拉完后用 buffered 末尾修回真实时长。
   */
  settleDuration() {
    const ms = this.ms
    if (!ms || this.destroyed || ms.duration !== Infinity) return
    let end = 0
    for (const sb of [this.vsb, this.asb]) {
      if (!sb) continue
      try {
        if (sb.buffered.length) end = Math.max(end, sb.buffered.end(sb.buffered.length - 1))
      } catch {
        /* ignore */
      }
    }
    if (!(end > 0)) return
    try {
      ms.duration = end
      dbg('duration settled from buffered', end)
    } catch (err) {
      dbg('duration settle failed', err && err.message, end)
    }
  }

  /**
   * 按时间定位：探测 + 解析 sidx，返回「从哪个字节开始续传」。
   *
   * 探测失败一律试下一个备用地址（早期实现第一条线路不通就整段放弃 → 长视频续播要先从 0 拉几十 MB，
   * 看起来就是「一直缓冲」）。这里只做定位，不 append、不拉流 —— 由调用方决定音视频是否一起用。
   */
  async probeRanged(kind, urls, gen, start) {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]
      try {
        let head = await this.fetchBytes(url, 0, HEAD_PROBE_BYTES - 1, gen)
        if (!head) {
          dbg('ranged probe miss', 'no-response', url.slice(0, 70))
          continue
        }
        dbg('ranged probe', 'status=' + head.status, 'bytes=' + head.bytes.length, url.slice(0, 70))
        if (head.status !== 206) continue
        let sidx = parseSidx(head.bytes)
        if (!sidx) {
          // 有的视频 init 段比较大，sidx 落在 64KB 之后：放大到 512KB 再探一次
          head = await this.fetchBytes(url, 0, HEAD_PROBE_BYTES * 8 - 1, gen)
          if (!head || head.status !== 206) continue
          sidx = parseSidx(head.bytes)
          dbg('ranged re-probe', 'bytes=' + head.bytes.length, sidx ? 'refs=' + sidx.refs.length : 'no-sidx')
        } else {
          dbg('ranged sidx', 'refs=' + sidx.refs.length, 'initEnd=' + sidx.initEnd)
        }
        if (!sidx) continue
        return {
          urls: urls.slice(i),
          offset: sidxByteOffsetForTime(sidx, start),
          initBytes: head.bytes.subarray(0, sidx.initEnd)
        }
      } catch (err) {
        // 换下一个备用地址（把原因记下来，不然这条线路为什么失败完全查不到）
        dbg('ranged try failed', url.slice(0, 60), (err && err.message) || String(err))
      }
    }
    return null
  }

  /** 用 probeRanged 的结果起流：先 append init 段，再从目标字节续传 */
  async streamRanged(kind, plan, gen) {
    if (!(await this.append(kind, plan.initBytes, gen))) {
      dbg('ranged init append failed', kind)
      return false
    }
    const ok = await this.streamFrom(kind, plan.urls, gen, plan.offset)
    dbg('ranged stream', kind, 'offset=' + plan.offset, 'ok=' + ok, 'url=' + String(plan.urls[0]).slice(0, 60))
    return ok
  }

  /**
   * 以 Range 续传并逐块 append。
   * @param {number} offset 起始字节（0 表示从头，含 init 段）
   */
  async streamFrom(kind, urls, gen, offset) {
    let lastErr = null
    // 是否真的把数据交给过 SourceBuffer：调用方（tryRangedStart）靠它判断要不要回退到「从 0 拉」
    let appended = false
    for (const url of urls) {
      if (gen !== this.gen || this.destroyed) return appended
      const ac = new AbortController()
      this.aborts.add(ac)
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
          signal: ac.signal
        })
        dbg('streamFrom', kind, 'offset=' + offset, 'status=' + res.status, 'url=' + url.slice(0, 90))
        // 中段续流必须真的走 Range：有的 CDN 对 `bytes=<大偏移>-` 直接回 200（整个文件）或 416。
        // 把这种响应体当成「从 offset 开始」append 会得到错位数据（画面卡住、buffered 为空）→ 换线路。
        if (offset > 0 && res.status !== 206) {
          dbg('streamFrom range 被忽略，换线路', kind, 'status=' + res.status, 'offset=' + offset)
          this.aborts.delete(ac)
          try {
            if (res.body) await res.body.cancel()
          } catch {
            /* ignore */
          }
          continue
        }
        if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`)
        if (!res.body) throw new Error('响应没有可读流')
        const reader = res.body.getReader()
        let readBytes = 0
        // 攒批：网络 chunk 只有几十 KB，逐个 appendBuffer 会让解复用/解码频繁中断 → 卡顿
        const batchBytes = kind === 'video' ? BATCH_VIDEO_BYTES : BATCH_AUDIO_BYTES
        let pending = []
        let pendingBytes = 0
        let pendingSince = 0
        let chunks = 0
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
        for (;;) {
          if (gen !== this.gen || this.destroyed) {
            try {
              await reader.cancel()
            } catch {
              /* ignore */
            }
            return appended
          }
          while (this.ahead(kind) > AHEAD_MAX && gen === this.gen && !this.destroyed) {
            if (!(await flush())) return appended // 背压时先把攒下的数据交出去，避免手里囤着没 append 的块
            await sleep(220)
          }
          const { done, value } = await reader.read()
          if (done) break
          if (!value || !value.byteLength) continue
          if (!pendingSince) pendingSince = Date.now()
          pending.push(value)
          pendingBytes += value.byteLength
          readBytes += value.byteLength
          chunks += 1
          if (chunks === 1 || pendingBytes >= batchBytes || Date.now() - pendingSince >= BATCH_MS) {
            if (!(await flush())) return appended
          }
          // 「缓冲中… 已加载 XMB」只在画面还没出来（欠载/暂停）时才提示：否则正常播放时这个
          // 遮罩会一直盖在画面上，看着像永远在缓冲。
          if (kind === 'video' && this.usedFallbackFromZero && offset === 0) {
            const stalled = !this.el || this.el.readyState < 3 || this.el.paused
            const now = Date.now()
            if (stalled) {
              if (now - (this.statusAt || 0) > 500) {
                this.statusAt = now
                this.bufferingMsg = true
                this.status('缓冲中… 已加载 ' + Math.round(readBytes / 1048576) + 'MB')
              }
            } else if (this.bufferingMsg) {
              this.bufferingMsg = false
              this.status('')
            }
          }
        }
        if (!(await flush())) return appended
        this.aborts.delete(ac)
        return appended
      } catch (err) {
        this.aborts.delete(ac)
        lastErr = err
        if (gen !== this.gen || this.destroyed) return appended
      }
    }
    if (!appended && lastErr && gen === this.gen && !this.destroyed) {
      this.hooks.onError && this.hooks.onError(new Error(`拉流失败：${lastErr.message}`))
    }
    return appended
  }

  async append(kind, bytes, gen) {
    const sb = kind === 'video' ? this.vsb : this.asb
    if (!sb || gen !== this.gen || this.destroyed) return false
    while (sb.updating) {
      if (gen !== this.gen || this.destroyed || sb !== (kind === 'video' ? this.vsb : this.asb)) return false
      await waitUpdate(sb, 3000)
    }
    let ok = false
    for (let attempt = 0; ; attempt++) {
      try {
        sb.appendBuffer(bytes)
        ok = true
        break
      } catch (err) {
        const quota = err && err.name === 'QuotaExceededError'
        dbg('appendBuffer threw', kind, 'len=' + bytes.byteLength, err && err.name, err && err.message, 'attempt=' + attempt)
        if (!quota || attempt >= 2 || gen !== this.gen || this.destroyed) return false
        // 腾配额：先清「播放点之后太远」的数据（音轨甩太远时就是它撑爆的），再清播放点之前的
        dbg('quota exceeded → evict', kind, 'attempt=' + attempt)
        await this.evict(Math.max(10, AHEAD_MAX + 15 - attempt * 20))
        if (gen !== this.gen || this.destroyed) return false
        if (sb !== (kind === 'video' ? this.vsb : this.asb)) return false
        await sleep(120)
        while (sb.updating) {
          if (gen !== this.gen || this.destroyed || sb !== (kind === 'video' ? this.vsb : this.asb)) return false
          await waitUpdate(sb, 3000)
        }
      }
    }
    if (!ok) return false
    await waitUpdate(sb, 5000)
    if (!this.appendLogged) this.appendLogged = {}
    if (!this.appendLogged[kind]) {
      this.appendLogged[kind] = true
      dbg('first append ok', kind, 'len=' + bytes.byteLength, 'buffered=' + this.bufferedText())
    }
    return true
  }

  bufferedText() {
    try {
      const b = this.vsb ? this.vsb.buffered : null
      if (!b || !b.length) return 'empty'
      const segs = []
      for (let i = 0; i < b.length; i++) segs.push(b.start(i).toFixed(1) + '~' + b.end(i).toFixed(1))
      return segs.join(',')
    } catch {
      return 'err'
    }
  }

  /**
   * 释放不再需要的已缓冲数据，给 SourceBuffer 腾配额。
   *
   * 两类数据都要扔：
   *  1) 播放点之前 5 秒以外（已经播过，回看价值低）；
   *  2) 播放点之后太远的部分 —— 音轨比视频轨轻得多，并行拉流时会甩开视频几十上百秒，
   *     只按「超前多少秒」做背压的话音轨能把 SourceBuffer 撑爆（实测 `QuotaExceededError`：
   *     `The SourceBuffer is full, and cannot free space to append additional buffers`），
   *     而当时 `currentTime≈0`，只按「播放点之前」清的话一秒都清不掉，append 直接失败、音轨断流。
   */
  async evict(keepAhead = AHEAD_MAX + 15) {
    const now = this.el.currentTime || 0
    const cut = now - 5
    const far = now + keepAhead
    for (const sb of [this.vsb, this.asb]) {
      if (!sb || this.destroyed) continue
      if (sb.updating) await waitUpdate(sb, 3000)
      let ranges = []
      try {
        const b = sb.buffered
        for (let i = 0; i < b.length; i++) ranges.push([b.start(i), b.end(i)])
      } catch {
        continue
      }
      // 先把要删的区间一次算好，再逐段 remove —— remove() 是异步的，
      // 连着调第二个会在 `updating` 时抛 InvalidStateError（原来那样写会把后面几段全吞掉）
      const targets = []
      for (const [start, end] of ranges) {
        if (end <= cut || start > far) targets.push([start, end])
        else if (start < cut) targets.push([start, Math.min(cut, end)])
      }
      for (const [from, to] of targets) {
        if (this.destroyed) break
        if (sb.updating) await waitUpdate(sb, 3000)
        try {
          sb.remove(from, to)
        } catch {
          /* 区间已被上一段 remove 合并，忽略 */
        }
      }
      if (sb.updating) await waitUpdate(sb, 3000)
    }
  }

  /** 已缓冲到播放点之后多少秒（用于背压）；kind 指定用哪条轨的缓冲，避免音轨甩太远 */
  ahead(kind) {
    const sb = kind === 'audio' ? this.asb : kind === 'video' ? this.vsb : this.vsb || this.asb
    if (!sb) return 0
    try {
      const b = sb.buffered
      if (!b.length) return 0
      const t = this.el.currentTime || 0
      for (let i = 0; i < b.length; i++) {
        if (t >= b.start(i) - 1 && t <= b.end(i) + 30) return b.end(i) - t
      }
      return Math.max(0, b.end(b.length - 1) - t)
    } catch {
      return 0
    }
  }

  isBuffered(t, pad = 0.4) {
    try {
      const b = this.el.buffered
      for (let i = 0; i < b.length; i++) {
        if (t >= b.start(i) - pad && t <= b.end(i) - 0.25) return true
      }
    } catch {
      /* ignore */
    }
    return false
  }

  async jumpWhenBuffered(target, gen) {
    for (let i = 0; i < 160; i++) {
      if (gen !== this.gen || this.destroyed) return
      if (this.isBuffered(target)) {
        try {
          this.el.currentTime = target
        } catch {
          /* ignore */
        }
        return
      }
      await sleep(120)
    }
  }

  async onSeeking() {
    if (!this.ready || this.restarting || this.destroyed) return
    const t = this.el.currentTime
    // 目标点超出已知总时长（例如从长分P的进度续播到一个更短的 P）：
    // 夹到末尾收工，否则会去做一次注定失败的 ranged 定位，播放器就永远停在「缓冲中…」
    const total = this.getDuration()
    if (this.saneSeconds(total) && t > total - 0.4) {
      dbg('seek 超出总时长，夹到末尾', t, '->', Math.max(0, total - 0.4))
      this.el.currentTime = Math.max(0, total - 0.4)
      return
    }
    if (this.isBuffered(t)) return
    // 记下跳转前的播放状态：openDash 会重建 MediaSource（元素被重置为暂停），
    // 不记住的话跳转后就停在暂停态不动了（拖一次进度条视频就「死」住）
    const resume = !this.el.paused || this.wasPlaying
    this.restarting = true
    this.status('正在跳转…')
    const payload = this.payload
    try {
      if (payload) await this.openDash(payload, t)
      const vol = this.el.volume
      this.el.volume = vol
      if (resume) {
        this.wasPlaying = true
        // openDash 里可能重建过 SourceBuffer（元素被重置成暂停），而重建又是异步的，
        // 所以这里用 ensurePlaying 反复确认，直到元素真的回到播放状态
        await this.ensurePlaying(this.gen, 6)
      }
    } catch (err) {
      this.hooks.onError && this.hooks.onError(err)
    } finally {
      this.restarting = false
    }
  }

  /** range 请求小工具：返回 {status, bytes} 或 null */
  async fetchBytes(url, start, end, gen) {
    const ac = new AbortController()
    this.aborts.add(ac)
    const timer = setTimeout(() => {
      try {
        ac.abort()
      } catch {
        /* ignore */
      }
    }, 8000)
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Range: `bytes=${start}-${end}` },
        signal: ac.signal
      })
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`)
      const want = end - start + 1
      // 有的 CDN（实测 mcdn.bilivideo.cn:8082）忽略 Range，直接 200 + 整个文件：
      // 这时必须只读前 want 字节就掐断，否则这次探测会把整条视频下载完 —— 续播/拖动进度条看起来就是「一直缓冲」
      if (res.status !== 206 && res.body) {
        const reader = res.body.getReader()
        const parts = []
        let got = 0
        while (got < want) {
          const { done, value } = await reader.read()
          if (done) break
          parts.push(value)
          got += value.byteLength
        }
        try {
          await reader.cancel()
        } catch {
          /* ignore */
        }
        if (gen != null && gen !== this.gen) return null
        return { status: res.status, bytes: concatBytes(parts, got) }
      }
      const buf = new Uint8Array(await res.arrayBuffer())
      if (gen != null && gen !== this.gen) return null
      return { status: res.status, bytes: buf }
    } finally {
      clearTimeout(timer)
      this.aborts.delete(ac)
    }
  }

  status(text) {
    this.hooks.onStatus && this.hooks.onStatus(text)
  }

  /* --- 对外控制 --- */
  play() {
    this.wasPlaying = true
    return this.el.play().catch(() => {})
  }

  pause() {
    this.wasPlaying = false
    this.el.pause()
  }

  seek(t) {
    const target = Math.max(0, Math.min(t, this.getDuration() || t))
    try {
      this.el.currentTime = target
    } catch {
      /* ignore */
    }
  }

  setVolume(v) {
    this.el.volume = Math.min(1, Math.max(0, v))
  }

  setMuted(m) {
    this.el.muted = Boolean(m)
  }

  teardownMedia() {
    for (const ac of this.aborts) {
      try {
        ac.abort()
      } catch {
        /* ignore */
      }
    }
    this.aborts.clear()
    if (this.flv) {
      try {
        this.flv.destroy()
      } catch {
        /* ignore */
      }
      this.flv = null
    }
    for (const sb of [this.vsb, this.asb]) {
      if (!sb) continue
      try {
        if (this.ms && this.ms.readyState === 'open' && !sb.updating) this.ms.removeSourceBuffer(sb)
      } catch {
        /* ignore */
      }
    }
    this.vsb = null
    this.asb = null
    try {
      if (this.ms && this.ms.readyState === 'open') this.ms.endOfStream()
    } catch {
      /* ignore */
    }
    this.ms = null
    if (this.objectUrl) {
      try {
        URL.revokeObjectURL(this.objectUrl)
      } catch {
        /* ignore */
      }
      this.objectUrl = ''
    }
    try {
      if (this.el.getAttribute('src')) {
        this.el.removeAttribute('src')
        this.el.load()
      }
    } catch {
      /* ignore */
    }
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

export default DashPlayer
