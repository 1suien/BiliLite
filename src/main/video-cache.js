import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { BASE_HEADERS, cookieHeader, fixUrl } from './bili/http.js'
import { store } from './store.js'

/**
 * 视频离线缓存（主进程）。
 *
 * 目录结构：`<userData>/offline-cache/<bvid>/<cid>/{meta.json,v.m4s,a.m4s[,export.mp4]}`
 *  - v.m4s / a.m4s 就是 B 站 DASH 的原始分片流（fMP4），**不改一个字节**，所以离线播放
 *    只需要把播放器的取流地址换成 `bcache://` 自定义协议（见 cache-protocol.js）。
 *  - meta.json 记录画质、音视频轨参数（codecs/带宽/尺寸）与时长 —— 播放器需要这些来
 *    构造 MediaSource。这些参数在 playurl 里才有，缓存时必须存下来，否则离线时无从得知。
 *
 * 下载策略：
 *  - 先探一次 `Range: bytes=0-0` 拿总长度（同时确认服务端支持 Range）；
 *  - 支持 Range 且知道总长 → 3 个 worker 并行拉 2MB 分片，各自 `write(buf, 0, len, pos)`
 *    写到自己的偏移上（续传安全、速度快）；
 *  - 拿不到总长（少数 CDN 直接返回 200 全量）→ 单线程顺序追加，遇到短读即结束。
 */

const META_FILE = 'meta.json'
export const CACHE_V = 'v.m4s'
export const CACHE_A = 'a.m4s'
export const CACHE_MP4 = 'export.mp4'
export const CACHE_FILES = [CACHE_V, CACHE_A, CACHE_MP4]

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/
const CHUNK_BYTES = 2 * 1024 * 1024
const WORKERS = 3
const RETRY = 3

let ctx = { root: '', getPlayurl: null, onProgress: () => {} }
/** key -> 进行中的任务 */
const tasks = new Map()

export function initVideoCache({ root, getPlayurl, onProgress }) {
  ctx.root = root
  ctx.getPlayurl = getPlayurl
  if (typeof onProgress === 'function') ctx.onProgress = onProgress
  try {
    fs.mkdirSync(root, { recursive: true })
  } catch (err) {
    console.warn('[cache] 建缓存目录失败：', err && err.message)
  }
}

/** 默认根目录（`<userData>/offline-cache`），设置页拿它做「恢复默认位置」。 */
export function defaultCacheRoot() {
  return ctx.root
}

/** 用户在设置里指定的缓存目录；空串/相对路径都算没设。 */
function customRoot() {
  const raw = store.state.settings.cacheDir
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s || !path.isAbsolute(s)) return ''
  return s
}

/**
 * 当前生效的缓存根目录。自定义目录不可写时回退默认目录（宁可放默认位置，也不要写失败）。
 * 注意：`bcache://` 协议也走这个函数，所以改目录后离线播放会立刻跟着换。
 */
export function cacheRootPath() {
  const custom = customRoot()
  if (!custom) return ctx.root
  try {
    fs.mkdirSync(custom, { recursive: true })
    return custom
  } catch (err) {
    console.warn('[cache] 自定义缓存目录不可用，回退默认位置：', err && err.message)
    return ctx.root
  }
}

export function cacheKey(bvid, cid) {
  return `${bvid}:${cid}`
}

function clean(value) {
  const s = String(value == null ? '' : value)
  return NAME_RE.test(s) ? s : ''
}

/** 由 bvid/cid 推出缓存目录（参数非法时返回空串，调用方要判空）。 */
export function cacheDir(bvid, cid) {
  const b = clean(bvid)
  const c = clean(cid)
  const root = cacheRootPath()
  if (!b || !c || !root) return ''
  return path.join(root, b, c)
}

/** 渲染层/播放器用的离线取流地址。 */
export function cacheFileUrl(bvid, cid, name) {
  const b = clean(bvid)
  const c = clean(cid)
  if (!b || !c || !CACHE_FILES.includes(name)) return ''
  return `bcache://media/${b}/${c}/${name}`
}

