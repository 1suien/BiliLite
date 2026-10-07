<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import Icon from '../components/Icon.vue'
import EmptyBlock from '../components/EmptyBlock.vue'
import { fmtDuration, fmtAgo } from '../utils/format'
import { listLocals, putLocal, removeLocal } from '../db'
import { useUiStore } from '../stores/ui'

/**
 * 「本地」页：播放本机的视频文件。
 *
 * 只登记路径、不复制也不转码：
 *   - 「打开文件」/「打开文件夹」走主进程的系统对话框，拿回绝对路径；
 *   - 主进程把路径登记成 `lmedia://local/<id>`（id = 路径哈希，支持 Range），渲染层用它当 <video> 的 src；
 *   - 时长和封面（缩略图）由本页用一个隐藏的 <video> + <canvas> 现场解析一次，之后存进 IndexedDB；
 *   - 看到哪儿（pos）也存 IndexedDB，重新打开就是续播。
 */

const router = useRouter()
const ui = useUiStore()
const rows = ref([])
const loading = ref(true)
const busy = ref(false)
const probing = ref('')

function sizeText(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

function pct(row) {
  if (!row.duration || !row.pos) return 0
  return Math.min(100, Math.round((row.pos / row.duration) * 100))
}

const totalBytes = computed(() => rows.value.reduce((s, r) => s + (Number(r.size) || 0), 0))

/** 从 IndexedDB 读列表，并让主进程按当前路径重新登记一遍（拿回 lmedia:// 地址、顺便发现文件是否还在） */
async function load() {
  loading.value = true
  const saved = await listLocals()
  rows.value = saved
  loading.value = false
  if (!saved.length) return
  try {
    const res = await api.local.register(saved.map((r) => r.path))
    const byId = new Map((res.entries || []).map((e) => [e.id, e]))
    const next = []
    for (const r of saved) {
      const e = byId.get(r.id)
      if (e) {
        next.push({ ...r, url: e.url, size: e.size, mtime: e.mtime, missing: false })
      } else {
        next.push({ ...r, missing: true })
        if (!r.missing) await putLocal({ id: r.id, missing: true })
      }
    }
    rows.value = next
  } catch (err) {
    console.warn('[local] 重新登记失败：', err && err.message)
  }
  probeMissing()
}

/** 用隐藏的 <video> 解析时长，再 seek 一帧画进 canvas 当封面 */
function probeOne(row) {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.muted = true
    let settled = false
    const finish = (patch) => {
      if (settled) return
      settled = true
      try {
        v.removeAttribute('src')
        v.load()
        v.remove()
      } catch {
        /* 清不掉也无所谓，元素没插进文档 */
      }
      resolve(patch)
    }
    v.onerror = () => finish({ duration: 0, thumb: '' })
    v.onloadedmetadata = async () => {
      let duration = Number(v.duration) || 0
      // MediaRecorder 之类录出来的 webm 头里没写时长（Infinity）：先 seek 到极大值逼它算出来
      if (!isFinite(duration)) {
        try {
          await new Promise((r) => {
            const t = setTimeout(r, 2000)
            v.onseeked = () => {
              clearTimeout(t)
              r()
            }
            v.currentTime = 1e101
          })
          duration = Number(v.duration) || 0
        } catch {
          duration = 0
        }
      }
      let thumb = ''
      try {
        const at = duration > 4 ? Math.min(duration * 0.15, 30) : Math.max(duration * 0.3, 0)
        await new Promise((r) => {
          const t = setTimeout(r, 1600)
          v.onseeked = () => {
            clearTimeout(t)
            r()
          }
          v.currentTime = at
        })
        const w = 320
        const ratio = v.videoWidth ? v.videoHeight / v.videoWidth : 9 / 16
        const h = Math.max(1, Math.round(w * ratio))
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        c.getContext('2d').drawImage(v, 0, 0, w, h)
        thumb = c.toDataURL('image/jpeg', 0.72)
      } catch {
        thumb = ''
      }
      finish({ duration, thumb })
    }
    setTimeout(() => finish({ duration: 0, thumb: '' }), 12000)
    v.src = row.url
  })
}

