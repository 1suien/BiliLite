<script setup lang="ts">
/**
 * 分页器：1 … 4 5 6 … 20 的省略号样式
 * 还原自 Pager-SKEgCVkC.js
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    page?: number
    pages?: number
  }>(),
  { page: 1, pages: 1 },
)

const emit = defineEmits<{ (e: 'change', page: number): void }>()

const items = computed<(number | string)[]>(() => {
  const total = Math.max(1, props.pages)
  const cur = Math.min(Math.max(1, props.page), total)
  const nums = [...new Set([1, total, cur, cur - 1, cur + 1])]
    .filter((n) => n >= 1 && n <= total)
    .sort((a, b) => a - b)
  const out: (number | string)[] = []
  let prev = 0
  for (const n of nums) {
    if (prev && n - prev > 1) out.push('…')
    out.push(n)
    prev = n
  }
  return out
})

function go(target: number | string) {
  if (target === '…' || target === props.page) return
  emit('change', Math.min(Math.max(1, Number(target)), Math.max(1, props.pages)))
}
</script>

<template>
  <div v-if="pages > 1" class="pager">
    <button :disabled="page <= 1" @click="go(page - 1)">上一页</button>
    <button
      v-for="(n, i) in items"
      :key="i"
      :class="{ on: n === page }"
      @click="go(n)"
    >
      {{ n }}
    </button>
    <button :disabled="page >= pages" @click="go(page + 1)">下一页</button>
  </div>
</template>
