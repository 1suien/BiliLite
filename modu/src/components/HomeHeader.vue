<script setup lang="ts">
/**
 * 首页顶栏：居中「书架 / 智能助理」切换 + 右侧图标行。
 * 宽屏显示全部图标，窄屏只留搜索 / 导入 / 更多（统计与设置收进更多与左侧抽屉）。
 */
import { useRouter } from 'vue-router'
import { computed } from 'vue'

const props = defineProps<{ tab: 'shelf' | 'agent'; searching?: boolean }>()
const emit = defineEmits<{
  (e: 'search'): void
  (e: 'import'): void
  (e: 'newchat'): void
  (e: 'stats'): void
  (e: 'settings'): void
  (e: 'filter'): void
  (e: 'more'): void
}>()

const router = useRouter()
const isShelf = computed(() => props.tab === 'shelf')

function go(tab: 'shelf' | 'agent') {
  if (props.tab === tab) return
  router.push(tab === 'shelf' ? { name: 'shelf' } : { name: 'agent' })
}
</script>

<template>
  <header class="hh">
    <button class="hh-icon hh-menu" aria-label="书目筛选" @click="emit('filter')">
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
        <rect x="3.5" y="4.5" width="17" height="15" rx="3.5" />
        <path d="M9 4.5v15" />
      </svg>
    </button>

    <nav class="hh-tabs" aria-label="主导航">
      <button class="hh-tab" :class="{ on: isShelf }" @click="go('shelf')">书架</button>
      <span class="hh-sep">/</span>
      <button class="hh-tab" :class="{ on: !isShelf }" @click="go('agent')">智能助理</button>
    </nav>

    <div class="hh-actions">
      <template v-if="isShelf">
        <button class="hh-icon" :class="{ on: searching }" aria-label="搜索" @click="emit('search')">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4.2-4.2" />
          </svg>
        </button>
        <button class="hh-icon" aria-label="导入书籍" @click="emit('import')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        <button class="hh-icon only-wide" aria-label="筛选与排序" @click="emit('filter')">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
            <circle cx="16" cy="7" r="2.1" />
            <circle cx="10" cy="17" r="2.1" />
          </svg>
        </button>
        <button class="hh-icon only-wide" aria-label="阅读统计" @click="emit('stats')">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 19h16" />
            <path d="M7 16v-4M12 16V7M17 16v-6" />
          </svg>
        </button>
        <button class="hh-icon only-wide" aria-label="设置" @click="emit('settings')">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3.1" />
            <path d="M12 3.5v2.2M12 18.3v2.2M4.8 7.8l1.9 1.1M17.3 15.1l1.9 1.1M4.8 16.2l1.9-1.1M17.3 8.9l1.9-1.1" />
          </svg>
        </button>
      </template>
      <template v-else>
        <button class="hh-icon" aria-label="新对话" @click="emit('newchat')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        <button class="hh-icon only-wide" aria-label="设置" @click="emit('settings')">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3.1" />
            <path d="M12 3.5v2.2M12 18.3v2.2M4.8 7.8l1.9 1.1M17.3 15.1l1.9 1.1M4.8 16.2l1.9-1.1M17.3 8.9l1.9-1.1" />
          </svg>
        </button>
      </template>
      <button class="hh-icon" aria-label="更多" @click="emit('more')">
        <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5.5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="18.5" cy="12" r="1.6" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.hh {
  position: relative;
  z-index: 8;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 54px;
  padding: calc(2px + var(--safe-top)) 10px 0;
  background: color-mix(in srgb, var(--shelf-bg) 88%, transparent);
  -webkit-backdrop-filter: blur(16px);
  backdrop-filter: blur(16px);
}
.hh-icon {
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  color: var(--ink-2);
  transition: background 0.15s ease, color 0.15s ease;
}
.hh-icon:hover {
  background: color-mix(in srgb, var(--ink) 6%, transparent);
}
.hh-icon:active,
.hh-icon.on {
  background: color-mix(in srgb, var(--ink) 9%, transparent);
  color: var(--ink);
}
.hh-tabs {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding-bottom: 1px;
}
.hh-tab {
  font-family: var(--font-ui);
  font-size: 16px;
  font-weight: 400;
  letter-spacing: 0.02em;
  color: color-mix(in srgb, var(--ink) 36%, transparent);
  padding: 6px 2px;
  transition: color 0.16s ease;
}
.hh-tab.on {
  color: var(--ink);
  font-weight: 500;
}
.hh-sep {
  font-family: var(--font-ui);
  font-size: 14px;
  color: color-mix(in srgb, var(--ink) 22%, transparent);
  transform: translateY(-0.5px);
}
.hh-actions {
  display: flex;
  align-items: center;
  gap: 1px;
}
.only-wide {
  display: none;
}
@media (min-width: 620px) {
  .hh {
    height: 58px;
    padding-left: 16px;
    padding-right: 16px;
  }
  .only-wide {
    display: inline-flex;
  }
  .hh-tab {
    font-size: 17px;
  }
}
</style>
