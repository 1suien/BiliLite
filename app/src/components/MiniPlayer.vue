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

/** 圆形气泡直径（px）；进度环半径 47（viewBox 100，描边 3，留 2px 边距） */
const BUBBLE = 112
const RING_LEN = 2 * Math.PI * 47

const rootStyle = computed(() => {
  const left = mini.x >= 0 ? mini.x : null
  const top = mini.y >= 0 ? mini.y : null
  return {
    ...(left == null ? { right: '18px' } : { left: left + 'px' }),
    ...(top == null ? { bottom: '96px' } : { top: top + 'px' }),
  }
})

/** 把坐标夹到可视区内（圆形气泡是正方形） */
function clampPos(x: number, y: number) {
  const maxX = Math.max(8, window.innerWidth - BUBBLE - 8)
  const maxY = Math.max(8, window.innerHeight - BUBBLE - 8)
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

/** 回到视频页（带上当前进度） */
function backToVideo() {
  if (!mini.bvid) return mini.close()
  const target = mini.videoTarget
  mini.close()
  router.push(target)
}

// ---- 拖动（整个圆圈都能拖；松手时位移小才算「点」） ----
let dragFrom: { x: number; y: number } | null = null
let justDraggedAt = 0

function endDrag() {
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', endDrag)
  window.removeEventListener('pointercancel', endDrag)
  if (dragging.value) {
    dragging.value = false
    justDraggedAt = Date.now()
    mini.persist()
  }
  dragFrom = null
  dragOffset = null
}

function onDragMove(e: PointerEvent) {
  if (!dragOffset || !dragFrom) return
  if (!dragging.value) {
    const moved = Math.hypot(e.clientX - dragFrom.x, e.clientY - dragFrom.y)
    if (moved < 8) return
    dragging.value = true
  }
  moveTo(e.clientX - dragOffset.dx, e.clientY - dragOffset.dy)
}

function startDrag(e: PointerEvent) {
  if (e.button !== 0) return
  const rect = rootEl.value ? rootEl.value.getBoundingClientRect() : { left: mini.x, top: mini.y }
  dragFrom = { x: e.clientX, y: e.clientY }
  dragOffset = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', endDrag)
  window.addEventListener('pointercancel', endDrag)
}

/** 窗口尺寸变化后重新夹住位置 */
function onResize() {
  if (mini.x < 0) return
  moveTo(mini.x, mini.y)
}

/**
 * tap 去重：WebView 里 pointerup 和 click 都会来，500ms 内只执行一次；
 * 刚拖动过（<350ms）忽略，避免拖完顺带点到。
 */
function tap(e: Event | undefined, fn: () => void) {
  if (dragging.value || Date.now() - justDraggedAt < 350) return
  const now = Date.now()
  if (e && e.type === 'click' && lastTap && now - lastTap < 500) return
  lastTap = now
  // 注意：这里不能 stopPropagation，否则 window 上的 pointerup（endDrag）收不到，拖动监听会泄漏
  fn()
}

onMounted(() => {
  // 第一次出现：没存过位置就摆到右下角，然后落盘
  if (mini.x < 0) {
    nextTick(() => {
      moveTo(window.innerWidth - BUBBLE - 22, window.innerHeight - BUBBLE - 104)
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
</script>

<template>
  <div
    v-if="mini.open"
    ref="rootEl"
    :class="['mini-player', { dragging }]"
    :style="rootStyle"
    @pointerdown="startDrag"
  >
    <video ref="videoEl" class="mp-video" playsinline></video>
    <div class="mp-shade"></div>

    <!-- 进度环：沿圆圈一圈显示播放进度 -->
    <svg class="mp-ring" viewBox="0 0 100 100" aria-hidden="true">
      <circle class="mp-ring-bg" cx="50" cy="50" r="47" />
      <circle
        class="mp-ring-fg"
        cx="50"
        cy="50"
        r="47"
        :style="{ strokeDashoffset: String(RING_LEN * (1 - mini.pct / 100)) }"
      />
    </svg>

    <div v-if="!mini.playing" class="mp-badge">
      <Icon :name="mini.error ? 'refresh' : 'play'" :size="24" />
    </div>

    <button
      class="mp-close"
      draggable="false"
      title="关闭小窗"
      @pointerdown.stop="() => {}"
      @pointerup="tap($event, mini.close)"
      @click="tap($event, mini.close)"
    >
      <Icon name="x" :size="11" />
    </button>

    <button
      class="mp-tap"
      draggable="false"
      :title="
        mini.error
          ? `播放出错：${mini.error}（点一下回到视频页）`
          : '点一下回到视频页继续看；按住可拖动位置'
      "
      @pointerup="tap($event, backToVideo)"
      @click="tap($event, backToVideo)"
    >
      <span v-if="mini.error" class="mp-tip">出错了，点一下回视频页</span>
      <span v-else-if="mini.status" class="mp-tip">{{ mini.status }}</span>
      <span v-else class="mp-clock mono">{{ mini.clock }}</span>
    </button>
  </div>
</template>

<style scoped>
/* 圆形气泡小窗（本机定制：原来的长方形小窗改成右下角的小圆圈，点圆圈回到视频页继续看） */
.mini-player {
  position: fixed;
  z-index: 60;
  width: 112px;
  height: 112px;
  border-radius: 50%;
  /* 不裁切根元素：右上角关闭按钮要能被点到（圆的角落会被 overflow:hidden 裁掉命中区） */
  overflow: visible;
  background: #000;
  border: 2px solid var(--line-strong);
  box-shadow: 0 14px 34px #0000008c;
  user-select: none;
  touch-action: none;
  cursor: grab;
}
.mini-player.dragging {
  opacity: 0.92;
  cursor: grabbing;
}
.mp-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  background: #000;
  border-radius: 50%;
  overflow: hidden;
}
.mp-shade {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: radial-gradient(circle, #0000 52%, #00000038 100%);
  pointer-events: none;
}
.mp-ring {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
  pointer-events: none;
}
.mp-ring circle {
  fill: none;
  stroke-width: 3;
}
.mp-ring-bg {
  stroke: #ffffff2e;
}
.mp-ring-fg {
  stroke: var(--brand);
  stroke-linecap: round;
  stroke-dasharray: 295.31;
  transition: stroke-dashoffset 0.25s linear;
}
.mp-badge {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #00000066;
  color: #fff;
  pointer-events: none;
}
.mp-close {
  position: absolute;
  top: 0;
  right: 0;
  z-index: 3;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: #000000a8;
  color: #fff;
  cursor: pointer;
}
.mp-tap {
  position: absolute;
  inset: 7px;
  z-index: 2;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 0 0 9px;
  border: none;
  border-radius: 50%;
  background: none;
  cursor: pointer;
  overflow: hidden;
}
.mp-tip {
  font-size: 10px;
  line-height: 1.25;
  color: #fff;
  background: #000000a8;
  border-radius: 6px;
  padding: 1px 5px;
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mp-clock {
  font-size: 10px;
  color: #fff;
  background: #000000a8;
  border-radius: 6px;
  padding: 1px 5px;
}
</style>
