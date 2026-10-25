<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'
import BiliImage from '../components/BiliImage.vue'
import EmptyBlock from '../components/EmptyBlock.vue'
import Pager from '../components/Pager.vue'
import Icon from '../components/Icon.vue'
import { useLearnStore } from '../stores/learn'
import { useUpsStore, DEFAULT_GROUP } from '../stores/ups'
import { useUiStore } from '../stores/ui'
import { fmtCount } from '../utils/format'

const route = useRoute()
const router = useRouter()
const learn = useLearnStore()
const ups = useUpsStore()
const ui = useUiStore()

const mid = computed(() => String(route.params.mid || ''))
const loading = ref(false)
const uploading = ref(false)
const up = ref(null)
const list = ref([])
const page = ref(1)
const pages = ref(1)
const errorMsg = ref('')

async function loadUp() {
  try {
    up.value = await api.up.info(mid.value)
  } catch (err) {
    errorMsg.value = err.message || 'UP 主信息加载失败'
  }
}

async function loadVideos(reset = true) {
  if (reset) page.value = 1
  uploading.value = true
  try {
    const data = await api.up.videos(mid.value, page.value)
    list.value = reset ? data.items : [...list.value, ...data.items]
    pages.value = data.page && data.page.count ? Math.ceil(data.page.count / 30) : 1
  } catch (err) {
    errorMsg.value = err.message || '投稿列表加载失败'
  } finally {
    uploading.value = false
  }
}

function progressOf(bvid) {
  const rec = Object.values(learn.progressMap).find((x) => x.bvid === bvid)
  if (!rec || !rec.duration) return 0
  return Math.min(1, rec.seconds / rec.duration)
}

function go(p) {
  page.value = p
  loadVideos(false)
}

const inUpsList = computed(() => ups.items.some((x) => String(x.mid) === mid.value))

async function addToList() {
  if (!up.value) return
  try {
    await ups.addUp(
      { mid: up.value.mid || mid.value, name: up.value.name, face: up.value.face, sign: up.value.sign },
      ups.activeGroup && ups.activeGroup !== 'all' ? ups.activeGroup : DEFAULT_GROUP
    )
    ui.ok(`已加入 UP 管理：${up.value.name}`)
  } catch (err) {
    ui.err(err.message || '加入失败')
  }
}

async function removeFromList() {
  const ok = await ui.confirm('从 UP 管理名单移除？', `移除后首页不再显示「${up.value.name}」的更新。`)
  if (!ok) return
  await ups.removeUp(mid.value)
  ui.ok('已移出名单')
}

onMounted(async () => {
  await learn.init()
  try {
    await ups.init()
  } catch (err) {
    console.warn('[up] UP 名单初始化失败：', err && err.message)
  }
  loading.value = true
  await Promise.all([loadUp(), loadVideos(true)])
  loading.value = false
})
</script>

<template>
  <div>
    <div class="page-head">
      <button class="btn sm ghost" @click="router.back()"><Icon name="left" :size="14" /> 返回</button>
      <h1>{{ up ? up.name : 'UP 主' }}</h1>
      <p v-if="up">{{ fmtCount(up.fans) }} 粉丝 · Lv{{ up.level || 0 }}</p>
      <span class="grow" />
      <button class="btn sm" :disabled="uploading" @click="loadVideos(true)">
        <Icon name="refresh" :size="14" /> 刷新
      </button>
    </div>

    <div v-if="up" class="panel row" style="gap: 14px; margin-bottom: 18px">
      <BiliImage :src="up.face" :alt="up.name" style="width: 72px; height: 72px; border-radius: 50%" />
      <div style="min-width: 0">
        <div style="font-weight: 700; font-size: 16px">{{ up.name }}</div>
        <div class="muted" style="font-size: 12.5px">{{ up.sign || '这个人很神秘' }}</div>
      </div>
      <span class="grow" />
      <button v-if="!inUpsList" class="btn sm primary" @click="addToList">
        <Icon name="plus" :size="14" /> 加入 UP 管理
      </button>
      <button v-else class="btn sm" @click="removeFromList">
        <Icon name="check" :size="14" /> 已在 UP 管理
      </button>
      <button
        class="btn sm ghost"
        @click="api.sys.openExternal('https://space.bilibili.com/' + mid).catch(() => {})"
      >
        <Icon name="external" :size="14" /> 打开主页
      </button>
    </div>

    <div v-if="errorMsg" class="panel" style="color: var(--danger)">{{ errorMsg }}</div>
    <div v-else-if="loading" class="panel row" style="gap: 10px"><span class="spinner" /><span class="dim">正在读取投稿…</span></div>
    <EmptyBlock v-else-if="!list.length" icon="film" title="没有读到投稿" desc="该 UP 主可能没有公开投稿，或接口被风控。" />
    <div v-else style="display: flex; flex-direction: column; gap: 4px">
      <div v-for="v in list" :key="v.bvid" class="rowitem" @click="router.push({ name: 'video', params: { bvid: v.bvid } })">
        <BiliImage :src="v.cover" :alt="v.title" />
        <div class="info grow">
          <div class="t clamp-2">{{ v.title }}</div>
          <div class="d">{{ fmtCount(v.play) }} 播放 · {{ v.length }} · {{ v.pubdate ? new Date(v.pubdate * 1000).toLocaleDateString() : '' }}</div>
          <div class="d clamp-2">{{ v.description }}</div>
        </div>
        <span v-if="progressOf(v.bvid) > 0" class="chip plain" style="flex: none">
          <Icon name="clock" :size="12" /> {{ Math.round(progressOf(v.bvid) * 100) }}%
        </span>
      </div>
      <Pager :page="page" :pages="pages" @change="go" />
    </div>
  </div>
</template>
