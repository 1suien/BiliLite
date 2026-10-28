<script setup lang="ts">
/**
 * 右下角提醒卡片（本机定制 0.4.12）
 *
 * 习惯 / 专注目标 / 课表的到点提醒都显示在这里：常驻、不自动消失，
 * 点「去打卡 / 去专注 / 去学习」跳到对应页面，点右上角 × 关掉这一张。
 */
import { computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/Icon.vue'
import { useRemindStore } from '@/stores/remind'

const router = useRouter()
const remind = useRemindStore()
const cards = computed(() => remind.cards)

const KIND_LABEL: Record<string, string> = {
  habit: '习惯打卡',
  focus: '专注提醒',
  course: '课表提醒',
}

function close(key: string) {
  remind.dismiss(key)
}

function act(key: string, to: any) {
  remind.dismiss(key)
  if (to) router.push(to)
}

// 自动化探针（和 __habitProbe 一样只在测试里用）：手动触发一轮扫描 / 读当前卡片
onMounted(() => {
  ;(window as any).__remindProbe = () => ({
    cards: remind.cards.map((c) => ({ key: c.key, kind: c.kind, title: c.title })),
    lastCheck: remind.lastCheck,
  })
  ;(window as any).__remindCheck = (now?: string, day?: string) => remind.check(now, day)
})
onUnmounted(() => {
  try {
    ;(window as any).__remindProbe = null
    ;(window as any).__remindCheck = null
  } catch {}
})
</script>

<template>
  <div v-if="cards.length" class="reminder-dock" role="region" aria-label="到点提醒">
    <div v-for="card in cards" :key="card.key" class="reminder-card" :class="'kind-' + card.kind" :data-remind-key="card.key">
      <div class="rc-head">
        <span class="rc-kind">{{ KIND_LABEL[card.kind] || '提醒' }}</span>
        <button class="rc-close" type="button" title="关闭这条提醒" aria-label="关闭" @click="close(card.key)">
          <Icon name="x" :size="12" />
        </button>
      </div>
      <div class="rc-title">{{ card.title }}</div>
      <div class="rc-body">{{ card.body }}</div>
      <div class="rc-actions">
        <button
          v-for="a in card.actions"
          :key="a.label"
          class="btn sm primary"
          type="button"
          @click="act(card.key, a.to)"
        >
          {{ a.label }}
        </button>
        <button class="btn sm ghost" type="button" @click="close(card.key)">知道了</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.reminder-dock {
  position: fixed;
  right: 16px;
  /* 让开右下角的刷新/回顶部浮动按钮 */
  bottom: calc(96px + env(safe-area-inset-bottom));
  z-index: 75;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(300px, calc(100vw - 32px));
  pointer-events: none;
}
.reminder-card {
  pointer-events: auto;
  background: var(--card);
  border: 1px solid var(--line);
  border-left: 3px solid var(--brand);
  border-radius: 12px;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
  padding: 10px 12px 12px;
  animation: rc-in 0.18s ease-out;
}
.reminder-card.kind-focus {
  border-left-color: var(--magenta, var(--brand));
}
.reminder-card.kind-course {
  border-left-color: var(--blue, var(--brand));
}
@keyframes rc-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.rc-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rc-kind {
  font-size: 11px;
  color: var(--brand);
  letter-spacing: 0.04em;
}
.kind-focus .rc-kind {
  color: var(--magenta, var(--brand));
}
.kind-course .rc-kind {
  color: var(--blue, var(--brand));
}
.rc-close {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
}
.rc-close:hover {
  opacity: 1;
  background: var(--hover, rgba(128, 128, 128, 0.16));
}
.rc-title {
  margin-top: 4px;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.35;
}
.rc-body {
  margin-top: 3px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
  word-break: break-word;
}
.rc-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
</style>
