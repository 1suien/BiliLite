<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'
import { DashPlayer } from '../player/dash.js'
import BiliImage from '../components/BiliImage.vue'
import Icon from '../components/Icon.vue'
import EmptyBlock from '../components/EmptyBlock.vue'
import CollectModal from '../components/CollectModal.vue'
import { useLearnStore } from '../stores/learn'
import { useCollectStore } from '../stores/collect'
import { useUpsStore, DEFAULT_GROUP } from '../stores/ups'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useAuthStore } from '../stores/auth'
import { fmtCount, fmtDate, fmtDuration, parseDuration } from '../utils/format'
import { qnLabel, sortQuality } from '../utils/quality'
import { db } from '../db'

const route = useRoute()
const router = useRouter()
const learn = useLearnStore()
const collect = useCollectStore()
const ups = useUpsStore()
const settings = useSettingsStore()
const ui = useUiStore()
const auth = useAuthStore()

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
  return p && pageList.value.length > 1 ? `P${p.page} ${p.title}` : ''
})
const inShelf = computed(() => (bvid.value ? learn.inShelf(bvid.value) : false))
const collectCount = computed(() => collect.items.filter((x) => x.bvid === bvid.value).length)
const collectTarget = computed(() => ({ ...meta(), upName: info.value.upName }))
const inUpsList = computed(() =>
  Boolean(info.value.upMid) && ups.items.some((x) => String(x.mid) === String(info.value.upMid))
)

/* 字幕 / 菜单 */
const menuOpen = computed(() => speedMenu.value || ccMenu.value)
const activeCc = computed(() => {
  const cc = ccList.value.find((s) => s.lan === ccLan.value)
  if (!cc || !cc.items.length) return ''
  const t = currentTime.value
  const items = cc.items
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

async function loadSubtitles() {
  if (ccLoading.value || ccList.value.length) return
  ccLoading.value = true
  try {
    const r = await api.video.subtitle(bvid.value, cid.value)
    ccList.value = (r && r.list) || []
    if (ccList.value.length && !ccLan.value) ccLan.value = ccList.value[0].lan
  } catch {
    ccList.value = []
  } finally {
    ccLoading.value = false
  }
}

async function openCcMenu() {
  ccMenu.value = !ccMenu.value
  if (!ccMenu.value) return
  await loadSubtitles()
  if (!ccList.value.length) ui.toast('这个视频没有可用字幕（未登录时多数视频拿不到）')
}

function pickCc(lan) {
  ccLan.value = lan
  ccMenu.value = false
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
    const [v, pages] = await Promise.all([api.video.view(id), api.video.pages(id)])
    view.value = v
    pageList.value = pages.length ? pages : [{ cid: v.cid, page: 1, title: v.title, duration: v.duration }]
  } catch (err) {
    errorMsg.value = err.message || '视频信息加载失败'
    loading.value = false
    return
  }

  const want = Number(route.query.p || 0)
  pageIndex.value = want >= 1 && want <= pageList.value.length ? want - 1 : 0
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

function startSeconds() {
  const explicit = Number(route.query.t || 0)
  if (explicit > 0) return explicit
  const rec = learn.get(bvid.value, cid.value)
  if (!rec || !rec.seconds) return 0
  const total = rec.duration || info.value.duration || 0
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
  try {
    const data = await api.video.playurl(bvid.value, cid.value, qn)
    playurl.value = data
    quality.value = data.quality || qn
    actualQuality.value = 0
    // 有的视频 playurl 里的 dash.duration 是垃圾值（例如 1000ms）：直接用它既会让进度条总时长显示成
    // 0:01，又会让 MSE 把超出 1 秒的帧全部丢掉（画面永远「缓冲中…」）。所以只在看起来合理时采用。
    const dashSec = data.dash && data.dash.duration ? data.dash.duration / 1000 : 0
    const infoSec = parseDuration(info.value.duration)
    duration.value = dashSec > 3 && dashSec < 86400 ? dashSec : infoSec || dashSec || 0
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
  () => loadAll()
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
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('pointerdown', onWinDown, true)
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

          <div v-if="ccLan && activeCc" class="cc-line">{{ activeCc }}</div>

          <div v-if="statusText && !isPlaying" class="player-msg">
            <span class="spinner" style="margin: 0 auto" />
            <div>{{ statusText }}</div>
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
                <div v-if="ccMenu" class="ctl-menu">
                  <div class="mi" :class="{ on: !ccLan }" @click="pickCc('')">关闭字幕</div>
                  <div v-if="ccLoading" class="mrow">字幕加载中…</div>
                  <template v-else-if="ccList.length">
                    <div
                      v-for="c in ccList"
                      :key="c.lan"
                      class="mi"
                      :class="{ on: c.lan === ccLan }"
                      @click="pickCc(c.lan)"
                    >
                      <span>{{ c.lanDoc }}</span><span class="k">{{ c.items.length }} 句</span>
                    </div>
                  </template>
                  <div v-else class="mrow">这个视频没有可用字幕</div>
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
        <div class="pages-list">
          <div
            v-for="(p, i) in pageList"
            :key="p.cid"
            class="page-pill"
            :class="{ on: i === pageIndex }"
            :title="p.title"
            @click="selectPage(i)"
          >
            P{{ p.page }} · {{ p.title }}
          </div>
        </div>
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
        <div class="row" style="margin-bottom: 9px">
          <Icon name="list" :size="15" />
          <b style="font-size: 13px">分P列表</b>
          <span class="grow" />
          <span class="muted" style="font-size: 11.5px">{{ pageIndex + 1 }}/{{ pageList.length }}</span>
        </div>
        <div class="pages-list">
          <div
            v-for="(p, i) in pageList"
            :key="p.cid"
            class="page-pill"
            :class="{ on: i === pageIndex }"
            :title="p.title"
            @click="selectPage(i)"
          >
            P{{ p.page }} · {{ p.title }}
          </div>
        </div>
      </div>

      <div class="panel" style="padding: 13px">
        <div class="row" style="margin-bottom: 9px">
          <Icon name="film" :size="15" />
          <b style="font-size: 13px">相关推荐</b>
        </div>
        <div v-if="!related.length" class="muted" style="font-size: 12px">暂无推荐</div>
        <div
          v-for="r in related.slice(0, 12)"
          :key="r.bvid"
          class="rowitem"
          style="padding: 6px; gap: 9px"
          @click="router.push({ name: 'video', params: { bvid: r.bvid } })"
        >
          <BiliImage :src="r.cover" :alt="r.title" style="width: 84px; border-radius: 6px" />
          <div class="info">
            <div class="t clamp-2" style="font-size: 12.5px">{{ r.title }}</div>
            <div class="d" style="font-size: 11.5px">{{ r.upName }}</div>
          </div>
        </div>
      </div>
    </aside>

    <CollectModal :open="collectOpen" :video="collectTarget" @close="collectOpen = false" />
  </div>
</template>
