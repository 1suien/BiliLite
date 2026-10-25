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
let pollId = 0

function findScroller() {
  return document.querySelector('.scroll')
}

/**
 * 实时定位滚动容器。
 *
 * 关键：滚动位置不能靠「挂载时缓存下来的节点」——换页/重挂载后 `.scroll` 可能已被替换，
 * 旧节点的 scrollTop 永远是 0，于是「顶部」按钮再也不出现（真实踩到的 bug：
 * 页面已经滚到 1637px，按钮的 display 仍是 none）。
 */
function currentScroller() {
  const el = findScroller()
  if (el && el !== scroller) {
    if (scroller) scroller.removeEventListener('scroll', onScroll)
    scroller = el
    scroller.addEventListener('scroll', onScroll, { passive: true })
  }
  return scroller
}

function syncTop() {
  if (!scroller || !scroller.isConnected) currentScroller()
  const top = scroller ? scroller.scrollTop : 0
  canTop.value = top > 200
}

function onScroll() {
  syncTop()
}

function toTop() {
  const el = scroller && scroller.isConnected ? scroller : currentScroller()
  if (!el) return
  const from = el.scrollTop
  el.scrollTo({ top: 0, behavior: 'smooth' })
  // 兜底：窗口被遮挡 / 合成器不产帧时，`behavior:'smooth'` 可能一点都不推进
  // （实测打包版出现过点了「顶部」3 秒后 scrollTop 还停在 1637px）。400ms 后如果位置没动就直接跳回顶部 ——
  // 注意必须用 `behavior:'instant'` 覆盖 `.scroll` 上的 `scroll-behavior: smooth`，
  // 否则直接赋 `scrollTop = 0` 又会变成一次「动画」，在这个环境下照样不动。
  setTimeout(() => {
    if (el.isConnected && el.scrollTop >= from && el.scrollTop > 0) {
      el.scrollTo({ top: 0, behavior: 'instant' })
    }
  }, 400)
}

function refresh() {
  spinning.value = true
  ui.refresh()
  setTimeout(() => {
    spinning.value = false
  }, 600)
}

onMounted(() => {
  currentScroller()
  syncTop()
  // 容器自带监听之外，再在 capture 阶段监听一次，覆盖别的可滚动容器（如列表内滚动）
  document.addEventListener('scroll', onScroll, true)
  // 兜底轮询：某些情况（窗口不可见/合成器不动画）滚动事件可能整批不到，读一次 scrollTop 开销极低，
  // 这里保证按钮状态一定跟得上滚动位置。
  pollId = setInterval(syncTop, 400)
})

onBeforeUnmount(() => {
  clearInterval(pollId)
  document.removeEventListener('scroll', onScroll, true)
  if (scroller) scroller.removeEventListener('scroll', onScroll)
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
