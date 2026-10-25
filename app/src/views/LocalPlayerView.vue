<script setup lang="ts">
/**
 * 本地视频播放页 /local/:id
 *
 * 还原自 LocalPlayerView-CakE6idn.js：
 * 不是在线视频那套 DASH 播放器，这里就是一个原生 <video>，
 * 播放地址由「路径 → blob URL」登记得到（bili.local.register）。
 * 播放进度每 5 秒（以及暂停/结束/返回时）写回 Dexie 的 locals 表。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import { useUiStore } from '@/stores/ui'
import { bili } from '@/bridge'
import { getLocal, putLocal } from '@/db'
import { formatClock } from '@/utils/format'
import type { LocalVideo } from '@/types'

/** 原实现里播放进度的字段名是 pos（types.ts 里写作 seconds），按原字段名读写以兼容旧数据 */
interface LocalRecord extends LocalVideo {
  pos?: number
  thumb?: string
  missing?: boolean
}

const route = useRoute()
const router = useRouter()
const ui = useUiStore()

const rec = ref<LocalRecord | null>(null)
const ready = ref(false)
const failed = ref(false)
const errorText = ref('')
const videoEl = ref<HTMLVideoElement | null>(null)

let timer: any = 0
/** 上次落库的时间戳，避免 5 秒内反复写 */
let lastSave = 0

/** 取库里的记录 → 重新登记路径拿新的 blob URL */
async function load() {
  const id = String(route.params.id || '')
  let item: LocalRecord | null = await getLocal(id)
  if (!item) {
    failed.value = true
    return
  }
  try {
    const entry = ((await bili.local.register([item.path])).entries || [])[0]
    if (!entry) {
      failed.value = true
      return
    }
    item = { ...item, url: entry.url, size: entry.size, mtime: entry.mtime }
  } catch (e: any) {
    // 文件被移动/删除/改名，登记会失败
    errorText.value = (e && e.message) || '这个文件打不开了'
    failed.value = true
    return
  }
  rec.value = item
  ready.value = true
  ;(window as any).__playLog = {
    source: 'local',
    id: item.id,
    name: item.name,
    url: item.url,
    pos: item.pos || 0,
  }
}

/** 元数据到手后跳到上次看到的位置（离结尾不足 1 秒就不跳了） */
function onLoadedMetadata() {
  const v = videoEl.value
  if (!v || !rec.value) return
  const pos = Number(rec.value.pos) || 0
  const dur = Number(v.duration)
  if (pos > 1 && (!isFinite(dur) || pos < dur - 1)) v.currentTime = pos
}

/** 解码失败：错误码 4 一般是容器/编码不支持（HEVC、AV1 的 MKV 很常见） */
function onError() {
  const v = videoEl.value
  const code = v && v.error ? v.error.code : 0
  errorText.value =
    code === 4
      ? '内置播放器解不了这个格式（常见于 HEVC/AV1 编码的 MKV）。可以先用别的工具转成 MP4 再放进来。'
      : '这个文件播放失败了，可能已损坏或编码不受支持。'
}

/** 记录播放进度（force=false 时 5 秒节流） */
function saveProgress(force = false) {
  const v = videoEl.value
  if (!v || !rec.value) return
  const now = Date.now()
  if (!force && now - lastSave < 5e3) return
  lastSave = now
  const dur =
    isFinite(v.duration) && v.duration > 0 ? v.duration : rec.value.duration || 0
  const pos = Number(v.currentTime) || 0
  rec.value.pos = pos
  if (dur) rec.value.duration = dur
  // pos / thumb 是原实现自带的字段（types.ts 里没有），用 any 绕过多余属性检查
  const patch: any = { id: rec.value.id, pos, duration: dur, playedAt: now, thumb: rec.value.thumb || '' }
  putLocal(patch)
}

function back() {
  saveProgress(true)
  router.push({ name: 'local' })
}

async function revealFile() {
  if (!rec.value) return
  try {
    await bili.local.reveal(rec.value.path)
  } catch (e: any) {
    ui.err(e.message || '打开位置失败')
  }
}

onMounted(() => {
  load()
  // 原构建里留在 window 上的自动化探针（APK 中同样存在，保留）
  ;(window as any).__playProbe = () => {
    const v = videoEl.value
    if (!v) return null
    return {
      t: Number(v.currentTime) || 0,
      paused: v.paused,
      err: v.error ? v.error.code : null,
      duration: Number(v.duration) || 0,
    }
  }
  timer = setInterval(() => saveProgress(), 5e3)
})

onBeforeUnmount(() => {
  clearInterval(timer)
  // 离开页面时补记一次
  saveProgress(true)
})
</script>

<template>
  <div>
    <div class="page-head">
      <div class="grow" style="min-width: 0">
        <h1 class="clamp-1" :title="rec ? rec.path : ''">
          {{ rec ? rec.name : '本地视频' }}
        </h1>
        <p class="muted" style="margin: 4px 0 0">
          <template v-if="rec">
            {{ formatClock(rec.duration || 0) || '时长未知' }} · {{ rec.path }}
          </template>
          <template v-else>正在准备…</template>
        </p>
      </div>
      <div class="row" style="flex: none">
        <button class="btn sm ghost" @click="back">
          <Icon name="left" :size="14" /> 返回列表
        </button>
        <button class="btn sm ghost" @click="revealFile">
          <Icon name="external" :size="14" /> 打开位置
        </button>
      </div>
    </div>

    <!-- 记录还在，但文件打不开了 -->
    <div v-if="failed" class="panel" style="padding: 22px; text-align: center">
      <p style="margin: 0 0 6px; font-size: 14px; font-weight: 600">
        {{ errorText || '文件不在了：可能被移动、改名或删除' }}
      </p>
      <p class="muted" style="margin: 0 0 14px; font-size: 12.5px">
        列表里保留的是路径，文件被移走后就播不了；可以回列表把它移除，或重新添加。
      </p>
      <button class="btn sm" @click="back">返回列表</button>
    </div>

    <template v-else>
      <div class="stage">
        <video
          v-if="ready"
          ref="videoEl"
          class="v"
          :src="rec?.url"
          controls
          autoplay
          playsinline
          preload="metadata"
          @loadedmetadata="onLoadedMetadata"
          @timeupdate="saveProgress()"
          @pause="saveProgress(true)"
          @ended="saveProgress(true)"
          @error="onError"
        ></video>
        <div v-else class="sk" style="height: 260px"></div>
      </div>
      <p
        v-if="errorText"
        class="muted"
        style="color: var(--danger); font-size: 12.5px; margin: 10px 2px"
      >
        {{ errorText }}
      </p>
      <p v-else class="muted" style="font-size: 12.5px; margin: 10px 2px">
        播放进度会自动记住，下次从这儿继续。文件不会被复制或转码。
      </p>
    </template>
  </div>
</template>

<style scoped>
/* 来源: LocalPlayerView-sZl1JEp5.css  scope: data-v-e4d696d1 */
.stage {
  background: #000;
  border-radius: 12px;
  overflow: hidden;
}
.v {
  display: block;
  width: 100%;
  max-height: 68vh;
  background: #000;
}
.clamp-1 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
