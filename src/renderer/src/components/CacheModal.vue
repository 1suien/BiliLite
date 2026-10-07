<script setup>
/**
 * 「缓存」弹层：选分P（可多选）+ 选清晰度（探测真实大小）→ 交给主进程下载。
 *
 * 大小是主进程发一次 Range 探测出来的（api.cache.probe），所以每个分P 单独探测；
 * 弹层里只探「第一个选中的分P」用于展示清晰度列表与预计大小，其余分P 按同一档位下载。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import api from '../api'
import Icon from './Icon.vue'
import { useUiStore } from '../stores/ui'
import { qnLabel, sortQuality } from '../utils/quality'

const props = defineProps({
  open: { type: Boolean, default: false },
  bvid: { type: String, default: '' },
  /** 分P 列表（pageList）：{ cid, page, part, title, duration } */
  parts: { type: Array, default: () => [] },
  /** 当前分P 下标（0-based） */
  index: { type: Number, default: 0 },
  /** 视频信息：{ title, upName, cover, duration } */
  info: { type: Object, default: () => ({}) },
  defaultQn: { type: Number, default: 80 }
})
const emit = defineEmits(['close', 'started'])

const ui = useUiStore()

const picked = ref([])
const qn = ref(80)
const probe = ref(null)
const probing = ref(false)
const starting = ref(false)
const rows = ref([])
const tasks = ref([])
let off = null

const partsCount = computed(() => props.parts.length)
const cachedCids = computed(() => new Set(rows.value.filter((r) => r.done).map((r) => String(r.cid))))
const probeCid = computed(() => {
  const c = picked.value[0]
  if (c) return c
  const p = props.parts[props.index]
  return p ? String(p.cid) : ''
})
const qualityList = computed(() => {
  const list = probe.value && probe.value.acceptQuality && probe.value.acceptQuality.length ? probe.value.acceptQuality : [qn.value]
  return sortQuality(list)
})
const sizeText = computed(() => {
  if (!probe.value) return ''
  return fmt(probe.value.total)
})

