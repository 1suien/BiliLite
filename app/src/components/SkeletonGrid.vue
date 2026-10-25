<script setup lang="ts">
/**
 * 加载骨架屏：铺满一屏的假卡片（.vcard + .sk 类来自 global.css）
 * 还原自 SkeletonGrid-BPezhzYm.js 里的 SkeletonGrid
 */
withDefaults(
  defineProps<{
    /** 骨架卡片数量 */
    count?: number
  }>(),
  { count: 12 },
)
</script>

<template>
  <div class="grid">
    <div v-for="n in count" :key="n" class="vcard" style="cursor: default">
      <div class="thumb sk"></div>
      <div class="meta">
        <div class="sk" style="height: 13px; width: 92%"></div>
        <div class="sk" style="height: 13px; width: 62%"></div>
        <div class="sk" style="height: 10px; width: 40%; margin-top: 4px"></div>
      </div>
    </div>
  </div>
</template>
