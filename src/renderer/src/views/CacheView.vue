<script setup>
/**
 * 缓存页：看占用、换缓存文件夹、管理正在下载的任务、按稿件分组管理已缓存的分P。
 *
 * 缓存文件的真相在主进程（src/main/video-cache.js）：这里只负责展示与操作，
 * 下载进度通过 preload 暴露的 'cache:progress' 事件推过来（api.cache.onProgress）。
 *
 * 已缓存区按 bvid 聚合成卡片：同一稿件的多个分P 收在一张卡里，默认收起，
 * 展开后才逐条显示分P（播放/导出/打开位置/删除）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import BiliImage from '../components/BiliImage.vue'
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
/** 'cached' | 'tasks'：两个分段的切换，纯本地状态，不写路由 */
const tab = ref('cached')
/** 已展开分P的 bvid 集合：默认全部收起 */
const expanded = ref([])
/** api.cache.path() 的结果：{ current, default, custom } */
const dirInfo = ref({ current: '', default: '', custom: '' })
let offProgress = null
let timer = null

const pct = computed(() => {
  const max = Number(stats.value.maxBytes) || 1
  return Math.min(100, Math.round(((Number(stats.value.bytes) || 0) / max) * 100))
})

/**
 * 按 bvid 聚合已缓存分P：
 * - parts 按 page 升序（「播放全部」取第一个，也就是 P 号最小的分P）
 * - bytes 是整组总大小，updatedAt 取组内最近一次缓存时间
 */
