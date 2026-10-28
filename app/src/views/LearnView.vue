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
import { formatClock, relativeTime } from '@/utils/format'
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
          <button class="btn primary" @click="router.push('/search')">去搜索找视频</button>
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
