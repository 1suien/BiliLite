<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import BiliImage from '../components/BiliImage.vue'
import EmptyBlock from '../components/EmptyBlock.vue'
import Icon from '../components/Icon.vue'
import { useLearnStore } from '../stores/learn'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { usePomodoroStore } from '../stores/pomodoro'
import { fmtHours, fmtDuration, fmtAgo } from '../utils/format'

const router = useRouter()
const learn = useLearnStore()
const settings = useSettingsStore()
const ui = useUiStore()
const pomo = usePomodoroStore()

// 番茄钟时长输入框（改完回写 store，超范围会被 store 夹回合法值）
const focusInput = ref(pomo.focusMin)
const shortInput = ref(pomo.shortMin)
const longInput = ref(pomo.longMin)

function applyDurations() {
  pomo.setDurations({ focusMin: focusInput.value, shortMin: shortInput.value, longMin: longInput.value })
  focusInput.value = pomo.focusMin
  shortInput.value = pomo.shortMin
  longInput.value = pomo.longMin
}

const tab = ref('recent')
const ready = ref(false)

const recent = computed(() => learn.listByVideo.slice(0, 40))
const shelf = computed(() => learn.shelf)
const peak = computed(() => Math.max(1, learn.maxDailySeconds))
const recent14 = computed(() => learn.recentDays)

const stats = computed(() => [
  { label: '总学习时长', value: fmtHours(learn.totalSeconds) + ' h', icon: 'clock' },
  { label: '看过视频', value: String(learn.totalVideos), icon: 'play' },
  { label: '已看完', value: String(learn.completedCount), icon: 'check' },
  { label: '在看', value: String(learn.inProgressCount), icon: 'chart' },
  { label: '连续签到（天）', value: String(learn.checkinStreak), icon: 'fire' }
])

// ── 签到日历 ──────────────────────────────────────────────
const YEAR = new Date().getFullYear()
const checkinSet = computed(() => new Set(learn.checkins))
const checkedToday = computed(() => checkinSet.value.has(todayKeyLocal()))

function keyOfDate(d) {
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function todayKeyLocal() {
  return keyOfDate(new Date())
}

/** 一年 53 列 × 7 行（周一为首行） */
const calendar = computed(() => {
  const jan1 = new Date(YEAR, 0, 1)
  const mondayOffset = (jan1.getDay() + 6) % 7
  const cursor = new Date(YEAR, 0, 1 - mondayOffset)
  const cols = []
  while (cursor.getFullYear() <= YEAR) {
    const week = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(cursor)
      const key = keyOfDate(d)
      week.push({
        key,
        day: d.getDate(),
        inYear: d.getFullYear() === YEAR,
        checked: checkinSet.value.has(key)
      })
      cursor.setDate(cursor.getDate() + 1)
    }
    cols.push(week)
    if (cursor.getFullYear() > YEAR) break
  }
  return cols
})

const monthLabels = computed(() =>
  calendar.value.map((week) => {
    const first = week.find((d) => d.inYear && d.day === 1)
    return first ? `${new Date(first.key).getMonth() + 1}月` : ''
  })
)

async function doCheckin() {
  const added = await learn.checkin()
  if (added) ui.ok(`打卡成功，已连续 ${learn.checkinStreak} 天`)
  else ui.toast('今天已经打过卡了')
}

// ── 按 UP 分布（饼图）────────────────────────────────────
const PIE_COLORS = ['#6ea8fe', '#7fd68a', '#f0a868', '#b39ddb', '#5ad1c8', '#e879a6', '#d9d9de', '#8a8a93']
const RADIUS = 54
const CIRC = 2 * Math.PI * RADIUS

const pie = computed(() => {
  const rows = learn.upDistribution.slice(0, 8)
  let acc = 0
  return rows.map((r, i) => {
    const len = r.pct * CIRC
    const seg = {
      ...r,
      color: PIE_COLORS[i % PIE_COLORS.length],
      dash: `${len} ${CIRC - len}`,
      offset: -acc
    }
    acc += len
    return seg
  })
})

function pct(rec) {
  if (!rec.duration) return 0
  return Math.min(1, rec.seconds / rec.duration)
}

function open(rec) {
  router.push({ name: 'video', params: { bvid: rec.bvid }, query: { cid: rec.cid } })
}

async function removeRec(rec) {
  const ok = await ui.confirm('删除这条学习记录？', '删除后该视频的进度会清零。')
  if (!ok) return
  try {
    const { db } = await import('../db')
    await db.progress.delete(rec.key)
    await learn.init(true)
    ui.ok('已删除记录')
  } catch (err) {
    ui.err(err.message)
  }
}

async function clearAll() {
  const ok = await ui.confirm('清空全部学习数据？', '进度、每日时长、签到、笔记、学习清单都会被删除，且无法恢复。')
  if (!ok) return
  await learn.clearAll()
  ui.ok('学习数据已清空')
}

