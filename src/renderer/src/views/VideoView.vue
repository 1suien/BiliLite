<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'
import { DashPlayer } from '../player/dash.js'
import BiliImage from '../components/BiliImage.vue'
import Icon from '../components/Icon.vue'
import EmptyBlock from '../components/EmptyBlock.vue'
import PartList from '../components/PartList.vue'
import CollectModal from '../components/CollectModal.vue'
import { useLearnStore } from '../stores/learn'
import { useCollectStore } from '../stores/collect'
import { useUpsStore, DEFAULT_GROUP } from '../stores/ups'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useAuthStore } from '../stores/auth'
import { useMiniStore } from '../stores/mini'
import { fmtCount, fmtDate, fmtDuration, parseDuration } from '../utils/format'
import { qnLabel, sortQuality } from '../utils/quality'
import { db, listLocalSubs, putLocalSub, removeLocalSub } from '../db'
import { decodeSubtitleBytes, isSubtitleFile, parseSubtitle, subExt } from '../utils/subtitle'

const route = useRoute()
const router = useRouter()
const learn = useLearnStore()
const collect = useCollectStore()
const ups = useUpsStore()
const settings = useSettingsStore()
const ui = useUiStore()
const auth = useAuthStore()
const mini = useMiniStore()

/** 这个小窗现在放的就是当前视频吗（决定按钮显示「小窗播放」还是「正在小窗播放」） */
const miniHere = computed(() => mini.open && mini.bvid === bvid.value)

const bvid = computed(() => String(route.params.bvid || ''))
const videoEl = ref(null)
const wrapEl = ref(null)

let player = null
let tickTimer = null
let saveTimer = null
let pendingSeconds = 0
let lastSavedSeconds = -1
let lastVolumeSent = 0
/** 本次播放累计观看秒数（自动打卡判断用） */
let watchedTotal = 0
let autoChecked = false

const loading = ref(true)
const errorMsg = ref('')
const statusText = ref('')
const view = ref(null)
const pageList = ref([])
const pageIndex = ref(0) // 0-based
const related = ref([])
const playurl = ref(null)
const quality = ref(0)
const actualQuality = ref(0) // 播放器实际选中的视频轨画质（服务端可能降级）
const isPlaying = ref(false)
const duration = ref(0)
const currentTime = ref(0)
const bufferedPct = ref(0)
const volume = ref(0.8)
const muted = ref(false)
const tab = ref('intro')
const noteText = ref('')
const notes = ref([])
const collectOpen = ref(false)

/* ── 播放器：倍速 / 字幕 / 控制栏 ───────── */
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
const speed = ref(1)
const speedMenu = ref(false)
const ccMenu = ref(false)
const ccList = ref([])
const ccLan = ref('')
const ccLoading = ref(false)
/** 在线字幕是按「分P」取的：记住上次取的是哪个 cid，切分P时要重新取（否则 P2 会显示 P1 的字幕） */
const ccCid = ref('')
/** 本地字幕：一个分P可以挂多份；localKey 是当前选中的那份 */
const localSubs = ref([])
const localKey = ref('')
/** 用户点了「关闭字幕」：此时即使加载了字幕也不显示，直到他重新选一份 */
const ccOff = ref(false)
const SUB_SIZES = [
  { v: 18, label: '小' },
  { v: 22, label: '中' },
  { v: 26, label: '大' },
  { v: 32, label: '特大' }
]
const SUB_POS = [
  { v: 8, label: '靠下' },
  { v: 30, label: '居中' },
  { v: 55, label: '靠上' }
]
const ctlVisible = ref(true)
let hideTimer = null

const info = computed(() => (view.value ? view.value : {}))
const cid = computed(() => {
  const p = pageList.value[pageIndex.value]
  return p ? p.cid : view.value && view.value.cid
})
const qualities = computed(() => {
  const data = playurl.value
  if (!data) return []
  const list = data.acceptQuality && data.acceptQuality.length ? data.acceptQuality : [data.quality]
  return sortQuality(list)
})
const pct = computed(() => (duration.value ? Math.min(100, (currentTime.value / duration.value) * 100) : 0))
const currentPageTitle = computed(() => {
  const p = pageList.value[pageIndex.value]
  const t = p ? p.title || p.part : ''
  return p && pageList.value.length > 1 ? `P${p.page} ${t || ''}`.trim() : ''
})
const inShelf = computed(() => (bvid.value ? learn.inShelf(bvid.value) : false))
const collectCount = computed(() => collect.items.filter((x) => x.bvid === bvid.value).length)
const collectTarget = computed(() => ({ ...meta(), upName: info.value.upName }))
const inUpsList = computed(() =>
  Boolean(info.value.upMid) && ups.items.some((x) => String(x.mid) === String(info.value.upMid))
)

/* 字幕 / 菜单 */
const menuOpen = computed(() => speedMenu.value || ccMenu.value)

/** 生效中的字幕 cues：本地选中的优先，其次在线选中的；点过「关闭字幕」就都不显示 */
const ccItems = computed(() => {
  if (ccOff.value) return []
  const local = localSubs.value.find((s) => s.key === localKey.value)
  if (local && local.items && local.items.length) return local.items
  const online = ccList.value.find((s) => s.lan === ccLan.value)
  return online && online.items ? online.items : []
})

const ccOn = computed(() => !ccOff.value && ccItems.value.length > 0)

