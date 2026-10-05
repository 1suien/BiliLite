<script setup>
import { useUiStore } from '../stores/ui'

const ui = useUiStore()
</script>

<template>
  <div class="toasts">
    <TransitionGroup name="t">
      <div v-for="t in ui.toasts" :key="t.id" class="toast" :class="t.type">{{ t.message }}</div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.t-enter-active,
.t-leave-active {
  transition: opacity 0.18s, transform 0.18s;
}
.t-enter-from,
.t-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
