<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import BiliImage from '../components/BiliImage.vue'
import EmptyBlock from '../components/EmptyBlock.vue'
import Icon from '../components/Icon.vue'
import { useLearnStore } from '../stores/learn'
import { useUiStore } from '../stores/ui'
import { fmtHours, fmtDuration, fmtAgo } from '../utils/format'

const router = useRouter()
const learn = useLearnStore()
const ui = useUiStore()

const tab = ref('recent')
const ready = ref(false)

const recent = computed(() => learn.list.slice(0, 40))
const shelf = computed(() => learn.shelf)
const daily = computed(() => learn.daily)
const peak = computed(() => Math.max(1, learn.maxDailySeconds))

const stats = computed(() => [
  { label: '今日学习', value: fmtHours(learn.todaySeconds) + ' h', icon: 'clock' },
  { label: '累计学习', value: fmtHours(learn.totalSeconds) + ' h', icon: 'chart' },
  { label: '学过视频', value: String(learn.totalVideos), icon: 'film' },
  { label: '已完成', value: String(learn.completedCount), icon: 'check' },
  { label: '连续天数', value: String(learn.streak), icon: 'fire' }
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
  const ok = await ui.confirm('清空全部学习数据？', '进度、每日时长、笔记、学习清单都会被删除，且无法恢复。')
  if (!ok) return
  await learn.clearAll()
  ui.ok('学习数据已清空')
}

async function exportJson() {
  try {
    const { db } = await import('../db')
    const [progress, dailyRows, notes, shelfRows] = await Promise.all([
      db.progress.toArray(),
      db.daily.toArray(),
      db.notes.toArray(),
      db.shelf.toArray()
    ])
    const payload = {
      app: 'study-bili',
      exportedAt: new Date().toISOString(),
      progress,
      daily: dailyRows,
      notes,
      shelf: shelfRows
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
      <button class="btn sm danger" @click="clearAll"><Icon name="trash" :size="14" /> 清空</button>
    </div>

    <div class="stat-grid">
      <div v-for="s in stats" :key="s.label" class="stat">
        <div class="row" style="gap: 6px"><Icon :name="s.icon" :size="14" /><span class="muted">{{ s.label }}</span></div>
        <div class="num">{{ s.value }}</div>
      </div>
    </div>

    <div class="panel" style="margin: 18px 0">
      <div class="row" style="margin-bottom: 12px">
        <strong style="font-size: 13px">最近 30 天</strong>
        <span class="grow" />
        <span class="muted" style="font-size: 12px">峰值 {{ fmtHours(learn.maxDailySeconds) }} h / 天</span>
      </div>
      <div class="bars">
        <div
          v-for="d in daily"
          :key="d.date"
          class="bar"
          :title="d.date + ' · ' + fmtHours(d.seconds) + ' h'"
        >
          <i :style="{ height: Math.max(2, Math.round((d.seconds / peak) * 100)) + '%' }" />
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
.bars {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 96px;
}
.bar {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: flex-end;
  border-radius: 3px;
  background: var(--soft);
}
.bar i {
  display: block;
  width: 100%;
  border-radius: 3px;
  background: var(--accent);
  opacity: 0.85;
}
</style>
