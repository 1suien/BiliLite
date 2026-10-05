<script setup>
import Icon from './Icon.vue'

defineProps({
  icon: { type: String, default: 'search' },
  title: { type: String, default: '这里还是空的' },
  desc: { type: String, default: '' }
})
</script>

<template>
  <div class="empty">
    <Icon :name="icon" :size="30" :stroke="1.4" />
    <b>{{ title }}</b>
    <span v-if="desc" style="max-width: 420px">{{ desc }}</span>
    <div v-if="$slots.default" class="row" style="margin-top: 4px">
      <slot />
    </div>
  </div>
</template>
