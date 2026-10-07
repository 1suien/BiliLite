<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import BiliImage from './BiliImage.vue'
import DashPlayer from '../player/dash'
import { useMiniStore } from '../stores/mini'
import { useSettingsStore } from '../stores/settings'
import api from '../api'

/* ── 悬浮小窗播放器 ────────────────────────────────────────────────────
   用户要求（2026-10-07）：像 B 站客户端那样，信息流卡片上点「小窗」按钮，
   视频就进小窗继续放，人可以接着翻别的页面。

   它是挂在 App.vue 上的全局组件（跟着路由一直在），所以：
   - 取流、播放、进度都写进 mini store，切页不重置；
   - 复用视频页同一个 DashPlayer（本地缓存文件走 lmedia://、在线走 DASH，都同一套逻辑）；
   - 「回到视频页」把当前秒数带进 ?t=，视频页从那儿接着播。

   播放器实例只在「有 bvid 且小窗开着」时存在，关掉就 destroy（别留着偷偷拉流）。 */

const mini = useMiniStore()
const settings = useSettingsStore()
const router = useRouter()

const rootEl = ref(null)
const videoEl = ref(null)
const dragging = ref(false)
const READY = ref(false)

let player = null
let gen = 0
let muted = false
let volume = 0.8

const size = computed(() => mini.size)

const boxStyle = computed(() => {
  const x = mini.x >= 0 ? mini.x : null
  const y = mini.y >= 0 ? mini.y : null
  return {
    width: size.value.w + 'px',
    ...(x == null ? { right: '22px' } : { left: x + 'px' }),
    ...(y == null ? { bottom: '84px' } : { top: y + 'px' })
  }
})

/** 把窗口夹在可视区内：拖到屏幕外就再也点不到了 */
function clamp(x, y) {
  const w = size.value.w
  const h = size.value.h + 30
  const maxX = Math.max(8, window.innerWidth - w - 8)
  const maxY = Math.max(8, window.innerHeight - h - 8)
  return { x: Math.min(maxX, Math.max(8, x)), y: Math.min(maxY, Math.max(8, y)) }
}

function place(x, y) {
  const c = clamp(x, y)
  mini.moveTo(c.x, c.y)
}

function teardown() {
  gen += 1
  if (player) {
    try {
      player.destroy()
    } catch {
      /* ignore */
    }
    player = null
  }
  mini.playing = false
}

async function reload() {
  if (!mini.open || !mini.bvid) return
  const myGen = ++gen
  mini.error = ''
  mini.status = '正在获取播放地址…'
  await nextTick()
  if (myGen !== gen || !videoEl.value) return

  // 卡片点进来时只有 bvid：cid 得自己查（分P信息顺带拿到标题与时长）
  let cid = Number(mini.cid) || 0
  if (!cid) {
    try {
      const pages = await api.video.pages(mini.bvid)
      const list = Array.isArray(pages) ? pages : []
      const hit = list.find((p) => Number(p.page) === Number(mini.page)) || list[0]
      if (hit) {
        cid = Number(hit.cid) || 0
        if (hit.duration) mini.duration = Number(hit.duration) || 0
        if (!mini.title && (hit.part || hit.title)) mini.title = hit.part || hit.title
      }
    } catch {
      /* 下面统一报错 */
    }
    if (myGen !== gen) return
    if (!cid) {
      mini.setError('拿不到这个视频的分P信息，换一个试试')
      return
    }
    mini.cid = cid
  }

  const qn = Number(mini.qn) || Number(settings.settings.defaultQuality) || 80
  let data = null
  try {
    data = await api.video.playurl(mini.bvid, cid, qn)
  } catch (err) {
    if (myGen === gen) mini.setError(err.message || '播放地址获取失败')
    return
  }
  if (myGen !== gen || !videoEl.value) return

  volume = Number(settings.settings.playerVolume)
  if (!Number.isFinite(volume)) volume = 0.8
  muted = false

  if (!player) {
    player = new DashPlayer(videoEl.value, {
      onStatus: (t) => {
        if (myGen === gen) mini.status = t || ''
      },
      onProgress: (t, d) => {
        if (myGen === gen) mini.setProgress(t, d)
      },
      onDuration: (d) => {
        if (myGen === gen && d) mini.duration = Number(d) || mini.duration
      },
      onState: (s) => {
        if (myGen !== gen) return
        mini.setState(s)
        if (s === 'playing') mini.status = ''
      },
      onEnded: () => {
        if (myGen === gen) mini.status = '播放结束'
      },
      onError: (e) => {
        if (myGen === gen) mini.setError(e && e.message)
      }
    })
  }
  if (player.setDurationHint) player.setDurationHint(mini.duration)
  try {
    await player.load(data, {
      startTime: mini.startTime || 0,
      volume,
      muted,
      autoplay: true
    })
    if (myGen !== gen) return
    mini.status = ''
    // 冒烟用：证明小窗真的在拉流播放（和视频页的 window.__playLog 是同一套思路）
    window.__miniLog = {
      source: 'mini',
      bvid: mini.bvid,
      cid: String(cid),
      title: mini.title,
      quality: data.quality || qn
    }
  } catch (err) {
    if (myGen === gen) mini.setError(err.message || '播放失败')
  }
}

