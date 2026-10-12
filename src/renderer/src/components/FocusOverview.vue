<script setup>
/**
 * 专注概览：右栏顶上的四张卡（今日番茄 / 今日专注时长 / 总番茄 / 总专注时长）。
 * 只读 pomodoro store 里已经算好的统计，自己不碰数据库。
 */
import { computed } from 'vue'
import Icon from './Icon.vue'
import { usePomodoroStore } from '../stores/pomodoro'

const pomo = usePomodoroStore()

/**
 * 把秒数拆成「大数字 + 小单位」，好让 115h 26m 这种长时长也能在一格里排下。
 * 不用 fmtDuration 是因为它给的是 1:55:26，卡片上更想看到「115h 26m」。
 */
function split(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  if (s === 0) return { num: '0', unit: 'm' }
  if (s < 60) return { num: String(s), unit: 's' }
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  if (h > 0) return { num: String(h), unit: m > 0 ? `h ${m}m` : 'h' }
  return { num: String(m || 1), unit: 'm' }
}

const cards = computed(() => [
  { key: 'todayCount', label: '今日番茄', num: String(pomo.todayCount), unit: '轮' },
  { key: 'todaySeconds', label: '今日专注时长', ...split(pomo.todaySeconds) },
  { key: 'allCount', label: '总番茄', num: String(pomo.allCount), unit: '轮' },
  { key: 'allSeconds', label: '总专注时长', ...split(pomo.allSeconds) }
])
</script>

<template>
  <div class="panel ov">
    <div class="ov-head">
      <Icon name="chart" :size="15" />
      <b>概览</b>
      <span class="grow" />
      <span class="muted ov-sub">全部历史 · 只存在本机</span>
    </div>
    <div class="ov-grid">
      <div v-for="c in cards" :key="c.key" class="ov-card">
        <div class="ov-k">{{ c.label }}</div>
        <div class="ov-v mono">{{ c.num }}<span class="ov-u">{{ c.unit }}</span></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ov {
  margin-bottom: 18px;
  padding: 14px 16px 16px;
}
.ov-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.ov-head > .icon {
  color: var(--brand);
}
.ov-head b {
  font-size: 14px;
}
.ov-sub {
  font-size: 12px;
}
.ov-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.ov-card {
  background: var(--soft);
  border-radius: var(--radius);
  padding: 12px 14px;
  min-width: 0;
}
.ov-k {
  font-size: 11.5px;
  color: var(--t3);
}
.ov-v {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.25;
  margin-top: 1px;
}
.ov-u {
  font-size: 12px;
  font-weight: 500;
  color: var(--t3);
  margin-left: 3px;
}
</style>
