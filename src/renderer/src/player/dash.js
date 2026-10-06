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
 * 最后按带宽降序。
 *
 * 为什么必须先按 id 过滤：playurl 里同一编码可能带 1080P+/1080P/720P/480P/360P 多条轨，
 * 只看带宽会永远挑到最高那条 —— 用户选了 720P 却在拉 1080P+（实测日志 avc1.640033 ≈ 1080P+，
 * 而 UI 显示「当前 720P」），解码压力大、更容易卡顿。
 */
export function pickVideoTrack(tracks = [], preferQuality = 0) {
  const usable = [...tracks].filter((t) => trackUrl(t))
  if (!usable.length) return undefined
  const wanted = Number(preferQuality) || 0
  const matched = wanted ? usable.filter((t) => Number(t.id) === wanted) : []
  const pool = matched.length ? matched : usable
  return pool.sort((a, b) => videoRank(a) - videoRank(b) || (b.bandwidth || 0) - (a.bandwidth || 0))[0]
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

  const version = head[box.offset + 8]
  const body = new DataView(head.buffer, head.byteOffset + box.offset + box.headerSize)
  let p = 0
  p += 4 // reference_ID
  const timescale = body.getUint32(p)
  p += 4
  let firstOffset = 0
  if (version === 0) {
    p += 4
    firstOffset = body.getUint32(p)
    p += 4
  } else {
    p += 8
    firstOffset = Number(body.getBigUint64(p))
    p += 8
  }
  p += 2
  const count = body.getUint16(p)
  p += 2
  const refs = []
  for (let i = 0; i < count && p + 12 <= body.byteLength; i++) {
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
    this.aborts = new Set()
    this.usedFallbackFromZero = false
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
    on('pause', () => this.hooks.onState && this.hooks.onState('paused'))
    on('waiting', () => this.hooks.onState && this.hooks.onState('waiting'))
    on('error', () => {
      // 重建流时清空 src 会触发一次空错误，这里忽略
      if (!this.ready || this.restarting || this.destroyed) return
      const e = el.error
      if (e && this.hooks.onError) this.hooks.onError(new Error(`媒体错误 code=${e.code}`))
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
      try {
        await this.el.play()
      } catch {
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
    this.ms = new MediaSource()
    this.objectUrl = URL.createObjectURL(this.ms)
    this.el.src = this.objectUrl
    await waitEvent(this.ms, 'sourceopen', 8000)
    if (this.destroyed || gen !== this.gen) {
      dbg('abort after sourceopen', 'destroyed=' + this.destroyed, 'gen=' + gen, 'cur=' + this.gen)
      return
    }
    dbg('sourceopen ok, readyState=' + this.ms.readyState)

    this.vsb = this.ms.addSourceBuffer(vMime)
    this.vsb.mode = 'segments'
    this.asb = null
    const aMime = `audio/mp4; codecs="${audio.codecs}"`
    if (window.MediaSource.isTypeSupported(aMime)) {
      try {
        this.asb = this.ms.addSourceBuffer(aMime)
        this.asb.mode = 'segments'
      } catch {
        this.asb = null
      }
    }

    this.status('缓冲中…')
    // MSE 必须先有 duration 才会进 HAVE_METADATA；但若时长是垃圾值（小到不可能，例如 1000ms），
    // Chromium 会把超出该时长的帧全部丢掉（buffered 一直 empty、画面永远「缓冲中…」）。
    // 所以：payload 时长合理才用 → 否则用页面给的 hint → 都不合理就先给 Infinity，
    // 等整条轨拉完后由 settleDuration() 用 buffered 末尾修回真实时长。
    const dur = this.saneSeconds(this.duration) ? this.duration : this.saneSeconds(this.durationHint) ? this.durationHint : Infinity
    try {
      this.ms.duration = dur
      dbg('ms.duration =', dur === Infinity ? 'Infinity(待收尾修正)' : dur)
    } catch {
      /* ignore */
    }
    const vUrls = trackUrls(video)
    const aUrls = trackUrls(audio)

    // 起流不阻塞 load()：一边拉一边播。只等首段数据进来就返回，
    // 否则 load() 要等整条视频拉完才 resolve —— 学习计时器/状态文案都会被卡死。
    const streaming = Promise.all([
      this.startTrack('video', vUrls, gen, start),
      this.startTrack('audio', aUrls, gen, start)
    ])
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

  /** 从字节 0 顺序拉完整条轨；若 needSeek 则先 append init 段再从目标偏移续传。 */
  async startTrack(kind, urls, gen, start) {
    const sb = kind === 'video' ? this.vsb : this.asb
    if (!sb || !urls.length) return

    if (start > 1) {
      const ranged = await this.tryRangedStart(kind, urls, gen, start)
      if (ranged) {
        this.settleDuration()
        return
      }
      this.usedFallbackFromZero = true
    }
    await this.streamFrom(kind, urls, gen, 0)
    this.settleDuration()
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

  async tryRangedStart(kind, urls, gen, start) {
    for (const url of urls) {
      try {
        const head = await this.fetchBytes(url, 0, HEAD_PROBE_BYTES - 1, gen)
        if (!head) return false
        if (head.status !== 206) return false
        const sidx = parseSidx(head.bytes)
        if (!sidx) return false
        const initBytes = head.bytes.subarray(0, sidx.initEnd)
        if (!(await this.append(kind, initBytes, gen))) return false
        const offset = sidxByteOffsetForTime(sidx, start)
        await this.streamFrom(kind, [url], gen, offset)
        return true
      } catch {
        /* 换下一个备用地址 */
      }
    }
    return false
  }

  /**
   * 以 Range 续传并逐块 append。
   * @param {number} offset 起始字节（0 表示从头，含 init 段）
   */
  async streamFrom(kind, urls, gen, offset) {
    let lastErr = null
    for (const url of urls) {
      if (gen !== this.gen || this.destroyed) return
      const ac = new AbortController()
      this.aborts.add(ac)
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
          signal: ac.signal
        })
        dbg('streamFrom', kind, 'offset=' + offset, 'status=' + res.status, 'url=' + url.slice(0, 90))
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
          return this.append(kind, bytes, gen)
        }
        for (;;) {
          if (gen !== this.gen || this.destroyed) {
            try {
              await reader.cancel()
            } catch {
              /* ignore */
            }
            return
          }
          while (this.ahead(kind) > AHEAD_MAX && gen === this.gen && !this.destroyed) {
            if (!(await flush())) return // 背压时先把攒下的数据交出去，避免手里囤着没 append 的块
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
            if (!(await flush())) return
          }
          if (kind === 'video' && this.usedFallbackFromZero && offset === 0) {
            this.status('缓冲中… 已加载 ' + Math.round(readBytes / 1048576) + 'MB')
          }
        }
        if (!(await flush())) return
        this.aborts.delete(ac)
        return
      } catch (err) {
        this.aborts.delete(ac)
        lastErr = err
        if (gen !== this.gen || this.destroyed) return
      }
    }
    if (lastErr && gen === this.gen && !this.destroyed) {
      this.hooks.onError && this.hooks.onError(new Error(`拉流失败：${lastErr.message}`))
    }
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
    if (this.isBuffered(t)) return
    this.restarting = true
    this.status('正在跳转…')
    const payload = this.payload
    try {
      if (payload) await this.openDash(payload, t)
      const vol = this.el.volume
      this.el.volume = vol
      if (this.wasPlaying) await this.el.play().catch(() => {})
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
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Range: `bytes=${start}-${end}` },
        signal: ac.signal
      })
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`)
      const buf = new Uint8Array(await res.arrayBuffer())
      if (gen != null && gen !== this.gen) return null
      return { status: res.status, bytes: buf }
    } finally {
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
  }

  destroy() {
    this.destroyed = true
    this.gen++
    this.detach()
    this.teardownMedia()
  }
}

export default DashPlayer
