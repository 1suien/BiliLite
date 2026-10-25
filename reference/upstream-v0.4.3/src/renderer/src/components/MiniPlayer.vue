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
/** 静音开关（响应式：图标要跟着变） */
const muted = ref(false)
/** 自动播放被浏览器拦下时置 true，提示文案换成「点一下播放」 */
const blocked = ref(false)

let player = null
let gen = 0
let volume = 0.8
/** 正在跑的那次取流：reload() 必须串行，两次 load() 叠在一起会把 MediaSource 顶掉 */
let inflight = null
/** 用户自己按的暂停：自动救援不能把它又拉起来 */
let userPaused = false
/** 一次取流最多自动救援几次（流断了就重建，别无限重试） */
let autoTries = 0

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

/** 以 <video> 为准回写进度：暂停/缓冲时 timeupdate 不触发，store 里的秒数可能还停在旧值 */
function syncTime() {
  const v = videoEl.value
  if (!v) return
  const t = Number(v.currentTime)
  if (!Number.isFinite(t) || t <= 0) return
  const d = Number(v.duration)
  mini.setProgress(t, Number.isFinite(d) && d > 0 ? d : mini.duration)
}

function teardown() {
  syncTime()
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
  blocked.value = false
}

/** 真正的取流流程（不要直接调它，走下面的 reload） */
async function doReload() {
  if (!mini.open || !mini.bvid) return
  const myGen = ++gen
  // 冒烟用：一次「点小窗」应该只取一路流（拆成两个 watcher 的旧写法这里会变 2）
  window.__miniLoads = (Number(window.__miniLoads) || 0) + 1
  autoTries = 0
  userPaused = false
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
  muted.value = false
  blocked.value = false

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
        if (s === 'playing') {
          mini.status = ''
          blocked.value = false
        }
        if (s === 'blocked') blocked.value = true
        // 暂停/卡住时把真实秒数落一次，免得「回到视频页」拿着一个 0 秒回去
        if (s === 'paused' || s === 'waiting' || s === 'blocked') syncTime()
        // 没点过暂停却退回了暂停态 = 流被卡掉（DashPlayer 重建缓冲时会这样）。
        // 没人管的话小窗就永远停在那一帧上，看着像「功能坏了」，所以自己救一次。
        const v = videoEl.value
        if (s === 'paused' && !userPaused && v && !v.ended) scheduleAutoResume()
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
      muted: muted.value,
      autoplay: true
    })
    if (myGen !== gen) return
    mini.status = ''
    // 自动播放被拦（或者 play() 被新的 load 打断）时退回「静音先播」：
    // 静音自动播放是被允许的，用户点右下角喇叭再开声音，总好过对着静止画面发愣。
    if (videoEl.value && videoEl.value.paused) {
      muted.value = true
      player.setMuted(true)
      try {
        await player.play()
      } catch {
        /* ignore */
      }
      if (myGen === gen && videoEl.value && videoEl.value.paused) blocked.value = true
    }
    // 冒烟用：证明小窗真的在拉流播放（和视频页的 window.__playLog 是同一套思路）
    window.__miniLog = {
      source: 'mini',
      bvid: mini.bvid,
      cid: String(cid),
      title: mini.title,
      quality: data.quality || qn,
      muted: muted.value,
      startTime: Number(mini.startTime) || 0,
      loads: Number(window.__miniLoads) || 0
    }
  } catch (err) {
    if (myGen === gen) mini.setError(err.message || '播放失败')
  }
}

/** 取流入口：串行化，避免同一时刻两次 load() 把对方的 MediaSource 顶掉 */
async function reload() {
  if (!mini.open || !mini.bvid) return
  if (inflight) {
    try {
      await inflight
    } catch {
      /* 上一次失败无所谓，下面重新来 */
    }
  }
  const run = doReload()
  inflight = run
  try {
    await run
  } finally {
    if (inflight === run) inflight = null
  }
}

