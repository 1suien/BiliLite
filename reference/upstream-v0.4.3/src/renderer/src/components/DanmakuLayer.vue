<script setup>
/**
 * 弹幕层：把 { time, mode, size, color, text } 列表按播放进度飘出来。
 * 用 rAF 跟着 <video>.currentTime 走，所以拖动进度、倍速播放都能跟上。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({
  items: { type: Array, default: () => [] },
  enabled: { type: Boolean, default: true },
  opacity: { type: Number, default: 0.9 },
  /** <video> 元素引用（父组件的 ref 对象） */
  video: { type: Object, default: null },
  /** 弹幕占播放器高度的比例 */
  area: { type: Number, default: 1 }
})

const boxEl = ref(null)
const LANE_H = 34
const CROSS_SECONDS = 8

let raf = 0
let cursor = 0
let lastTime = -1
let lanes = []

function clearAll() {
  const box = boxEl.value
  if (!box) return
  while (box.firstChild) box.removeChild(box.firstChild)
  lanes = []
}

function colorOf(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return '#ffffff'
  return '#' + v.toString(16).padStart(6, '0')
}

function laneCount() {
  const box = boxEl.value
  if (!box) return 1
  const usable = Math.max(40, box.clientHeight * Math.max(0.25, Math.min(1, props.area)))
  return Math.max(1, Math.floor((usable - 8) / LANE_H))
}

function spawn(dm, width, now) {
  const box = boxEl.value
  if (!box) return
  const el = document.createElement('div')
  el.className = 'dm-item'
  el.textContent = dm.text
  el.style.color = colorOf(dm.color)
  el.style.fontSize = (dm.size ? Math.max(14, Math.min(30, dm.size)) : 20) + 'px'
  box.appendChild(el)
  const w = el.offsetWidth || 120
  const count = laneCount()

  // 顶部（mode 5）/ 底部（mode 4）弹幕：居中停留几秒
  if (dm.mode === 4 || dm.mode === 5) {
    const lane = dm.mode === 5 ? 0 : Math.max(0, count - 1)
    el.style.top = lane * LANE_H + 4 + 'px'
    el.style.left = Math.max(0, (width - w) / 2) + 'px'
    const anim = el.animate(
      [{ opacity: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 1, offset: 0.9 }, { opacity: 0 }],
      { duration: 4200, easing: 'linear' }
    )
    anim.onfinish = () => el.remove()
    return
  }

  // 滚动弹幕：轨道上的“尾巴”离开右边缘后就能再用这条轨道
  const speed = width / CROSS_SECONDS
  let lane = -1
  for (let i = 0; i < count; i++) {
    if ((lanes[i] || 0) <= now) {
      lane = i
      break
    }
  }
  if (lane < 0) lane = 0
  lanes[lane] = now + (w / speed) * 1000 + 180
  const duration = ((width + w) / speed) * 1000
  el.style.top = lane * LANE_H + 4 + 'px'
  const anim = el.animate(
    [
      { transform: `translateX(${width}px)` },
      { transform: `translateX(${-w - 4}px)` }
    ],
    { duration, easing: 'linear' }
  )
  anim.onfinish = () => el.remove()
}

function lowerBound(items, t) {
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (items[mid].time < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

function tick() {
  raf = requestAnimationFrame(tick)
  const box = boxEl.value
  if (!box) return
  if (!props.enabled) return
  const items = props.items
  if (!items || !items.length) return
  const v = props.video
  const t = v ? Number(v.currentTime) || 0 : -1
  if (t < 0) return

  // 拖动进度 / 刚起播 / 切集：清屏并把游标挪到当前位置
  if (lastTime < 0 || t < lastTime - 0.35 || t > lastTime + 1.6) {
    clearAll()
    cursor = lowerBound(items, t)
  }
  lastTime = t

  const width = box.clientWidth || 640
  const now = performance.now()
  let budget = 14
  while (cursor < items.length && items[cursor].time <= t && budget > 0) {
    spawn(items[cursor], width, now)
    cursor += 1
    budget -= 1
  }
}

watch(
  () => props.items,
  () => {
    clearAll()
    cursor = 0
    lastTime = -1
  }
)

watch(
  () => props.enabled,
  (on) => {
    if (!on) clearAll()
    else {
      cursor = 0
      lastTime = -1
    }
  }
)

onMounted(() => {
  raf = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  clearAll()
})

defineExpose({ clear: clearAll })
</script>

<template>
  <div ref="boxEl" class="dm-layer" :style="{ opacity: enabled ? opacity : 0 }" />
</template>