const activeCc = computed(() => {
  const items = ccItems.value
  if (!items.length) return ''
  const t = currentTime.value
  let lo = 0
  let hi = items.length - 1
  let hit = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (items[mid].from <= t) {
      hit = items[mid]
      lo = mid + 1
    } else hi = mid - 1
  }
  if (!hit) return ''
  const end = hit.to || hit.from + 8
  return t <= end ? hit.content : ''
})

/** 字幕样式：字号 / 有没有背景遮罩 / 距舞台底部百分之多少（都在设置里存着） */
const ccStyle = computed(() => {
  const s = settings.settings
  return {
    fontSize: `${Number(s.subFontSize) || 22}px`,
    bottom: `${Number(s.subBottom) >= 0 ? Number(s.subBottom) : 10}%`,
    background: s.subBg ? '' : 'transparent',
    textShadow: s.subBg ? '' : '0 1px 4px rgba(0, 0, 0, 0.95)'
  }
})

function applyRate() {
  if (videoEl.value) videoEl.value.playbackRate = speed.value
}

async function setSpeed(v) {
  speed.value = v
  speedMenu.value = false
  applyRate()
  try {
    await settings.patch({ playbackRate: v })
  } catch {
    /* 设置落盘失败不影响播放 */
  }
}

/**
 * 取在线字幕。按 cid 记一份「已经取过谁」：切分P后必须重新取，
 * 不然 P2 会一直显示 P1 的字幕（老版本就有这个毛病）。
 */
async function loadSubtitles() {
  const cidNow = String(cid.value || '')
  if (!cidNow || ccLoading.value) return
  if (ccCid.value === cidNow && ccList.value.length) return
  ccLoading.value = true
  ccCid.value = cidNow
  ccList.value = []
  ccLan.value = ''
  try {
    const r = await api.video.subtitle(bvid.value, cidNow)
    ccList.value = (r && r.list) || []
    if (ccList.value.length && !ccOff.value && !localKey.value) ccLan.value = ccList.value[0].lan
  } catch {
    ccList.value = []
  } finally {
    ccLoading.value = false
  }
}

async function openCcMenu() {
  ccMenu.value = !ccMenu.value
  if (!ccMenu.value) return
  await loadLocalSubs()
  await loadSubtitles()
  if (!ccList.value.length && !localSubs.value.length) {
    ui.toast('这个视频没有可用字幕，可以点「选择字幕文件…」加载本地字幕')
  }
}

/** 选在线字幕：会清掉本地选择，避免两份字幕抢着显示 */
function pickCc(lan) {
  ccLan.value = lan
  localKey.value = ''
  ccOff.value = !lan
  ccMenu.value = false
}

/** 选本地字幕 */
function pickLocal(key) {
  localKey.value = key
  ccLan.value = ''
  ccOff.value = false
  ccMenu.value = false
}

/** 该分P上挂着的本地字幕（存 IndexedDB，下次打开同一分P自动带出来） */
async function loadLocalSubs(keep = true) {
  if (!bvid.value || !cid.value) return
  try {
    localSubs.value = await listLocalSubs(bvid.value, cid.value)
  } catch {
    localSubs.value = []
  }
  if (!localSubs.value.length) {
    localKey.value = ''
    return
  }
  const still = localSubs.value.some((s) => s.key === localKey.value)
  // 换分P/首次加载时：默认用第一份（除非用户已经点了「关闭字幕」）
  if (!still) localKey.value = keep && !ccOff.value ? localSubs.value[0].key : ''
}

/** 从磁盘上的一个字幕文件加进来（选文件、拖进来都走这里） */
async function addSubFromPath(path) {
  try {
    const file = await api.sys.readSubtitle(path)
    const text = decodeSubtitleBytes(file.bytes)
    const { format, items } = parseSubtitle(text, subExt(file.name))
    if (!items.length) {
      ui.toast(`${file.name}：没解析出字幕内容（支持 srt / vtt / ass）`)
      return false
    }
    const row = await putLocalSub({
      bvid: bvid.value,
      cid: cid.value,
      name: file.name,
      format,
      items
    })
    if (!row) {
      ui.toast('字幕保存失败（这个分P还没准备好？）')
      return false
    }
    await loadLocalSubs()
    pickLocal(row.key)
    ui.toast(`已加载字幕 ${file.name}（${items.length} 句）`)
    return true
  } catch (err) {
    ui.toast((err && err.message) || '读字幕失败')
    return false
  }
}

async function pickSubtitleFile() {
  try {
    const paths = await api.sys.pickSubtitle()
    for (const p of paths || []) await addSubFromPath(p)
  } catch (err) {
    ui.toast((err && err.message) || '选择字幕文件失败')
  }
}

async function removeSub(s) {
  await removeLocalSub(s.key)
  if (localKey.value === s.key) localKey.value = ''
  await loadLocalSubs()
}

/** 拖文件进窗口：preload 统一派发 bili:files-dropped，这里只认字幕扩展名 */
async function onFilesDropped(e) {
  const paths = ((e && e.detail && e.detail.paths) || []).filter((p) => isSubtitleFile(p))
  for (const p of paths) await addSubFromPath(p)
}

async function patchSub(patch) {
  try {
    await settings.patch(patch)
  } catch {
    /* 设置落盘失败不影响当前播放 */
  }
}

function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer)
  if (!settings.settings.autoHideCtl) {
    ctlVisible.value = true
    return
  }
  hideTimer = setTimeout(() => {
    if (isPlaying.value && !menuOpen.value) ctlVisible.value = false
  }, 2800)
}

function onStageMove() {
  ctlVisible.value = true
  scheduleHide()
}

