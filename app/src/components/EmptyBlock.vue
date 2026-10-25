<script setup lang="ts">
/**
 * 空状态占位（列表为空 / 加载失败时用）
 * 还原自 EmptyBlock-B2CVG3dR.js
 */
import Icon from './Icon.vue'

withDefaults(
  defineProps<{
    icon?: string
    title?: string
    desc?: string
  }>(),
  { icon: 'search', title: '这里还是空的', desc: '' },
)
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
