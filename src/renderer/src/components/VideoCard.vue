<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import BiliImage from './BiliImage.vue'
import Icon from './Icon.vue'
import { fmtCount, fmtDuration } from '../utils/format'
import { useMiniStore } from '../stores/mini'

const props = defineProps({
  item: { type: Object, required: true },
  /** 0~1，来自学习记录 */
  progress: { type: Number, default: 0 },
  showUp: { type: Boolean, default: true }
})

const router = useRouter()
const mini = useMiniStore()
const durationText = computed(() => fmtDuration(props.item.duration))
const pct = computed(() => Math.min(100, Math.max(0, (props.progress || 0) * 100)))

function open() {
  if (!props.item.bvid) return
  router.push({ name: 'video', params: { bvid: props.item.bvid } })
}

/** 缩略图右上角「小窗播放」：不跳页，直接把视频丢进悬浮小窗 */
function playMini(e) {
  e.stopPropagation()
  if (!props.item.bvid) return
  mini.play({
    bvid: props.item.bvid,
    fromCard: true,
    page: 1,
    title: props.item.title || '',
    upName: props.item.upName || '',
    cover: props.item.cover || '',
    duration: props.item.duration || 0
  })
}

function openUp(e) {
  e.stopPropagation()
  if (props.item.upMid) router.push({ name: 'up', params: { mid: String(props.item.upMid) } })
}
</script>

<template>
  <div class="vcard" @click="open">
    <div class="thumb">
      <BiliImage :src="item.cover" :alt="item.title" />
      <button class="mini" title="小窗播放（接着翻别的页面）" @click="playMini">
        <Icon name="pip" :size="14" />
      </button>
      <span v-if="durationText !== '0:00'" class="dur">{{ durationText }}</span>
      <div v-if="pct > 0" class="watch"><i :style="{ width: pct + '%' }" /></div>
    </div>
    <div class="meta">
      <div class="title clamp-2">{{ item.title }}</div>
      <div class="sub">
        <span v-if="showUp && item.upName" class="up" @click="openUp">{{ item.upName }}</span>
        <span v-if="item.reason" class="muted clamp-1">· {{ item.reason }}</span>
        <span v-else-if="item.play != null" class="muted">{{ fmtCount(item.play) }} 播放</span>
      </div>
    </div>
  </div>
</template>
