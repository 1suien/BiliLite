<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import { getLocal, putLocal } from '../db'
import { useUiStore } from '../stores/ui'
import { fmtDuration } from '../utils/format'
import api from '../api'

/**
 * 本地视频播放页。
 *
 * 用原生 <video> 直接放 `lmedia://local/<id>`：Electron 的默认 autoplayPolicy 是
 * 'no-user-gesture-required'，所以自动播放没问题；进度每 5 秒（以及离开页面时）写回 IndexedDB，
 * 下次进列表就是「继续播放」。
 */

const route = useRoute()
const router = useRouter()
const ui = useUiStore()

const row = ref(null)
const ready = ref(false)
const missing = ref(false)
const playError = ref('')
const videoEl = ref(null)
let timer = 0
let lastSave = 0

async function boot() {
  const id = String(route.params.id || '')
  let rec = await getLocal(id)
  if (!rec) {
    missing.value = true
    return
  }
  try {
    // 重启后主进程的内存登记表是空的，这里按路径重新登记，拿回 lmedia:// 地址
    const res = await api.local.register([rec.path])
    const e = (res.entries || [])[0]
    if (!e) {
      missing.value = true
      return
    }
    rec = { ...rec, url: e.url, size: e.size, mtime: e.mtime }
  } catch (err) {
    playError.value = (err && err.message) || '这个文件打不开了'
    missing.value = true
    return
  }
  row.value = rec
  ready.value = true
  window.__playLog = { source: 'local', id: rec.id, name: rec.name, url: rec.url, pos: rec.pos || 0 }
}

function onMeta() {
  const v = videoEl.value
  if (!v || !row.value) return
  const pos = Number(row.value.pos) || 0
  const dur = Number(v.duration)
  if (pos > 1 && (!isFinite(dur) || pos < dur - 1)) v.currentTime = pos
}

function onError() {
  const v = videoEl.value
  const code = v && v.error ? v.error.code : 0
  playError.value =
    code === 4
      ? '内置播放器解不了这个格式（常见于 HEVC/AV1 编码的 MKV）。可以先用别的工具转成 MP4 再放进来。'
      : '这个文件播放失败了，可能已损坏或编码不受支持。'
}

function save(force = false) {
  const v = videoEl.value
  if (!v || !row.value) return
  const now = Date.now()
  if (!force && now - lastSave < 5000) return
  lastSave = now
  const duration = isFinite(v.duration) && v.duration > 0 ? v.duration : row.value.duration || 0
  const pos = Number(v.currentTime) || 0
  row.value.pos = pos
  if (duration) row.value.duration = duration
  putLocal({ id: row.value.id, pos, duration, playedAt: now, thumb: row.value.thumb || '' })
}

function back() {
  save(true)
  router.push({ name: 'local' })
}

async function reveal() {
  if (!row.value) return
  try {
    await api.local.reveal(row.value.path)
  } catch (err) {
    ui.err(err.message || '打开位置失败')
  }
}

onMounted(() => {
  boot()
  // 自动化冒烟用：读当前播放状态
  window.__playProbe = () => {
    const v = videoEl.value
    return v ? { t: Number(v.currentTime) || 0, paused: v.paused, err: v.error ? v.error.code : null, duration: Number(v.duration) || 0 } : null
  }
  timer = setInterval(() => save(), 5000)
})

onBeforeUnmount(() => {
  clearInterval(timer)
  save(true)
})
</script>

<template>
  <div>
    <div class="page-head">
      <div class="grow" style="min-width: 0">
        <h1 class="clamp-1" :title="row ? row.path : ''">{{ row ? row.name : '本地视频' }}</h1>
        <p class="muted" style="margin: 4px 0 0">
          <template v-if="row">{{ fmtDuration(row.duration) || '时长未知' }} · {{ row.path }}</template>
          <template v-else>正在准备…</template>
        </p>
      </div>
      <div class="row" style="flex: none">
        <button class="btn sm ghost" @click="back"><Icon name="left" :size="14" /> 返回列表</button>
        <button class="btn sm ghost" @click="reveal"><Icon name="external" :size="14" /> 打开位置</button>
      </div>
    </div>

    <div v-if="missing" class="panel" style="padding: 22px; text-align: center">
      <p style="margin: 0 0 6px; font-size: 14px; font-weight: 600">
        {{ playError || '文件不在了：可能被移动、改名或删除' }}
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
          :src="row.url"
          controls
          autoplay
          playsinline
          preload="metadata"
          @loadedmetadata="onMeta"
          @timeupdate="save()"
          @pause="save(true)"
          @ended="save(true)"
          @error="onError"
        ></video>
        <div v-else class="sk" style="height: 260px"></div>
      </div>
      <p v-if="playError" class="muted" style="color: var(--danger); font-size: 12.5px; margin: 10px 2px">{{ playError }}</p>
      <p v-else class="muted" style="font-size: 12.5px; margin: 10px 2px">
        播放进度会自动记住，下次从这儿继续。文件不会被复制或转码。
      </p>
    </template>
  </div>
</template>

<style scoped>
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