function onStageLeave() {
  if (isPlaying.value && !menuOpen.value) ctlVisible.value = false
}

function onWinDown(e) {
  if (!menuOpen.value) return
  const el = e.target
  if (el && el.closest && el.closest('.ctl-menu-wrap')) return
  speedMenu.value = false
  ccMenu.value = false
}

async function addCurrentUp() {
  if (!info.value.upMid) return
  try {
    await ups.addUp(
      {
        mid: info.value.upMid,
        name: info.value.upName,
        face: (info.value.owner && info.value.owner.face) || '',
        sign: ''
      },
      ups.activeGroup && ups.activeGroup !== 'all' ? ups.activeGroup : DEFAULT_GROUP
    )
    ui.ok(`已加入 UP 管理：${info.value.upName}`)
  } catch (err) {
    ui.err(err.message || '加入失败')
  }
}

function applySettings() {
  volume.value = settings.settings.playerVolume
  muted.value = false
  lastVolumeSent = volume.value
  speed.value = Number(settings.settings.playbackRate) || 1
  ctlVisible.value = true
}

/* ── 数据加载 ─────────────────────────────────────────── */
async function loadAll() {
  const id = bvid.value
  if (!id) return
  teardown()
  loading.value = true
  errorMsg.value = ''
  statusText.value = ''
  view.value = null
  pageList.value = []
  playurl.value = null
  related.value = []
  notes.value = []
  tab.value = 'intro'
  applySettings()

  try {
    // 分P列表拉不到（接口超时/风控）不该把整个播放页拖死：退回「只有一个 P」的列表继续播，
    // 取流只需要 cid，而 cid 在 view 里就有。
    const [v, pages] = await Promise.all([api.video.view(id), api.video.pages(id).catch(() => [])])
    view.value = v
    pageList.value = pages.length
      ? pages
      : [{ cid: v.cid, page: 1, title: v.title, part: v.title, duration: v.duration }]
  } catch (err) {
    errorMsg.value = err.message || '视频信息加载失败'
    loading.value = false
    return
  }

  // 初始分P的优先顺序：?p → ?cid（学习记录点进来带的是 cid）→ 上次看的那一 P → 第 1 P。
  // 早期版本只看 ?p，导致从首页/学习记录点进一个多分P视频永远回到 P1：既认不出「上次看到哪一 P」，
  // 也认不出「这条进度记录属于哪一 P」，续播于是永远从 P1 从头开始。
  const want = Number(route.query.p || 0)
  const wantCid = String(route.query.cid || '')
  const byP = want >= 1 && want <= pageList.value.length ? want - 1 : -1
  const byCid = wantCid ? pageList.value.findIndex((x) => String(x.cid) === wantCid) : -1
  const seen = learn.list.find((r) => r.bvid === id && r.page >= 1 && r.page <= pageList.value.length)
  pageIndex.value = byP >= 0 ? byP : byCid >= 0 ? byCid : seen ? seen.page - 1 : 0
  // 必须先渲染出 <video> 再取流：video 元素在 v-else 分支里，loading 为 true 时不存在
  loading.value = false
  await nextTick()
  await startPlay()
  loadRelated()
  loadNotes()
  if (view.value && view.value.bvid) learn.save(meta()).catch(() => {})
}

async function loadRelated() {
  try {
    related.value = await api.video.related(bvid.value)
  } catch {
    related.value = []
  }
}

async function loadNotes() {
  try {
    const rows = await db.notes.where('bvid').equals(bvid.value).toArray()
    notes.value = rows.sort((a, b) => (b.at || 0) - (a.at || 0))
  } catch {
    notes.value = []
  }
}

function meta() {
  const v = info.value
  return {
    bvid: bvid.value,
    cid: cid.value,
    title: currentPageTitle.value || v.title || '',
    cover: v.cover || '',
    upName: v.upName || '',
    upMid: (v.owner && v.owner.mid) || v.upMid || null,
    page: pageList.value[pageIndex.value] ? pageList.value[pageIndex.value].page : 1,
    duration: duration.value || v.duration || 0
  }
}

/** 当前视频所属 UP（用于按 UP 统计学习时长） */
function upRef() {
  const v = info.value
  const name = v.upName || (v.owner && v.owner.name) || ''
  const mid = (v.owner && v.owner.mid) || v.upMid || null
  if (!name && !mid) return null
  return { mid, name }
}

/** 上次看到哪儿：优先 URL 里的 t=，否则用本地学习记录的秒数（快看完时从头开始）。 */
function startSeconds() {
  const explicit = Number(route.query.t || 0)
  if (explicit > 0) return explicit
  const rec = learn.get(bvid.value, cid.value)
  if (!rec || !rec.seconds) return 0
  const partSec = Number((pageList.value[pageIndex.value] || {}).duration) || 0
  const total = rec.duration || partSec || info.value.duration || 0
  if (total && rec.seconds > total - 12) return 0
  if (rec.seconds < 4) return 0
  return rec.seconds
}

