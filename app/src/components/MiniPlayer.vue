<script setup lang="ts">
/**
 * 小窗播放器（可拖动 / 可缩放 / 跨页面常驻）
 * 还原自 main-CoY7YGNA.js 里的 MiniPlayer 组件（__name: "MiniPlayer"）
 *
 * 播放器实例来自 @/player/dash（createDashPlayer），它的状态统一写回 mini store。
 * Android WebView 里 pointer* 和 click 都会触发，所以所有按钮都走 tap() 去重。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import { useMiniStore } from '@/stores/mini'
import { useSettingsStore } from '@/stores/settings'
import { bili } from '@/bridge'
import { createDashPlayer } from '@/player/dash'

/** createDashPlayer 的返回值（按 CONTRACT 的公共 API 声明，个别方法是可选的能力探测） */
interface MiniDashPlayer {
  load(url: any, opts?: any): Promise<void>
  play(): Promise<any> | void
  pause(): void
  seek(sec: number): void
  setVolume(v: number): void
  setRate?(rate: number): void
  setMuted?(muted: boolean): void
  setDurationHint?(duration: number): void
  destroy(): void
  /** APK 里的 dash 会读这个标记来决定「用户是想播的」 */
  wasPlaying?: boolean
}

const mini = useMiniStore()
const settings = useSettingsStore()
const router = useRouter()

const rootEl = ref<HTMLElement | null>(null)
const videoEl = ref<HTMLVideoElement | null>(null)
/** 正在拖动（拖动时忽略 tap，避免拖完顺带点一下） */
const dragging = ref(false)
/** 是否静音（自动播放被拦时会自动静音重试） */
const muted = ref(false)
/** 点了播放但被系统拦下（还没真正起播） */
const blocked = ref(false)

let player: MiniDashPlayer | null = null
/** 加载代号：换视频/关闭时自增，丢弃过期的异步结果 */
let gen = 0
/** 音量（来自设置 playerVolume） */
let volume = 0.8
/** 正在进行的加载（避免重复 load） */
let loadTask: Promise<void> | null = null
/** 用户主动暂停：拖进度/暂停后不再自动续播 */
let userPaused = false
/** 自动续播次数上限 */
let resumeCount = 0
/** 拖动时的指针偏移 */
let dragOffset: { dx: number; dy: number } | null = null
/** 上一次 tap 的时间（pointerup + click 去重） */
let lastTap = 0

const size = computed(() => mini.size)
const rootStyle = computed(() => {
  const left = mini.x >= 0 ? mini.x : null
  const top = mini.y >= 0 ? mini.y : null
  return {
    width: size.value.w + 'px',
    ...(left == null ? { right: '22px' } : { left: left + 'px' }),
    ...(top == null ? { bottom: '84px' } : { top: top + 'px' }),
  }
})

/** 把坐标夹到可视区内（整窗含底栏的高度也要算进去） */
function clampPos(x: number, y: number) {
  const w = size.value.w
  const h = size.value.h + 30
  const maxX = Math.max(8, window.innerWidth - w - 8)
  const maxY = Math.max(8, window.innerHeight - h - 8)
  return {
    x: Math.min(maxX, Math.max(8, x)),
    y: Math.min(maxY, Math.max(8, y)),
  }
}

function moveTo(x: number, y: number) {
  const pos = clampPos(x, y)
  mini.moveTo(pos.x, pos.y)
}

/** 把当前进度写回 store（关闭/暂停/切页时调用） */
function saveProgress() {
  const v = videoEl.value
  if (!v) return
  const current = Number(v.currentTime)
  if (!Number.isFinite(current) || current <= 0) return
  const duration = Number(v.duration)
  mini.setProgress(current, Number.isFinite(duration) && duration > 0 ? duration : mini.duration)
}

/** 停止并销毁播放器 */
function stop() {
  saveProgress()
  gen += 1
  if (player) {
    try {
      player.destroy()
    } catch {}
    player = null
  }
  mini.playing = false
  blocked.value = false
}

/** 把静音/音量同步给播放器（契约 API 只有 setVolume，静音压到 0；实现带 setMuted 时一并调用） */
function applyAudio() {
  const v = videoEl.value
  if (player) {
    if (typeof player.setMuted === 'function') player.setMuted(muted.value)
    else player.setVolume(muted.value ? 0 : volume)
  }
  if (v) v.muted = muted.value
}

