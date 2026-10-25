<script setup lang="ts">
/**
 * UP 主主页：头部信息 + 投稿列表（分页）+ 加入/移出 UP 管理
 * 还原自 UpView-hFPleUQP.js
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import BiliImage from '@/components/BiliImage.vue'
import EmptyBlock from '@/components/EmptyBlock.vue'
import Pager from '@/components/Pager.vue'
import { bili } from '@/bridge'
import { useLearnStore } from '@/stores/learn'
import { UNGROUPED, useUpsStore } from '@/stores/ups'
import { useUiStore } from '@/stores/ui'
import { formatCount } from '@/utils/format'
import type { UpCardInfo, VideoCard } from '@/types'

/** UP 主资料：桥接层另外还给了 level */
interface UpInfo extends UpCardInfo {
  level?: number
}

/** 投稿条目：桥接层给的是 {play,length,description}（types 里的 VideoCard 没写全） */
interface UpVideo extends VideoCard {
  play?: number
  length?: string
  description?: string
}

/** bili.up.videos 实际返回 {page:{count,pn,ps},items} */
interface UpVideoResult {
  items: UpVideo[]
  page?: { count?: number }
}

const route = useRoute()
const router = useRouter()
const learn = useLearnStore()
const ups = useUpsStore()
const ui = useUiStore()

const mid = computed(() => String(route.params.mid || ''))
/** 首次进入的整页 loading */
const initialLoading = ref(false)
/** 投稿列表 loading（翻页/刷新） */
const listLoading = ref(false)
const info = ref<UpInfo | null>(null)
const videos = ref<UpVideo[]>([])
const page = ref(1)
const pages = ref(1)
const error = ref('')

/** 是否已经在 UP 管理名单里 */
const isAdded = computed(() => ups.items.some((u) => String(u.mid) === mid.value))

async function loadInfo() {
  try {
    info.value = await bili.up.info(mid.value)
  } catch (e: any) {
    error.value = (e && e.message) || 'UP 主信息加载失败'
  }
}

/** 读投稿；reset=false 用于「加载更多」 */
async function loadVideos(reset = true) {
  if (reset) page.value = 1
  listLoading.value = true
  try {
    const res = (await bili.up.videos(mid.value, page.value)) as unknown as UpVideoResult
    videos.value = reset ? res.items : [...videos.value, ...res.items]
    pages.value = res.page && res.page.count ? Math.ceil(res.page.count / 30) : 1
  } catch (e: any) {
    error.value = (e && e.message) || '投稿列表加载失败'
  } finally {
    listLoading.value = false
  }
}

/** 某个投稿的观看进度（0~1） */
function progressOf(bvid: string) {
  const hit = Object.values(learn.progressMap).find((p) => p.bvid === bvid)
  if (!hit || !hit.duration) return 0
  return Math.min(1, (hit.seconds || 0) / hit.duration)
}

function changePage(p: number) {
  page.value = p
  loadVideos(false)
}

/** 加入 UP 管理名单（跟随当前分组） */
async function addToList() {
  if (!info.value) return
  try {
    await ups.addUp(
      {
        mid: info.value.mid || mid.value,
        name: info.value.name,
        face: info.value.face,
        sign: info.value.sign,
      },
      ups.activeGroup && ups.activeGroup !== 'all' ? ups.activeGroup : UNGROUPED,
    )
    ui.ok(`已加入 UP 管理：${info.value.name}`)
  } catch (e: any) {
    ui.err((e && e.message) || '加入失败')
  }
}

/** 从名单移除 */
async function removeFromList() {
  const ok = await ui.confirm(
    '从 UP 管理名单移除？',
    `移除后首页不再显示「${info.value?.name}」的更新。`,
  )
  if (!ok) return
  await ups.removeUp(mid.value)
  ui.ok('已移出名单')
}

onMounted(async () => {
  await learn.init()
  try {
    await ups.init()
  } catch (e: any) {
    console.warn('[up] UP 名单初始化失败：', e && e.message)
  }
  initialLoading.value = true
  await Promise.all([loadInfo(), loadVideos(true)])
  initialLoading.value = false
})
</script>

<template>
  <div>
    <div class="page-head">
      <button class="btn sm ghost" @click="router.back()">
        <Icon name="left" :size="14" /> 返回
      </button>
      <h1>{{ info ? info.name : 'UP 主' }}</h1>
      <p v-if="info">{{ formatCount(info.fans || 0) }} 粉丝 · Lv{{ info.level || 0 }}</p>
      <span class="grow"></span>
      <button class="btn sm" :disabled="listLoading" @click="loadVideos(true)">
        <Icon name="refresh" :size="14" /> 刷新
      </button>
    </div>

    <!-- 头部资料 -->
    <div v-if="info" class="panel row" style="gap: 14px; margin-bottom: 18px">
      <BiliImage
        :src="info.face"
        :alt="info.name"
        style="width: 72px; height: 72px; border-radius: 50%"
      />
      <div style="min-width: 0">
        <div style="font-weight: 700; font-size: 16px">{{ info.name }}</div>
        <div class="muted" style="font-size: 12.5px">{{ info.sign || '这个人很神秘' }}</div>
      </div>
      <span class="grow"></span>
      <button v-if="isAdded" class="btn sm" @click="removeFromList">
        <Icon name="check" :size="14" /> 已在 UP 管理
      </button>
      <button v-else class="btn sm primary" @click="addToList">
        <Icon name="plus" :size="14" /> 加入 UP 管理
      </button>
      <button
        class="btn sm ghost"
        @click="bili.sys.openExternal('https://space.bilibili.com/' + mid).catch(() => {})"
      >
        <Icon name="external" :size="14" /> 打开主页
      </button>
    </div>

    <div v-if="error" class="panel" style="color: var(--danger)">{{ error }}</div>

    <div v-else-if="initialLoading" class="panel row" style="gap: 10px">
      <span class="spinner"></span>
      <span class="dim">正在读取投稿…</span>
    </div>

    <div v-else-if="videos.length" style="display: flex; flex-direction: column; gap: 4px">
      <div
        v-for="v in videos"
        :key="v.bvid"
        class="rowitem"
        @click="router.push({ name: 'video', params: { bvid: v.bvid } })"
      >
        <BiliImage :src="v.cover" :alt="v.title" />
        <div class="info grow">
          <div class="t clamp-2">{{ v.title }}</div>
          <div class="d">
            {{ formatCount(v.play || 0) }} 播放 · {{ v.length }} ·
            {{ v.pubdate ? new Date(v.pubdate * 1000).toLocaleDateString() : '' }}
          </div>
          <div class="d clamp-2">{{ v.description }}</div>
        </div>
        <span v-if="progressOf(v.bvid) > 0" class="chip plain" style="flex: none">
          <Icon name="clock" :size="12" /> {{ Math.round(progressOf(v.bvid) * 100) }}%
        </span>
      </div>
      <Pager :page="page" :pages="pages" @change="changePage" />
    </div>

    <EmptyBlock
      v-else
      icon="film"
      title="没有读到投稿"
      desc="该 UP 主可能没有公开投稿，或接口被风控。"
    />
  </div>
</template>