async function startPlay() {
  const qn = Number(settings.settings.defaultQuality) || 80
  statusText.value = '正在获取播放地址…'
  errorMsg.value = ''
  watchedTotal = 0
  autoChecked = false

  // 这个视频已经在小窗里放了：本页别再拉一路（否则两个声音叠在一起）。
  // 页面上会显示「视频正在小窗播放」+ 收回按钮。
  if (mini.open && mini.bvid === bvid.value) {
    statusText.value = ''
    return
  }

  // 冒烟靠它判断这一轮播的是在线流还是本地文件
  window.__playLog = { source: 'online', bvid: bvid.value, cid: String(cid.value) }
  let data = null
  try {
    data = await api.video.playurl(bvid.value, cid.value, qn)
  } catch (err) {
    errorMsg.value = err.message || '播放地址获取失败'
    statusText.value = ''
    return
  }

  try {
    playurl.value = data
    quality.value = data.quality || qn
    actualQuality.value = 0
    // 有的视频 playurl 里的 dash.duration 是垃圾值（例如 1000ms）：直接用它既会让进度条总时长显示成
    // 0:01，又会让 MSE 把超出 1 秒的帧全部丢掉（画面永远「缓冲中…」）。所以只在看起来合理时采用。
    const dashSec = data.dash && data.dash.duration ? data.dash.duration / 1000 : 0
    const partSec = Number((pageList.value[pageIndex.value] || {}).duration) || 0
    const infoSec = parseDuration(info.value.duration)
    // 分P视频注意：web-interface/view 的 duration 是「整部合集」的总时长（实测新概念英语第二册 146592s），
    // 拿它当单P时长会让进度条总时长、续播判断全错，所以优先用 pagelist 给的单P时长。
    duration.value =
      partSec > 3 && partSec < 86400
        ? partSec
        : dashSec > 3 && dashSec < 86400
          ? dashSec
          : infoSec || dashSec || 0
  } catch (err) {
    errorMsg.value = err.message || '播放地址获取失败'
    statusText.value = ''
    return
  }

  await nextTick()
  if (!videoEl.value) return
  if (!player) {
    player = new DashPlayer(videoEl.value, {
      onStatus: (t) => {
        statusText.value = t || ''
      },
      onProgress: (t, d) => {
        currentTime.value = t
        if (d) duration.value = d
        updateBuffered()
      },
      onDuration: (d) => {
        if (d) duration.value = d
      },
      onState: (s) => {
        isPlaying.value = s === 'playing'
        if (s === 'waiting') statusText.value = '缓冲中…'
        else if (s === 'playing') statusText.value = ''
      },
      onEnded: onEnded,
      // 播放器实际选中的视频轨 id：服务端可能降级（报 720P 却只回 480P 轨），
      // 所以「当前清晰度」以实际播的那条轨为准，避免显示与画质不符。
      onTracks: (t) => {
        actualQuality.value = Number(t && t.video && t.video.id) || 0
      },
      onError: (e) => {
        errorMsg.value = e.message
        statusText.value = ''
      }
    })
  }
  // 把「我们确信的总时长」告诉播放器：MSE 需要 MediaSource.duration 才能进 HAVE_METADATA
  if (player && player.setDurationHint) player.setDurationHint(duration.value)
  const start = startSeconds()
  if (start > 0) statusText.value = `从 ${fmtDuration(start)} 继续播放`
  try {
    await player.load(playurl.value, {
      startTime: start,
      volume: volume.value,
      muted: muted.value,
      autoplay: true
    })
    startTimers() // 幂等：切分P/换清晰度后保证计时器仍在跑
    applyRate()
    // 本地字幕跟着分P走；开了「自动开启在线字幕」就顺手取一次（失败不打扰用户）
    loadLocalSubs().catch(() => {})
    if (settings.settings.subAuto) loadSubtitles().catch(() => {})
  } catch (err) {
    errorMsg.value = err.message || '播放失败'
    statusText.value = ''
  }
}

function teardown() {
  if (player) {
    player.destroy()
    player = null
  }
  stopTimers()
  isPlaying.value = false
  currentTime.value = 0
  duration.value = 0
  bufferedPct.value = 0
  statusText.value = ''
  ccLan.value = ''
  ccList.value = []
  ccCid.value = ''
  localSubs.value = []
  localKey.value = ''
}

/* ── 小窗播放 ─────────────────────────────────────────── */
/**
 * 把当前分P扔进右下角的悬浮小窗（B 站客户端那种「小窗播放」）：
 * 分P、清晰度、「已经看到哪儿」都带上，页面这路立刻让位 —— 同一路流不能两处同时拉。
 */
function popMini() {
  // 「看到哪儿」必须以 <video> 为准：暂停时 timeupdate 不触发，那个响应式值可能还停在 0，
  // 结果点了小窗又从 0 秒重放（用户看到的就是「小窗不接着播」）。
  const el = videoEl.value
  const live = el && Number.isFinite(el.currentTime) && el.currentTime > 0 ? el.currentTime : 0
  const t = live || currentTime.value || 0
  mini.play({
    bvid: bvid.value,
    cid: cid.value,
    page: pageIndex.value + 1,
    title: info.value.title || '',
    upName: info.value.upName || '',
    cover: info.value.cover || '',
    duration: duration.value || 0,
    qn: actualQuality.value || quality.value || 0,
    startTime: t
  })
  teardown()
  ui.toast('已缩到小窗播放，可以接着翻别的页面')
}

/** 从小窗收回本页：当前秒数写进 ?t=，startSeconds() 会优先用它接着播 */
function pullBackMini() {
  const t = Math.floor(mini.currentTime || 0)
  const page = Number(mini.page) || pageIndex.value + 1
  mini.close()
  const query = { ...(page > 1 ? { p: String(page) } : {}), ...(t > 3 ? { t: String(t) } : {}) }
  // 同一个 bvid 只换 query：路由参数没变、组件不会重挂，所以手动重新起播
  router.replace({ name: 'video', params: { bvid: bvid.value }, query })
  nextTick(() => startPlay())
}

