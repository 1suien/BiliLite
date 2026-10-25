<script setup lang="ts">
/**
 * 封面图：懒加载 + 失败占位（B 站图床用 no-referrer 才给图）
 * 还原自 BiliImage-7QEKisXq.js
 */
import { ref } from 'vue'

withDefaults(
  defineProps<{
    src?: string
    alt?: string
  }>(),
  { src: '', alt: '' },
)

const failed = ref(false)
</script>

<template>
  <img
    v-if="src && !failed"
    :src="src"
    :alt="alt"
    referrerpolicy="no-referrer"
    loading="lazy"
    decoding="async"
    @error="failed = true"
  />
  <div v-else class="ph" :title="alt">
    <span>{{ alt ? alt.slice(0, 1) : '·' }}</span>
  </div>
</template>

<style scoped>
img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.ph {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  background: var(--soft);
  color: var(--t3);
  font-size: 18px;
  font-weight: 600;
}
</style>
