<script setup>
/**
 * 缓存页：看占用、管理正在下载的任务、播放/导出/删除已缓存的分P。
 *
 * 缓存文件的真相在主进程（src/main/video-cache.js）：这里只负责展示与操作，
 * 下载进度通过 preload 暴露的 'cache:progress' 事件推过来（api.cache.onProgress）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import BiliImage from '../components/BiliImage.vue'
import EmptyBlock from '../components/EmptyBlock.vue'
import Icon from '../components/Icon.vue'
import { useUiStore } from '../stores/ui'

const router = useRouter()
const ui = useUiStore()

const rows = ref([])
const tasks = ref([])
const stats = ref({ bytes: 0, maxBytes: 4096 * 1024 * 1024, count: 0, videos: 0, over: false })
const loading = ref(true)
const busyKey = ref('')
const limitMB = ref(4096)
const prefer = ref(true)
let offProgress = null
let timer = null

const pct = computed(() => {
  const max = Number(stats.value.maxBytes) || 1
  return Math.min(100, Math.round(((Number(stats.value.bytes) || 0) / max) * 100))
})

function fmt(bytes) {
  const n = Math.max(0, Number(bytes) || 0)
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

function when(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function load(quiet = false) {
  if (!quiet) loading.value = true
  try {
    const data = await api.cache.list()
    rows.value = data.rows || []
    tasks.value = data.tasks || []
    if (data.stats) stats.value = data.stats
  } catch (e) {
    if (!quiet) ui.err('读取缓存失败：' + (e.message || e))
  } finally {
    loading.value = false
  }
}

async function loadSettings() {
  try {
    const s = await api.settings.get()
    limitMB.value = Number(s.cacheMaxMB) || 4096
    prefer.value = s.cachePrefer !== false
  } catch {
    /* 读不到就用默认值显示 */
  }
}

function onProgress(payload) {
  if (!payload || !payload.key) return
  const list = tasks.value.slice()
  const i = list.findIndex((t) => t.key === payload.key)
  const ended = payload.stage === 'done' || payload.stage === 'error' || payload.stage === 'canceled'
  if (ended) {
    if (i >= 0) list.splice(i, 1)
    tasks.value = list
    if (payload.stage === 'done') {
      ui.ok(`${payload.title || payload.bvid}${payload.page ? ` P${payload.page}` : ''} 缓存完成`)
    } else if (payload.stage === 'error') {
      ui.err('缓存失败：' + (payload.message || payload.error || '未知原因'))
    }
    load(true)
    return
  }
  if (i >= 0) list[i] = { ...list[i], ...payload }
  else list.push(payload)
  tasks.value = list
}

async function saveLimit() {
  const n = Math.max(256, Math.min(65536, Math.round(Number(limitMB.value) || 4096)))
  limitMB.value = n
  try {
    await api.settings.patch({ cacheMaxMB: n })
    ui.ok(`缓存上限已改成 ${n} MB`)
    load(true)
  } catch (e) {
    ui.err('保存上限失败：' + (e.message || e))
  }
}

async function togglePrefer() {
  prefer.value = !prefer.value
  try {
    await api.settings.patch({ cachePrefer: prefer.value })
    ui.ok(prefer.value ? '播放时优先用缓存' : '播放时不再优先用缓存')
  } catch (e) {
    prefer.value = !prefer.value
    ui.err('保存失败：' + (e.message || e))
  }
}

function play(row) {
  router.push({ name: 'video', params: { bvid: row.bvid }, query: { p: row.page || 1 } })
}

async function exportOne(row) {
  busyKey.value = row.key
  try {
    const res = await api.cache.exportMp4(row.key, true)
    if (res && res.canceled) return
    ui.ok('已导出：' + (res && res.path ? res.path : row.title))
    load(true)
  } catch (e) {
    ui.err('导出失败：' + (e.message || e))
  } finally {
    busyKey.value = ''
  }
}

async function reveal(row) {
  try {
    await api.cache.reveal(row.key)
  } catch (e) {
    ui.err('打开位置失败：' + (e.message || e))
  }
}

async function del(row) {
  const name = `${row.title || row.bvid}${row.page ? ` P${row.page}` : ''}`
  const ok = await ui.confirm(`删除「${name}」的缓存？`, `${fmt(row.bytes)}，导出的 MP4 也会一起删掉。`, '删除')
  if (!ok) return
  try {
    await api.cache.remove(row.key)
    ui.ok('已删除')
    load(true)
  } catch (e) {
    ui.err('删除失败：' + (e.message || e))
  }
}

async function cancel(task) {
  try {
    await api.cache.cancel(task.key)
  } catch (e) {
    ui.err('取消失败：' + (e.message || e))
  }
}

async function clearAll() {
  if (!rows.value.length && !tasks.value.length) return
  const ok = await ui.confirm('清空全部缓存？', `会删掉 ${rows.value.length} 个分P（${fmt(stats.value.bytes)}），正在下载的也会停掉。`, '清空')
  if (!ok) return
  try {
    const res = await api.cache.clear()
    ui.ok(`已清空 ${res && res.removed ? res.removed : 0} 个分P`)
    load(true)
  } catch (e) {
    ui.err('清空失败：' + (e.message || e))
  }
}

onMounted(() => {
  load()
  loadSettings()
  offProgress = api.cache.onProgress(onProgress)
  // 下载中每 2 秒对一次账（大小、磁盘真实占用）
  timer = setInterval(() => {
    if (tasks.value.length) load(true)
  }, 2000)
})

