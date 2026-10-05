<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'
import { DashPlayer } from '../player/dash.js'
import BiliImage from '../components/BiliImage.vue'
import Icon from '../components/Icon.vue'
import EmptyBlock from '../components/EmptyBlock.vue'
import { useLearnStore } from '../stores/learn'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useAuthStore } from '../stores/auth'
import { fmtCount, fmtDate, fmtDuration, parseDuration } from '../utils/format'
import { qnLabel, sortQuality } from '../utils/quality'
import { db } from '../db'

const route = useRoute()
const router = useRouter()
const learn = useLearnStore()
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

const loading = ref(true)
const errorMsg = ref('')
const statusText = ref('')
const view = ref(null)
const pageList = ref([])
const pageIndex = ref(0) // 0-based
const related = ref([])
const playurl = ref(null)
const quality = ref(0)
const isPlaying = ref(false)
const duration = ref(0)
const currentTime = ref(0)
const bufferedPct = ref(0)
const volume = ref(0.8)
const muted = ref(false)
const tab = ref('intro')
const noteText = ref('')
const notes = ref([])

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

function applySettings() {
  volume.value = settings.settings.playerVolume
  muted.value = false
  lastVolumeSent = volume.value
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
    page: pageList.value[pageIndex.value] ? pageList.value[pageIndex.value].page : 1,
    duration: duration.value || v.duration || 0
  }
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
  try {
    const data = await api.video.playurl(bvid.value, cid.value, qn)
    playurl.value = data
    quality.value = data.quality || qn
    duration.value = data.dash && data.dash.duration ? data.dash.duration / 1000 : parseDuration(info.value.duration)
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
      onError: (e) => {
        errorMsg.value = e.message
        statusText.value = ''
      }
    })
  }
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
}

/* ── 学习记录 ─────────────────────────────────────────── */
function startTimers() {
  stopTimers()
  tickTimer = setInterval(() => {
    if (!player || !videoEl.value) return
    if (!videoEl.value.paused && !videoEl.value.ended) {
      pendingSeconds += 1
      if (pendingSeconds >= 10) {
        const n = pendingSeconds
        pendingSeconds = 0
        learn.addSeconds(n).catch((e) => console.error('[learn] 学习时长写入失败', (e && e.message) || e))
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
    learn.addSeconds(n).catch((e) => console.error('[learn] 学习时长写入失败', (e && e.message) || e))
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
  }
}

watch(
  () => route.params.bvid,
  () => loadAll()
)

onMounted(async () => {
  await settings.init()
  await learn.init()
  await loadAll()
  startTimers()
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
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
      <div ref="wrapEl" class="player-wrap">
        <div class="player-stage">
          <video ref="videoEl" playsinline preload="auto" @click="togglePlay" />
          <div v-if="statusText && !isPlaying" class="player-msg">
            <span class="spinner" style="margin: 0 auto" />
            <div>{{ statusText }}</div>
          </div>
        </div>

        <div class="player-ctl">
          <button class="btn ghost sm" :title="isPlaying ? '暂停' : '播放'" @click="togglePlay">
            <Icon :name="isPlaying ? 'pause' : 'play'" :size="16" />
          </button>
          <button class="btn ghost sm" title="上一个分P" :disabled="pageIndex <= 0" @click="selectPage(pageIndex - 1)">
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
          <button class="btn ghost sm" title="静音" @click="toggleMute">
            <Icon :name="muted ? 'mute' : 'volume'" :size="15" />
          </button>
          <input
            v-model.number="volume"
            type="range"
            min="0"
            max="1"
            step="0.02"
            style="width: 84px"
            @input="onVolumeInput"
          />
          <button class="btn ghost sm" title="全屏" @click="toggleFullscreen"><Icon name="expand" :size="15" /></button>
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
          <span class="muted" style="font-size: 11.5px">当前 {{ qnLabel(quality) }}</span>
        </div>
        <div class="row" style="flex-wrap: wrap">
          <span
            v-for="q in qualities"
            :key="q"
            class="chip"
            :class="{ on: q === quality }"
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
  </div>
</template>
