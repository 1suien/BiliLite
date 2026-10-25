<script setup lang="ts">
/**
 * 通用视频卡片（首页 / 搜索 / 关注更新 / …都用它）
 * 还原自 SkeletonGrid-BPezhzYm.js 里的 VideoCard（与 SkeletonGrid 同 chunk）
 *
 * 原实现没有 emit：点击整卡 → 播放页；点小窗按钮 → 小窗播放；点 UP 名 → UP 主页。
 * props 按原调用点反推：`:item`（视频实体）+ `:progress`（0~1 的观看进度）；`showUp` 默认开。
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import BiliImage from '@/components/BiliImage.vue'
import Icon from '@/components/Icon.vue'
import { useMiniStore } from '@/stores/mini'
import { formatClock, formatCount } from '@/utils/format'
import type { VideoCard } from '@/types'

/** 卡片实体：桥接层在 VideoCard 之外还给了 play（播放量）、duration（秒） */
interface CardItem extends VideoCard {
  play?: number
  /** 关注更新流会带 relativeTime 生成的原因文案 */
  reason?: string
}

const props = withDefaults(
  defineProps<{
    item: CardItem
    /** 观看进度，0~1；>0 才显示封面底部的进度条 */
    progress?: number
    /** 是否显示 UP 名（收藏夹等场景可关掉） */
    showUp?: boolean
  }>(),
  { progress: 0, showUp: true },
)

const router = useRouter()
const mini = useMiniStore()

const durationText = computed(() => formatClock(props.item.duration || 0))
/** 进度条宽度百分比（0~100） */
const pct = computed(() => Math.min(100, Math.max(0, (props.progress || 0) * 100)))

/** 点整卡：进播放页 */
function openVideo() {
  if (!props.item.bvid) return
  router.push({ name: 'video', params: { bvid: props.item.bvid } })
}

/** 小窗播放：不离开当前列表，接着翻别的页面 */
function playMini(e: Event) {
  e.stopPropagation()
  if (!props.item.bvid) return
  mini.play({
    bvid: props.item.bvid,
    fromCard: true,
    page: 1,
    title: props.item.title || '',
    upName: props.item.upName || '',
    cover: props.item.cover || '',
    duration: props.item.duration || 0,
  })
}

/** 点 UP 名：进 UP 主页 */
function openUp(e: Event) {
  e.stopPropagation()
  if (!props.item.upMid) return
  router.push({ name: 'up', params: { mid: String(props.item.upMid) } })
}
</script>

<template>
  <div class="vcard" @click="openVideo">
    <div class="thumb">
      <BiliImage :src="item.cover" :alt="item.title" />
      <button class="mini" title="小窗播放（接着翻别的页面）" @click="playMini">
        <Icon name="pip" :size="14" />
      </button>
      <!-- 时长 0 秒时不显示角标（原实现用 formatClock 结果 !== "0:00" 判断） -->
      <span v-if="durationText !== '0:00'" class="dur">{{ durationText }}</span>
      <div v-if="pct > 0" class="watch">
        <i :style="{ width: pct + '%' }"></i>
      </div>
    </div>
    <div class="meta">
      <div class="title clamp-2">{{ item.title }}</div>
      <div class="sub">
        <span v-if="showUp && item.upName" class="up" @click="openUp">{{ item.upName }}</span>
        <!-- 有 reason（如「3 小时前」/「已看 40%」）时优先显示，没有才显示播放量 -->
        <span v-if="item.reason" class="muted clamp-1">
          <template v-if="showUp && item.upName">· </template>{{ item.reason }}
        </span>
        <span v-else-if="item.play != null" class="muted">{{ formatCount(item.play) }} 播放</span>
      </div>
    </div>
  </div>
</template>