/* ── 学习记录 ─────────────────────────────────────────── */
/** 播放满 5 分钟自动打卡（可在设置里关掉） */
function maybeAutoCheckin() {
  if (autoChecked || watchedTotal < 300) return
  if (!settings.settings.autoCheckin) return
  if (learn.isChecked()) {
    autoChecked = true
    return
  }
  autoChecked = true
  learn
    .checkin()
    .then((added) => {
      if (added) ui.toast(`已自动打卡 · 连续 ${learn.checkinStreak} 天`)
    })
    .catch(() => {})
}

function startTimers() {
  stopTimers()
  tickTimer = setInterval(() => {
    if (!player || !videoEl.value) return
    if (!videoEl.value.paused && !videoEl.value.ended) {
      pendingSeconds += 1
      watchedTotal += 1
      maybeAutoCheckin()
      if (pendingSeconds >= 10) {
        const n = pendingSeconds
        pendingSeconds = 0
        learn.addSeconds(n, upRef()).catch((e) => console.error('[learn] 学习时长写入失败', (e && e.message) || e))
      }
    }
    updateBuffered()
  }, 1000)

  saveTimer = setInterval(() => {
    if (!player || !videoEl.value) return
    const t = videoEl.value.currentTime || 0
    // 首次有播放位置就落一条（lastSavedSeconds 初始为 -1），之后每 2 秒才写一次
    if (t <= 0) return
    if (lastSavedSeconds >= 0 && Math.abs(t - lastSavedSeconds) < 2) return
    lastSavedSeconds = t
    const total = duration.value || 0
    learn
      .save({
        ...meta(),
        seconds: t,
        duration: total,
        completed: total > 0 && t / total > 0.95
      })
      .then(() => {})
      .catch((e) => console.error('[learn] 进度保存失败', (e && e.message) || e))
  }, 5000)
}

function stopTimers() {
  if (tickTimer) clearInterval(tickTimer)
  if (saveTimer) clearInterval(saveTimer)
  tickTimer = null
  saveTimer = null
  if (pendingSeconds > 0) {
    const n = pendingSeconds
    pendingSeconds = 0
    learn.addSeconds(n, upRef()).catch((e) => console.error('[learn] 学习时长写入失败', (e && e.message) || e))
  }
}

function flushProgress() {
  if (!player || !videoEl.value) return
  const t = videoEl.value.currentTime || 0
  const total = duration.value || 0
  if (t > 0) {
    learn
      .save({ ...meta(), seconds: t, duration: total, completed: total > 0 && t / total > 0.95 })
      .catch(() => {})
  }
  stopTimers()
}

function updateBuffered() {
  if (!videoEl.value) return
  try {
    const b = videoEl.value.buffered
    if (!b.length) return
    const end = b.end(b.length - 1)
    const total = duration.value || 0
    bufferedPct.value = total ? Math.min(100, (end / total) * 100) : 0
  } catch {
    /* ignore */
  }
}

function onEnded() {
  isPlaying.value = false
  const total = duration.value || 0
  learn
    .save({ ...meta(), seconds: total, duration: total, completed: true })
    .catch(() => {})
  if (settings.settings.autoNext && pageIndex.value + 1 < pageList.value.length) {
    ui.toast('自动播放下一 P')
    selectPage(pageIndex.value + 1)
  }
}

/* ── 交互 ─────────────────────────────────────────────── */
function togglePlay() {
  if (!player) return
  if (videoEl.value.paused) player.play()
  else player.pause()
}

function seekBy(delta) {
  if (!player) return
  player.seek((videoEl.value.currentTime || 0) + delta)
}

function onProgressPointer(e) {
  if (!duration.value) return
  const el = e.currentTarget
  const move = (ev) => {
    const rect = el.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width))
    currentTime.value = ratio * duration.value
  }
  const up = (ev) => {
    const rect = el.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width))
    if (player) player.seek(ratio * duration.value)
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  move(e)
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function toggleMute() {
  muted.value = !muted.value
  if (player) player.setMuted(muted.value)
}

async function selectPage(idx) {
  if (idx === pageIndex.value) return
  flushProgress()
  pageIndex.value = idx
  lastSavedSeconds = -1
  router.replace({ name: 'video', params: { bvid: bvid.value }, query: { p: idx + 1 } })
  statusText.value = '切换分P…'
  await startPlay()
}

async function selectQuality(qn) {
  if (qn === quality.value || !player) return
  const keep = videoEl.value.currentTime || 0
  quality.value = qn
  statusText.value = `切换到 ${qnLabel(qn)}…`
  try {
    const data = await api.video.playurl(bvid.value, cid.value, qn)
    playurl.value = data
    await player.load(data, { startTime: keep, volume: volume.value, muted: muted.value, autoplay: true })
    settings.patch({ defaultQuality: qn })
    ui.ok(`已切换到 ${qnLabel(qn)}`)
  } catch (err) {
    ui.err(err.message || '清晰度切换失败')
    statusText.value = ''
  }
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await wrapEl.value.requestFullscreen()
  } catch {
    /* ignore */
  }
}

function onVolumeInput() {
  if (player) player.setVolume(volume.value)
  if (muted.value && volume.value > 0) {
    muted.value = false
    if (player) player.setMuted(false)
  }
  if (Math.abs(volume.value - lastVolumeSent) > 0.05) {
    lastVolumeSent = volume.value
    settings.patch({ playerVolume: volume.value })
  }
}