/** 给还没解析出时长的行补时长/封面（一个一个来，别同时开一堆解码器） */
async function probeMissing() {
  for (const row of rows.value.slice()) {
    if (row.missing || row.duration) continue
    probing.value = row.name
    const patch = await probeOne(row)
    if (patch.duration) {
      await putLocal({ id: row.id, duration: patch.duration, thumb: patch.thumb || '' })
      const t = rows.value.find((r) => r.id === row.id)
      if (t) {
        t.duration = patch.duration
        if (patch.thumb) t.thumb = patch.thumb
      }
    }
  }
  probing.value = ''
}

async function add(entries) {
  for (const e of entries) {
    const old = rows.value.find((r) => r.id === e.id)
    await putLocal({
      id: e.id,
      path: e.path,
      name: e.name,
      size: e.size,
      mtime: e.mtime,
      duration: old && old.duration ? old.duration : 0,
      thumb: (old && old.thumb) || '',
      pos: (old && old.pos) || 0,
      addedAt: (old && old.addedAt) || Date.now()
    })
  }
  await load()
}

async function pickFiles() {
  if (busy.value) return
  busy.value = true
  try {
    const res = await api.local.pickFiles()
    if (res.canceled) return
    const entries = res.entries || []
    if (!entries.length) {
      ui.toast('选中的文件读不出来（可能已被删除）')
      return
    }
    await add(entries)
    ui.ok(`已加入 ${entries.length} 个本地视频`)
  } catch (err) {
    ui.err(err.message || '打开文件失败')
  } finally {
    busy.value = false
  }
}

async function pickFolder() {
  if (busy.value) return
  busy.value = true
  try {
    const res = await api.local.pickFolder()
    if (res.canceled) return
    const entries = res.entries || []
    if (!entries.length) {
      ui.toast('这个文件夹里没有找到视频文件')
      return
    }
    if (res.truncated) ui.toast('文件太多，只取了前 500 个')
    await add(entries)
    ui.ok(`已加入 ${entries.length} 个本地视频`)
  } catch (err) {
    ui.err(err.message || '扫描文件夹失败')
  } finally {
    busy.value = false
  }
}

function play(row) {
  if (row.missing) {
    ui.err('文件不在了：可能被移动、改名或删除')
    return
  }
  router.push({ name: 'local-player', params: { id: row.id } })
}

async function reveal(row) {
  try {
    await api.local.reveal(row.path)
  } catch (err) {
    ui.err(err.message || '打开位置失败')
  }
}

async function del(row) {
  const yes = await ui.confirm('从列表里移除？', `${row.name}\n磁盘上的文件不会被删除。`, '移除')
  if (!yes) return
  await removeLocal(row.id)
  try {
    await api.local.remove(row.id)
  } catch {
    /* 主进程那边只是内存登记，删不掉也无影响 */
  }
  rows.value = rows.value.filter((r) => r.id !== row.id)
}

onMounted(() => {
  load()
  // 自动化冒烟用：等价于用户在对话框里选完文件（不弹系统弹窗）
  window.__addLocalFiles = async (paths) => {
    const res = await api.local.register(paths)
    await add(res.entries || [])
    return rows.value.length
  }
  // 自动化冒烟用：读列表当前状态（时长/进度/封面解析结果）
  window.__localProbe = () =>
    rows.value.map((r) => ({
      id: r.id,
      name: r.name,
      duration: Number(r.duration) || 0,
      pos: Number(r.pos) || 0,
      thumb: !!r.thumb,
      missing: !!r.missing
    }))
})
</script>