/** 创建播放器实例并把状态接回 store（只创建一次，换视频复用） */
function ensurePlayer() {
  const el = videoEl.value
  if (player || !el) return
  player = createDashPlayer(el, {
    onTime(current: number, duration: number) {
      if (!player) return
      mini.setProgress(current, duration > 0 ? duration : undefined)
    },
    onState(state: string, message?: string) {
      if (!player) return
      const v = videoEl.value
      mini.setState(state)
      if (message) mini.status = String(message)
      if (state === 'playing') {
        if (!message) mini.status = ''
        blocked.value = false
      } else if (state === 'ended') {
        mini.status = '播放结束'
        saveProgress()
      } else if (state === 'paused' || state === 'waiting') {
        saveProgress()
      }
      if (state === 'paused' && !userPaused && v && !v.ended) scheduleResume()
    },
    onError(e: Error) {
      if (!player) return
      mini.setError((e && e.message) || '播放失败')
    },
  }) as unknown as MiniDashPlayer
}

/** 加载（可能换视频了）：取 cid -> 取播放地址 -> 起播 */
async function load() {
  if (!mini.open || !mini.bvid) return
  const myGen = ++gen
  ;(window as any).__miniLoads = (Number((window as any).__miniLoads) || 0) + 1
  resumeCount = 0
  userPaused = false
  mini.error = ''
  mini.status = '正在获取播放地址…'
  await nextTick()
  if (myGen !== gen || !videoEl.value) return

  // fromCard 进来的没带 cid，先取分P拿第一 P 的 cid
  let cid = Number(mini.cid) || 0
  if (!cid) {
    try {
      const pages = await bili.video.pages(mini.bvid)
      const list = Array.isArray(pages) ? pages : []
      const page = list.find((p: any) => Number(p.page) === Number(mini.page)) || list[0]
      if (page) {
        cid = Number(page.cid) || 0
        if (page.duration) mini.duration = Number(page.duration) || 0
        if (!mini.title && (page.part || page.title)) mini.title = page.part || page.title
      }
    } catch {}
    if (myGen !== gen) return
    if (!cid) {
      mini.setError('拿不到这个视频的分P信息，换一个试试')
      return
    }
    mini.cid = cid
  }

  const qn = Number(mini.qn) || Number(settings.settings.defaultQuality) || 80
  let playUrl: any = null
  try {
    playUrl = await bili.video.playurl(mini.bvid, cid, qn)
  } catch (e: any) {
    if (myGen === gen) mini.setError(e.message || '播放地址获取失败')
    return
  }
  if (myGen !== gen || !videoEl.value) return

  volume = Number(settings.settings.playerVolume)
  if (!Number.isFinite(volume)) volume = 0.8
  muted.value = false
  blocked.value = false

  ensurePlayer()
  const p = player
  if (!p) return
  if (p.setDurationHint) p.setDurationHint(mini.duration)

  try {
    await p.load(playUrl, {
      startTime: mini.startTime || 0,
      volume,
      muted: muted.value,
      autoplay: true,
    })
    if (myGen !== gen) return
    p.setVolume(volume)
    mini.status = ''
    // 自动播放被拦：先静音再试，还不行就提示用户点一下
    if (videoEl.value && videoEl.value.paused) {
      muted.value = true
      applyAudio()
      try {
        await p.play()
      } catch {}
      if (myGen === gen && videoEl.value && videoEl.value.paused) blocked.value = true
    }
    ;(window as any).__miniLog = {
      source: 'mini',
      bvid: mini.bvid,
      cid: String(cid),
      title: mini.title,
      quality: playUrl.quality || qn,
      muted: muted.value,
      startTime: Number(mini.startTime) || 0,
      loads: Number((window as any).__miniLoads) || 0,
    }
  } catch (e: any) {
    if (myGen === gen) mini.setError(e.message || '播放失败')
  }
}

/** 去重的加载入口：同一时间只跑一个 load，后来的等前一个结束再跑 */
async function ensureLoad() {
  if (!mini.open || !mini.bvid) return
  if (loadTask) {
    try {
      await loadTask
    } catch {}
  }
  const task = load()
  loadTask = task
  try {
    await task
  } finally {
    if (loadTask === task) loadTask = null
  }
}