function toggle() {
  if (!player || !videoEl.value) return
  if (videoEl.value.paused) player.play()
  else player.pause()
}

function onSeekClick(e) {
  if (!player) return
  const rect = e.currentTarget.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  player.seek(ratio * (mini.duration || 0))
}

function toggleMute() {
  muted = !muted
  if (player) player.setMuted(muted)
}

function backToPage() {
  if (!mini.bvid) return mini.close()
  // 先取目标路由：close() 会把 currentTime 清零
  const target = mini.videoTarget
  mini.close()
  router.push(target)
}

/* ── 拖动 ─────────────────────────────────────────────────────────── */
let dragFrom = null

function onDragStart(e) {
  if (e.button !== 0) return
  const el = rootEl.value
  const rect = el ? el.getBoundingClientRect() : { left: mini.x, top: mini.y }
  dragFrom = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
  dragging.value = true
  if (el && el.setPointerCapture) {
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }
  e.preventDefault()
}

function onDragMove(e) {
  if (!dragFrom) return
  place(e.clientX - dragFrom.dx, e.clientY - dragFrom.dy)
}

function onDragEnd() {
  if (!dragFrom) return
  dragFrom = null
  dragging.value = false
  mini.persist()
}

function resizeWindow() {
  if (mini.x < 0) return
  place(mini.x, mini.y)
}

onMounted(() => {
  // 第一次起来（还没存过位置）：摆到右下角、悬浮按钮上方
  if (mini.x < 0) {
    nextTick(() => {
      place(window.innerWidth - size.value.w - 26, window.innerHeight - size.value.h - 110)
      mini.persist()
    })
  }
  window.addEventListener('resize', resizeWindow)
  if (mini.open) reload()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resizeWindow)
  teardown()
})

watch(
  () => mini.seq,
  () => {
    if (mini.open) reload()
  }
)

watch(
  () => mini.open,
  (open) => {
    if (open) reload()
    else teardown()
  }
)

watch(
  () => mini.sizeIndex,
  () => {
    if (mini.x >= 0) resizeWindow()
  }
)
</script>

