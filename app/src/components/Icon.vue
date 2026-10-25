<script setup lang="ts">
/**
 * 图标组件：内置 52 个描边图标（见 icons.ts），无第三方图标库
 * 还原自 Icon-BMG-uEuU.js 里的 Icon 组件
 */
import { computed } from 'vue'
import { ICONS } from './icons'

const props = withDefaults(
  defineProps<{
    name: string
    size?: number | string
    stroke?: number | string
  }>(),
  { size: 18, stroke: 1.7 },
)

const html = computed(() => ICONS[props.name] || '')
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="stroke"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="html"
  />
</template>

<style scoped>
.icon {
  flex: none;
  display: inline-block;
  vertical-align: -0.145em;
}
</style>