async function exportJson() {
  try {
    const { db } = await import('../db')
    const [progress, dailyRows, notes, shelfRows, checkins, upTime] = await Promise.all([
      db.progress.toArray(),
      db.daily.toArray(),
      db.notes.toArray(),
      db.shelf.toArray(),
      db.checkins.toArray(),
      db.upTime.toArray()
    ])
    const payload = {
      app: 'study-bili',
      exportedAt: new Date().toISOString(),
      progress,
      daily: dailyRows,
      notes,
      shelf: shelfRows,
      checkins,
      upTime
    }
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
    ui.ok('学习数据已复制到剪贴板')
  } catch (err) {
    ui.err(err.message || '导出失败')
  }
}

onMounted(async () => {
  try {
    await learn.init(true)
  } catch (err) {
    ui.err(err.message)
  }
  pomo.init()
  focusInput.value = pomo.focusMin
  shortInput.value = pomo.shortMin
  longInput.value = pomo.longMin
  ready.value = true
})
</script>

<template>
  <div>
    <div class="page-head">
      <h1>学习</h1>
      <p>所有数据只保存在本机（IndexedDB），不会上传。</p>
      <span class="grow" />
      <button class="btn sm ghost" @click="exportJson"><Icon name="list" :size="14" /> 导出 JSON</button>
      <button class="btn sm" style="color: var(--danger)" @click="clearAll"><Icon name="trash" :size="14" /> 清空</button>
    </div>

    <div class="stat-grid">
      <div v-for="s in stats" :key="s.label" class="stat">
        <div class="k row" style="gap: 6px; align-items: center">
          <Icon :name="s.icon" :size="13" /> {{ s.label }}
        </div>
        <div class="v">{{ s.value }}</div>
      </div>
    </div>

    <!-- 番茄钟 -->
    <div class="panel pomo" style="margin: 18px 0 0">
      <div class="row" style="margin-bottom: 10px">
        <Icon name="clock" :size="15" />
        <strong style="font-size: 13.5px">番茄钟</strong>
        <span class="grow" />
        <span class="muted" style="font-size: 12.5px">
          今日完成 {{ pomo.doneToday }} 个 · {{ pomo.modeLabel }}
        </span>
      </div>

      <div class="pomo-row">
        <div class="pomo-clock" :class="{ run: pomo.running }">{{ pomo.clock }}</div>
        <div class="pomo-side">
          <div class="row pomo-modes" style="gap: 6px; flex-wrap: wrap">
            <span class="chip" :class="{ on: pomo.mode === 'focus' }" @click="pomo.setMode('focus')">专注</span>
            <span class="chip" :class="{ on: pomo.mode === 'short' }" @click="pomo.setMode('short')">短休息</span>
            <span class="chip" :class="{ on: pomo.mode === 'long' }" @click="pomo.setMode('long')">长休息</span>
          </div>
          <div class="pomo-bar"><i :style="{ width: Math.round(pomo.progress * 100) + '%' }" /></div>
          <div class="row pomo-ctl" style="gap: 8px; flex-wrap: wrap">
            <button class="btn sm primary" @click="pomo.toggle()">
              <Icon :name="pomo.running ? 'pause' : 'play'" :size="14" />
              {{ pomo.running ? '暂停' : '开始' }}
            </button>
            <button class="btn sm ghost" @click="pomo.reset()"><Icon name="refresh" :size="14" /> 重置</button>
            <button class="btn sm ghost" @click="pomo.finish(false)">跳过</button>
            <span class="grow" />
            <span class="muted" style="font-size: 11.5px">专注结束自动计入学习时长</span>
          </div>
          <div class="row pomo-nums">
            <span class="muted" style="font-size: 11.5px">时长（分钟）</span>
            <label>专注 <input v-model.number="focusInput" class="input" type="number" min="1" max="180" @change="applyDurations" /></label>
            <label>短休 <input v-model.number="shortInput" class="input" type="number" min="1" max="180" @change="applyDurations" /></label>
            <label>长休 <input v-model.number="longInput" class="input" type="number" min="1" max="180" @change="applyDurations" /></label>
          </div>
        </div>
      </div>
    </div>

    <!-- 每日签到 -->
    <div class="panel" style="margin: 18px 0">
      <div class="row" style="margin-bottom: 12px">
        <strong style="font-size: 13.5px">每日签到 · {{ YEAR }}年</strong>
        <span class="grow" />
        <span v-if="checkedToday" class="muted" style="font-size: 12.5px; color: var(--ok)">
          签到成功，已连续 {{ learn.checkinStreak }} 天
        </span>
        <span v-else class="muted" style="font-size: 12.5px">今天还没打卡</span>
        <button class="btn sm" :class="{ primary: !checkedToday }" :disabled="checkedToday" @click="doCheckin">
          <Icon name="calendar" :size="14" /> {{ checkedToday ? '今日已签到' : '今日打卡' }}
        </button>
      </div>

      <div class="cal-wrap">
        <div class="wd">
          <span v-for="w in ['一', '二', '三', '四', '五', '六', '日']" :key="w">{{ w }}</span>
        </div>
        <div class="cal-scroll">
          <div class="months">
            <span v-for="(m, i) in monthLabels" :key="i" class="mlabel">{{ m }}</span>
          </div>
          <div class="cal">
            <div v-for="(week, ci) in calendar" :key="ci" class="col">
              <i
                v-for="d in week"
                :key="d.key"
                class="cell"
                :class="{ on: d.checked, out: !d.inYear }"
                :title="d.inYear ? `${d.key} · ${d.checked ? '已签到' : '未签到'}` : ''"
              />
            </div>
          </div>
        </div>
      </div>
      <p class="muted" style="margin: 10px 0 0; font-size: 12px; color: var(--ok)">绿色 = 已签到</p>
    </div>

    <!-- 近 14 天条形图 -->
    <div class="panel" style="margin-bottom: 18px">
      <div class="row" style="margin-bottom: 12px">
        <strong style="font-size: 13.5px">每日学习（条形图 · 近 14 天）</strong>
        <span class="grow" />
        <span class="muted" style="font-size: 12px">峰值 {{ fmtHours(learn.maxDailySeconds) }} h / 天</span>
      </div>
      <div class="bars14">
        <div v-for="d in recent14" :key="d.date" class="bcol" :title="d.date + ' · ' + fmtHours(d.seconds) + ' h'">
          <div class="btrack">
            <i :style="{ height: Math.max(2, Math.round((d.seconds / peak) * 100)) + '%' }" />
          </div>
          <span class="blabel mono">{{ d.date.slice(5).replace('-', '/') }}</span>
        </div>
      </div>
    </div>

    <!-- 按 UP 分布 -->
    <div class="panel" style="margin-bottom: 18px">
      <div class="row" style="margin-bottom: 12px">
        <strong style="font-size: 13.5px">按 UP 分布（饼图）</strong>
        <span class="grow" />
        <span class="muted" style="font-size: 12px">统计每个 UP 的累计学习时长</span>
      </div>
      <EmptyBlock v-if="!pie.length" icon="pie" title="还没有分布数据" desc="播放视频满 10 秒后，就会按 UP 统计学习时长。" />
      <div v-else class="pie-wrap">
        <svg viewBox="0 0 140 140" class="pie">
          <circle cx="70" cy="70" :r="RADIUS" fill="none" stroke="var(--soft)" stroke-width="18" />
          <circle
            v-for="(s, i) in pie"
            :key="i"
            cx="70"
            cy="70"
            :r="RADIUS"
            fill="none"
            :stroke="s.color"
            stroke-width="18"
            :stroke-dasharray="s.dash"
            :stroke-dashoffset="s.offset"
            transform="rotate(-90 70 70)"
          >
            <title>{{ s.name }} · {{ fmtHours(s.seconds) }} h</title>
          </circle>
        </svg>
        <div class="legend">
          <div v-for="(s, i) in pie" :key="i" class="lgrow">
            <span class="dot" :style="{ background: s.color }" />
            <span class="grow clamp-1">{{ s.name }}</span>
            <span class="muted mono" style="font-size: 12px">{{ Math.round(s.pct * 100) }}% · {{ fmtHours(s.seconds) }} h</span>
          </div>
        </div>
      </div>
    </div>

    <div class="tabs">
      <button class="tab" :class="{ on: tab === 'recent' }" @click="tab = 'recent'">学习进度（{{ recent.length }}）</button>
      <button class="tab" :class="{ on: tab === 'shelf' }" @click="tab = 'shelf'">学习清单（{{ shelf.length }}）</button>
    </div>

    <div v-if="!ready" class="panel row" style="gap: 10px"><span class="spinner" /><span class="dim">读取本地数据…</span></div>

    <template v-else-if="tab === 'recent'">
      <EmptyBlock
        v-if="!recent.length"
        icon="chart"
        title="还没有学习记录"
        desc="打开任意视频播放几秒，进度就会自动记录在这里。"
      >
        <button class="btn primary" @click="router.push('/')">去首页找视频</button>
      </EmptyBlock>
      <div v-else style="display: flex; flex-direction: column; gap: 4px">
        <div v-for="rec in recent" :key="rec.key" class="rowitem" @click="open(rec)">
          <BiliImage :src="rec.cover" :alt="rec.title" />
          <div class="info grow">
            <div class="t clamp-1">{{ rec.title || rec.bvid }}</div>
            <div class="d">
              {{ rec.upName || '未知 UP' }} · 已看 {{ fmtDuration(Math.floor(rec.seconds)) }} / {{ fmtDuration(rec.duration) }}
              · {{ fmtAgo(rec.updatedAt) }}
            </div>
            <div class="progress thin"><i :style="{ width: (pct(rec) * 100).toFixed(1) + '%' }" /></div>
          </div>
          <span v-if="rec.completed" class="chip on" style="flex: none"><Icon name="check" :size="12" /> 完成</span>
          <span v-else class="chip plain" style="flex: none">{{ Math.round(pct(rec) * 100) }}%</span>
          <button class="btn sm ghost" style="flex: none" @click.stop="removeRec(rec)"><Icon name="trash" :size="13" /></button>
        </div>
      </div>
    </template>

    <template v-else>
      <EmptyBlock
        v-if="!shelf.length"
        icon="book"
        title="学习清单是空的"
        desc="在视频页点「加入学习清单」，把要学的视频攒起来。"
      />
      <div v-else style="display: flex; flex-direction: column; gap: 4px">
        <div
          v-for="it in shelf"
          :key="it.bvid"
          class="rowitem"
          @click="router.push({ name: 'video', params: { bvid: it.bvid } })"
        >
          <BiliImage :src="it.cover" :alt="it.title" />
          <div class="info grow">
            <div class="t clamp-1">{{ it.title }}</div>
            <div class="d">{{ it.upName || '未知 UP' }} · 加入于 {{ fmtAgo(it.at) }}</div>
          </div>
          <button class="btn sm ghost" style="flex: none" @click.stop="learn.shelfToggle(it)"><Icon name="x" :size="13" /> 移除</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* ── 签到日历 ─────────────────────────────── */
