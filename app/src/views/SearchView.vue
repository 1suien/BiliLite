<script setup lang="ts">
/**
 * 搜索页：视频 / UP 主 两个 tab + 排序 + 分页
 * 还原自 SearchView-CJauU8wO.js
 *
 * URL 只同步 q（原实现不写 type/order/page 到 query）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import BiliImage from '@/components/BiliImage.vue'
import EmptyBlock from '@/components/EmptyBlock.vue'
import Pager from '@/components/Pager.vue'
import SkeletonGrid from '@/components/SkeletonGrid.vue'
import VideoCard from '@/components/VideoCard.vue'
import { bili } from '@/bridge'
import { useLearnStore } from '@/stores/learn'
import { formatCount } from '@/utils/format'
import type { VideoCard as VideoCardEntity } from '@/types'

/** 搜索 UP 主的结果行（bili.search.ups 的 items 元素） */
interface UpHit {
  mid: number
  name: string
  face: string
  fans?: number
  videos?: number
  sign?: string
}

/** bili.search.* 实际返回 {items,pages,total}（桥里的 Paged 类型没写 pages） */
interface SearchResult<T> {
  items: T[]
  pages?: number
  total?: number
}

const route = useRoute()
const router = useRouter()
const learn = useLearnStore()

/** 当前 tab：video / up */
const tab = ref<'video' | 'up'>('video')
const keyword = ref(String(route.query.q || ''))
const page = ref(1)
const loading = ref(false)
const error = ref('')
const videos = ref<VideoCardEntity[]>([])
const ups = ref<UpHit[]>([])
const pages = ref(1)
const total = ref(0)
const order = ref('totalrank')

const ORDERS = [
  { key: 'totalrank', label: '综合' },
  { key: 'click', label: '最多播放' },
  { key: 'pubdate', label: '最新发布' },
  { key: 'dm', label: '最多弹幕' },
  { key: 'stow', label: '最多收藏' },
]

const hasKeyword = computed(() => !!keyword.value.trim())

/** 某个视频的观看进度（0~1） */
function progressOf(bvid: string) {
  const hit = Object.values(learn.progressMap).find((p) => p.bvid === bvid)
  if (!hit || !hit.duration) return 0
  return Math.min(1, (hit.seconds || 0) / hit.duration)
}

/** 搜索；reset=false 用于翻页 */
async function search(reset = true) {
  const kw = keyword.value.trim()
  if (!kw) return
  if (reset) page.value = 1
  loading.value = true
  error.value = ''
  try {
    if (tab.value === 'video') {
      const res = (await bili.search.videos(kw, page.value, order.value)) as unknown as SearchResult<VideoCardEntity>
      videos.value = res.items
      pages.value = res.pages || 1
      total.value = res.total || 0
    } else {
      const res = (await bili.search.ups(kw, page.value)) as unknown as SearchResult<UpHit>
      ups.value = res.items
      pages.value = res.pages || 1
      total.value = res.total || 0
    }
  } catch (e: any) {
    error.value = (e && e.message) || '搜索失败'
    videos.value = []
    ups.value = []
  } finally {
    loading.value = false
  }
}

/** 回车 / 点搜索按钮：先把关键词同步进 URL */
function submit() {
  const kw = keyword.value.trim()
  if (!kw) return
  router.replace({ name: 'search', query: { q: kw } })
  search(true)
}

function switchTab(t: 'video' | 'up') {
  tab.value = t
  if (hasKeyword.value) search(true)
}

function setOrder(key: string) {
  order.value = key
  search(true)
}

function changePage(p: number) {
  page.value = p
  search(false)
}

watch(
  () => route.query.q,
  (q) => {
    const s = String(q || '')
    if (s && s !== keyword.value) {
      keyword.value = s
      search(true)
    }
  },
)

onMounted(() => {
  if (hasKeyword.value) search(true)
})
</script>

<template>
  <div>
    <div class="page-head">
      <h1>搜索</h1>
      <p v-if="total">共 {{ formatCount(total) }} 条结果 · 第 {{ page }}/{{ pages }} 页</p>
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
      <div :class="['tab', { on: tab === 'video' }]" @click="switchTab('video')">视频</div>
      <div :class="['tab', { on: tab === 'up' }]" @click="switchTab('up')">UP 主</div>
    </div>

    <!-- 排序只在视频 tab 下有用 -->
    <div v-if="tab === 'video'" class="row" style="flex-wrap: wrap; margin-bottom: 14px">
      <span
        v-for="o in ORDERS"
        :key="o.key"
        :class="['chip', { on: order === o.key }]"
        @click="setOrder(o.key)"
      >
        {{ o.label }}
      </span>
    </div>

    <div v-if="error" class="panel" style="color: var(--danger)">
      {{ error }}
      <div class="muted" style="font-size: 12px; margin-top: 6px">
        搜索接口偶发风控，稍后重试通常即可；登录后成功率更高。
      </div>
    </div>

    <SkeletonGrid v-else-if="loading" />

    <template v-else-if="tab === 'video'">
      <div v-if="videos.length" class="grid">
        <VideoCard v-for="v in videos" :key="v.bvid" :item="v" :progress="progressOf(v.bvid)" />
      </div>
      <EmptyBlock
        v-else
        icon="search"
        :title="hasKeyword ? '没有找到相关视频' : '还没有搜索内容'"
        :desc="hasKeyword ? '换个关键词试试，或切换到综合排序。' : '在上方输入关键词后回车。'"
      />
      <Pager :page="page" :pages="pages" @change="changePage" />
    </template>

    <template v-else>
      <div v-if="ups.length" style="display: flex; flex-direction: column; gap: 4px">
        <div
          v-for="u in ups"
          :key="u.mid"
          class="rowitem"
          @click="router.push({ name: 'up', params: { mid: String(u.mid) } })"
        >
          <BiliImage
            :src="u.face"
            :alt="u.name"
            style="width: 92px; aspect-ratio: 1; border-radius: 50%"
          />
          <div class="info">
            <div class="t">{{ u.name }}</div>
            <div class="d clamp-2">{{ u.sign || '这个人很神秘' }}</div>
            <div class="d">{{ formatCount(u.fans || 0) }} 粉丝 · {{ formatCount(u.videos || 0) }} 投稿</div>
          </div>
        </div>
      </div>
      <EmptyBlock v-else icon="user" title="没有找到相关 UP 主" desc="试试更短的关键词。" />
      <Pager :page="page" :pages="pages" @change="changePage" />
    </template>
  </div>
</template>
