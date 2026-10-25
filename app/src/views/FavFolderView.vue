<script setup lang="ts">
/**
 * 某个 B 站收藏夹的内容（分页 + 加载更多）
 * 还原自 FavFolderView-DYE1nnc0.js
 */
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import BiliImage from '@/components/BiliImage.vue'
import EmptyBlock from '@/components/EmptyBlock.vue'
import { bili } from '@/bridge'
import { useLearnStore } from '@/stores/learn'
import { useUiStore } from '@/stores/ui'
import { formatClock, formatCount, formatDateTime } from '@/utils/format'

/** 收藏夹内容条目（bili.fav.resources 的 medias 元素） */
interface FavMedia {
  id: number
  bvid?: string
  title: string
  cover: string
  intro?: string
  upper?: string
  duration?: number
  favTime?: number
  cntInfo?: { play?: number }
}

/**
 * 注意：桥里 fav.resources 声明返回 Paged<FavResource>，
 * 实际后端返回的是 { info, medias, hasMore }，这里按真实结构取。
 */
interface FavResourcesResult {
  info?: { id?: number; title?: string; mediaCount?: number; cover?: string }
  medias: FavMedia[]
  hasMore?: boolean
}

const route = useRoute()
const router = useRouter()
const ui = useUiStore()
const learn = useLearnStore()

const mediaId = computed(() => String(route.params.mediaId || ''))
const loading = ref(false)
const error = ref('')
const info = ref<{ id?: number; title?: string; mediaCount?: number; cover?: string }>({})
const medias = ref<FavMedia[]>([])
const hasMore = ref(false)
const page = ref(1)

/** 某个视频的观看进度（0~1） */
function progressOf(bvid?: string) {
  const hit = Object.values(learn.progressMap).find((p) => p.bvid === bvid)
  if (!hit || !hit.duration) return 0
  return Math.min(1, (hit.seconds || 0) / hit.duration)
}

/** 读取收藏夹内容；reset=false 用于「加载更多」 */
async function load(reset = true) {
  if (reset) page.value = 1
  loading.value = true
  error.value = ''
  try {
    const res = (await bili.fav.resources(mediaId.value, page.value)) as unknown as FavResourcesResult
    info.value = res.info || {}
    medias.value = reset ? res.medias : [...medias.value, ...res.medias]
    hasMore.value = !!res.hasMore
  } catch (e: any) {
    error.value = (e && e.message) || '读取收藏夹内容失败'
    if (e && e.needLogin) {
      ui.askLogin()
      router.replace('/fav')
    }
  } finally {
    loading.value = false
  }
}

function loadMore() {
  page.value += 1
  load(false)
}

function open(m: FavMedia) {
  if (!m.bvid) return
  router.push({ name: 'video', params: { bvid: m.bvid } })
}

onMounted(() => {
  learn.init()
  load(true)
})
</script>

<template>
  <div>
    <div class="page-head">
      <RouterLink to="/fav" class="btn sm ghost">
        <Icon name="left" :size="14" /> 收藏夹
      </RouterLink>
      <h1>{{ info.title || '收藏夹内容' }}</h1>
      <p v-if="info.mediaCount != null">{{ info.mediaCount }} 个内容</p>
      <span class="grow"></span>
      <button class="btn sm" :disabled="loading" @click="load(true)">
        <Icon name="refresh" :size="14" /> 刷新
      </button>
    </div>

    <div v-if="error" class="panel" style="color: var(--danger)">{{ error }}</div>

    <div v-else-if="loading && !medias.length" class="panel row" style="gap: 10px">
      <span class="spinner"></span>
      <span class="dim">正在读取…</span>
    </div>

    <div v-else-if="medias.length" style="display: flex; flex-direction: column; gap: 4px">
      <div v-for="m in medias" :key="m.id" class="rowitem" @click="open(m)">
        <BiliImage :src="m.cover" :alt="m.title" />
        <div class="info grow">
          <div class="t clamp-2">{{ m.title }}</div>
          <div class="d">
            {{ m.upper }} · {{ formatClock(m.duration || 0) }} ·
            {{ formatCount((m.cntInfo && m.cntInfo.play) || 0) }} 播放
          </div>
          <div class="d clamp-2">{{ m.intro }}</div>
        </div>
        <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex: none">
          <span class="muted" style="font-size: 11.5px">{{ formatDateTime(m.favTime) }} 收藏</span>
          <span v-if="progressOf(m.bvid) > 0" class="chip plain">
            <Icon name="clock" :size="12" /> {{ Math.round(progressOf(m.bvid) * 100) }}%
          </span>
        </div>
      </div>

      <div v-if="hasMore" class="load-more">
        <button class="btn" :disabled="loading" @click="loadMore">
          <span v-if="loading" class="spinner"></span>
          <Icon v-else name="down" :size="14" />
          {{ loading ? '加载中' : '加载更多' }}
        </button>
      </div>
    </div>

    <EmptyBlock
      v-else
      icon="star"
      title="这个收藏夹是空的"
      desc="在 B 站里收藏一些学习视频，这里就会出现。"
    />
  </div>
</template>