.cal-wrap {
  display: flex;
  gap: 6px;
}
.wd {
  display: grid;
  grid-template-rows: repeat(7, 11px);
  gap: 3px;
  padding-top: 16px;
  font-size: 10.5px;
  color: var(--t3);
  text-align: right;
  width: 14px;
  flex: none;
}
.wd span {
  line-height: 11px;
}
.cal-scroll {
  overflow-x: auto;
  padding-bottom: 2px;
}
.months {
  display: flex;
  gap: 3px;
  height: 16px;
  font-size: 10.5px;
  color: var(--t3);
}
.mlabel {
  width: 11px;
  flex: none;
  white-space: nowrap;
}
.cal {
  display: flex;
  gap: 3px;
}
.col {
  display: grid;
  grid-template-rows: repeat(7, 11px);
  gap: 3px;
}
.cell {
  width: 11px;
  height: 11px;
  border-radius: 2px;
  background: var(--soft);
  display: block;
}
.cell.on {
  background: var(--ok);
}
.cell.out {
  background: transparent;
}

/* ── 14 天条形图 ──────────────────────────── */
.bars14 {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 132px;
}
.bcol {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  height: 100%;
  gap: 6px;
}
.btrack {
  flex: 1;
  display: flex;
  align-items: flex-end;
  border-radius: 3px;
  background: var(--soft);
  overflow: hidden;
}
.btrack i {
  display: block;
  width: 100%;
  border-radius: 3px;
  background: var(--accent);
  opacity: 0.85;
}
.blabel {
  font-size: 10.5px;
  color: var(--t3);
  text-align: center;
}

