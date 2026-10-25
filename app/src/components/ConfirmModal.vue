<script setup lang="ts">
/**
 * 全局确认弹窗
 * 还原自 main-CoY7YGNA.js 里的 ConfirmModal 组件（__name: "ConfirmModal"）
 * 用法：await ui.confirm(title, sub, okText) -> boolean
 * 交互：点遮罩取消 / 取消按钮 / Esc 取消 / 确定按钮 / Enter 确认
 */
import { onMounted, onUnmounted } from 'vue'
import { useUiStore } from '@/stores/ui'

const ui = useUiStore()

function onKeydown(e: KeyboardEvent) {
  if (!ui.confirmState.open) return
  if (e.key === 'Escape') ui.answerConfirm(false)
  if (e.key === 'Enter') ui.answerConfirm(true)
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
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
        <button class="btn danger" @click="ui.answerConfirm(true)">
          {{ ui.confirmState.okText }}
        </button>
      </div>
    </div>
  </div>
</template>