async function toggleShelf() {
  if (!info.value.bvid) return
  const added = await learn.shelfToggle({
    bvid: bvid.value,
    title: info.value.title,
    cover: info.value.cover,
    upName: info.value.upName,
    upMid: info.value.upMid,
    duration: info.value.duration
  })
  ui.toast(added ? '已加入学习清单' : '已从学习清单移除')
}

async function addNote() {
  const text = noteText.value.trim()
  if (!text) return
  const at = videoEl.value ? Math.floor(videoEl.value.currentTime || 0) : 0
  await db.notes.add({ bvid: bvid.value, cid: cid.value, sec: at, text, at: Date.now() })
  noteText.value = ''
  await loadNotes()
  ui.ok('笔记已保存')
}

async function delNote(id) {
  await db.notes.delete(id)
  await loadNotes()
}

function jumpNote(n) {
  if (player) player.seek(n.sec)
}

function openExternal() {
  api.sys.openExternal(`https://www.bilibili.com/video/${bvid.value}`).catch(() => {})
}

function onKey(e) {
  const tag = document.activeElement && document.activeElement.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  if (e.code === 'Space') {
    e.preventDefault()
    togglePlay()
  } else if (e.code === 'ArrowLeft') {
    seekBy(-settings.settings.seekStep)
  } else if (e.code === 'ArrowRight') {
    seekBy(settings.settings.seekStep)
  } else if (e.code === 'ArrowUp') {
    volume.value = Math.min(1, volume.value + 0.05)
    onVolumeInput()
  } else if (e.code === 'ArrowDown') {
    volume.value = Math.max(0, volume.value - 0.05)
    onVolumeInput()
  } else if (e.code === 'KeyF') {
    toggleFullscreen()
  }
}

watch(
  () => route.params.bvid,
  () => {
    loadAll()
  }
)

watch(isPlaying, (playing) => {
  if (!playing) {
    ctlVisible.value = true
    if (hideTimer) clearTimeout(hideTimer)
  } else {
    scheduleHide()
  }
})

watch(menuOpen, (open) => {
  if (open) ctlVisible.value = true
})

onMounted(async () => {
  await settings.init()
  await learn.init()
  try {
    await collect.init()
    await ups.init()
  } catch (err) {
    console.warn('[video] 本机收藏/UP 名单初始化失败：', err && err.message)
  }
  await loadAll()
  startTimers()
  window.addEventListener('keydown', onKey)
  window.addEventListener('pointerdown', onWinDown, true)
  window.addEventListener('bili:files-dropped', onFilesDropped)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('pointerdown', onWinDown, true)
  window.removeEventListener('bili:files-dropped', onFilesDropped)
  if (hideTimer) clearTimeout(hideTimer)
  flushProgress()
  teardown()
})
</script>

