<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import BiliImage from '../components/BiliImage.vue'
import EmptyBlock from '../components/EmptyBlock.vue'
import FocusPanel from '../components/FocusPanel.vue'
import SessionHistory from '../components/SessionHistory.vue'
import Icon from '../components/Icon.vue'
import { useLearnStore } from '../stores/learn'
import { useUiStore } from '../stores/ui'
import { usePomodoroStore } from '../stores/pomodoro'
import { fmtHours, fmtDuration, fmtAgo } from '../utils/format'

const router = useRouter()
const learn = useLearnStore()
const ui = useUiStore()
const pomo = usePomodoroStore()

const tab = ref('recent')
const ready = ref(false)

const recent = computed(() => learn.listByVideo.slice(0, 40))
const shelf = computed(() => learn.shelf)

const stats = computed(() => [
  { label: '总学习时长', value: fmtHours(learn.totalSeconds) + ' h', icon: 'clock' },
  { label: '看过视频', value: String(learn.totalVideos), icon: 'play' },
  { label: '已看完', value: String(learn.completedCount), icon: 'check' },
  { label: '在看', value: String(learn.inProgressCount), icon: 'chart' },
  { label: '连续签到（天）', value: String(learn.checkinStreak), icon: 'fire' },
  { label: '今日专注', value: String(pomo.todayCount) + ' 轮', icon: 'zap' },
  { label: '本周专注', value: fmtDuration(pomo.weekSeconds), icon: 'zap' }
])

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
  const ok = await ui.confirm(
    '清空全部学习数据？',
    '进度、每日时长、签到、笔记、学习清单、专注记录都会被删除，且无法恢复。'
  )
  if (!ok) return
  await learn.clearAll()
  // 专注记录由 pomodoro store 维护，清表后要同步内存里的统计
  await pomo.clearSessions()
  ui.ok('学习数据已清空')
}

async function exportJson() {
  try {
    const { db } = await import('../db')
    const [progress, dailyRows, notes, shelfRows, checkins, upTime, focusRows] = await Promise.all([
      db.progress.toArray(),
      db.daily.toArray(),
      db.notes.toArray(),
      db.shelf.toArray(),
      db.checkins.toArray(),
      db.upTime.toArray(),
      db.focus.toArray()
    ])
    const payload = {
      app: 'study-bili',
      exportedAt: new Date().toISOString(),
      progress,
      daily: dailyRows,
      notes,
      shelf: shelfRows,
      checkins,
      upTime,
      focus: focusRows
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

    <!-- 专注（TickTick 风格：圆环 + 大号倒计时 + 任务绑定） -->
    <FocusPanel />

    <!-- 专注记录与统计 -->
    <SessionHistory />

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

