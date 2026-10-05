<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'
import BiliImage from '../components/BiliImage.vue'
import EmptyBlock from '../components/EmptyBlock.vue'
import Pager from '../components/Pager.vue'
import Icon from '../components/Icon.vue'
import { useUiStore } from '../stores/ui'
import { useLearnStore } from '../stores/learn'
import { fmtCount, fmtDuration, fmtDate } from '../utils/format'

const route = useRoute()
const router = useRouter()
const ui = useUiStore()
const learn = useLearnStore()

const mediaId = computed(() => String(route.params.mediaId || ''))
const loading = ref(false)
const errorMsg = ref('')
const info = ref({})
const medias = ref([])
const hasMore = ref(false)
const pn = ref(1)

function progressOf(bvid) {
  const rec = Object.values(learn.progressMap).find((x) => x.bvid === bvid)
  if (!rec || !rec.duration) return 0
  return Math.min(1, rec.seconds / rec.duration)
}

async function load(reset = true) {
  if (reset) pn.value = 1
  loading.value = true
  errorMsg.value = ''
  try {
    const data = await api.fav.resources(mediaId.value, pn.value)
    info.value = data.info || {}
    medias.value = reset ? data.medias : [...medias.value, ...data.medias]
    hasMore.value = data.hasMore
  } catch (err) {
    errorMsg.value = err.message || '读取收藏夹内容失败'
    if (err.needLogin) {
      ui.askLogin()
      router.replace('/fav')
    }
  } finally {
    loading.value = false
  }
}

function more() {
  pn.value += 1
  load(false)
}

function play(m) {
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
      <RouterLink to="/fav" class="btn sm ghost"><Icon name="left" :size="14" /> 收藏夹</RouterLink>
      <h1>{{ info.title || '收藏夹内容' }}</h1>
      <p v-if="info.mediaCount != null">{{ info.mediaCount }} 个内容</p>
      <span class="grow" />
      <button class="btn sm" :disabled="loading" @click="load(true)"><Icon name="refresh" :size="14" /> 刷新</button>
    </div>

    <div v-if="errorMsg" class="panel" style="color: var(--danger)">{{ errorMsg }}</div>
    <div v-else-if="loading && !medias.length" class="panel row" style="gap: 10px">
      <span class="spinner" /><span class="dim">正在读取…</span>
    </div>
    <EmptyBlock v-else-if="!medias.length" icon="star" title="这个收藏夹是空的" desc="在 B 站里收藏一些学习视频，这里就会出现。" />
    <div v-else style="display: flex; flex-direction: column; gap: 4px">
      <div v-for="m in medias" :key="m.id" class="rowitem" @click="play(m)">
        <BiliImage :src="m.cover" :alt="m.title" />
        <div class="info grow">
          <div class="t clamp-2">{{ m.title }}</div>
          <div class="d">{{ m.upper }} · {{ fmtDuration(m.duration) }} · {{ fmtCount(m.cntInfo && m.cntInfo.play) }} 播放</div>
          <div class="d clamp-2">{{ m.intro }}</div>
        </div>
        <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex: none">
          <span class="muted" style="font-size: 11.5px">{{ fmtDate(m.favTime) }} 收藏</span>
          <span v-if="progressOf(m.bvid) > 0" class="chip plain">
            <Icon name="clock" :size="12" /> {{ Math.round(progressOf(m.bvid) * 100) }}%
          </span>
        </div>
      </div>
      <div v-if="hasMore" class="load-more">
        <button class="btn" :disabled="loading" @click="more">
          <span v-if="loading" class="spinner" /><Icon v-else name="down" :size="14" />
          {{ loading ? '加载中' : '加载更多' }}
        </button>
      </div>
    </div>
  </div>
</template>