/** 确保在播（未加载先加载；被拦则静音重试；1.2s 后还没动就重新加载） */
async function ensurePlay() {
  const v = videoEl.value
  if (!player || !v) {
    await ensureLoad()
    return
  }
  userPaused = false
  player.wasPlaying = true
  try {
    await player.play()
  } catch {
    muted.value = true
    applyAudio()
    try {
      await player.play()
    } catch {
      await ensureLoad()
      return
    }
  }
  const startedAt = v.currentTime
  await new Promise((r) => setTimeout(r, 1200))
  if (videoEl.value === v && v.paused && Math.abs(v.currentTime - startedAt) < 0.05) {
    await ensureLoad()
  }
}

/** 暂停后 1.5s 还没恢复就自己拉起来（最多 3 次，避免死循环） */
function scheduleResume() {
  if (resumeCount >= 3) return
  resumeCount += 1
  setTimeout(() => {
    if (!mini.open || userPaused) return
    const v = videoEl.value
    if (v && (!v.paused || v.ended)) return
    ensurePlay()
  }, 1500)
}

/** 播放/暂停（视频区双击、底栏按钮） */
function togglePlay() {
  const v = videoEl.value
  if (!player || !v) {
    ensureLoad()
    return
  }
  if (v.paused) {
    userPaused = false
    ensurePlay()
  } else {
    userPaused = true
    player.pause()
  }
}

/** 点进度条跳转 */
function seekTo(e: MouseEvent) {
  if (!player) return
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  player.seek(ratio * (mini.duration || 0))
  if (videoEl.value && videoEl.value.paused) ensurePlay()
}

/** 静音开关 */
function toggleMute() {
  muted.value = !muted.value
  applyAudio()
  if (!muted.value && (!Number.isFinite(volume) || volume <= 0.01)) {
    volume = 0.8
    if (player) player.setVolume(volume)
  }
  if (!muted.value && videoEl.value && videoEl.value.paused) ensurePlay()
}

/** 回到视频页（带上当前进度） */
function backToVideo() {
  if (!mini.bvid) return mini.close()
  const target = mini.videoTarget
  mini.close()
  router.push(target)
}

// ---- 拖动 ----
function endDrag() {
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', endDrag)
  window.removeEventListener('pointercancel', endDrag)
  if (dragOffset) {
    dragOffset = null
    dragging.value = false
    mini.persist()
  }
}

function onDragMove(e: PointerEvent) {
  if (!dragOffset) return
  moveTo(e.clientX - dragOffset.dx, e.clientY - dragOffset.dy)
}

function startDrag(e: PointerEvent) {
  if (e.button !== 0) return
  const target = e.target as HTMLElement | null
  // 头部按钮自己处理点击，不让它触发拖动
  if (target && target.closest && target.closest('button')) return
  const rect = rootEl.value ? rootEl.value.getBoundingClientRect() : { left: mini.x, top: mini.y }
  dragOffset = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
  dragging.value = true
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', endDrag)
  window.addEventListener('pointercancel', endDrag)
  e.preventDefault()
}

/** 窗口尺寸变化 / 换大小后重新夹住位置 */
function onResize() {
  if (mini.x < 0) return
  moveTo(mini.x, mini.y)
}

/**
 * tap 去重：WebView 里 pointerup 和 click 都会来，500ms 内只执行一次；
 * 拖动过程中（dragging）直接忽略。原实现还会写 window.__tapLog，属于调试埋点，这里去掉。
 */
function tap(e: Event | undefined, fn: () => void) {
  if (dragging.value) return
  const now = Date.now()
  if (e && e.type === 'click' && lastTap && now - lastTap < 500) return
  lastTap = now
  if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
  fn()
}

onMounted(() => {
  // 第一次出现：没存过位置就摆到右下角，然后落盘
  if (mini.x < 0) {
    nextTick(() => {
      moveTo(
        window.innerWidth - size.value.w - 26,
        window.innerHeight - size.value.h - 110,
      )
      mini.persist()
    })
  }
  window.addEventListener('resize', onResize)
  if (mini.open) ensureLoad()
})

onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  endDrag()
  stop()
})

watch([() => mini.open, () => mini.seq], ([open]) => {
  if (open) ensureLoad()
  else stop()
})

watch(
  () => mini.sizeIndex,
  () => {
    if (mini.x >= 0) onResize()
  },
)
</script>

