<script setup lang="ts">
/**
 * 专注总览：今日番茄 / 今日时长 / 总番茄 / 总时长 四个数字卡
 * 还原自 LearnView-ByneIRdr.js 的 FocusOverview 组件（data-v-c22ce961）。
 * 注意：这个组件里没有任何图表，纯 DOM + CSS。
 */
import { computed } from 'vue'
import Icon from '@/components/Icon.vue'
import { usePomodoroStore } from '@/stores/pomodoro'

const pomo = usePomodoroStore()

/** 秒 -> { 数字, 单位 }，拆开是为了让数字大、单位小 */
function splitSeconds(sec: any) {
  const v = Math.max(0, Math.round(Number(sec) || 0))
  if (v === 0) return { num: '0', unit: 'm' }
  if (v < 60) return { num: String(v), unit: 's' }
  const h = Math.floor(v / 3600)
  const m = Math.round((v % 3600) / 60)
  if (h > 0) return { num: String(h), unit: m > 0 ? `h ${m}m` : 'h' }
  return { num: String(m || 1), unit: 'm' }
}

const cards = computed(() => [
  { key: 'todayCount', label: '今日番茄', num: String(pomo.todayCount), unit: '轮' },
  { key: 'todaySeconds', label: '今日专注时长', ...splitSeconds(pomo.todaySeconds) },
  { key: 'allCount', label: '总番茄', num: String(pomo.allCount), unit: '轮' },
  { key: 'allSeconds', label: '总专注时长', ...splitSeconds(pomo.allSeconds) },
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
        <div class="ov-v mono">
          {{ c.num }}<span class="ov-u">{{ c.unit }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 来源: LearnView-DSahkCnj.css  scope: data-v-c22ce961 */
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
