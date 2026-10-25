<script setup lang="ts">
/**
 * 学习页：概览统计 + 今日习惯 + 专注面板 + 学习进度 / 学习清单
 * 还原自 reference/decompiled/js/LearnView-ByneIRdr.js 的 LearnView 组件。
 *
 * 说明：原页面没有 tab 切换（概览/专注/记录都同时铺在页面上），
 * 只有底部「学习进度 / 学习清单」两个 tab。
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import BiliImage from '@/components/BiliImage.vue'
import EmptyBlock from '@/components/EmptyBlock.vue'
import HabitHome from '@/components/HabitHome.vue'
import FocusPanel from '@/components/FocusPanel.vue'
import { usePomodoroStore } from '@/stores/pomodoro'
import { useLearnStore } from '@/stores/learn'
import { useUiStore } from '@/stores/ui'
import { db } from '@/db'
import { formatClock, toHours, relativeTime } from '@/utils/format'
import type { ProgressRecord } from '@/types'

const router = useRouter()
const learn = useLearnStore()
const ui = useUiStore()
const pomo = usePomodoroStore()

const tab = ref<'recent' | 'shelf'>('recent')
/** 本地数据读完之前先显示 loading */
const ready = ref(false)

const recent = computed(() => learn.listByVideo.slice(0, 40))
const shelf = computed(() => learn.shelf)
const stats = computed(() => [
  { label: '总学习时长', value: toHours(learn.totalSeconds) + ' h', icon: 'clock' },
  { label: '连续签到（天）', value: String(learn.checkinStreak), icon: 'fire' },
  { label: '本周专注', value: formatClock(pomo.weekSeconds), icon: 'zap' },
])

/** 观看进度 0~1 */
function progressOf(p: ProgressRecord) {
  return p.duration ? Math.min(1, p.seconds / p.duration) : 0
}

function openVideo(p: ProgressRecord) {
  router.push({ name: 'video', params: { bvid: p.bvid }, query: { cid: p.cid } })
}

async function removeRecord(p: ProgressRecord) {
  if (!(await ui.confirm('删除这条学习记录？', '删除后该视频的进度会清零。'))) return
  try {
    await db.progress.delete(p.key)
    await learn.init(true)
    ui.ok('已删除记录')
  } catch (e: any) {
    ui.err(e.message)
  }
}

async function clearAllData() {
  if (
    !(await ui.confirm(
      '清空全部学习数据？',
      '进度、每日时长、签到、笔记、学习清单、专注记录都会被删除，且无法恢复。',
    ))
  )
    return
  await learn.clearAll()
  await pomo.clearSessions()
  ui.ok('学习数据已清空')
}

/** 把本地库整份导出成 JSON 文本塞进剪贴板 */
async function exportJson() {
  try {
    const [progress, daily, notes, shelfRows, checkins, upTime, focus, habits, habitLogs] =
      await Promise.all([
        db.progress.toArray(),
        db.daily.toArray(),
        db.notes.toArray(),
        db.shelf.toArray(),
        db.checkins.toArray(),
        db.upTime.toArray(),
        db.focus.toArray(),
        db.habits.toArray(),
        db.habitLogs.toArray(),
      ])
    const payload = {
      app: 'study-bili',
      exportedAt: new Date().toISOString(),
      progress,
      daily,
      notes,
      shelf: shelfRows,
      checkins,
      upTime,
      focus,
      habits,
      habitLogs,
    }
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
    ui.ok('学习数据已复制到剪贴板')
  } catch (e: any) {
    ui.err(e.message || '导出失败')
  }
}

onMounted(async () => {
  try {
    await learn.init(true)
  } catch (e: any) {
    ui.err(e.message)
  }
  // 番茄钟 store 的 init 负责跨天重置 + 读取专注记录
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
      <button class="btn sm ghost" @click="exportJson">
        <Icon name="list" :size="14" /> 导出 JSON
      </button>
      <button class="btn sm" style="color: var(--danger)" @click="clearAllData">
        <Icon name="trash" :size="14" /> 清空
      </button>
    </div>

    <div class="stat-grid">
      <div v-for="s in stats" :key="s.label" class="stat">
        <div class="k row" style="gap: 6px; align-items: center">
          <Icon :name="s.icon" :size="13" /> {{ s.label }}
        </div>
        <div class="v">{{ s.value }}</div>
      </div>
    </div>

    <HabitHome />
    <FocusPanel />

    <div class="tabs">
      <button :class="['tab', { on: tab === 'recent' }]" @click="tab = 'recent'">
        学习进度（{{ recent.length }}）
      </button>
      <button :class="['tab', { on: tab === 'shelf' }]" @click="tab = 'shelf'">
        学习清单（{{ shelf.length }}）
      </button>
    </div>

    <template v-if="ready">
      <!-- 学习进度 -->
      <template v-if="tab === 'recent'">
        <div v-if="recent.length" style="display: flex; flex-direction: column; gap: 4px">
          <div v-for="p in recent" :key="p.key" class="rowitem" @click="openVideo(p)">
            <BiliImage :src="p.cover" :alt="p.title" />
            <div class="info grow">
              <div class="t clamp-1">{{ p.title || p.bvid }}</div>
              <div class="d">
                {{ p.upName || '未知 UP' }} · 已看 {{ formatClock(Math.floor(p.seconds)) }} /
                {{ formatClock(p.duration) }} · {{ relativeTime(p.updatedAt || 0) }}
              </div>
              <div class="progress thin">
                <i :style="{ width: (progressOf(p) * 100).toFixed(1) + '%' }" />
              </div>
            </div>
            <span v-if="p.completed" class="chip on" style="flex: none">
              <Icon name="check" :size="12" /> 完成
            </span>
            <span v-else class="chip plain" style="flex: none">
              {{ Math.round(progressOf(p) * 100) }}%
            </span>
            <button class="btn sm ghost" style="flex: none" @click.stop="removeRecord(p)">
              <Icon name="trash" :size="13" />
            </button>
          </div>
        </div>
        <EmptyBlock
          v-else
          icon="chart"
          title="还没有学习记录"
          desc="打开任意视频播放几秒，进度就会自动记录在这里。"
        >
          <button class="btn primary" @click="router.push('/')">去首页找视频</button>
        </EmptyBlock>
      </template>

      <!-- 学习清单 -->
      <template v-else>
        <div v-if="shelf.length" style="display: flex; flex-direction: column; gap: 4px">
          <div
            v-for="item in shelf"
            :key="item.bvid"
            class="rowitem"
            @click="router.push({ name: 'video', params: { bvid: item.bvid } })"
          >
            <BiliImage :src="item.cover" :alt="item.title" />
            <div class="info grow">
              <div class="t clamp-1">{{ item.title }}</div>
              <div class="d">
                {{ item.upName || '未知 UP' }} · 加入于 {{ relativeTime(item.at || 0) }}
              </div>
            </div>
            <button class="btn sm ghost" style="flex: none" @click.stop="learn.shelfToggle(item)">
              <Icon name="x" :size="13" /> 移除
            </button>
          </div>
        </div>
        <EmptyBlock
          v-else
          icon="book"
          title="学习清单是空的"
          desc="在视频页点「加入学习清单」，把要学的视频攒起来。"
        />
      </template>
    </template>

    <div v-else class="panel row" style="gap: 10px">
      <span class="spinner" />
      <span class="dim">读取本地数据…</span>
    </div>
  </div>
</template>
