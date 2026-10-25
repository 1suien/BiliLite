<script setup lang="ts">
/**
 * 收藏到本机（弹窗）
 * 还原自 VideoView-B4FS9Q24.js 里的 CollectModal 组件（scope: data-v-832a0317）
 *
 * 只操作本机收藏（Dexie collect 表），不走 B 站接口。
 */
import { computed, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import { useCollectStore } from '@/stores/collect'
import { useUiStore } from '@/stores/ui'

const props = withDefaults(
  defineProps<{
    open?: boolean
    video?: any
  }>(),
  { open: false, video: () => ({}) },
)

const emit = defineEmits<{ (e: 'close'): void }>()

const collect = useCollectStore()
const ui = useUiStore()

/** 新建文件夹的输入 */
const name = ref('')
/** 正在写入（写的时候禁用列表点击） */
const saving = ref(false)

/** 当前视频已经收藏到哪些文件夹 */
const collected = computed(
  () => new Set(collect.items.filter((i) => i.bvid === props.video.bvid).map((i) => i.folder)),
)

// 每次打开都刷新一次收藏夹列表
watch(
  () => props.open,
  async (open) => {
    if (!open) return
    name.value = ''
    await collect.init()
  },
)

/** 收藏到指定文件夹 */
async function addTo(folder: string) {
  if (!props.video.bvid) return
  saving.value = true
  try {
    await collect.add(props.video, folder)
    ui.ok(`已收藏到「${folder}」`)
    emit('close')
  } catch (e: any) {
    ui.err(e.message || '收藏失败')
  } finally {
    saving.value = false
  }
}

/** 新建文件夹并立即收藏 */
async function createAndAdd() {
  const folder = name.value.trim()
  if (!folder) return
  try {
    await collect.createFolder(folder)
  } catch (e: any) {
    ui.err(e.message)
    return
  }
  name.value = ''
  await addTo(folder)
}

/** 把当前视频从本机收藏里全部移出 */
async function removeAll() {
  const n = await collect.removeByBvid(props.video.bvid)
  if (n) ui.ok(`已移出本机收藏（${n} 处）`)
  emit('close')
}
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div class="modal" style="width: 420px">
      <h3>收藏到本机</h3>
      <p class="muted clamp-1" style="margin: 0; font-size: 12.5px">
        {{ video.title || '当前视频' }}
      </p>

      <div class="flist">
        <div
          v-for="f in collect.folderList"
          :key="f.name"
          :class="['frow', { disabled: saving }]"
          @click="addTo(f.name)"
        >
          <Icon name="folder" :size="16" />
          <span class="grow clamp-1">{{ f.name }}</span>
          <span class="muted mono" style="font-size: 11.5px">{{ f.n }}</span>
          <span v-if="collected.has(f.name)" class="tag">已收藏</span>
        </div>
      </div>

      <div class="row">
        <input
          v-model="name"
          class="input"
          placeholder="新建文件夹并收藏"
          @keyup.enter="createAndAdd"
        />
        <button class="btn primary" @click="createAndAdd">
          <Icon name="plus" :size="15" />
        </button>
      </div>

      <div class="row" style="justify-content: space-between">
        <button
          v-if="collected.size"
          class="btn ghost sm"
          style="color: var(--danger)"
          @click="removeAll"
        >
          <Icon name="trash" :size="14" /> 移出本机收藏
        </button>
        <span class="grow" />
        <button class="btn" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 来源: VideoView-D0GRAdLR.css  scope: data-v-832a0317 */
.flist {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 280px;
  overflow: auto;
}
.frow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
}
.frow:hover {
  background: var(--card-hover);
  border-color: var(--line-strong);
}
.frow.disabled {
  opacity: 0.6;
  pointer-events: none;
}
.tag {
  font-size: 11px;
  color: var(--ok);
}
</style>
