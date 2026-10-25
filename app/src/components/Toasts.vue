<script setup lang="ts">
/**
 * 全局轻提示
 * 还原自 main-CoY7YGNA.js 里的 Toasts 组件（__name: "Toasts"）
 * 数据来自 ui.toasts，由 ui.toast() 写入、到时自动 dismiss；动画名固定为 "t"
 */
import { useUiStore } from '@/stores/ui'

const ui = useUiStore()
</script>

<template>
  <div class="toasts">
    <TransitionGroup name="t">
      <div v-for="t in ui.toasts" :key="t.id" :class="['toast', t.type]">
        {{ t.message }}
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.t-enter-active,
.t-leave-active {
  transition:
    opacity 0.18s,
    transform 0.18s;
}
.t-enter-from,
.t-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
