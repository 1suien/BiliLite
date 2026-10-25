<script setup>
import { computed } from 'vue'

const props = defineProps({
  page: { type: Number, default: 1 },
  pages: { type: Number, default: 1 }
})
const emit = defineEmits(['change'])

const nums = computed(() => {
  const total = Math.max(1, props.pages)
  const cur = Math.min(Math.max(1, props.page), total)
  const out = new Set([1, total, cur, cur - 1, cur + 1])
  const list = [...out].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b)
  const res = []
  let prev = 0
  for (const n of list) {
    if (prev && n - prev > 1) res.push('…')
    res.push(n)
    prev = n
  }
  return res
})

function go(n) {
  if (n === '…' || n === props.page) return
  emit('change', Math.min(Math.max(1, n), Math.max(1, props.pages)))
}
</script>

<template>
  <div v-if="pages > 1" class="pager">
    <button :disabled="page <= 1" @click="go(page - 1)">上一页</button>
    <button v-for="(n, i) in nums" :key="i" :class="{ on: n === page }" @click="go(n)">{{ n }}</button>
    <button :disabled="page >= pages" @click="go(page + 1)">下一页</button>
  </div>
</template>