<template>
  <div
    v-if="mini.open"
    ref="rootEl"
    class="mini-player"
    :class="{ dragging, collapsed: mini.minimized }"
    :style="boxStyle"
    @pointermove="onDragMove"
    @pointerup="onDragEnd"
    @pointercancel="onDragEnd"
  >
    <div class="mp-head" title="按住拖动小窗" @pointerdown="onDragStart">
      <Icon name="pip" :size="14" />
      <span class="mp-title clamp-1">{{ mini.title || '小窗播放' }}</span>
      <button class="mp-btn" :title="mini.minimized ? '展开小窗' : '收起成一条'" @click="mini.toggleMinimize()">
        <Icon :name="mini.minimized ? 'up' : 'down'" :size="13" />
      </button>
      <button class="mp-btn" title="换大小" @click="mini.cycleSize()"><Icon name="size" :size="13" /></button>
      <button class="mp-btn" title="回到视频页" @click="backToPage"><Icon name="external" :size="13" /></button>
      <button class="mp-btn danger" title="关闭小窗" @click="mini.close()"><Icon name="x" :size="13" /></button>
    </div>

    <div v-show="!mini.minimized" class="mp-body">
      <video ref="videoEl" class="mp-video" playsinline @dblclick="toggle"></video>

      <div v-if="mini.error" class="mp-overlay">
        <div class="mp-err">{{ mini.error }}</div>
        <button class="btn sm" @click="reload">重试</button>
      </div>
      <div v-else-if="!mini.playing" class="mp-overlay soft" @click="toggle">
        <Icon name="play" :size="30" />
        <span class="mp-tip">{{ mini.status || '点一下继续播放' }}</span>
      </div>
      <div v-else-if="mini.status" class="mp-status mono">{{ mini.status }}</div>
    </div>

    <div v-show="!mini.minimized" class="mp-foot">
      <button class="mp-btn" :title="mini.playing ? '暂停' : '播放'" @click="toggle">
        <Icon :name="mini.playing ? 'pause' : 'play'" :size="14" />
      </button>
      <span class="mp-time mono">{{ mini.clock }}</span>
      <div class="mp-bar" title="点一下跳转" @click="onSeekClick">
        <div class="mp-track"><i :style="{ width: mini.pct + '%' }" /></div>
      </div>
      <button class="mp-btn" :title="mini.error ? '重新加载' : '静音开关'" @click="toggleMute">
        <Icon :name="muted ? 'mute' : 'volume'" :size="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.mini-player {
  position: fixed;
  z-index: 60;
  background: var(--card);
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  box-shadow: 0 18px 46px rgba(0, 0, 0, 0.42);
  overflow: hidden;
  user-select: none;
}

.mini-player.dragging {
  opacity: 0.92;
  cursor: grabbing;
}

.mp-head {
  height: 30px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px 0 10px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  cursor: grab;
  color: var(--t2);
}

.mini-player.collapsed .mp-head {
  border-bottom: none;
}

.mp-title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--t1);
}

.mp-btn {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--t2);
  cursor: pointer;
  flex: none;
}

.mp-btn:hover {
  background: var(--line);
  color: var(--t1);
}

.mp-btn.danger:hover {
  background: var(--danger);
  color: #fff;
}

.mp-body {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #000;
}

.mp-video {
  width: 100%;
  height: 100%;
  display: block;
  background: #000;
}

.mp-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  text-align: center;
  padding: 10px;
}

.mp-overlay.soft {
  background: rgba(0, 0, 0, 0.35);
  cursor: pointer;
}

.mp-err {
  font-size: 12px;
  line-height: 1.5;
}

.mp-tip {
  font-size: 11.5px;
  color: rgba(255, 255, 255, 0.85);
}

.mp-status {
  position: absolute;
  left: 8px;
  bottom: 8px;
  font-size: 11px;
  color: #fff;
  background: rgba(0, 0, 0, 0.5);
  border-radius: 6px;
  padding: 2px 6px;
}

.mp-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  height: 30px;
  border-top: 1px solid var(--line);
}

.mp-time {
  font-size: 11px;
  color: var(--t3);
  flex: none;
}

.mp-bar {
  flex: 1;
  height: 16px;
  display: flex;
  align-items: center;
  cursor: pointer;
}

.mp-track {
  width: 100%;
  height: 4px;
  border-radius: 999px;
  background: var(--line-strong);
  overflow: hidden;
}

.mp-track i {
  display: block;
  height: 100%;
  background: var(--accent);
}
</style>