<template>
  <div>
    <div class="page-head">
      <div class="grow">
        <h1>本地</h1>
        <p class="muted" style="margin: 4px 0 0">
          播放本机的视频文件：只登记路径，不复制、不转码。时长、封面和上次看到哪儿都存在本机。
        </p>
      </div>
      <div class="row" style="flex: none">
        <button class="btn sm" :disabled="busy" @click="pickFiles"><Icon name="folder" :size="14" /> 打开文件</button>
        <button class="btn sm" :disabled="busy" @click="pickFolder"><Icon name="list" :size="14" /> 打开文件夹</button>
      </div>
    </div>

    <div v-if="rows.length" class="row muted" style="font-size: 12.5px; margin: 10px 2px">
      <span>{{ rows.length }} 个视频 · 共 {{ sizeText(totalBytes) }}</span>
      <span v-if="probing" class="dim" style="margin-left: auto">正在解析「{{ probing }}」的时长与封面…</span>
    </div>

    <div v-if="loading" class="panel" style="padding: 18px">
      <div class="sk" style="height: 76px; margin-bottom: 10px"></div>
      <div class="sk" style="height: 76px"></div>
    </div>

    <EmptyBlock
      v-else-if="!rows.length"
      icon="film"
      title="还没有本地视频"
      desc="点右上角「打开文件」选几个视频，或者「打开文件夹」把一个目录里的视频全扫进来。文件留在原地，不会被复制或转码。"
    >
      <button class="btn sm" :disabled="busy" @click="pickFiles"><Icon name="folder" :size="14" /> 打开文件</button>
      <button class="btn sm ghost" :disabled="busy" @click="pickFolder"><Icon name="list" :size="14" /> 打开文件夹</button>
    </EmptyBlock>

    <div v-else class="panel" style="padding: 8px">
      <div v-for="row in rows" :key="row.id" class="rowitem lrow" :class="{ miss: row.missing }">
        <div class="thumb" @click="play(row)">
          <img v-if="row.thumb" :src="row.thumb" alt="" />
          <div v-else class="ph"><Icon name="film" :size="22" /></div>
          <span v-if="row.duration" class="len">{{ fmtDuration(row.duration) }}</span>
        </div>
        <div class="info grow" style="min-width: 0">
          <div class="t clamp-1" :title="row.path">{{ row.name }}</div>
          <div class="d">
            <span v-if="row.missing" style="color: var(--danger)">文件不在了</span>
            <span v-else>{{ sizeText(row.size) }}</span>
            <span v-if="row.playedAt"> · 上次看到 {{ fmtAgo(row.playedAt) }}</span>
          </div>
          <div v-if="pct(row)" class="pbar" :title="`已看 ${pct(row)}%`"><i :style="{ width: pct(row) + '%' }"></i></div>
        </div>
        <div class="row" style="flex: none">
          <button class="btn sm" :disabled="row.missing" @click="play(row)">
            <Icon name="play" :size="13" /> {{ row.pos > 3 ? '继续播放' : '播放' }}
          </button>
          <button class="btn sm ghost" title="在资源管理器里定位" @click="reveal(row)"><Icon name="external" :size="13" /></button>
          <button class="btn sm ghost" title="从列表移除（不删文件）" @click="del(row)"><Icon name="trash" :size="13" /></button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lrow {
  align-items: center;
}
.lrow.miss .thumb {
  opacity: 0.45;
}
.thumb {
  position: relative;
  flex: none;
  width: 132px;
  height: 74px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-soft, #eceff3);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.thumb .ph {
  color: var(--t3);
}
.thumb .len {
  position: absolute;
  right: 5px;
  bottom: 5px;
  padding: 1px 5px;
  border-radius: 5px;
  font-size: 11px;
  color: #fff;
  background: rgba(0, 0, 0, 0.62);
}
.lrow .info .t {
  font-size: 13.5px;
}
.lrow .info .d {
  font-size: 12px;
  color: var(--t3);
  margin-top: 3px;
}
.clamp-1 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pbar {
  height: 4px;
  border-radius: 999px;
  background: var(--line-strong);
  margin-top: 7px;
  overflow: hidden;
}
.pbar i {
  display: block;
  height: 100%;
  background: var(--accent);
}
</style>
