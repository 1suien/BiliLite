<script setup>
/**
 * 页面右侧悬浮操作组（对齐 B 站客户端 / 参考截图）：
 * - 「换一换」：把当前页面整个重新加载一遍（重新拉取数据）
 * - 「顶部」：页面往下拉过一段后出现，点一下平滑回到顶部
 * 位置固定在内容区右下角，不随页面滚动。
 */
import { ref, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { useUiStore } from '../stores/ui'

const ui = useUiStore()
const canTop = ref(false)
const spinning = ref(false)
let scroller = null

function findScroller() {
  return document.querySelector('.scroll')
}

function onScroll(e) {
  const el = scroller || (scroller = findScroller())
  const target = el || e.target
  if (!target || typeof target.scrollTop !== 'number') return
  const top = el ? el.scrollTop : (e.target && e.target.scrollTop) || 0
  canTop.value = top > 200
}

function toTop() {
  const el = scroller || (scroller = findScroller())
  if (!el) return
  el.scrollTo({ top: 0, behavior: 'smooth' })
}

function refresh() {
  spinning.value = true
  ui.refresh()
  setTimeout(() => {
    spinning.value = false
  }, 600)
}

onMounted(() => {
  scroller = findScroller()
  onScroll({})
  // capture 阶段监听，任何可滚动容器的滚动都能收到
  document.addEventListener('scroll', onScroll, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('scroll', onScroll, true)
})
</script>

<template>
  <div class="page-float">
    <button class="float-btn" title="换一换：重新加载当前页面" @click="refresh">
      <Icon name="refresh" :size="18" :class="{ spin: spinning }" />
    </button>
    <button
      v-show="canTop"
      class="float-btn"
      title="回到顶部"
      @click="toTop"
    >
      <Icon name="up" :size="18" />
      <span class="float-text">顶部</span>
    </button>
  </div>
</template>

<style scoped>
.page-float {
  position: fixed;
  right: 22px;
  bottom: 26px;
  z-index: 40;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.float-btn {
  width: 42px;
  height: 42px;
  border-radius: 13px;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--t2);
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, transform 0.15s;
}

.float-btn:hover {
  color: var(--accent-fg);
  border-color: var(--accent);
  background: var(--accent);
  transform: translateY(-1px);
}

.float-text {
  font-size: 10px;
  line-height: 1;
}

.spin {
  animation: float-spin 0.6s linear;
}

@keyframes float-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
