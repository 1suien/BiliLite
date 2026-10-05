<script setup>
import { ref, watch, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api'
import VideoCard from '../components/VideoCard.vue'
import SkeletonGrid from '../components/SkeletonGrid.vue'
import EmptyBlock from '../components/EmptyBlock.vue'
import Pager from '../components/Pager.vue'
import Icon from '../components/Icon.vue'
import BiliImage from '../components/BiliImage.vue'
import { fmtCount } from '../utils/format'
import { useLearnStore } from '../stores/learn'

const route = useRoute()
const router = useRouter()
const learn = useLearnStore()

const tab = ref('video')
const keyword = ref(String(route.query.q || ''))
const page = ref(1)
const loading = ref(false)
const errorMsg = ref('')
const list = ref([])
const ups = ref([])
const pages = ref(1)
const total = ref(0)
const order = ref('totalrank')

const ORDERS = [
  { key: 'totalrank', label: '综合' },
  { key: 'click', label: '最多播放' },
  { key: 'pubdate', label: '最新发布' },
  { key: 'dm', label: '最多弹幕' },
  { key: 'stow', label: '最多收藏' }
]

const hasQuery = computed(() => Boolean(keyword.value.trim()))

function progressOf(bvid) {
  const rec = Object.values(learn.progressMap).find((x) => x.bvid === bvid)
  if (!rec || !rec.duration) return 0
  return Math.min(1, rec.seconds / rec.duration)
}

async function run(reset = true) {
  const q = keyword.value.trim()
  if (!q) return
  if (reset) page.value = 1
  loading.value = true
  errorMsg.value = ''
  try {
    if (tab.value === 'video') {
      const data = await api.search.videos(q, page.value, order.value)
      list.value = data.items
      pages.value = data.pages
      total.value = data.total
    } else {
      const data = await api.search.ups(q, page.value)
      ups.value = data.items
      pages.value = data.pages
      total.value = data.total
    }
  } catch (err) {
    errorMsg.value = err.message || '搜索失败'
    list.value = []
    ups.value = []
  } finally {
    loading.value = false
  }
}

function submit() {
  const q = keyword.value.trim()
  if (!q) return
  router.replace({ name: 'search', query: { q } })
  run(true)
}

function changeTab(t) {
  tab.value = t
  if (hasQuery.value) run(true)
}

function go(p) {
  page.value = p
  run(false)
}

watch(
  () => route.query.q,
  (q) => {
    const next = String(q || '')
    if (next && next !== keyword.value) {
      keyword.value = next
      run(true)
    }
  }
)

onMounted(() => {
  if (hasQuery.value) run(true)
})
</script>

<template>
  <div>
    <div class="page-head">
      <h1>搜索</h1>
      <p v-if="total">共 {{ fmtCount(total) }} 条结果 · 第 {{ page }}/{{ pages }} 页</p>
      <p v-else>找知识点、找 UP 主，回车开始</p>
    </div>

    <div class="row" style="margin-bottom: 14px; max-width: 640px">
      <input
        v-model="keyword"
        class="input"
        placeholder="输入关键词，例如：线性代数 速成"
        @keyup.enter="submit"
      />
      <button class="btn primary" :disabled="loading" @click="submit">
        <Icon name="search" :size="15" /> 搜索
      </button>
    </div>

    <div class="tabs" style="margin-bottom: 12px">
      <div class="tab" :class="{ on: tab === 'video' }" @click="changeTab('video')">视频</div>
      <div class="tab" :class="{ on: tab === 'up' }" @click="changeTab('up')">UP 主</div>
    </div>

    <div v-if="tab === 'video'" class="row" style="flex-wrap: wrap; margin-bottom: 14px">
      <span v-for="o in ORDERS" :key="o.key" class="chip" :class="{ on: order === o.key }" @click="order = o.key; run(true)">
        {{ o.label }}
      </span>
    </div>

    <div v-if="errorMsg" class="panel" style="color: var(--danger)">
      {{ errorMsg }}
      <div class="muted" style="font-size: 12px; margin-top: 6px">
        搜索接口偶发风控，稍后重试通常即可；登录后成功率更高。
      </div>
    </div>

    <SkeletonGrid v-else-if="loading" />

    <template v-else-if="tab === 'video'">
      <EmptyBlock
        v-if="!list.length"
        icon="search"
        :title="hasQuery ? '没有找到相关视频' : '还没有搜索内容'"
        :desc="hasQuery ? '换个关键词试试，或切换到综合排序。' : '在上方输入关键词后回车。'"
      />
      <div v-else class="grid">
        <VideoCard v-for="v in list" :key="v.bvid" :item="v" :progress="progressOf(v.bvid)" />
      </div>
      <Pager :page="page" :pages="pages" @change="go" />
    </template>

    <template v-else>
      <EmptyBlock v-if="!ups.length" icon="user" title="没有找到相关 UP 主" desc="试试更短的关键词。" />
      <div v-else style="display: flex; flex-direction: column; gap: 4px">
        <div
          v-for="u in ups"
          :key="u.mid"
          class="rowitem"
          @click="router.push({ name: 'up', params: { mid: String(u.mid) } })"
        >
          <BiliImage :src="u.face" :alt="u.name" style="width: 92px; aspect-ratio: 1; border-radius: 50%" />
          <div class="info">
            <div class="t">{{ u.name }}</div>
            <div class="d clamp-2">{{ u.sign || '这个人很神秘' }}</div>
            <div class="d">{{ fmtCount(u.fans) }} 粉丝 · {{ fmtCount(u.videos) }} 投稿</div>
          </div>
        </div>
      </div>
      <Pager :page="page" :pages="pages" @change="go" />
    </template>
  </div>
</template>