/* ── 饼图 ─────────────────────────────────── */
.pie-wrap {
  display: flex;
  align-items: center;
  gap: 22px;
  flex-wrap: wrap;
}
.pie {
  width: 150px;
  height: 150px;
  flex: none;
}
.legend {
  flex: 1;
  min-width: 220px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.lgrow {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: none;
}
/* ── 番茄钟 ───────────────────────────────── */
.pomo-row {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
}
.pomo-clock {
  font-family: var(--mono);
  font-size: 42px;
  line-height: 1;
  letter-spacing: 1px;
  font-variant-numeric: tabular-nums;
  min-width: 150px;
  color: var(--t2);
}
.pomo-clock.run {
  color: var(--t1);
}
.pomo-side {
  flex: 1;
  min-width: 260px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  justify-content: center;
}
/* 视觉顺序：模式 → 控制按钮 → 进度条 → 时长设置（DOM 顺序不用动，只调 order） */
.pomo-modes {
  order: 1;
}
.pomo-ctl {
  order: 2;
}
.pomo-bar {
  order: 3;
  height: 6px;
  border-radius: 999px;
  background: var(--soft);
  overflow: hidden;
}
.pomo-bar i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.25s linear;
}
.pomo-nums {
  order: 4;
  gap: 12px;
  flex-wrap: wrap;
  color: var(--t2);
}
.pomo-nums label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
}
.pomo-nums .input {
  width: 62px;
  padding: 3px 6px;
  font-size: 12px;
}
</style>
