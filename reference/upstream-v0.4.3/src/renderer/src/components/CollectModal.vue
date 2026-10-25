<script setup>
import { ref, computed, watch } from 'vue'
import { useCollectStore } from '../stores/collect'
import { useUiStore } from '../stores/ui'
import Icon from './Icon.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  /** {bvid,title,cover,upName,upMid,duration,page} */
  video: { type: Object, default: () => ({}) }
})
const emit = defineEmits(['close'])

const collect = useCollectStore()
const ui = useUiStore()

const newFolder = ref('')
const busy = ref(false)

const collectedIn = computed(() => new Set(collect.items.filter((x) => x.bvid === props.video.bvid).map((x) => x.folder)))

watch(
  () => props.open,
  async (v) => {
    if (!v) return
    newFolder.value = ''
    await collect.init()
  }
)

async function pick(name) {
  if (!props.video.bvid) return
  busy.value = true
  try {
    await collect.add(props.video, name)
    ui.ok(`已收藏到「${name}」`)
    emit('close')
  } catch (err) {
    ui.err(err.message || '收藏失败')
  } finally {
    busy.value = false
  }
}

async function createAndPick() {
  const name = newFolder.value.trim()
  if (!name) return
  try {
    await collect.createFolder(name)
  } catch (err) {
    ui.err(err.message)
    return
  }
  newFolder.value = ''
  await pick(name)
}

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
      <p class="muted clamp-1" style="margin: 0; font-size: 12.5px">{{ video.title || '当前视频' }}</p>

      <div class="flist">
        <div
          v-for="f in collect.folderList"
          :key="f.name"
          class="frow"
          :class="{ disabled: busy }"
          @click="pick(f.name)"
        >
          <Icon name="folder" :size="16" />
          <span class="grow clamp-1">{{ f.name }}</span>
          <span class="muted mono" style="font-size: 11.5px">{{ f.n }}</span>
          <span v-if="collectedIn.has(f.name)" class="tag">已收藏</span>
        </div>
      </div>

      <div class="row">
        <input v-model="newFolder" class="input" placeholder="新建文件夹并收藏" @keyup.enter="createAndPick" />
        <button class="btn primary" @click="createAndPick"><Icon name="plus" :size="15" /></button>
      </div>

      <div class="row" style="justify-content: space-between">
        <button v-if="collectedIn.size" class="btn ghost sm" style="color: var(--danger)" @click="removeAll">
          <Icon name="trash" :size="14" /> 移出本机收藏
        </button>
        <span class="grow" />
        <button class="btn" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
