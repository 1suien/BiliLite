<script setup lang="ts">
/**
 * 右下角浮动按钮：换一换（全局刷新）+ 回到顶部
 * 还原自 main-CoY7YGNA.js 里的 PageFloat 组件（__name: "PageFloat"）
 *
 * 滚动容器是 .scroll（全局样式里定义），组件内部自己找它并监听 scroll；
 * 因为 .scroll 会被路由切换替换，另外用 400ms 轮询兜底（原实现即如此）。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import Icon from '@/components/Icon.vue'
import { useUiStore } from '@/stores/ui'

const ui = useUiStore()

/** 是否显示「回到顶部」（scrollTop > 200） */
const showTop = ref(false)
/** 刷新图标转一圈的动画标记 */
const spinning = ref(false)

let scrollEl: HTMLElement | null = null
let timer = 0

function findScroll() {
  return document.querySelector('.scroll') as HTMLElement | null
}

/** 绑定当前 .scroll 的 scroll 监听（容器变了就换绑） */
function bindScroll() {
  const el = findScroll()
  if (el && el !== scrollEl) {
    if (scrollEl) scrollEl.removeEventListener('scroll', onScroll)
    scrollEl = el
    scrollEl.addEventListener('scroll', onScroll, { passive: true })
  }
  return scrollEl
}

function update() {
  if (!scrollEl || !scrollEl.isConnected) bindScroll()
  const top = scrollEl ? scrollEl.scrollTop : 0
  showTop.value = top > 200
}

function onScroll() {
  update()
}

function toTop() {
  const el = scrollEl && scrollEl.isConnected ? scrollEl : bindScroll()
  if (!el) return
  const before = el.scrollTop
  el.scrollTo({ top: 0, behavior: 'smooth' })
  // 兼容：某些 WebView 里 smooth 无效，400ms 后仍未动就直接跳
  setTimeout(() => {
    if (el.isConnected && el.scrollTop >= before && el.scrollTop > 0) {
      el.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
    }
  }, 400)
}

/** 换一换：全局刷新信号 + 图标转一圈 */
function refresh() {
  spinning.value = true
  ui.refresh()
  setTimeout(() => {
    spinning.value = false
  }, 600)
}

onMounted(() => {
  bindScroll()
  update()
  // 捕获阶段监听：子容器滚动也能收到
  document.addEventListener('scroll', onScroll, true)
  timer = window.setInterval(update, 400)
})

onUnmounted(() => {
  clearInterval(timer)
  document.removeEventListener('scroll', onScroll, true)
  if (scrollEl) scrollEl.removeEventListener('scroll', onScroll)
})
</script>

<template>
  <div class="page-float">
    <button class="float-btn" title="换一换：重新加载当前页面" @click="refresh">
      <Icon name="refresh" :size="18" :class="{ spin: spinning }" />
    </button>
    <button v-show="showTop" class="float-btn" title="回到顶部" @click="toTop">
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
  transition:
    color 0.15s,
    border-color 0.15s,
    transform 0.15s;
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
  0% {
    transform: rotate(0);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