export function maxBytes() {
  const mb = Number(store.state.settings.cacheMaxMB)
  return (Number.isFinite(mb) && mb > 0 ? mb : 4096) * 1024 * 1024
}

async function readMeta(bvid, cid) {
  const dir = cacheDir(bvid, cid)
  if (!dir) return null
  try {
    const raw = await fsp.readFile(path.join(dir, META_FILE), 'utf8')
    const meta = JSON.parse(raw)
    return meta && typeof meta === 'object' ? meta : null
  } catch {
    return null
  }
}

async function writeMeta(bvid, cid, meta) {
  const dir = cacheDir(bvid, cid)
  if (!dir) throw new Error('缓存路径不合法')
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, META_FILE)
  await fsp.writeFile(file + '.tmp', JSON.stringify(meta, null, 2), 'utf8')
  await fsp.rename(file + '.tmp', file)
  return meta
}

async function fileSize(file) {
  try {
    const st = await fsp.stat(file)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

function round1(n) {
  return Math.round(Number(n) || 0)
}

/** 一条缓存记录（列表用），带磁盘上的真实大小。 */
async function describe(bvid, cid, meta) {
  const dir = cacheDir(bvid, cid)
  const vBytes = await fileSize(path.join(dir, CACHE_V))
  const aBytes = await fileSize(path.join(dir, CACHE_A))
  const mp4Bytes = await fileSize(path.join(dir, CACHE_MP4))
  const key = cacheKey(bvid, cid)
  return {
    key,
    bvid,
    cid,
    title: meta.title || '',
    page: meta.page || 1,
    partTitle: meta.partTitle || '',
    upName: meta.upName || '',
    cover: meta.cover || '',
    duration: meta.duration || 0,
    quality: meta.quality || 0,
    qualityLabel: meta.qualityLabel || '',
    vCodecs: meta.vCodecs || '',
    aCodecs: meta.aCodecs || '',
    vId: meta.vId || 0,
    aId: meta.aId || 0,
    width: meta.width || 0,
    height: meta.height || 0,
    frameRate: meta.frameRate || '',
    vBandwidth: meta.vBandwidth || 0,
    aBandwidth: meta.aBandwidth || 0,
    bytes: vBytes + aBytes,
    vBytes,
    aBytes,
    mp4Bytes,
    done: Boolean(meta.done) && vBytes > 0,
    createdAt: meta.createdAt || 0,
    updatedAt: meta.updatedAt || 0,
    files: {
      video: CACHE_V,
      audio: aBytes > 0 ? CACHE_A : '',
      mp4: mp4Bytes > 0 ? CACHE_MP4 : ''
    }
  }
}

/** 缓存列表（按加入时间倒序）。 */
export async function listCache() {
  const out = []
  const root = cacheRootPath()
  if (!root) return out
  let bvids = []
  try {
    bvids = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const b of bvids) {
    if (!b.isDirectory() || !clean(b.name)) continue
    let cids = []
    try {
      cids = await fsp.readdir(path.join(root, b.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const c of cids) {
      if (!c.isDirectory() || !clean(c.name)) continue
      const meta = await readMeta(b.name, c.name)
      if (!meta) continue
      const row = await describe(b.name, c.name, meta)
      const task = tasks.get(row.key)
      if (task) row.progress = task.public()
      out.push(row)
    }
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return out
}

/** 占用统计（给设置页与缓存页用）。 */
export async function cacheStats() {
  const rows = await listCache()
  const bytes = rows.reduce((n, r) => n + (r.bytes || 0), 0)
  const max = maxBytes()
  return {
    bytes,
    maxBytes: max,
    count: rows.length,
    videos: new Set(rows.map((r) => r.bvid)).size,
    over: bytes > max
  }
}

/** 某个分P是否已缓存完（离线播放用）。 */
export async function lookupCache(bvid, cid) {
  const meta = await readMeta(bvid, cid)
  if (!meta) return null
  const row = await describe(bvid, cid, meta)
  if (!row.done) return null
  row.urls = {
    video: cacheFileUrl(bvid, cid, CACHE_V),
    audio: row.aBytes > 0 ? cacheFileUrl(bvid, cid, CACHE_A) : '',
    mp4: row.mp4Bytes > 0 ? cacheFileUrl(bvid, cid, CACHE_MP4) : ''
  }
  return row
}

/**
 * 删除目录并重试。
 *
 * Windows 上「目录已空但 rmdir 报 ENOTEMPTY/EBUSY」很常见：文件刚被 unlink 掉，但
 * 还有别的进程（最典型的是渲染层那个正在读 export.mp4 的 `<video>`）没释放句柄，
 * 目录项要等句柄关闭后才消失。所以这里退避重试几次，最后再用 force 兜底。
 */
async function rmWithRetry(dir, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fsp.rm(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (i === attempts - 1) throw err
      await new Promise((r) => setTimeout(r, 120 * (i + 1)))
    }
  }
}

export async function removeCache(key) {
  const [bvid, cid] = String(key || '').split(':')
  const dir = cacheDir(bvid, cid)
  if (!dir) return { removed: false }
  const task = tasks.get(String(key))
  if (task) task.cancel()
  await rmWithRetry(dir)
  return { removed: true }
}

export async function clearCache() {
  for (const task of tasks.values()) task.cancel()
  const root = cacheRootPath()
  if (!root) return { removed: 0 }
  const rows = await listCache()
  await rmWithRetry(root)
  await fsp.mkdir(root, { recursive: true })
  return { removed: rows.length }
}

export async function revealCache(key) {
  const [bvid, cid] = String(key || '').split(':')
  const dir = cacheDir(bvid, cid)
  if (!dir) throw new Error('缓存路径不合法')
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------

function headersFor(extra) {
  const jar = cookieHeader()
  return { ...BASE_HEADERS, ...(jar ? { Cookie: jar } : {}), ...(extra || {}) }
}

/** 探一次 Range，拿总长度并确认服务端支持 Range。 */
async function probeTrack(urls, signal) {
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: headersFor({ Range: 'bytes=0-1' }), signal })
      if (!res.ok && res.status !== 206) continue
      const cr = res.headers.get('content-range') || ''
      const m = /\/(\d+)\s*$/.exec(cr)
      if (res.status === 206 && m) {
        try {
          await res.body?.cancel()
        } catch {
          /* ignore */
        }
        return { total: Number(m[1]) || 0, range: true }
      }
      const len = Number(res.headers.get('content-length')) || 0
      try {
        await res.body?.cancel()
      } catch {
        /* ignore */
      }
      if (len > 0) return { total: len, range: false }
    } catch (err) {
      if (err && err.name === 'AbortError') throw err
    }
  }
  return { total: 0, range: false }
}

async function fetchChunk(urls, start, end, signal) {
  let lastErr = null
  for (let attempt = 0; attempt < RETRY; attempt++) {
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          headers: headersFor({ Range: `bytes=${start}-${end}` }),
          signal
        })
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status}`)
          continue
        }
        const buf = Buffer.from(await res.arrayBuffer())
        if (!buf.length) {
          lastErr = new Error('分片为空')
          continue
        }
        return buf
      } catch (err) {
        if (err && err.name === 'AbortError') throw err
        lastErr = err
      }
    }
  }
  throw lastErr || new Error('分片下载失败')
}

/** 并行拉一个轨（需要先知道总长）。 */
async function downloadParallel(task, kind, urls, dest, total) {
  const progress = kind === 'video' ? task.video : task.audio
  progress.total = total
  let done = await fileSize(dest)
  progress.done = Math.min(done, total)
  task.report()
  if (done >= total) return total

  const fd = await fsp.open(dest, done > 0 ? 'r+' : 'w+')
  let cursor = done
  let failed = null
  const worker = async () => {
    for (;;) {
      if (task.cancelled) return
      if (failed) return
      const start = cursor
      if (start >= total) return
      cursor = Math.min(start + CHUNK_BYTES, total)
      const end = cursor - 1
      try {
        const buf = await fetchChunk(urls, start, end, task.signal())
        await fd.write(buf, 0, buf.length, start)
        done += buf.length
        progress.done = Math.min(done, total)
        task.report()
      } catch (err) {
        if (err && err.name === 'AbortError') return
        failed = err
        return
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(WORKERS, 4) }, worker))
  } finally {
    try {
      await fd.close()
    } catch {
      /* ignore */
    }
  }
  if (task.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true })
  if (failed) throw failed
  const size = await fileSize(dest)
  if (size > total) {
    // 极端情况下多写了尾巴（服务端忽略 Range 返回全量）——按 total 截断，避免污染后续解析
    try {
      await fsp.truncate(dest, total)
    } catch {
      /* ignore */
    }
  }
  progress.done = Math.min(size, total)
  task.report()
  return progress.done
}

/** 顺序追加拉一个轨（拿不到总长时的兜底）。 */
async function downloadSequential(task, kind, urls, dest) {
  const progress = kind === 'video' ? task.video : task.audio
  let start = await fileSize(dest)
  progress.done = start
  const fd = await fsp.open(dest, start > 0 ? 'a' : 'w')
  try {
    for (;;) {
      if (task.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true })
      const end = start + CHUNK_BYTES - 1
      let buf = null
      try {
        buf = await fetchChunk(urls, start, end, task.signal())
      } catch (err) {
        if (start > 0) break // 已经把能拿的都拿到了
        throw err
      }
      await fd.write(buf, 0, buf.length, null)
      start += buf.length
      progress.done = start
      if (!progress.total) progress.total = start
      task.report()
      if (buf.length < CHUNK_BYTES) break
    }
  } finally {
    try {
      await fd.close()
    } catch {
      /* ignore */
    }
  }
  progress.total = progress.done
  task.report()
  return progress.done
}

/**
 * 在 playurl 里挑轨：优先精确画质，其次不超过该画质的最高档，最后退回最低档。
 *
 * 同一个画质 id 通常在 dash.video 里有 av01 / avc1 / hevc 三条（编码不同、体积不同）。
 * 这里刻意优先 avc1（H.264）：本地缓存要同时喂给 MSE 播放和自写的 MP4 remux，
 * H.264 在这两条路上兼容性最好；AV1 在部分显卡/解码器上会放不出来，H.265 更挑环境。
 */
export function pickTracks(dash, qn) {
  const rank = (t) => {
    const c = String((t && t.codecs) || '')
    if (/^avc1/i.test(c)) return 0
    if (/^(hev1|hvc1)/i.test(c)) return 1
    if (/^av01/i.test(c)) return 2
    return 3
  }
  const best = (list) =>
    list.length
      ? list
          .slice()
          .sort((a, b) => rank(a) - rank(b) || (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0))[0]
      : null
  const sameId = (list, id) => best(list.filter((t) => Number(t.id) === id))
  const videos = (dash?.video || []).filter((t) => t && t.url)
  if (!videos.length) return null
  const want = Number(qn) || 0
  const lower = videos.filter((t) => Number(t.id) < want).sort((a, b) => Number(b.id) - Number(a.id))
  const higher = videos.filter((t) => Number(t.id) > want).sort((a, b) => Number(a.id) - Number(b.id))
  const video =
    sameId(videos, want) ||
    (lower.length ? sameId(videos, lower[0].id) : null) ||
    (higher.length ? sameId(videos, higher[0].id) : null) ||
    best(videos)
  const audios = (dash?.audio || []).filter((t) => t && t.url)
  // 优先 mp4a（MediaSource 兼容性最好），其余按带宽从高到低
  const audio =
    audios.find((t) => /mp4a/i.test(t.codecs || '')) ||
    audios.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0] ||
    null
  return { video, audio }
}

/** 只探测大小，不下载（「缓存」弹层里显示预计占用）。 */
export async function probeCache({ bvid, cid, qn }) {
  const data = await ctx.getPlayurl(bvid, cid, Number(qn) || 80)
  const picked = pickTracks(data.dash, qn || data.quality)
  if (!picked) throw new Error('这个视频拿不到可缓存的 DASH 流')
  const vUrls = [picked.video.url, ...(picked.video.backup || [])].map(fixUrl).filter(Boolean)
  const aUrls = picked.audio ? [picked.audio.url, ...(picked.audio.backup || [])].map(fixUrl).filter(Boolean) : []
  const [v, a] = await Promise.all([probeTrack(vUrls), aUrls.length ? probeTrack(aUrls) : { total: 0 }])
  return {
    video: {
      id: picked.video.id,
      codecs: picked.video.codecs,
      width: picked.video.width,
      height: picked.video.height,
      bandwidth: picked.video.bandwidth,
      frameRate: picked.video.frameRate,
      bytes: v.total
    },
    audio: picked.audio
      ? { id: picked.audio.id, codecs: picked.audio.codecs, bandwidth: picked.audio.bandwidth, bytes: a.total }
      : null,
    total: v.total + a.total,
    quality: picked.video.id,
    duration: data.dash?.duration || 0,
    acceptQuality: data.acceptQuality || [],
    acceptDescription: data.acceptDescription || []
  }
}

class CacheTask {
  constructor(req) {
    this.key = cacheKey(req.bvid, req.cid)
    this.req = req
    this.cancelled = false
    this.controller = new AbortController()
    this.stage = 'start'
    this.message = ''
    this.video = { done: 0, total: 0 }
    this.audio = { done: 0, total: 0 }
    this.meta = null
    this.startedAt = Date.now()
    this.finishedAt = 0
    this.error = ''
  }

  signal() {
    return this.controller.signal
  }

  cancel() {
    this.cancelled = true
    try {
      this.controller.abort()
    } catch {
      /* ignore */
    }
  }

  report() {
    ctx.onProgress(this.public())
  }

  public() {
    const v = this.video
    const a = this.audio
    const done = v.done + a.done
    const total = v.total + a.total
    return {
      key: this.key,
      bvid: this.req.bvid,
      cid: this.req.cid,
      stage: this.stage,
      message: this.message,
      error: this.error,
      done,
      total,
      pct: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0,
      video: { done: round1(v.done), total: round1(v.total) },
      audio: { done: round1(a.done), total: round1(a.total) },
      speed: 0,
      title: this.req.title || '',
      partTitle: this.req.partTitle || '',
      page: this.req.page || 1,
      quality: this.req.qn || 0,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt
    }
  }
}

async function runTask(task) {
  const { bvid, cid, qn } = task.req
  try {
    task.stage = 'probe'
    task.message = '正在解析地址'
    task.report()

    const data = await ctx.getPlayurl(bvid, cid, Number(qn) || 80)
    const picked = pickTracks(data.dash, qn || data.quality)
    if (!picked) throw new Error('这个视频拿不到可缓存的 DASH 流')

    const video = picked.video
    const audio = picked.audio
    const dir = cacheDir(bvid, cid)
    if (!dir) throw new Error('缓存路径不合法')
    await fsp.mkdir(dir, { recursive: true })

    const vUrls = [video.url, ...(video.backup || [])].map(fixUrl).filter(Boolean)
    const aUrls = audio ? [audio.url, ...(audio.backup || [])].map(fixUrl).filter(Boolean) : []

    const meta = {
      bvid,
      cid,
      title: task.req.title || '',
      partTitle: task.req.partTitle || '',
      page: task.req.page || 1,
      upName: task.req.upName || '',
      cover: task.req.cover || '',
      duration: data.dash?.duration || 0,
      quality: video.id,
      qualityLabel: task.req.qualityLabel || '',
      vId: video.id,
      vCodecs: video.codecs || '',
      width: video.width || 0,
      height: video.height || 0,
      frameRate: video.frameRate || '',
      vBandwidth: video.bandwidth || 0,
      aId: audio ? audio.id : 0,
      aCodecs: audio ? audio.codecs || '' : '',
      aBandwidth: audio ? audio.bandwidth || 0 : 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      done: false
    }
    task.meta = meta
    await writeMeta(bvid, cid, meta)

    task.stage = 'video'
    task.message = '正在缓存视频轨'
    const destV = path.join(dir, CACHE_V)
    const pv = await probeTrack(vUrls, task.signal())
    if (pv.range && pv.total > 0) await downloadParallel(task, 'video', vUrls, destV, pv.total)
    else await downloadSequential(task, 'video', vUrls, destV)

    if (aUrls.length) {
      task.stage = 'audio'
      task.message = '正在缓存音频轨'
      const destA = path.join(dir, CACHE_A)
      const pa = await probeTrack(aUrls, task.signal())
      if (pa.range && pa.total > 0) await downloadParallel(task, 'audio', aUrls, destA, pa.total)
      else await downloadSequential(task, 'audio', aUrls, destA)
    }

    meta.done = true
    meta.updatedAt = Date.now()
    await writeMeta(bvid, cid, meta)
    task.stage = 'done'
    task.message = '缓存完成'
    task.finishedAt = Date.now()
    task.report()
    return await describe(bvid, cid, meta)
  } catch (err) {
    if (task.cancelled || (err && (err.cancelled || err.name === 'AbortError'))) {
      task.stage = 'cancel'
      task.message = '已取消'
      task.report()
      return null
    }
    task.stage = 'error'
    task.error = (err && err.message) || '下载失败'
    task.message = task.error
    task.finishedAt = Date.now()
    task.report()
    console.error('[cache] 下载失败：', task.key, task.error)
    return null
  } finally {
    setTimeout(() => tasks.delete(task.key), 1500).unref?.()
  }
}

/** 开始缓存一个分P（同一分P重复调用会复用进行中的任务）。 */
export async function startCache(req) {
  if (!ctx.getPlayurl) throw new Error('缓存模块还没初始化')
  const bvid = clean(req?.bvid)
  const cid = clean(req?.cid)
  if (!bvid || !cid) throw new Error('bvid / cid 不合法')
  const key = cacheKey(bvid, cid)
  const running = tasks.get(key)
  if (running) return running.public()

  const stats = await cacheStats()
  const max = stats.maxBytes
  if (stats.bytes >= max) {
    throw new Error(`缓存已占满（${(stats.bytes / 1048576).toFixed(0)}MB / 上限 ${(max / 1048576).toFixed(0)}MB），先去缓存页删掉一些`)
  }

  const task = new CacheTask({ ...req, bvid, cid })
  tasks.set(key, task)
  task.report()
  runTask(task).catch((err) => console.error('[cache] 任务异常：', err))
  return task.public()
}

export function runningTasks() {
  return Array.from(tasks.values()).map((t) => t.public())
}

export function cancelCache(key) {
  const task = tasks.get(String(key || ''))
  if (!task) return { cancelled: false }
  task.cancel()
  return { cancelled: true }
}

// ---------------------------------------------------------------------------
// 导出通用 MP4（remux，不重新编码）
// ---------------------------------------------------------------------------

/** 导出成能被系统播放器双击打开的普通 MP4；返回输出文件信息。 */
export async function exportCache(key, { outPath } = {}) {
  const [bvid, cid] = String(key || '').split(':')
  const dir = cacheDir(bvid, cid)
  if (!dir) throw new Error('缓存路径不合法')
  const vPath = path.join(dir, CACHE_V)
  const aPath = path.join(dir, CACHE_A)
  if (!(await fileSize(vPath))) throw new Error('这个缓存还没有视频数据')
  const meta = (await readMeta(bvid, cid)) || {}
  const target = outPath || path.join(dir, CACHE_MP4)

  const { remuxDashToMp4 } = await import('./mp4/remux.js')
  const hasAudio = (await fileSize(aPath)) > 0
  const result = await remuxDashToMp4({
    videoPath: vPath,
    audioPath: hasAudio ? aPath : undefined,
    outPath: target
  })
  if (!outPath) {
    meta.updatedAt = Date.now()
    await writeMeta(bvid, cid, meta)
  }
  return { path: target, bytes: result?.bytes || (await fileSize(target)), ...result }
}
