<script setup lang="ts">
export interface TocItem {
  title: string
  level: number
  /** 阅读器内部章节下标（TXT=章节序号，EPUB=spine 下标） */
  index: number
}

const props = defineProps<{
  items: TocItem[]
  current: number
}>()
const emit = defineEmits<{
  (e: 'select', index: number): void
  (e: 'close'): void
}>()
</script>

<template>
  <Transition name="fade" appear>
    <div class="scrim" @click="emit('close')" />
  </Transition>
  <Transition name="sheet" appear>
    <div class="sheet toc-sheet" @click.stop>
      <h3>目录 <span class="count">{{ items.length }} 章</span></h3>
      <div class="toc-list">
        <button
          v-for="it in items"
          :key="it.index"
          class="toc-item"
          :class="{ on: it.index === current }"
          :style="{ paddingLeft: 14 + Math.min(it.level, 4) * 16 + 'px' }"
          @click="emit('select', it.index)"
        >
          <span class="t">{{ it.title }}</span>
          <svg v-if="it.index === current" class="mark" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12.5 10 17.5 19 6.5" />
          </svg>
        </button>
        <p v-if="!items.length" class="empty">这本书没有目录信息</p>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.toc-sheet {
  color: var(--ink);
}
.count {
  font-size: 12px;
  font-weight: 400;
  color: var(--muted);
  margin-left: 6px;
}
.toc-list {
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: 8px;
}
.toc-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 12px 14px;
  border-radius: 12px;
  font-size: 15px;
  color: var(--ink-2);
  line-height: 1.4;
}
.toc-item.on {
  background: var(--accent-soft);
  color: var(--ink);
  font-weight: 600;
}
.toc-item .t {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mark {
  flex: 0 0 auto;
  color: var(--accent);
}
.empty {
  text-align: center;
  color: var(--muted);
  font-size: 13px;
  padding: 24px 0;
}
</style>
