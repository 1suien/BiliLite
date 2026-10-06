<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'

// 分P列表：长视频（课程/合集）动辄上百个 P，早先那种「按文字宽度排列的胶囊」一排下来
// 右边缘参差不齐、也找不到第几个 P 在哪。这里排成对齐的单列清单：
//   序号徽章（等宽） + 单行省略的标题 + 当前行高亮，超出高度时内部滚动并自动滚到当前 P。
// 超过 12 个 P 时给一个筛选框（按编号或标题关键字）。
const props = defineProps({
  parts: { type: Array, default: () => [] },
  index: { type: Number, default: 0 },
  title: { type: String, default: '分P列表' }
})
const emit = defineEmits(['select'])

const filter = ref('')
const box = ref(null)

const rows = computed(() =>
  props.parts
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => {
      const q = filter.value.trim().toLowerCase()
      if (!q) return true
      const name = String(p.title || p.part || '').toLowerCase()
      const page = String(p.page || '')
      return name.includes(q) || page.includes(q.replace(/^p\s*/i, ''))
    })
)
const nameOf = (p) => p.title || p.part || `P${p.page}`

async function scrollToCurrent() {
  await nextTick()
  const list = box.value
  const el = list && list.querySelector('.page-pill.on')
  if (!list || !el) return
  // 明确算 scrollTop：scrollIntoView 会连带滚动祖先，
  // 而且筛掉当前 P 再清空时它不一定把当前行带回视野（列表停在中间）
  const top = el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
  const max = Math.max(0, list.scrollHeight - list.clientHeight)
  list.scrollTop = Math.min(max, Math.max(0, top - (list.clientHeight - el.clientHeight) / 2))
}
onMounted(scrollToCurrent)
watch(() => props.index, scrollToCurrent, { flush: 'post' })
watch(filter, scrollToCurrent, { flush: 'post' })
</script>

<template>
  <div class="pages">
    <div class="row pages-head">
      <Icon name="list" :size="15" />
      <b style="font-size: 13px">{{ title }}</b>
      <span class="grow" />
      <span class="muted" style="font-size: 11.5px">
        共 {{ parts.length }} P<template v-if="filter.trim()"> · 命中 {{ rows.length }}</template>
        <template v-else> · 当前 P{{ index + 1 }}</template>
      </span>
    </div>

    <input
      v-if="parts.length > 12"
      v-model="filter"
      class="input pages-filter"
      placeholder="筛选分P：编号或标题关键字"
    />

    <div ref="box" class="pages-list">
      <button
        v-for="r in rows"
        :key="r.p.cid || r.i"
        class="page-pill"
        :class="{ on: r.i === index }"
        :title="nameOf(r.p)"
        @click="emit('select', r.i)"
      >
        <span class="pn mono">P{{ r.p.page }}</span>
        <span class="pt">{{ nameOf(r.p) }}</span>
        <span v-if="r.i === index" class="pdot" aria-hidden="true" />
      </button>
      <div v-if="!rows.length" class="muted" style="font-size: 12.5px; padding: 6px 2px">没有匹配的分P</div>
    </div>
  </div>
</template>

<style scoped>
.pages-head {
  margin-bottom: 8px;
}
.pages-filter {
  margin-bottom: 8px;
  font-size: 12.5px;
  padding: 5px 9px;
}
.pages-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: min(52vh, 460px);
  overflow: auto;
  padding-right: 4px;
}
.page-pill {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 6px 9px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--t1);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.page-pill:hover {
  background: var(--soft-hover);
}
.page-pill .pn {
  flex: none;
  width: 34px;
  text-align: center;
  font-size: 11px;
  color: var(--t3);
  background: var(--soft);
  border-radius: 5px;
  padding: 1.5px 0;
}
.page-pill .pt {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.page-pill .pdot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.page-pill.on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-fg);
  font-weight: 600;
}
.page-pill.on .pn {
  background: rgba(255, 255, 255, 0.16);
  color: var(--accent-fg);
}
.page-pill.on .pdot {
  background: var(--accent-fg);
}
</style>
