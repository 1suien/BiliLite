<script setup lang="ts">
import { computed } from 'vue'
import type { Annotation } from '@/db'

const props = defineProps<{
  annotations: Annotation[]
  /** 当前所在章，用于高亮 */
  currentChapter?: number
}>()
const emit = defineEmits<{
  (e: 'select', a: Annotation): void
  (e: 'edit', a: Annotation): void
  (e: 'remove', a: Annotation): void
  (e: 'close'): void
}>()

interface Group {
  chapter: number
  title: string
  items: Annotation[]
}

const groups = computed<Group[]>(() => {
  const map = new Map<number, Group>()
  for (const a of props.annotations) {
    let g = map.get(a.chapter)
    if (!g) {
      g = { chapter: a.chapter, title: a.chapterTitle || `第 ${a.chapter + 1} 章`, items: [] }
      map.set(a.chapter, g)
    }
    g.items.push(a)
  }
  const list = Array.from(map.values()).sort((x, y) => x.chapter - y.chapter)
  for (const g of list) g.items.sort((x, y) => x.createdAt - y.createdAt)
  return list
})

const total = computed(() => props.annotations.length)
const notes = computed(() => props.annotations.filter((a) => a.note).length)

function fmtDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
</script>

<template>
  <Transition name="fade" appear>
    <div class="scrim" @click="emit('close')" />
  </Transition>
  <Transition name="sheet" appear>
    <div class="sheet notes-sheet" @click.stop>
      <h3>
        划线与笔记
        <span class="count">{{ total }} 条 · {{ notes }} 条想法</span>
      </h3>

      <div class="list">
        <template v-for="g in groups" :key="g.chapter">
          <div class="group-title" :class="{ cur: g.chapter === currentChapter }">
            {{ g.title }}
            <span>{{ g.items.length }}</span>
          </div>
          <div v-for="a in g.items" :key="a.id" class="item" @click="emit('select', a)">
            <div class="bar" :class="'b-' + a.color" />
            <div class="body">
              <p class="quote">{{ a.quote }}</p>
              <p v-if="a.note" class="note">{{ a.note }}</p>
              <div class="meta">
                <span>{{ fmtDate(a.createdAt) }}</span>
                <span class="spacer" />
                <button class="mini" title="编辑" @click.stop="emit('edit', a)">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z" />
                  </svg>
                </button>
                <button class="mini danger" title="删除" @click.stop="emit('remove', a)">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </template>
        <p v-if="!total" class="empty">还没有划线和笔记。<br />在书里长按选中一句话，就能划线或写想法。</p>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.notes-sheet {
  color: var(--ink);
  height: 62vh;
}
.count {
  font-size: 12px;
  font-weight: 400;
  color: var(--muted);
  margin-left: 6px;
}
.list {
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: 12px;
}
.group-title {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--surface);
  padding: 10px 2px 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  letter-spacing: 0.06em;
  display: flex;
  align-items: center;
  gap: 8px;
}
.group-title.cur {
  color: var(--accent);
}
.group-title span {
  font-size: 11px;
  font-weight: 400;
  opacity: 0.7;
}
.item {
  display: flex;
  gap: 10px;
  padding: 10px 8px 10px 0;
  border-radius: 12px;
  cursor: pointer;
}
.item:active {
  background: var(--surface-2);
}
.bar {
  width: 3px;
  border-radius: 3px;
  flex: 0 0 auto;
  margin: 3px 0;
}
.b-yellow {
  background: #e9c46a;
}
.b-green {
  background: #8fbf8a;
}
.b-blue {
  background: #7fa8d9;
}
.b-pink {
  background: #e3a0a8;
}
.body {
  min-width: 0;
  flex: 1;
}
.quote {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 14.5px;
  line-height: 1.6;
  color: var(--ink);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.note {
  margin: 5px 0 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--ink-2);
  background: var(--surface-2);
  border-radius: 8px;
  padding: 6px 9px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.meta {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--muted);
}
.spacer {
  flex: 1;
}
.mini {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: var(--muted);
}
.mini:active {
  background: var(--line);
}
.mini.danger:active {
  color: var(--danger);
}
.empty {
  margin: 40px 0;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.9;
}
</style>