const groups = computed(() => {
  const map = new Map()
  for (const r of rows.value) {
    const bvid = r.bvid || r.key
    let g = map.get(bvid)
    if (!g) {
      g = {
        bvid,
        title: r.title || r.bvid || '未命名稿件',
        upName: r.upName || '',
        cover: r.cover || '',
        bytes: 0,
        updatedAt: 0,
        parts: []
      }
      map.set(bvid, g)
    }
    g.parts.push(r)
    g.bytes += Number(r.bytes) || 0
    if ((Number(r.updatedAt) || 0) > g.updatedAt) g.updatedAt = Number(r.updatedAt) || 0
    if (!g.cover && r.cover) g.cover = r.cover
    if (!g.upName && r.upName) g.upName = r.upName
    if (!g.title && r.title) g.title = r.title
  }
  const list = [...map.values()]
  for (const g of list) {
    g.parts.sort((a, b) => (Number(a.page) || 0) - (Number(b.page) || 0))
    g.first = g.parts[0]
  }
  // 最近缓存的排前面
  list.sort((a, b) => b.updatedAt - a.updatedAt)
  return list
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

/** 分P 名：和稿件标题一样就不重复显示，只留 P 号 */
function partName(row, group) {
  const t = (row.partTitle || '').trim()
  if (!t || t === (group.title || '').trim()) return ''
  return t
}

function rowTitle(row) {
  return `${row.title || row.bvid}${row.page ? ` P${row.page}` : ''}`
}

function isOpen(bvid) {
  return expanded.value.includes(bvid)
}

function toggle(bvid) {
  const list = expanded.value.slice()
  const i = list.indexOf(bvid)
  if (i >= 0) list.splice(i, 1)
  else list.push(bvid)
  expanded.value = list
}

async function load(quiet = false) {
  if (!quiet) loading.value = true
  try {
    const data = await api.cache.list()
    rows.value = data.rows || []
    tasks.value = data.tasks || []
    if (data.stats) stats.value = data.stats
    // 展开状态跟着数据走：整组被删掉了就把它的展开标记也清掉
    const alive = new Set(rows.value.map((r) => r.bvid || r.key))
    expanded.value = expanded.value.filter((b) => alive.has(b))
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

/**
 * 缓存根目录：api.cache.path() 由主进程新增。
 * 万一这个桥接还没就绪也不要炸掉整页，静默留空即可。
 */
async function loadDir() {
  try {
    if (!api.cache || typeof api.cache.path !== 'function') return
    const info = await api.cache.path()
    if (info && typeof info === 'object') {
      dirInfo.value = {
        current: info.current || '',
        default: info.default || '',
        custom: info.custom || ''
      }
    }
  } catch {
    /* 老版本主进程没有这个方法：不显示路径，其余功能照旧 */
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

/* ── 缓存文件夹 ───────────────────────────────────────────── */

/** 选一个自定义缓存文件夹：主进程选完即保存并返回 { path }，取消返回 { canceled: true } */
async function changeDir() {
  try {
    if (!api.cache || typeof api.cache.pickDir !== 'function') {
      ui.err('当前版本还不支持修改缓存文件夹')
      return
    }
    const res = await api.cache.pickDir()
    if (!res || res.canceled) return
    await loadDir()
    await load(true)
    ui.ok('缓存文件夹已改为 ' + (res.path || dirInfo.value.current))
    // 已经存在的缓存文件不会被搬过去，这点在面板上一直有提示
  } catch (e) {
    ui.err('更改缓存文件夹失败：' + (e.message || e))
  }
}

async function openDir() {
  try {
    if (!api.cache || typeof api.cache.openDir !== 'function') {
      ui.err('当前版本还不支持打开缓存文件夹')
      return
    }
    await api.cache.openDir()
  } catch (e) {
    ui.err('打开文件夹失败：' + (e.message || e))
  }
}

/** 恢复默认位置：cacheDir 置空，主进程会回到默认目录 */
async function resetDir() {
  try {
    await api.settings.patch({ cacheDir: '' })
    await loadDir()
    ui.ok('已恢复默认缓存位置')
  } catch (e) {
    ui.err('恢复默认位置失败：' + (e.message || e))
  }
}

/* ── 播放 / 导出 / 打开位置 / 删除 ────────────────────────── */

function play(row) {
  router.push({ name: 'video', params: { bvid: row.bvid }, query: { p: row.page || 1 } })
}

function playGroup(g) {
  if (g.first) play(g.first)
}

async function exportOne(row) {
  busyKey.value = row.key
  try {
    const res = await api.cache.exportMp4(row.key, true)
    if (res && res.canceled) return
    ui.ok('已导出：' + (res && res.path ? res.path : rowTitle(row)))
    load(true)
  } catch (e) {
    ui.err('导出失败：' + (e.message || e))
  } finally {
    busyKey.value = ''
  }
}

/** 整组导出：按 P 号顺序依次弹保存框，用户取消就停下 */
async function exportGroup(g) {
  if (busyKey.value) return
  const total = g.parts.length
  let done = 0
  for (const row of g.parts) {
    busyKey.value = row.key
    try {
      const res = await api.cache.exportMp4(row.key, true)
      if (res && res.canceled) {
        ui.ok(`已取消导出（已完成 ${done}/${total} 个）`)
        return
      }
      done += 1
    } catch (e) {
      busyKey.value = ''
      ui.err(`P${row.page || '?'} 导出失败：` + (e.message || e))
      return
    } finally {
      busyKey.value = ''
    }
  }
  load(true)
  ui.ok(`已导出整组 ${done} 个分P`)
}

async function reveal(row) {
  try {
    await api.cache.reveal(row.key)
  } catch (e) {
    ui.err('打开位置失败：' + (e.message || e))
  }
}

function revealGroup(g) {
  if (g.first) reveal(g.first)
}

async function del(row) {
  const name = rowTitle(row)
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

/** 删除整组：循环删掉该稿件下所有分P，删完若组内为空就从列表里去掉（load 会重算） */
async function delGroup(g) {
  const n = g.parts.length
  const ok = await ui.confirm('删除整组缓存', `这会删掉该视频下 ${n} 个分P的本地文件（共 ${fmt(g.bytes)}）。`, '删除整组')
  if (!ok) return
  let removed = 0
  for (const row of g.parts) {
    try {
      await api.cache.remove(row.key)
      removed += 1
    } catch (e) {
      ui.err('删除失败：' + (e.message || e))
      break
    }
  }
  if (removed) ui.ok(`已删除 ${removed} 个分P`)
  await load(true)
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
  loadDir()
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
      <p>缓存过的分P 可以离线播放，也能导出成通用 MP4。文件都存在本机缓存文件夹里。</p>
      <span class="grow" />
      <button class="btn sm" @click="load()"><Icon name="refresh" :size="14" /> 刷新</button>
    </div>

    <!-- 占用与缓存文件夹 -->
    <div class="panel">
      <div class="sec">
        <div class="row" style="justify-content: space-between; flex-wrap: wrap; gap: 10px">
          <div>
            <div style="font-size: 14px; font-weight: 600">
              已占用 {{ fmt(stats.bytes) }} <span class="muted" style="font-weight: 400">/ 上限 {{ fmt(stats.maxBytes) }}</span>
            </div>
            <div class="muted" style="font-size: 12px; margin-top: 3px">
              {{ stats.count }} 个分P · {{ stats.videos }} 个稿件<template v-if="stats.over"> · 已超出上限，新的缓存会被拒绝</template>
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

        <div class="field" style="align-items: center; flex-wrap: wrap">
          <label style="width: 68px">缓存文件夹</label>
          <span class="mono clamp-1 cdir" style="flex: 1; min-width: 160px; font-size: 12px" :title="dirInfo.current">
            {{ dirInfo.current || '（读取中…）' }}
          </span>
          <button class="btn sm" @click="changeDir"><Icon name="folder" :size="13" /> 更改文件夹</button>
          <button class="btn sm ghost" @click="openDir"><Icon name="external" :size="13" /> 打开文件夹</button>
          <button v-if="dirInfo.custom" class="btn sm ghost" @click="resetDir">恢复默认位置</button>
          <span class="hint" style="flex-basis: 100%">
            更改文件夹后，已经缓存好的文件会留在旧文件夹里，不会自动搬过去。
          </span>
        </div>
      </div>
    </div>

    <!-- 已缓存视频 / 正在缓存 -->
    <div class="tabs">
      <div class="tab" :class="{ on: tab === 'cached' }" @click="tab = 'cached'">已缓存视频 ({{ groups.length }})</div>
      <div class="tab" :class="{ on: tab === 'tasks' }" @click="tab = 'tasks'">正在缓存 ({{ tasks.length }})</div>
    </div>

    <!-- 已缓存视频：按稿件分组成卡片 -->
    <div v-show="tab === 'cached'">
      <div v-if="loading" class="muted" style="font-size: 12.5px">正在读取…</div>
      <div v-else-if="!groups.length" class="empty">
        <Icon name="download" :size="30" :stroke="1.4" />
        <b>还没有缓存任何视频</b>
        <span style="max-width: 420px">还没有缓存任何视频。打开一个视频，点「缓存」按钮选分P和清晰度即可离线观看。</span>
      </div>
      <div v-else class="clist">
        <div v-for="g in groups" :key="g.bvid" class="ccard">
          <div class="chead">
            <div class="cthumb">
              <BiliImage :src="g.cover" :alt="g.title" />
              <span class="csize mono">{{ fmt(g.bytes) }}</span>
            </div>
            <div class="cinfo">
              <div class="ctitle clamp-1" :title="g.title" @click="toggle(g.bvid)">{{ g.title }}</div>
              <div class="muted" style="font-size: 12px">{{ g.upName || '未知 UP 主' }}</div>
              <div class="row" style="gap: 8px; flex-wrap: wrap">
                <span class="ccount">{{ g.parts.length }} 个内容</span>
                <span class="muted" style="font-size: 12px">共 {{ fmt(g.bytes) }} · 最近缓存 {{ when(g.updatedAt) }}</span>
              </div>
            </div>
            <div class="row" style="flex: none; align-items: flex-start; gap: 6px">
              <button class="btn sm" @click="playGroup(g)"><Icon name="play" :size="13" /> 播放全部</button>
              <button class="btn sm ghost" @click="toggle(g.bvid)">
                <Icon :name="isOpen(g.bvid) ? 'up' : 'down'" :size="13" />
                {{ isOpen(g.bvid) ? '收起' : `展开 ${g.parts.length} 个分P` }}
              </button>
              <details class="cmenu">
                <summary class="btn sm ghost"><Icon name="list" :size="13" /> 更多操作</summary>
                <div class="cmenu-pop">
                  <div class="cmenu-item" @click="revealGroup(g)"><Icon name="folder" :size="13" /> 打开整组位置</div>
                  <div class="cmenu-item" @click="exportGroup(g)"><Icon name="download" :size="13" /> 导出整组为 MP4</div>
                  <div class="cmenu-item danger" @click="delGroup(g)"><Icon name="trash" :size="13" /> 删除整组</div>
                </div>
              </details>
            </div>
          </div>

          <div v-if="isOpen(g.bvid)" class="cparts">
            <div v-for="r in g.parts" :key="r.key" class="crow">
              <div class="crow-t clamp-1" :title="partName(r, g) || r.title">
                <span class="mono" style="color: var(--t3)">P{{ r.page || 1 }}</span>
                <template v-if="partName(r, g)"> {{ partName(r, g) }}</template>
              </div>
              <span class="chip plain">{{ r.qualityLabel || r.quality || '未知清晰度' }}</span>
              <span class="mono muted" style="font-size: 12px; flex: none">{{ fmt(r.bytes) }}</span>
              <span class="muted" style="font-size: 12px; flex: none">{{ when(r.updatedAt || r.createdAt) }}</span>
              <div class="row" style="flex: none; gap: 6px">
                <button class="btn sm" @click="play(r)"><Icon name="play" :size="13" /> 播放</button>
                <button class="btn sm" :disabled="busyKey === r.key" @click="exportOne(r)">
                  <Icon name="download" :size="13" /> 导出 MP4
                </button>
                <button class="btn sm ghost" @click="reveal(r)"><Icon name="folder" :size="13" /> 打开位置</button>
                <button class="btn sm danger" @click="del(r)"><Icon name="trash" :size="13" /> 删除</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 正在缓存 -->
    <div v-show="tab === 'tasks'">
      <div v-if="!tasks.length" class="empty">
        <Icon name="clock" :size="30" :stroke="1.4" />
        <b>当前没有正在缓存的任务</b>
        <span style="max-width: 420px">在视频页点「缓存」选好分P和清晰度后，这里会显示每个分P的下载进度。</span>
      </div>
      <div v-else class="panel">
        <div class="sec">
          <div v-for="t in tasks" :key="t.key" class="task">
            <div class="row" style="justify-content: space-between; gap: 10px">
              <div style="min-width: 0">
                <div class="clamp-1" style="font-size: 13px">
                  {{ t.title || t.bvid }}<span v-if="t.page" class="muted"> · P{{ t.page }}</span>
                </div>
                <div class="muted" style="font-size: 11.5px">
                  {{ t.message || '下载中' }} · {{ fmt(t.done) }} / {{ t.total ? fmt(t.total) : '未知' }}
                  <template v-if="t.video || t.audio">
                    · 视频 {{ fmt(t.video && t.video.done) }} / {{ t.video && t.video.total ? fmt(t.video.total) : '?' }}
                    · 音频 {{ fmt(t.audio && t.audio.done) }} / {{ t.audio && t.audio.total ? fmt(t.audio.total) : '?' }}
                  </template>
                </div>
                <div v-if="t.error" style="font-size: 12px; color: var(--danger); margin-top: 3px">
                  {{ t.error }}
                </div>
              </div>
              <div class="row" style="flex: none; gap: 8px">
                <span class="mono" style="font-size: 12px">{{ t.pct || 0 }}%</span>
                <button class="btn sm ghost" @click="cancel(t)">取消</button>
              </div>
            </div>
            <div class="bar" style="margin-top: 8px"><i :style="{ width: (t.pct || 0) + '%' }" /></div>
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

/* ── 已缓存：按稿件分组的卡片 ─────────────────────────────── */
.clist {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ccard {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 12px;
}
.chead {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.cthumb {
  position: relative;
  width: 168px;
  aspect-ratio: 16 / 9;
  flex: none;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--soft);
}
.csize {
  position: absolute;
  right: 5px;
  bottom: 5px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.72);
  color: #fff;
  font-size: 11px;
}
.cinfo {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.ctitle {
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.ctitle:hover {
  color: var(--accent);
}
.ccount {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--soft);
  border: 1px solid var(--line);
  color: var(--t2);
  font-size: 11.5px;
}

/* 「更多操作」：用 <details> 做小菜单，不引新依赖 */
.cmenu {
  position: relative;
}
.cmenu > summary {
  list-style: none;
  cursor: pointer;
}
.cmenu > summary::-webkit-details-marker {
  display: none;
}
.cmenu[open] > summary {
  border-color: var(--line-strong);
}
.cmenu-pop {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 5;
  min-width: 158px;
  padding: 5px;
  border-radius: var(--radius-sm);
  background: var(--card);
  border: 1px solid var(--line-strong);
  box-shadow: var(--shadow-sm);
}
.cmenu-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 9px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  cursor: pointer;
  white-space: nowrap;
}
.cmenu-item:hover {
  background: var(--card-hover);
}
.cmenu-item.danger {
  color: var(--danger);
}

/* ── 分P 行 ───────────────────────────────────────────────── */
.cparts {
  margin-top: 10px;
  border-top: 1px solid var(--line);
}
.crow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 4px;
  border-bottom: 1px solid var(--line);
}
.crow:last-child {
  border-bottom: none;
}
.crow-t {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
}
</style>