<template>
  <div v-if="loading" class="panel row" style="gap: 12px">
    <span class="spinner" /> <span class="dim">正在加载视频…</span>
  </div>

  <EmptyBlock v-else-if="!view" icon="film" title="无法打开这个视频" :desc="errorMsg">
    <button class="btn" @click="loadAll">重试</button>
    <RouterLink to="/" class="btn ghost">回首页</RouterLink>
  </EmptyBlock>

  <div v-else class="watch">
    <div style="min-width: 0">
      <div ref="wrapEl" class="player-wrap" @mousemove="onStageMove" @mouseleave="onStageLeave">
        <div class="player-stage" @dblclick="toggleFullscreen">
          <video ref="videoEl" playsinline preload="auto" @click="togglePlay" />

          <div v-if="ccOn && activeCc" class="cc-line" :style="ccStyle">{{ activeCc }}</div>

          <div v-if="statusText && !isPlaying" class="player-msg">
            <span class="spinner" style="margin: 0 auto" />
            <div>{{ statusText }}</div>
          </div>

          <!-- 这一路已经在小窗里放了：本页不再拉第二路流，只提示 + 收回归位 -->
          <div v-if="miniHere" class="player-msg player-msg-col">
            <Icon name="pip" :size="28" />
            <div>视频正在小窗播放</div>
            <button class="btn sm" @click="pullBackMini">收回本页播放</button>
          </div>

          <div class="stage-ui" :class="{ hide: !ctlVisible }">
            <div class="player-ctl">
              <button class="btn ghost sm" :title="isPlaying ? '暂停' : '播放'" @click="togglePlay">
                <Icon :name="isPlaying ? 'pause' : 'play'" :size="16" />
              </button>
              <button
                class="btn ghost sm"
                title="上一个分P"
                :disabled="pageIndex <= 0"
                @click="selectPage(pageIndex - 1)"
              >
                <Icon name="prev" :size="15" />
              </button>
              <button
                class="btn ghost sm"
                title="下一个分P"
                :disabled="pageIndex + 1 >= pageList.length"
                @click="selectPage(pageIndex + 1)"
              >
                <Icon name="next" :size="15" />
              </button>
              <span class="time">{{ fmtDuration(currentTime) }} / {{ fmtDuration(duration) }}</span>
              <div class="progress" @pointerdown.prevent="onProgressPointer">
                <div class="track">
                  <div class="buf" :style="{ width: bufferedPct + '%' }" />
                  <i :style="{ width: pct + '%' }" />
                </div>
              </div>
              <div class="ctl-menu-wrap">
                <button class="btn ghost sm" title="倍速" @click.stop="speedMenu = !speedMenu">{{ speed }}x</button>
                <div v-if="speedMenu" class="ctl-menu">
                  <div
                    v-for="s in SPEEDS"
                    :key="s"
                    class="mi"
                    :class="{ on: s === speed }"
                    @click="setSpeed(s)"
                  >
                    <span>{{ s === 1 ? '1.0x 正常' : s + 'x' }}</span>
                  </div>
                </div>
              </div>
              <div class="ctl-menu-wrap">
                <button class="btn ghost sm" title="字幕" @click.stop="openCcMenu()">
                  <Icon name="cc" :size="15" />
                </button>
                <div v-if="ccMenu" class="ctl-menu cc-menu">
                  <div class="mi" :class="{ on: !ccOn }" @click="pickCc('')">关闭字幕</div>

                  <div class="mhead">在线字幕</div>
                  <div v-if="ccLoading" class="mrow">字幕加载中…</div>
                  <template v-else-if="ccList.length">
                    <div
                      v-for="c in ccList"
                      :key="c.lan"
                      class="mi"
                      :class="{ on: !ccOff && !localKey && c.lan === ccLan }"
                      @click="pickCc(c.lan)"
                    >
                      <span>{{ c.lanDoc }}</span><span class="k">{{ c.items.length }} 句</span>
                    </div>
                  </template>
                  <div v-else class="mrow">这个视频没有可用字幕</div>
                  <div class="mi" :class="{ on: settings.settings.subAuto }" @click="patchSub({ subAuto: !settings.settings.subAuto })">
                    <span>自动开启在线字幕</span>
                    <span class="k">{{ settings.settings.subAuto ? '已开' : '关' }}</span>
                  </div>

                  <div class="mhead">本地字幕 · 也可以把文件拖进播放器</div>
                  <div
                    v-for="s in localSubs"
                    :key="s.key"
                    class="mi"
                    :class="{ on: !ccOff && s.key === localKey }"
                  >
                    <span class="grow clamp-1" @click="pickLocal(s.key)">{{ s.name }}</span>
                    <span class="k">{{ s.count }} 句</span>
                    <button class="mi-x" title="删除这份字幕" @click.stop="removeSub(s)">✕</button>
                  </div>
                  <div v-if="!localSubs.length" class="mrow">这个分P还没加载本地字幕</div>
                  <div class="mi" @click="pickSubtitleFile()">
                    <span>选择字幕文件…</span><span class="k">srt / vtt / ass</span>
                  </div>

                  <div class="mhead">字幕显示</div>
                  <div class="mrow sub-row">
                    <span class="sublab">字号</span>
                    <span class="chip-group">
                      <button
                        v-for="z in SUB_SIZES"
                        :key="z.v"
                        class="chip plain"
                        :class="{ on: Number(settings.settings.subFontSize) === z.v }"
                        @click="patchSub({ subFontSize: z.v })"
                      >
                        {{ z.label }}
                      </button>
                    </span>
                  </div>
                  <div class="mrow sub-row">
                    <span class="sublab">背景</span>
                    <span class="chip-group">
                      <button class="chip plain" :class="{ on: settings.settings.subBg }" @click="patchSub({ subBg: true })">有</button>
                      <button class="chip plain" :class="{ on: !settings.settings.subBg }" @click="patchSub({ subBg: false })">无</button>
                    </span>
                  </div>
                  <div class="mrow sub-row">
                    <span class="sublab">位置</span>
                    <span class="chip-group">
                      <button
                        v-for="p in SUB_POS"
                        :key="p.v"
                        class="chip plain"
                        :class="{ on: Number(settings.settings.subBottom) === p.v }"
                        @click="patchSub({ subBottom: p.v })"
                      >
                        {{ p.label }}
                      </button>
                    </span>
                  </div>
                </div>
              </div>
              <button class="btn ghost sm" title="静音" @click="toggleMute">
                <Icon :name="muted ? 'mute' : 'volume'" :size="15" />
              </button>
              <input
                v-model.number="volume"
                type="range"
                min="0"
                max="1"
                step="0.02"
                style="width: 74px"
                title="音量"
                @input="onVolumeInput"
              />
              <button class="btn ghost sm" title="全屏" @click="toggleFullscreen">
                <Icon name="expand" :size="15" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div v-if="errorMsg" class="panel" style="margin-top: 12px; border-color: var(--danger)">
        <div style="color: var(--danger)">{{ errorMsg }}</div>
        <div class="row" style="margin-top: 8px">
          <button class="btn sm" @click="startPlay">重新获取播放地址</button>
          <button v-if="!auth.loggedIn" class="btn sm primary" @click="ui.loginOpen = true">扫码登录</button>
          <button class="btn sm ghost" @click="openExternal">在浏览器打开</button>
        </div>
        <div class="muted" style="font-size: 12px; margin-top: 8px">
          付费/会员专享内容需要登录对应账号；未登录时只能观看 360P。
        </div>
      </div>

      <div style="margin-top: 14px; display: flex; gap: 10px; align-items: flex-start">
        <div class="grow" style="min-width: 0">
          <h1 style="font-size: 17px; margin: 0 0 6px; line-height: 1.45">{{ info.title }}</h1>
          <div v-if="currentPageTitle" class="dim" style="font-size: 12.5px">正在播放：{{ currentPageTitle }}</div>
          <div class="row muted" style="flex-wrap: wrap; margin-top: 8px; font-size: 12.5px">
            <span class="chip plain" style="cursor: pointer" @click="router.push({ name: 'up', params: { mid: String(info.upMid) } })">
              <Icon name="user" :size="13" /> {{ info.upName }}
            </span>
            <span class="chip plain">{{ fmtCount(info.play) }} 播放</span>
            <span class="chip plain">{{ fmtCount(info.danmaku) }} 弹幕</span>
            <span class="chip plain">{{ fmtCount(info.like) }} 点赞</span>
            <span class="chip plain">{{ fmtCount(info.fav) }} 收藏</span>
            <span class="chip plain">{{ fmtDate(info.pubdate) }}</span>
          </div>
        </div>
        <div class="row" style="flex: none">
          <button class="btn sm" @click="collectOpen = true">
            <Icon :name="collectCount ? 'check' : 'star'" :size="14" />
            {{ collectCount ? `已收藏 ${collectCount > 1 ? collectCount + ' 处' : ''}` : '收藏' }}
          </button>
          <button v-if="info.upMid && !inUpsList" class="btn sm" title="加入 UP 管理名单，首页就会显示 TA 的更新" @click="addCurrentUp">
            <Icon name="users" :size="14" /> 关注
          </button>
          <button class="btn sm" @click="toggleShelf">
            <Icon :name="inShelf ? 'check' : 'plus'" :size="14" /> {{ inShelf ? '已加入学习清单' : '加入学习清单' }}
          </button>
          <RouterLink to="/learn" class="btn sm ghost"><Icon name="book" :size="14" /> 学习面板</RouterLink>
          <button
            v-if="!miniHere"
            class="btn sm"
            title="小窗播放：视频缩到右下角的小窗里，接着翻别的页面"
            @click="popMini"
          >
            <Icon name="pip" :size="14" /> 小窗播放
          </button>
          <button v-else class="btn sm primary" title="把视频收回本页继续播" @click="pullBackMini">
            <Icon name="pip" :size="14" /> 正在小窗播放
          </button>
        </div>
      </div>

      <div class="tabs" style="margin-top: 18px">
        <div class="tab" :class="{ on: tab === 'intro' }" @click="tab = 'intro'">简介</div>
        <div class="tab" :class="{ on: tab === 'pages' }" @click="tab = 'pages'">分P（{{ pageList.length }}）</div>
        <div class="tab" :class="{ on: tab === 'notes' }" @click="tab = 'notes'">笔记（{{ notes.length }}）</div>
        <div class="tab" :class="{ on: tab === 'related' }" @click="tab = 'related'">相关推荐</div>
      </div>

      <div v-if="tab === 'intro'" class="panel" style="white-space: pre-wrap; font-size: 13px; color: var(--t2)">
        {{ info.desc || '这个视频没有填写简介。' }}
      </div>

      <div v-else-if="tab === 'pages'" class="panel">
        <PartList :parts="pageList" :index="pageIndex" @select="selectPage" />
      </div>

      <div v-else-if="tab === 'notes'" class="panel">
        <div class="row" style="margin-bottom: 10px">
          <input
            v-model="noteText"
            class="input"
            :placeholder="`记录当前时间点（${fmtDuration(currentTime)}）的想法，回车保存`"
            @keyup.enter="addNote"
          />
          <button class="btn primary" @click="addNote"><Icon name="plus" :size="14" /> 保存</button>
        </div>
        <div v-if="!notes.length" class="muted" style="font-size: 12.5px">
          还没有笔记。播放时按回车即可把「时间点 + 想法」存到本地。
        </div>
        <div v-for="n in notes" :key="n.id" class="field">
          <label style="width: 62px" class="mono">{{ fmtDuration(n.sec) }}</label>
          <div class="ctrl">{{ n.text }}</div>
          <div class="row" style="flex: none">
            <button class="btn sm ghost" title="跳转" @click="jumpNote(n)"><Icon name="play" :size="13" /></button>
            <button class="btn sm danger" title="删除" @click="delNote(n.id)"><Icon name="trash" :size="13" /></button>
          </div>
        </div>
      </div>

      <div v-else style="display: flex; flex-direction: column; gap: 4px">
        <EmptyBlock v-if="!related.length" icon="film" title="暂无相关推荐" />
        <template v-else>
          <div
            v-for="r in related"
            :key="r.bvid"
            class="rowitem"
            @click="router.push({ name: 'video', params: { bvid: r.bvid } })"
          >
            <BiliImage :src="r.cover" :alt="r.title" />
            <div class="info">
              <div class="t clamp-2">{{ r.title }}</div>
              <div class="d">{{ r.upName }} · {{ fmtCount(r.play) }} 播放</div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <aside style="display: flex; flex-direction: column; gap: 14px; min-width: 0">
      <div class="panel" style="padding: 13px">
        <div class="row" style="margin-bottom: 9px">
          <Icon name="monitor" :size="15" />
          <b style="font-size: 13px">清晰度</b>
          <span class="grow" />
          <span class="muted" style="font-size: 11.5px">当前 {{ qnLabel(actualQuality || quality) }}</span>
        </div>
        <div class="row" style="flex-wrap: wrap">
          <span
            v-for="q in qualities"
            :key="q"
            class="chip"
            :class="{ on: q === (actualQuality || quality) }"
            @click="selectQuality(q)"
          >
            {{ qnLabel(q) }}
          </span>
        </div>
        <div v-if="playurl && playurl.mode === 'durl'" class="muted" style="font-size: 11.5px; margin-top: 8px">
          该视频只提供整段流（durl），清晰度档位受限。
        </div>
      </div>

      <div class="panel" style="padding: 13px">
        <PartList :parts="pageList" :index="pageIndex" @select="selectPage" />
      </div>
    </aside>

    <CollectModal :open="collectOpen" :video="collectTarget" @close="collectOpen = false" />
  </div>
</template>