<template>
  <div
    v-if="mini.open"
    ref="rootEl"
    :class="['mini-player', { dragging, collapsed: mini.minimized }]"
    :style="rootStyle"
  >
    <div class="mp-head" title="按住拖动小窗" @pointerdown="startDrag">
      <Icon name="pip" :size="14" />
      <span class="mp-title clamp-1">{{ mini.title || '小窗播放' }}</span>
      <button
        class="mp-btn"
        draggable="false"
        :title="mini.minimized ? '展开小窗' : '收起成一条'"
        @pointerdown.stop="() => {}"
        @pointerup="tap($event, mini.toggleMinimize)"
        @click="tap($event, mini.toggleMinimize)"
      >
        <Icon :name="mini.minimized ? 'up' : 'down'" :size="13" />
      </button>
      <button
        class="mp-btn"
        draggable="false"
        title="换大小"
        @pointerdown.stop="() => {}"
        @pointerup="tap($event, mini.cycleSize)"
        @click="tap($event, mini.cycleSize)"
      >
        <!-- 原实现写的是 name="size"，icons.ts 里没有这个图标（APK 里渲染为空），这里用 expand -->
        <Icon name="expand" :size="13" />
      </button>
      <button
        class="mp-btn"
        draggable="false"
        title="回到视频页"
        @pointerdown.stop="() => {}"
        @pointerup="tap($event, backToVideo)"
        @click="tap($event, backToVideo)"
      >
        <Icon name="external" :size="13" />
      </button>
      <button
        class="mp-btn danger"
        draggable="false"
        title="关闭小窗"
        @pointerdown.stop="() => {}"
        @pointerup="tap($event, mini.close)"
        @click="tap($event, mini.close)"
      >
        <Icon name="x" :size="13" />
      </button>
    </div>

    <div v-show="!mini.minimized" class="mp-body">
      <video
        ref="videoEl"
        class="mp-video"
        playsinline
        @dblclick="togglePlay"
      ></video>
      <div v-if="mini.error" class="mp-overlay">
        <div class="mp-err">{{ mini.error }}</div>
        <button
          class="btn sm"
          draggable="false"
          @pointerup="tap($event, ensureLoad)"
          @click="tap($event, ensureLoad)"
        >
          重试
        </button>
      </div>
      <template v-else-if="mini.playing">
        <div v-if="mini.status" class="mp-status mono">{{ mini.status }}</div>
        <div v-else-if="muted" class="mp-status mono">已静音播放，点右下角开声音</div>
      </template>
      <div
        v-else
        class="mp-overlay soft"
        @pointerup="tap($event, ensurePlay)"
        @click="tap($event, ensurePlay)"
      >
        <Icon name="play" :size="30" />
        <span class="mp-tip">{{
          mini.status || (blocked ? '点了播放但被系统拦下，再点一下这里' : '点一下继续播放')
        }}</span>
      </div>
    </div>

    <div v-show="!mini.minimized" class="mp-foot">
      <button
        class="mp-btn"
        draggable="false"
        :title="mini.playing ? '暂停' : '播放'"
        @pointerdown.stop="() => {}"
        @pointerup="tap($event, togglePlay)"
        @click="tap($event, togglePlay)"
      >
        <Icon :name="mini.playing ? 'pause' : 'play'" :size="14" />
      </button>
      <span class="mp-time mono">{{ mini.clock }}</span>
      <div class="mp-bar" title="点一下跳转" @click="seekTo">
        <div class="mp-track">
          <i :style="{ width: mini.pct + '%' }"></i>
        </div>
      </div>
      <button
        class="mp-btn"
        draggable="false"
        :title="mini.error ? '重新加载' : '静音开关'"
        @pointerdown.stop="() => {}"
        @pointerup="tap($event, toggleMute)"
        @click="tap($event, toggleMute)"
      >
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
  box-shadow: 0 18px 46px #0000006b;
  overflow: hidden;
  user-select: none;
}
.mini-player.dragging {
  opacity: 0.92;
  cursor: grabbing;
}
.mp-head {
  height: 32px;
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
  width: 26px;
  height: 26px;
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
  background: #0000008c;
  color: #fff;
  text-align: center;
  padding: 10px;
}
.mp-overlay.soft {
  background: #00000059;
  cursor: pointer;
}
.mp-err {
  font-size: 12px;
  line-height: 1.5;
}
.mp-tip {
  font-size: 11.5px;
  color: #ffffffd9;
}
.mp-status {
  position: absolute;
  left: 8px;
  bottom: 8px;
  font-size: 11px;
  color: #fff;
  background: #00000080;
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