/** 播放按钮 / 点画面：先试恢复，叫不动就整条重取（卡住的媒体源只有重建才能救） */
async function resume() {
  const v = videoEl.value
  if (!player || !v) {
    await reload()
    return
  }
  userPaused = false
  player.wasPlaying = true
  try {
    await v.play()
  } catch {
    muted.value = true
    player.setMuted(true)
    try {
      await v.play()
    } catch {
      await reload()
      return
    }
  }
  const t0 = v.currentTime
  await new Promise((r) => setTimeout(r, 1200))
  // 「叫了 play 但时间不动」= 源已经废了（缓冲区被顶掉/网络断了），重建重来
  if (videoEl.value === v && v.paused && Math.abs(v.currentTime - t0) < 0.05) await reload()
}

/** 卡掉之后自己救一下（最多 autoTries 次），别让用户对着死画面点来点去 */
function scheduleAutoResume() {
  if (autoTries >= 3) return
  autoTries += 1
  setTimeout(() => {
    if (!mini.open || userPaused) return
    const v = videoEl.value
    if (!v || !v.paused || v.ended) return
    resume()
  }, 1500)
}

function toggle() {
  if (!player || !videoEl.value) return
  if (videoEl.value.paused) {
    userPaused = false
    resume()
  } else {
    userPaused = true
    player.pause()
  }
}

function onSeekClick(e) {
  if (!player) return
  const rect = e.currentTarget.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  player.seek(ratio * (mini.duration || 0))
  if (videoEl.value && videoEl.value.paused) resume()
}

function toggleMute() {
  muted.value = !muted.value
  if (player) player.setMuted(muted.value)
  // 视频页把音量拉到过 0：点「开声音」就该真的听得到，别放了个寂寞
  if (!muted.value && (!Number.isFinite(volume) || volume <= 0.01)) {
    volume = 0.8
    if (player) player.setVolume(volume)
  }
  if (!muted.value && videoEl.value && videoEl.value.paused) resume()
}

function backToPage() {
  if (!mini.bvid) return mini.close()
  // 先取目标路由：close() 会把 currentTime 清零
  const target = mini.videoTarget
  mini.close()
  router.push(target)
}

/* ── 拖动 ─────────────────────────────────────────────────────────── */
// ⚠ 别在这里 setPointerCapture：指针被抢到根节点以后，pointerup 的落点也变成根节点，
// 浏览器算出来的 click 目标就成了「按钮和根节点的共同祖先」= 根节点，
// 于是标题栏上那排按钮（收起/换大小/回到视频页/关闭）全都点不动（用户反馈「画圈部分点击不生效」）。
// 现在改成：按钮上的按下直接放行；拖动期间把 move/up 挂到 window 上，指针离开小窗也跟得住。
let dragFrom = null

function unbindDrag() {
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
  window.removeEventListener('pointercancel', onDragEnd)
}

/* 小窗里的按钮同时挂 pointerup 和 click，谁先来用谁，另一次在 500ms 内丢掉：
   - 真实鼠标/触摸/手写笔一定先来 pointerup（可靠，不受「click 被拖动或 preventDefault 吞掉」影响）；
   - 某些注入式输入（例如 Electron 的 sendInputEvent，用于冒烟）根本不产生 pointer 事件，
     这时只有 click 会来，照样能用。
   配合模板里的 @pointerdown.stop：在按钮上按下绝不会变成拖动；拖动中松手也不算点击。 */
let lastTap = 0

/* 交互点收口：模板里必须写成 tap($event, () => …)。
   坑（已踩过）：写成 tap(() => …) 是 Vue 的「内联语句」，编译出来是 ($event) => tap(() => …)——
   只会执行到工厂函数、把返回的 handler 丢掉，按钮看着有监听器（_vei 里也有 onClick）却永远不响应。 */
function tap(e, fn) {
  const row = { t: (e && e.type) || '?', drag: dragging.value, since: lastTap ? Date.now() - lastTap : -1, ran: false }
  if (!window.__tapLog) window.__tapLog = []
  if (window.__tapLog.length > 40) window.__tapLog.shift()
  window.__tapLog.push(row)
  if (dragging.value) return
  const now = Date.now()
  if (e && e.type === 'click' && lastTap && now - lastTap < 500) return
  lastTap = now
  row.ran = true
  if (e && e.stopPropagation) e.stopPropagation()
  fn()
}

