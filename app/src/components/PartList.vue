<script setup lang="ts">
/**
 * 分 P 列表（播放页右侧）
 * 还原自 VideoView-B4FS9Q24.js 里的 PartList 组件（scope: data-v-7dc2e51f）
 *
 * 交互：
 *  - 分 P 超过 12 个才出现筛选框（可输入编号或标题关键字，支持「P12」这种写法）
 *  - 按标题里的 `L001` / `L002` 这类前缀自动分组，其余归到「开篇」
 *  - 「跳到当前」把当前播放的分 P 滚到列表中间
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'

const props = withDefaults(
  defineProps<{
    parts?: any[]
    index?: number
    title?: string
  }>(),
  { parts: () => [], index: 0, title: '分P列表' },
)

const emit = defineEmits<{ (e: 'select', index: number): void }>()

/** 筛选关键字 */
const keyword = ref('')
/** 列表容器（滚动定位用） */
const box = ref<HTMLElement | null>(null)

/** 过滤后的分 P（保留原始下标，emit 用 index） */
const filtered = computed(() =>
  props.parts
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => {
      const kw = keyword.value.trim().toLowerCase()
      if (!kw) return true
      const title = String(p.title || p.part || '').toLowerCase()
      const page = String(p.page || '')
      // 「P12」写法去掉前缀只留数字
      return title.includes(kw) || page.includes(kw.replace(/^p\s*/i, ''))
    }),
)

/** 分 P 展示标题 */
const pageTitle = (p: any) => p.title || p.part || `P${p.page}`

/** 取分组键：L001 这类前缀单独成组，其它都算「开篇」 */
function groupKey(p: any) {
  const m = /^L(\d{3})/i.exec(String(pageTitle(p)).trim())
  return m ? `L${m[1]}` : '开篇'
}

/** 分组后的列表（相邻同组才合并，保持原顺序） */
const groups = computed(() => {
  const out: { key: string; rows: { p: any; i: number }[] }[] = []
  for (const row of filtered.value) {
    const key = groupKey(row.p)
    const last = out[out.length - 1]
    if (last && last.key === key) last.rows.push(row)
    else out.push({ key, rows: [row] })
  }
  return out
})

/** 把当前播放的分 P 滚到容器中间 */
async function scrollToCurrent() {
  await nextTick()
  const el = box.value
  const cur = el && el.querySelector<HTMLElement>('.page-pill.on')
  if (!el || !cur) return
  const offset = cur.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
  const max = Math.max(0, el.scrollHeight - el.clientHeight)
  el.scrollTop = Math.min(max, Math.max(0, offset - (el.clientHeight - cur.clientHeight) / 2))
}

// 首次挂载 + 切换分 P / 改筛选条件后都重新定位（flush: post 等 DOM 更新完）
onMounted(scrollToCurrent)
watch(() => props.index, scrollToCurrent, { flush: 'post' })
watch(keyword, scrollToCurrent, { flush: 'post' })
</script>

<template>
  <div class="pages">
    <div class="row pages-head">
      <Icon name="list" :size="15" />
      <b style="font-size: 13px">{{ title }}</b>
      <span class="grow" />
      <span class="muted" style="font-size: 11.5px">
        {{ ` 共 ${parts.length} P` }}
        <template v-if="keyword.trim()"> · 命中 {{ filtered.length }}</template>
        <template v-else> · 当前 P{{ index + 1 }}</template>
      </span>
      <button class="jump" type="button" title="滚动到当前播放的分P" @click="scrollToCurrent">
        跳到当前
      </button>
    </div>

    <!-- 分 P 多了才给筛选框 -->
    <input
      v-if="parts.length > 12"
      v-model="keyword"
      class="input pages-filter"
      placeholder="筛选分P：编号或标题关键字"
    />

    <div ref="box" class="pages-list">
      <template v-for="g in groups" :key="g.key">
        <div class="grp">
          <span class="gk">{{ g.key }}</span>
          <i class="ln" aria-hidden="true" />
          <span v-if="g.rows.length > 1" class="cnt">{{ g.rows.length }} 个分P</span>
        </div>
        <button
          v-for="r in g.rows"
          :key="r.p.cid || r.i"
          :class="['page-pill', { on: r.i === index }]"
          :title="pageTitle(r.p)"
          @click="emit('select', r.i)"
        >
          <span class="pn mono">P{{ r.p.page }}</span>
          <span class="pt">{{ pageTitle(r.p) }}</span>
          <span v-if="r.i === index" class="pdot" aria-hidden="true" />
        </button>
      </template>
      <div v-if="!filtered.length" class="muted" style="font-size: 12.5px; padding: 6px 2px">
        没有匹配的分P
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 来源: VideoView-D0GRAdLR.css  scope: data-v-7dc2e51f */
.pages-head {
  margin-bottom: 8px;
}
.jump {
  flex: none;
  margin-left: 8px;
  padding: 2px 8px;
  min-height: 22px;
  background: var(--bg-elev);
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--t2);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.jump:hover {
  border-color: var(--brand-line);
  color: var(--brand);
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
  max-height: clamp(373px, 56vh, 560px);
  overflow: auto;
  padding-right: 4px;
  scrollbar-gutter: stable;
}
.grp {
  display: flex;
  align-items: center;
  gap: 8px;
  position: sticky;
  top: 0;
  z-index: 1;
  margin: 6px 0 2px;
  padding: 4px 2px;
  background: var(--card);
  font-size: 11.5px;
}
.grp .gk {
  flex: none;
  color: var(--t2);
  font-weight: 600;
  letter-spacing: 0.3px;
}
.grp .ln {
  flex: 1;
  height: 1px;
  background: var(--line);
}
.grp .cnt {
  flex: none;
  color: var(--t3);
}
.page-pill {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 30px;
  padding: 6px 9px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--t1);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  transition:
    background 0.12s,
    border-color 0.12s;
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
  background: var(--brand);
}
.page-pill.on {
  background: var(--brand-soft);
  border-color: var(--brand-line);
  color: var(--t1);
  font-weight: 600;
  box-shadow: inset 2px 0 0 var(--brand);
}
.page-pill.on .pn {
  background: var(--brand-line);
  color: var(--t1);
}
.page-pill.on .pdot {
  background: var(--brand);
}
</style>
