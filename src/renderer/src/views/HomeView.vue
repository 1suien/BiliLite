<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import VideoCard from '../components/VideoCard.vue'
import SkeletonGrid from '../components/SkeletonGrid.vue'
import EmptyBlock from '../components/EmptyBlock.vue'
import Icon from '../components/Icon.vue'
import { useLearnStore } from '../stores/learn'
import { useUiStore } from '../stores/ui'
import { fmtHours } from '../utils/format'

const router = useRouter()
const learn = useLearnStore()
const ui = useUiStore()

const loading = ref(true)
const items = ref([])
const source = ref('recommend')
const page = ref(1)
const failed = ref('')

const continueList = computed(() =>
  learn.list
    .filter((r) => r.seconds > 5 && !r.completed)
    .slice(0, 6)
    .map((r) => ({
      ...r,
      progress: r.duration ? Math.min(1, r.seconds / r.duration) : 0
    }))
)

async function load(reset = true) {
  loading.value = true
  failed.value = ''
  if (reset) page.value = 1
  try {
    const data = await api.home.feed(page.value)
    items.value = reset ? data.items : [...items.value, ...data.items]
    source.value = data.source
  } catch (err) {
    failed.value = err.message || '加载失败'
  } finally {
    loading.value = false
  }
}

function more() {
  page.value += 1
  load(false)
}

function progressOf(item) {
  const rec = Object.values(learn.progressMap).find((x) => x.bvid === item.bvid)
  if (!rec || !rec.duration) return 0
  return Math.min(1, rec.seconds / rec.duration)
}

onMounted(async () => {
  await load(true)
  const err = failed.value
  if (err && /登录/.test(err)) ui.toast(err)
})
</script>

<template>
  <div>
    <section v-if="continueList.length" style="margin-bottom: 22px">
      <div class="page-head">
        <h1>继续学习</h1>
        <p>接着上次的进度继续，今天已学 {{ fmtHours(learn.todaySeconds) }} 小时</p>
        <span class="grow" />
        <RouterLink to="/learn" class="chip"><Icon name="chart" :size="13" /> 学习统计</RouterLink>
      </div>
      <div class="grid">
        <VideoCard
          v-for="r in continueList"
          :key="r.key"
          :item="{ bvid: r.bvid, title: r.title, cover: r.cover, upName: r.upName }"
          :progress="r.progress"
        />
      </div>
    </section>

    <div class="page-head">
      <h1>首页推荐</h1>
      <p>{{ source === 'recommend' ? '来自 B 站推荐流' : source === 'popular' ? '推荐流不可用，已切换为热门' : '排行榜' }}</p>
      <span class="grow" />
      <button class="btn sm" :disabled="loading" @click="load(true)"><Icon name="refresh" :size="14" /> 换一批</button>
    </div>

    <div v-if="failed" class="panel" style="color: var(--danger)">{{ failed }}</div>
    <SkeletonGrid v-else-if="loading && !items.length" />
    <EmptyBlock v-else-if="!items.length" icon="film" title="没有拿到推荐内容" desc="检查网络后重试，或先登录以获得更完整的推荐。" />
    <div v-else class="grid">
      <VideoCard v-for="v in items" :key="v.bvid + (v.cid || '')" :item="v" :progress="progressOf(v)" />
    </div>

    <div v-if="items.length" class="load-more">
      <button class="btn" :disabled="loading" @click="more">
        <Icon v-if="!loading" name="down" :size="14" />
        <span v-if="loading" class="spinner" />
        {{ loading ? '加载中' : '加载更多' }}
      </button>
    </div>
  </div>
</template>