function onDragStart(e) {
  if (e.button !== 0) return
  // 点在按钮上就别抢：抢了就是拖动，按钮也按不动
  if (e.target && e.target.closest && e.target.closest('button')) return
  const el = rootEl.value
  const rect = el ? el.getBoundingClientRect() : { left: mini.x, top: mini.y }
  dragFrom = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
  dragging.value = true
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
  window.addEventListener('pointercancel', onDragEnd)
  e.preventDefault()
}

function onDragMove(e) {
  if (!dragFrom) return
  place(e.clientX - dragFrom.dx, e.clientY - dragFrom.dy)
}

function onDragEnd() {
  unbindDrag()
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
  unbindDrag()
  teardown()
})

/* ⚠ 这里必须是一个 watcher：play() 会同时改 open 和 seq，
   拆成两个 watcher 的话同一次点击会跑两遍 reload() —— 两遍 load() 叠在一起，
   后一遍会把前一遍的 MediaSource 顶掉，表现就是「放两秒停住、点播放也没反应」。 */
watch(
  [() => mini.open, () => mini.seq],
  ([open]) => {
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
  >
    <div class="mp-head" title="按住拖动小窗" @pointerdown="onDragStart">
      <Icon name="pip" :size="14" />
      <span class="mp-title clamp-1">{{ mini.title || '小窗播放' }}</span>
      <button
        class="mp-btn"
        draggable="false"
        :title="mini.minimized ? '展开小窗' : '收起成一条'"
        @pointerdown.stop
        @pointerup="tap($event, () => mini.toggleMinimize())" @click="tap($event, () => mini.toggleMinimize())"
      >
        <Icon :name="mini.minimized ? 'up' : 'down'" :size="13" />
      </button>
      <button
        class="mp-btn"
        draggable="false"
        title="换大小"
        @pointerdown.stop
        @pointerup="tap($event, () => mini.cycleSize())" @click="tap($event, () => mini.cycleSize())"
      >
        <Icon name="size" :size="13" />
      </button>
      <button
        class="mp-btn"
        draggable="false"
        title="回到视频页"
        @pointerdown.stop
        @pointerup="tap($event, backToPage)" @click="tap($event, backToPage)"
      >
        <Icon name="external" :size="13" />
      </button>
      <button
        class="mp-btn danger"
        draggable="false"
        title="关闭小窗"
        @pointerdown.stop
        @pointerup="tap($event, () => mini.close())" @click="tap($event, () => mini.close())"
      >
        <Icon name="x" :size="13" />
      </button>
    </div>

    <div v-show="!mini.minimized" class="mp-body">
      <video ref="videoEl" class="mp-video" playsinline @dblclick="toggle"></video>

      <div v-if="mini.error" class="mp-overlay">
        <div class="mp-err">{{ mini.error }}</div>
        <button class="btn sm" draggable="false" @pointerup="tap($event, reload)" @click="tap($event, reload)">重试</button>
      </div>
      <div v-else-if="!mini.playing" class="mp-overlay soft" @pointerup="tap($event, resume)" @click="tap($event, resume)">
        <Icon name="play" :size="30" />
        <span class="mp-tip">{{ mini.status || (blocked ? '点了播放但被系统拦下，再点一下这里' : '点一下继续播放') }}</span>
      </div>
      <div v-else-if="mini.status" class="mp-status mono">{{ mini.status }}</div>
      <div v-else-if="muted" class="mp-status mono">已静音播放，点右下角开声音</div>
    </div>

    <div v-show="!mini.minimized" class="mp-foot">
      <button
        class="mp-btn"
        draggable="false"
        :title="mini.playing ? '暂停' : '播放'"
        @pointerdown.stop
        @pointerup="tap($event, toggle)" @click="tap($event, toggle)"
      >
        <Icon :name="mini.playing ? 'pause' : 'play'" :size="14" />
      </button>
      <span class="mp-time mono">{{ mini.clock }}</span>
      <div class="mp-bar" title="点一下跳转" @click="onSeekClick">
        <div class="mp-track"><i :style="{ width: mini.pct + '%' }" /></div>
      </div>
      <button
        class="mp-btn"
        draggable="false"
        :title="mini.error ? '重新加载' : '静音开关'"
        @pointerdown.stop
        @pointerup="tap($event, toggleMute)" @click="tap($event, toggleMute)"
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
  box-shadow: 0 18px 46px rgba(0, 0, 0, 0.42);
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