function fmt(bytes) {
  const n = Math.max(0, Number(bytes) || 0)
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

function partLabel(p) {
  const t = (p && (p.title || p.part)) || ''
  return `P${p.page}${t ? ' ' + t : ''}`
}

async function loadRows() {
  try {
    const data = await api.cache.list()
    rows.value = data.rows || []
    tasks.value = (data.tasks || []).filter((t) => String(t.bvid) === String(props.bvid))
  } catch {
    rows.value = []
  }
}

async function doProbe() {
  const cid = probeCid.value
  if (!cid) return
  probing.value = true
  try {
    probe.value = await api.cache.probe(props.bvid, cid, qn.value)
    // 服务端可能降级：以实际拿到的轨为准
    if (probe.value && probe.value.quality) qn.value = probe.value.quality
  } catch (e) {
    probe.value = null
    ui.err('探测大小失败：' + (e.message || e) + '（可以先直接开始缓存）')
  } finally {
    probing.value = false
  }
}

function pickQn(q) {
  qn.value = q
  doProbe()
}

function togglePart(cid) {
  const key = String(cid)
  const list = picked.value.slice()
  const i = list.indexOf(key)
  if (i >= 0) list.splice(i, 1)
  else list.push(key)
  picked.value = list
  doProbe()
}

function pickAll() {
  picked.value = props.parts.map((p) => String(p.cid))
  doProbe()
}

async function start() {
  const cids = picked.value.length ? picked.value : probeCid.value ? [probeCid.value] : []
  if (!cids.length) {
    ui.err('先选一个分P')
    return
  }
  starting.value = true
  let started = 0
  let firstErr = ''
  for (const cid of cids) {
    const p = props.parts.find((x) => String(x.cid) === String(cid)) || {}
    try {
      await api.cache.start({
        bvid: props.bvid,
        cid: String(cid),
        qn: qn.value,
        page: p.page || 1,
        partTitle: p.title || p.part || '',
        title: props.info.title || '',
        upName: props.info.upName || '',
        cover: props.info.cover || '',
        qualityLabel: qnLabel(qn.value)
      })
      started++
    } catch (e) {
      if (!firstErr) firstErr = e.message || String(e)
    }
  }
  starting.value = false
  if (started) {
    ui.ok(`已开始缓存 ${started} 个分P，可以在「缓存」页看进度`)
    emit('started', started)
    emit('close')
  } else {
    ui.err('开始缓存失败：' + (firstErr || '未知原因'))
  }
}

function onProgress(payload) {
  if (!payload || String(payload.bvid) !== String(props.bvid)) return
  const list = tasks.value.slice()
  const i = list.findIndex((t) => t.key === payload.key)
  const ended = payload.stage === 'done' || payload.stage === 'error' || payload.stage === 'canceled'
  if (ended) {
    if (i >= 0) list.splice(i, 1)
    loadRows()
  } else if (i >= 0) {
    list[i] = { ...list[i], ...payload }
  } else {
    list.push(payload)
  }
  tasks.value = list
}

watch(
  () => props.open,
  async (v) => {
    if (!v) {
      if (off) {
        off()
        off = null
      }
      return
    }
    const cur = props.parts[props.index]
    picked.value = cur ? [String(cur.cid)] : []
    qn.value = Number(props.defaultQn) || 80
    probe.value = null
    await loadRows()
    doProbe()
    off = api.cache.onProgress(onProgress)
  }
)

// 弹层跟着视频页一起被销毁（用户没点「取消」就跳走了）时也要退订
onBeforeUnmount(() => {
  if (off) {
    off()
    off = null
  }
})
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div class="modal" style="width: 520px">
      <h3><Icon name="download" :size="16" /> 缓存到本机</h3>
      <p class="muted clamp-1" style="margin: 0; font-size: 12.5px">{{ info.title || '当前视频' }}</p>

      <div v-if="partsCount > 1" class="cparts">
        <div class="phead">
          <span class="grow">选择分P（已选 {{ picked.length }}）</span>
          <button class="btn sm ghost" @click="pickAll">全选</button>
          <button class="btn sm ghost" @click="picked = []">清空</button>
        </div>
        <div class="plist">
          <div
            v-for="p in parts"
            :key="p.cid"
            class="prow"
            :class="{ on: picked.includes(String(p.cid)) }"
            @click="togglePart(p.cid)"
          >
            <Icon :name="picked.includes(String(p.cid)) ? 'check' : 'plus'" :size="14" />
            <span class="grow clamp-1">{{ partLabel(p) }}</span>
            <span v-if="cachedCids.has(String(p.cid))" class="tag">已缓存</span>
          </div>
        </div>
      </div>
      <div v-else class="muted" style="font-size: 12.5px">单P 视频，直接下载当前这一个。</div>

      <div class="row" style="align-items: center; flex-wrap: wrap">
        <b style="font-size: 12.5px">清晰度</b>
        <span
          v-for="q in qualityList"
          :key="q"
          class="chip"
          :class="{ on: q === qn }"
          :style="{ cursor: 'pointer' }"
          @click="pickQn(q)"
        >
          {{ qnLabel(q) }}
        </span>
        <span class="muted" style="font-size: 11.5px">
          <template v-if="probing">正在探测大小…</template>
          <template v-else-if="probe">当前分P 约 {{ sizeText }}</template>
          <template v-else>大小待探测</template>
        </span>
      </div>

      <div v-if="tasks.length" class="ctasks">
        <div v-for="t in tasks" :key="t.key">
          <div class="row" style="justify-content: space-between; font-size: 12px">
            <span class="clamp-1">{{ t.partTitle || t.title || t.bvid }} · {{ t.message || '下载中' }}</span>
            <span class="mono">{{ t.pct }}%</span>
          </div>
          <div class="bar"><i :style="{ width: t.pct + '%' }" /></div>
        </div>
      </div>

      <p class="muted" style="font-size: 11.5px; margin: 0">
        缓存的视频会一直留在本机（可在「缓存」页删掉或导出成 MP4）；占用到上限时会提示先清理。
      </p>

      <div class="row" style="justify-content: flex-end">
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn primary" :disabled="starting" @click="start">
          <Icon name="download" :size="14" /> {{ starting ? '正在开始…' : '开始缓存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cparts {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.phead {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--t2);
}
.plist {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 190px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 5px;
}
.prow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12.5px;
}
.prow:hover {
  background: var(--card-hover);
}
.prow.on {
  background: var(--soft);
  color: var(--t1);
}
.tag {
  font-size: 11px;
  color: var(--ok);
  flex: none;
}
.ctasks {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bar {
  height: 5px;
  background: var(--line);
  border-radius: 999px;
  overflow: hidden;
  margin-top: 4px;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--accent);
}
</style>
