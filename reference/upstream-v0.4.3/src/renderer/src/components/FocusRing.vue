<script setup>
import { computed } from 'vue'

/* ── 专注环：圆环进度 + 大号倒计时 ────────────────────────────────────
   环上有一圈刻度（TickTick 那种），随着剩余时间变少刻度逐个变亮，圆圈本身
   也跟着走。放在独立组件里，方便别处（比如以后的全屏专注模式）复用。 */

const props = defineProps({
  /** 0 → 1 的完成度 */
  progress: { type: Number, default: 0 },
  /** 已经过格式化的大号时间文本，例如 "24:59" */
  clock: { type: String, default: '00:00' },
  /** 倒计时进行中（决定颜色与呼吸感） */
  running: { type: Boolean, default: false },
  /** 环下方的模式名 */
  modeLabel: { type: String, default: '专注' },
  /** 任务名（没绑定就显示占位文案） */
  task: { type: String, default: '' },
  size: { type: Number, default: 208 },
  /** 刻度数量，但实际会按圆周长再夹一次，避免小尺寸下刻度糊成一片 */
  ticks: { type: Number, default: 60 }
})

const R = 96
const CIRC = 2 * Math.PI * R
const CENTER = 110

const pct = computed(() => Math.min(1, Math.max(0, Number(props.progress) || 0)))

/** 刻度：数一圈，前 pct 比例的刻度算「已走过」 */
const tickList = computed(() => {
  const n = Math.max(12, Math.min(Math.round(props.ticks), Math.floor(CIRC / 9)))
  const done = Math.round(n * pct.value)
  const out = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    out.push({
      k: i,
      x1: CENTER + Math.cos(a) * 84,
      y1: CENTER + Math.sin(a) * 84,
      x2: CENTER + Math.cos(a) * 90,
      y2: CENTER + Math.sin(a) * 90,
      on: i < done
    })
  }
  return out
})

/** 数字太长时缩一点字号，别顶出圆环 */
const clockStyle = computed(() => {
  const n = props.clock.length
  const base = n >= 8 ? 26 : n >= 7 ? 30 : n >= 6 ? 35 : 40
  return { fontSize: base + 'px' }
})
</script>

<template>
  <div class="ring" :class="{ run: running }" :style="{ width: size + 'px', height: size + 'px' }">
    <svg viewBox="0 0 220 220" class="ring-svg" aria-hidden="true">
      <circle :cx="CENTER" :cy="CENTER" :r="R" class="track" stroke-width="7" fill="none" />
      <circle
        :cx="CENTER"
        :cy="CENTER"
        :r="R"
        class="fill"
        stroke-width="7"
        fill="none"
        stroke-linecap="round"
        :stroke-dasharray="CIRC"
        :stroke-dashoffset="CIRC * (1 - pct)"
        :transform="`rotate(-90 ${CENTER} ${CENTER})`"
      />
      <line
        v-for="t in tickList"
        :key="t.k"
        :x1="t.x1"
        :y1="t.y1"
        :x2="t.x2"
        :y2="t.y2"
        class="tick"
        :class="{ on: t.on }"
      />
    </svg>

    <div class="ring-body">
      <div class="ring-clock mono" :style="clockStyle">{{ clock }}</div>
      <div class="ring-mode">
        <span class="dot" :class="{ on: running }" />
        {{ modeLabel }}
      </div>
      <div class="ring-task clamp-1" :title="task || '未绑定任务'">{{ task || '未绑定任务' }}</div>
    </div>
  </div>
</template>

<style scoped>
.ring {
  position: relative;
  flex: none;
}
.ring-svg {
  display: block;
  width: 100%;
  height: 100%;
}
.track {
  stroke: var(--soft);
}
.fill {
  stroke: var(--accent);
  transition: stroke-dashoffset 0.35s linear;
}
.ring.run .fill {
  stroke: var(--ok);
}
.tick {
  stroke: var(--line-strong);
  stroke-width: 1.6;
  stroke-linecap: round;
  transition: stroke 0.3s linear;
}
.tick.on {
  stroke: var(--accent);
}
.ring.run .tick.on {
  stroke: var(--ok);
}

.ring-body {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0 34px;
  text-align: center;
}
.ring-clock {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.5px;
  line-height: 1.05;
  color: var(--t1);
}
.ring-mode {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--t2);
}
.ring-mode .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--line-strong);
  flex: none;
}
.ring-mode .dot.on {
  background: var(--ok);
  animation: pulse 1.6s ease-in-out infinite;
}
.ring-task {
  max-width: 100%;
  font-size: 11.5px;
  color: var(--t3);
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
</style>
