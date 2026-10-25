<script setup lang="ts">
/**
 * 本地视频列表页 /local
 *
 * 还原自 LocalView-DCmLtwpo.js：
 * 只登记路径，不复制、不转码；时长 / 封面（thumb）/ 上次看到哪儿（pos）
 * 都存在本机 Dexie 的 locals 表里。文件被移走后列表里仍保留一条记录，
 * 标记 missing 后按钮置灰。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import EmptyBlock from '@/components/EmptyBlock.vue'
import { useUiStore } from '@/stores/ui'
import { bili } from '@/bridge'
import { listLocals, putLocal, removeLocal } from '@/db'
import { formatClock, relativeTime } from '@/utils/format'
import type { LocalVideo } from '@/types'

/** 原实现额外用了 pos / thumb / missing 三个字段（types.ts 里没有），此处本地扩展 */
interface LocalRecord extends LocalVideo {
  pos?: number
  thumb?: string
  missing?: boolean
}

const router = useRouter()
const ui = useUiStore()

const items = ref<LocalRecord[]>([])
const loading = ref(true)
/** 导入进行中：两个入口按钮都禁用 */
const busy = ref(false)
/** 正在解析时长与封面的文件名 */
const parsing = ref('')

function formatSize(size?: number) {
  const n = Number(size) || 0
  return n >= 1024 * 1024 * 1024
    ? `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
    : n >= 1024 * 1024
      ? `${(n / 1024 / 1024).toFixed(1)} MB`
      : n >= 1024
        ? `${(n / 1024).toFixed(0)} KB`
        : `${n} B`
}

/** 已看百分比（0 表示不显示进度条） */
function pct(item: LocalRecord) {
  return !item.duration || !item.pos
    ? 0
    : Math.min(100, Math.round((item.pos / item.duration) * 100))
}

const totalSize = computed(() =>
  items.value.reduce((sum, item) => sum + (Number(item.size) || 0), 0),
)

/** 取列表 → 重新登记路径拿 blob URL → 标记丢文件的记录 → 补解析缺失的时长/封面 */
async function load() {
  loading.value = true
  const rows = (await listLocals()) as unknown as LocalRecord[]
  items.value = rows
  loading.value = false
  if (!rows.length) return
  try {
    const res = await bili.local.register(rows.map((r) => r.path))
    const byId = new Map((res.entries || []).map((e: any) => [e.id, e]))
    const out: LocalRecord[] = []
    for (const row of rows) {
      const entry: any = byId.get(row.id)
      if (entry) {
        out.push({ ...row, url: entry.url, size: entry.size, mtime: entry.mtime, missing: false })
      } else {
        // 登记不到 = 文件被移动/改名/删除，只在第一次发现时落库
        out.push({ ...row, missing: true })
        if (!row.missing) {
          const patch: any = { id: row.id, missing: true }
          await putLocal(patch)
        }
      }
    }
    items.value = out
  } catch (e: any) {
    console.warn('[local] 重新登记失败：', e && e.message)
  }
  parseMissing()
}

/**
 * 用一个离屏 video 量时长 + 截一帧当封面。
 * 时长拿到后 seek 到 15%（最长 30 秒）再画到 320 宽的 canvas 上转 jpeg。
 */
function probeMeta(item: LocalRecord): Promise<{ duration: number; thumb: string }> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    let done = false
    const settle = (result: { duration: number; thumb: string }) => {
      if (done) return
      done = true
      try {
        video.removeAttribute('src')
        video.load()
        video.remove()
      } catch {}
      resolve(result)
    }
    video.onerror = () => settle({ duration: 0, thumb: '' })
    video.onloadedmetadata = async () => {
      let dur = Number(video.duration) || 0
      // 部分 webm 的 duration 是 Infinity，先 seek 到极大值逼它算出真实时长
      if (!isFinite(dur)) {
        try {
          await new Promise<void>((res) => {
            const timer = setTimeout(res, 2e3)
            video.onseeked = () => {
              clearTimeout(timer)
              res()
            }
            video.currentTime = 1e101
          })
          dur = Number(video.duration) || 0
        } catch {
          dur = 0
        }
      }
      let thumb = ''
      try {
        const at = dur > 4 ? Math.min(dur * 0.15, 30) : Math.max(dur * 0.3, 0)
        await new Promise<void>((res) => {
          const timer = setTimeout(res, 1600)
          video.onseeked = () => {
            clearTimeout(timer)
            res()
          }
          video.currentTime = at
        })
        const width = 320
        const ratio = video.videoWidth ? video.videoHeight / video.videoWidth : 9 / 16
        const height = Math.max(1, Math.round(width * ratio))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        canvas.getContext('2d')!.drawImage(video, 0, 0, width, height)
        thumb = canvas.toDataURL('image/jpeg', 0.72)
      } catch {
        thumb = ''
      }
      settle({ duration: dur, thumb })
    }
    // 兜底：12 秒还没结果就当解析失败
    setTimeout(() => settle({ duration: 0, thumb: '' }), 12e3)
    video.src = item.url || ''
  })
}

/** 给还没有时长/封面的记录补解析（串行，避免同时开一堆解码器） */
async function parseMissing() {
  for (const item of items.value.slice()) {
    if (item.missing || item.duration) continue
    parsing.value = item.name
    const meta = await probeMeta(item)
    if (meta.duration) {
      const patch: any = { id: item.id, duration: meta.duration, thumb: meta.thumb || '' }
      await putLocal(patch)
      const row = items.value.find((x) => x.id === item.id)
      if (row) {
        row.duration = meta.duration
        if (meta.thumb) row.thumb = meta.thumb
      }
    }
  }
  parsing.value = ''
}

/** 导入：entries 已经是可入库的记录，这里补上旧的进度信息后整表重载 */
async function upsert(entries: any[]) {
  for (const entry of entries) {
    const old = items.value.find((x) => x.id === entry.id)
    const patch: any = {
      id: entry.id,
      path: entry.path,
      name: entry.name,
      size: entry.size,
      mtime: entry.mtime,
      duration: (old && old.duration) || 0,
      thumb: (old && old.thumb) || '',
      pos: (old && old.pos) || 0,
      addedAt: (old && old.addedAt) || Date.now(),
    }
    await putLocal(patch)
  }
  await load()
}

async function pickFiles() {
  if (busy.value) return
  busy.value = true
  try {
    const res = await bili.local.pickFiles()
    if (res.canceled) return
    const entries = res.entries || []
    if (!entries.length) {
      ui.toast('选中的文件读不出来（可能已被删除）')
      return
    }
    await upsert(entries)
    ui.ok(`已加入 ${entries.length} 个本地视频`)
  } catch (e: any) {
    ui.err(e.message || '打开文件失败')
  } finally {
    busy.value = false
  }
}

async function pickFolder() {
  if (busy.value) return
  busy.value = true
  try {
    const res = await bili.local.pickFolder()
    if (res.canceled) return
    const entries = res.entries || []
    if (!entries.length) {
      ui.toast('这个文件夹里没有找到视频文件')
      return
    }
    if (res.truncated) ui.toast('文件太多，只取了前 500 个')
    await upsert(entries)
    ui.ok(`已加入 ${entries.length} 个本地视频`)
  } catch (e: any) {
    ui.err(e.message || '扫描文件夹失败')
  } finally {
    busy.value = false
  }
}

function open(item: LocalRecord) {
  if (item.missing) {
    ui.err('文件不在了：可能被移动、改名或删除')
    return
  }
  router.push({ name: 'local-player', params: { id: item.id } })
}

async function reveal(item: LocalRecord) {
  try {
    await bili.local.reveal(item.path)
  } catch (e: any) {
    ui.err(e.message || '打开位置失败')
  }
}

async function remove(item: LocalRecord) {
  const ok = await ui.confirm('从列表里移除？', `${item.name}\n磁盘上的文件不会被删除。`, '移除')
  if (!ok) return
  await removeLocal(item.id)
  try {
    await bili.local.remove(item.id)
  } catch {}
  items.value = items.value.filter((x) => x.id !== item.id)
}

onMounted(() => {
  load()
  // 原构建里留给自动化的入口（APK 中同样存在，保留）
  ;(window as any).__addLocalFiles = async (paths: string[]) => {
    const res = await bili.local.register(paths)
    await upsert(res.entries || [])
    return items.value.length
  }
  ;(window as any).__localProbe = () =>
    items.value.map((x) => ({
      id: x.id,
      name: x.name,
      duration: Number(x.duration) || 0,
      pos: Number(x.pos) || 0,
      thumb: !!x.thumb,
      missing: !!x.missing,
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
        <button class="btn sm" :disabled="busy" @click="pickFiles">
          <Icon name="folder" :size="14" /> 打开文件
        </button>
        <button class="btn sm" :disabled="busy" @click="pickFolder">
          <Icon name="list" :size="14" /> 打开文件夹
        </button>
      </div>
    </div>

    <div
      v-if="items.length"
      class="row muted"
      style="font-size: 12.5px; margin: 10px 2px"
    >
      <span>{{ items.length }} 个视频 · 共 {{ formatSize(totalSize) }}</span>
      <span v-if="parsing" class="dim" style="margin-left: auto">
        正在解析「{{ parsing }}」的时长与封面…
      </span>
    </div>

    <div v-if="loading" class="panel" style="padding: 18px">
      <div class="sk" style="height: 76px; margin-bottom: 10px"></div>
      <div class="sk" style="height: 76px"></div>
    </div>

    <div v-else-if="items.length" class="panel" style="padding: 8px">
      <div
        v-for="item in items"
        :key="item.id"
        :class="['rowitem lrow', { miss: item.missing }]"
      >
        <div class="thumb" @click="open(item)">
          <img v-if="item.thumb" :src="item.thumb" alt="" />
          <div v-else class="ph"><Icon name="film" :size="22" /></div>
          <span v-if="item.duration" class="len">{{ formatClock(item.duration) }}</span>
        </div>
        <div class="info grow" style="min-width: 0">
          <div class="t clamp-1" :title="item.path">{{ item.name }}</div>
          <div class="d">
            <span v-if="item.missing" style="color: var(--danger)">文件不在了</span>
            <span v-else>{{ formatSize(item.size) }}</span>
            <span v-if="item.playedAt"> · 上次看到 {{ relativeTime(Number(item.playedAt) || 0) }}</span>
          </div>
          <div v-if="pct(item)" class="pbar" :title="`已看 ${pct(item)}%`">
            <i :style="{ width: pct(item) + '%' }"></i>
          </div>
        </div>
        <div class="row" style="flex: none">
          <button class="btn sm" :disabled="item.missing" @click="open(item)">
            <Icon name="play" :size="13" /> {{ item.pos > 3 ? '继续播放' : '播放' }}
          </button>
          <button
            class="btn sm ghost"
            title="在资源管理器里定位"
            aria-label="在资源管理器里定位"
            @click="reveal(item)"
          >
            <Icon name="external" :size="13" />
          </button>
          <button
            class="btn sm ghost"
            title="从列表移除（不删文件）"
            aria-label="从列表移除"
            @click="remove(item)"
          >
            <Icon name="trash" :size="13" />
          </button>
        </div>
      </div>
    </div>

    <EmptyBlock
      v-else
      icon="film"
      title="还没有本地视频"
      desc="点右上角「打开文件」选几个视频，或者「打开文件夹」把一个目录里的视频全扫进来。文件留在原地，不会被复制或转码。"
    >
      <button class="btn sm" :disabled="busy" @click="pickFiles">
        <Icon name="folder" :size="14" /> 打开文件
      </button>
      <button class="btn sm ghost" :disabled="busy" @click="pickFolder">
        <Icon name="list" :size="14" /> 打开文件夹
      </button>
    </EmptyBlock>
  </div>
</template>

<style scoped>
/* 来源: LocalView-DMFrBuAl.css  scope: data-v-c768b200 */
.lrow {
  align-items: center;
  padding: 10px 8px;
}
.lrow + .lrow {
  border-top: 1px solid var(--line);
}
.lrow:hover {
  background: var(--soft);
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
  background: var(--soft);
  border: 1px solid var(--line);
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
  background: #0000009e;
}
.lrow .info .t {
  font-size: 14px;
}
.lrow .info .d {
  font-size: 12px;
  color: var(--t3);
  margin-top: 4px;
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
  margin-top: 8px;
  max-width: 360px;
  overflow: hidden;
}
.pbar i {
  display: block;
  height: 100%;
  background: var(--brand);
}
</style>
