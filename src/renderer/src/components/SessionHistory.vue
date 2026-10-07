<script setup>
import { ref, computed } from 'vue'
import Icon from './Icon.vue'
import { usePomodoroStore } from '../stores/pomodoro'
import { useUiStore } from '../stores/ui'
import { fmtDuration, todayKey } from '../utils/format'

/* ── 专注记录：统计 + 历史 ────────────────────────────────────────────
   数据来源是 IndexedDB 里的 focus 表（每轮专注一行）。这里只读 + 删除，
   写入由 pomodoro store 在每轮结束时负责。 */

const pomo = usePomodoroStore()
const ui = useUiStore()

const tab = ref('recent')

const sessions = computed(() => pomo.recentSessions)
const todaySessions = computed(() =>
  sessions.value.filter((r) => r.day === todayKey())
)
const shown = computed(() => (tab.value === 'today' ? todaySessions.value : sessions.value))

const weekPeak = computed(() => Math.max(60, ...pomo.weekBars.map((b) => b.seconds)))
const avgSeconds = computed(() => {
  const days = pomo.weekBars.filter((b) => b.seconds > 0).length
  return days ? Math.round(pomo.weekSeconds / days) : 0
})

const WD = ['日', '一', '二', '三', '四', '五', '六']
function weekdayOf(key) {
  const d = new Date(`${key}T00:00:00`)
  return Number.isNaN(d.getTime()) ? '' : WD[d.getDay()]
}
function labelOf(key) {
  if (key === todayKey()) return '今天'
  const d = new Date()
  d.setDate(d.getDate() - 1)
  if (key === todayKey(d)) return '昨天'
  return key.slice(5).replace('-', '/')
}
function timeOf(ts) {
  const n = Number(ts)
  if (!n) return '--:--'
  const d = new Date(n > 1e12 ? n : n * 1000)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

async function remove(rec) {
  const ok = await ui.confirm('删除这条专注记录？', '删除后今日/本周统计会同步变化。')
  if (!ok) return
  try {
    await pomo.removeSession(rec.id)
    ui.ok('已删除专注记录')
  } catch (err) {
    ui.err(err && err.message)
  }
}

async function clearAll() {
  const ok = await ui.confirm('清空全部专注记录？', '今日/本周专注统计会一起归零，且无法恢复。')
  if (!ok) return
  try {
    await pomo.clearSessions()
    ui.ok('专注记录已清空')
  } catch (err) {
    ui.err(err && err.message)
  }
}
</script>

<template>
  <div class="panel" style="margin-bottom: 18px">
    <div class="row" style="margin-bottom: 12px">
      <Icon name="zap" :size="14" />
      <strong style="font-size: 13.5px">专注记录</strong>
      <span class="grow" />
      <button class="btn sm ghost" :disabled="!sessions.length" @click="clearAll">
        <Icon name="trash" :size="12" /> 清空
      </button>
    </div>

    <!-- 近 7 天迷你条形图 -->
    <div class="minibars">
      <div v-for="b in pomo.weekBars" :key="b.date" class="mcol" :title="`${b.date} · ${fmtDuration(b.seconds)}`">
        <span class="mval mono">{{ b.seconds ? Math.round(b.seconds / 60) : '' }}</span>
        <div class="mtrack" :class="{ today: b.date === todayKey() }">
          <i :style="{ height: Math.max(b.seconds ? 4 : 0, Math.round((b.seconds / weekPeak) * 100)) + '%' }" />
        </div>
        <span class="mlabel">{{ weekdayOf(b.date) }}</span>
      </div>
    </div>
    <p class="muted msum">
      <span>今日 <b class="mono">{{ pomo.todayCount }}</b> 轮 · <b class="mono">{{ fmtDuration(pomo.todaySeconds) }}</b></span>
      <span>近 7 天 <b class="mono">{{ fmtDuration(pomo.weekSeconds) }}</b> · {{ pomo.weekCount }} 轮</span>
      <span>有专注的日子平均 <b class="mono">{{ fmtDuration(avgSeconds) }}</b>／天</span>
      <span>平均每轮 <b class="mono">{{ fmtDuration(pomo.avgSessionSeconds) }}</b></span>
      <span v-if="pomo.streakDays > 1" class="streak">
        <Icon name="fire" :size="12" /> 连续 {{ pomo.streakDays }} 天
      </span>
      <span class="muted" style="font-size: 11px">（柱上数字是分钟）</span>
    </p>

    <div class="tabs" style="margin-top: 14px">
      <button class="tab" :class="{ on: tab === 'recent' }" @click="tab = 'recent'">最近（{{ sessions.length }}）</button>
      <button class="tab" :class="{ on: tab === 'today' }" @click="tab = 'today'">今天（{{ todaySessions.length }}）</button>
    </div>

    <div v-if="!shown.length" class="muted" style="font-size: 12.5px; padding: 14px 0">
      还没有专注记录。上面点「开始专注」，结束后这里就会出现一行。
    </div>
    <div v-else class="hlist">
      <div v-for="r in shown" :key="r.id" class="hrow">
        <span class="hdot" :class="{ skip: !r.completed }" :title="r.completed ? '已完成' : '提前结束（部分完成）'" />
        <span class="htask clamp-1" :title="r.task || '未绑定任务'">{{ r.task || '未绑定任务' }}</span>
        <span class="muted hday">{{ labelOf(r.day) }}</span>
        <span class="muted mono htime">{{ timeOf(r.startedAt) }}</span>
        <span class="mono hdur">{{ fmtDuration(r.seconds) }}</span>
        <span v-if="!r.completed" class="chip plain" style="font-size: 10.5px">部分</span>
        <button class="btn sm ghost" title="删除这条记录" @click="remove(r)"><Icon name="trash" :size="12" /></button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.minibars {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  height: 96px;
}
.mcol {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  height: 100%;
}
.mval {
  font-size: 10px;
  color: var(--t3);
  height: 12px;
  line-height: 12px;
}
.mtrack {
  flex: 1;
  width: 100%;
  max-width: 34px;
  display: flex;
  align-items: flex-end;
  border-radius: 3px;
  background: var(--soft);
  overflow: hidden;
}
.mtrack i {
  display: block;
  width: 100%;
  background: var(--accent);
  opacity: 0.8;
  border-radius: 3px;
}
.mtrack.today i {
  background: var(--ok);
  opacity: 0.9;
}
.mlabel {
  font-size: 10.5px;
  color: var(--t3);
}

.msum {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 14px;
  margin: 8px 0 0;
  font-size: 11.5px;
  line-height: 1.7;
}
.msum b {
  color: var(--t1);
  font-weight: 600;
}
.msum .streak {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--soft);
  border: 1px solid var(--line);
  color: var(--ok);
}

.hlist {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 300px;
  overflow: auto;
}
.hrow {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
}
.hrow:hover {
  background: var(--soft);
}
.hdot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ok);
  flex: none;
}
.hdot.skip {
  background: var(--line-strong);
}
.htask {
  flex: 1;
  min-width: 0;
}
.hday,
.htime {
  flex: none;
  font-size: 11.5px;
}
.hdur {
  flex: none;
  min-width: 52px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
