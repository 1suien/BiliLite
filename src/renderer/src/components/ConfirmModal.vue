<script setup>
import { onMounted, onBeforeUnmount } from 'vue'
import { useUiStore } from '../stores/ui'

const ui = useUiStore()

function onKey(e) {
  if (!ui.confirmState.open) return
  if (e.key === 'Escape') ui.answerConfirm(false)
  if (e.key === 'Enter') ui.answerConfirm(true)
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div v-if="ui.confirmState.open" class="overlay" @click.self="ui.answerConfirm(false)">
    <div class="modal" style="max-width: 380px">
      <h3 style="font-size: 15px; margin-bottom: 8px">{{ ui.confirmState.title }}</h3>
      <p v-if="ui.confirmState.sub" class="muted" style="font-size: 12.5px; margin-bottom: 16px">
        {{ ui.confirmState.sub }}
      </p>
      <div class="row" style="justify-content: flex-end; gap: 8px">
        <button class="btn ghost" @click="ui.answerConfirm(false)">取消</button>
        <button class="btn danger" @click="ui.answerConfirm(true)">{{ ui.confirmState.okText }}</button>
      </div>
    </div>
  </div>
</template>
