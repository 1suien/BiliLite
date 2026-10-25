<script setup>
import { ref } from 'vue'

const props = defineProps({
  src: { type: String, default: '' },
  alt: { type: String, default: '' }
})

const broken = ref(false)
</script>

<template>
  <img
    v-if="src && !broken"
    :src="src"
    :alt="alt"
    referrerpolicy="no-referrer"
    loading="lazy"
    decoding="async"
    @error="broken = true"
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