onBeforeUnmount(() => {
  if (offProgress) offProgress()
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1>缓存</h1>
      <p>缓存过的分P 可以离线播放，也能导出成通用 MP4。文件都存在本机应用数据目录里。</p>
      <span class="grow" />
      <button class="btn sm" @click="load()"><Icon name="refresh" :size="14" /> 刷新</button>
    </div>

    <div class="panel">
      <div class="sec">
        <div class="row" style="justify-content: space-between; flex-wrap: wrap; gap: 10px">
          <div>
            <div style="font-size: 14px; font-weight: 600">
              已占用 {{ fmt(stats.bytes) }} <span class="muted" style="font-weight: 400">/ 上限 {{ fmt(stats.maxBytes) }}</span>
            </div>
            <div class="muted" style="font-size: 12px; margin-top: 3px">
              {{ stats.count }} 个分P · {{ stats.videos }} 个视频<template v-if="stats.over"> · 已超出上限，新的缓存会被拒绝</template>
            </div>
          </div>
          <div class="row" style="flex: none; gap: 8px">
            <span class="chip plain" style="cursor: pointer" :class="{ on: prefer }" @click="togglePrefer">
              <Icon :name="prefer ? 'check' : 'x'" :size="13" /> 播放时优先用缓存
            </span>
            <button class="btn sm" @click="clearAll"><Icon name="trash" :size="14" /> 清空缓存</button>
          </div>
        </div>
        <div class="bar" style="margin-top: 10px"><i :style="{ width: pct + '%' }" /></div>
        <div class="field" style="margin-top: 10px; align-items: center">
          <label style="width: 68px">占用上限</label>
          <input v-model="limitMB" class="input mono" type="number" min="256" max="65536" step="256" style="max-width: 130px" />
          <span class="muted" style="font-size: 12px">MB</span>
          <button class="btn sm" @click="saveLimit">保存</button>
          <span class="hint">留够空间再缓存；到上限后会提示你先删一些。</span>
        </div>
      </div>
    </div>

    <div v-if="tasks.length" class="panel">
      <div class="sec">
        <div style="font-size: 13px; font-weight: 600; margin-bottom: 8px">正在下载（{{ tasks.length }}）</div>
        <div v-for="t in tasks" :key="t.key" class="task">
          <div class="row" style="justify-content: space-between; gap: 10px">
            <div style="min-width: 0">
              <div class="clamp-1" style="font-size: 13px">{{ t.title || t.bvid }}<span v-if="t.page" class="muted"> · P{{ t.page }}</span></div>
              <div class="muted" style="font-size: 11.5px">
                {{ t.message || '下载中' }} · {{ fmt(t.done) }} / {{ t.total ? fmt(t.total) : '未知' }}
              </div>
            </div>
            <div class="row" style="flex: none; gap: 8px">
              <span class="mono" style="font-size: 12px">{{ t.pct }}%</span>
              <button class="btn sm ghost" @click="cancel(t)">取消</button>
            </div>
          </div>
          <div class="bar" style="margin-top: 8px"><i :style="{ width: t.pct + '%' }" /></div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="sec">
        <div style="font-size: 13px; font-weight: 600; margin-bottom: 6px">已缓存（{{ rows.length }}）</div>
        <div v-if="loading" class="muted" style="font-size: 12.5px">正在读取…</div>
        <EmptyBlock v-else-if="!rows.length" icon="download" title="还没有缓存" desc="打开任意视频，点「缓存」按钮选分P和清晰度就能存到本机。" />
        <div v-for="r in rows" :key="r.key" class="rowitem" @click="play(r)">
          <BiliImage :src="r.cover" :alt="r.title" />
          <div class="info">
            <div class="t clamp-2">{{ r.title || r.bvid }}</div>
            <div class="d">
              <template v-if="r.partTitle">P{{ r.page }} {{ r.partTitle }} · </template>
              {{ r.qualityLabel || r.quality }} · {{ fmt(r.bytes) }} · {{ when(r.createdAt) }}
              <span v-if="r.progress" class="muted"> · 下载中 {{ r.progress.pct }}%</span>
            </div>
            <div class="d">
              {{ r.width }}×{{ r.height }}<template v-if="r.aBytes"> · 含音轨</template>
              <template v-if="r.mp4Bytes"> · 已导出 MP4（{{ fmt(r.mp4Bytes) }}）</template>
            </div>
          </div>
          <div class="row" style="flex: none; align-items: flex-start; gap: 6px" @click.stop>
            <button class="btn sm" @click="play(r)"><Icon name="play" :size="13" /> 播放</button>
            <button class="btn sm" :disabled="busyKey === r.key" @click="exportOne(r)">
              <Icon name="download" :size="13" /> {{ r.mp4Bytes ? '重新导出' : '导出 MP4' }}
            </button>
            <button v-if="r.mp4Bytes" class="btn sm ghost" @click="reveal(r)"><Icon name="folder" :size="13" /> 打开位置</button>
            <button class="btn sm danger" @click="del(r)"><Icon name="trash" :size="13" /> 删除</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bar {
  height: 6px;
  background: var(--line);
  border-radius: 999px;
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.18s;
}
.task {
  padding: 9px 0;
  border-top: 1px solid var(--line);
}
.task:first-of-type {
  border-top: none;
}
.clamp-1 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rowitem .info {
  flex: 1;
}
</style>
