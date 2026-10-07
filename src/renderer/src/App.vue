<script setup>
import { ref, onMounted, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from './stores/auth'
import { useSettingsStore } from './stores/settings'
import { useLearnStore } from './stores/learn'
import { useUpsStore } from './stores/ups'
import { useUiStore } from './stores/ui'
import Icon from './components/Icon.vue'
import PageFloat from './components/PageFloat.vue'
import Toasts from './components/Toasts.vue'
import LoginModal from './components/LoginModal.vue'
import ConfirmModal from './components/ConfirmModal.vue'
import BiliImage from './components/BiliImage.vue'
import { fmtHours } from './utils/format'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const settings = useSettingsStore()
const learn = useLearnStore()
const ups = useUpsStore()
const ui = useUiStore()

const keyword = ref('')
const searchEl = ref(null)
const scrollEl = ref(null)

// 切换页面（路由变了）时回到顶部：否则从拉到一半的列表点进视频页，
// 播放器会被顶到屏幕外，看起来像「没有播放器」。
watch(
  () => route.fullPath,
  () => {
    const el = scrollEl.value || document.querySelector('.scroll')
    if (!el) return
    // .scroll 是 scroll-behavior:smooth，这里要「立刻」跳，不能带动画
    try {
      el.scrollTo({ top: 0, behavior: 'instant' })
    } catch (err) {
      el.scrollTop = 0
    }
  }
)

const DEFAULT_NAV = [
  { to: '/', icon: 'home', label: '首页' },
  { to: '/ups', icon: 'users', label: 'UP 管理' },
  { to: '/fav', icon: 'star', label: '收藏' },
  { to: '/learn', icon: 'book', label: '学习' },
  { to: '/cache', icon: 'download', label: '缓存' },
  { to: '/settings', icon: 'settings', label: '设置' }
]

/**
 * 侧栏顺序：settings.navOrder 里存的是路由路径数组（用户拖出来的顺序）。
 * 只认它里面「还存在的」路径，剩下的按默认顺序补在后面 —— 这样以后新增页面
 * 不会被老顺序弄丢，用户改了名字/删了页面也不会出现空条目。
 */
const navList = computed(() => {
  const saved = Array.isArray(settings.settings.navOrder) ? settings.settings.navOrder : []
  const picked = saved.map((to) => DEFAULT_NAV.find((n) => n.to === to)).filter(Boolean)
  const rest = DEFAULT_NAV.filter((n) => !picked.some((p) => p.to === n.to))
  return [...picked, ...rest]
})

/* ── 侧栏拖拽换序 ─────────────────────────────────────── */
const dragFrom = ref('')
const dragOver = ref('')

function onNavDragStart(n, e) {
  dragFrom.value = n.to
  dragOver.value = ''
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    // 内部拖拽带一个标识，别让浏览器把它当链接拖（否则 drop 里拿不到我们的数据）
    e.dataTransfer.setData('text/plain', n.to)
  }
}

function onNavDragOver(n, e) {
  if (!dragFrom.value || dragFrom.value === n.to) return
  e.preventDefault() // 不 preventDefault 就不会触发 drop
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dragOver.value = n.to
}

async function onNavDrop(n, e) {
  e.preventDefault()
  const from = dragFrom.value || (e.dataTransfer && e.dataTransfer.getData('text/plain')) || ''
  dragFrom.value = ''
  dragOver.value = ''
  if (!from || from === n.to) return
  const list = navList.value.map((x) => x.to)
  const i = list.indexOf(from)
  const j = list.indexOf(n.to)
  if (i < 0 || j < 0) return
  // 把拖起来的那项插到目标项的位置（其余顺延），比两两交换更符合直觉
  list.splice(j, 0, list.splice(i, 1)[0])
  try {
    await settings.patch({ navOrder: list })
  } catch (err) {
    console.warn('[nav] 侧栏顺序保存失败：', err && err.message)
  }
}

function onNavDragEnd() {
  dragFrom.value = ''
  dragOver.value = ''
}

const todayText = computed(() => fmtHours(learn.todaySeconds))
const activePath = computed(() => route.path)

function submitSearch() {
  const q = keyword.value.trim()
  if (!q) return
  router.push({ name: 'search', query: { q } })
}

function onLogout() {
  auth.logout()
  ui.toast('已退出登录')
}

onMounted(async () => {
  await settings.init()
  await auth.restore()
  try {
    await learn.init()
  } catch (err) {
    console.warn('[learn] 本地学习库初始化失败：', err && err.message)
  }
  try {
    await ups.init()
  } catch (err) {
    console.warn('[ups] 本机 UP 名单初始化失败：', err && err.message)
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      e.preventDefault()
      searchEl.value && searchEl.value.focus()
    }
  })
})
</script>

<template>
  <div class="app">
    <aside class="side">
      <div class="brand">
        <div class="brand-mark">学</div>
        <div class="brand-text">
          <b>BiliLite</b>
          <span>专注模式 · 黑白极简</span>
        </div>
      </div>

      <nav class="side-nav">
        <RouterLink
          v-for="n in navList"
          :key="n.to"
          :to="n.to"
          class="nav-item"
          :class="{
            'router-link-active': activePath === n.to,
            dragging: dragFrom === n.to,
            'drop-target': dragOver === n.to && dragFrom !== n.to
          }"
          draggable="true"
          :title="`${n.label}（按住拖动可调整顺序）`"
          @dragstart="onNavDragStart(n, $event)"
          @dragover="onNavDragOver(n, $event)"
          @drop="onNavDrop(n, $event)"
          @dragend="onNavDragEnd"
        >
          <Icon :name="n.icon" :size="17" />
          <span>{{ n.label }}</span>
          <span v-if="n.to === '/learn' && learn.todaySeconds > 0" class="badge">{{ todayText }}h</span>
        </RouterLink>
      </nav>

      <div class="side-foot">
        <template v-if="auth.loggedIn">
          <div class="side-user">
            <BiliImage :src="auth.avatar" :alt="auth.user.uname" />
            <div class="who">
              <b>{{ auth.user.uname }}</b>
              <span>Lv{{ auth.user.level || 0 }} · 已登录</span>
            </div>
          </div>
          <button class="btn sm ghost" @click="onLogout"><Icon name="logout" :size="14" /> 退出登录</button>
        </template>
        <template v-else>
          <div class="side-user">
            <div class="avatar-fallback" />
            <div class="who">
              <b>未登录</b>
              <span>部分功能受限</span>
            </div>
          </div>
          <button class="btn sm primary" @click="ui.loginOpen = true"><Icon name="user" :size="14" /> 扫码登录</button>
        </template>
      </div>
    </aside>

    <main class="main">
      <header class="top">
        <div class="top-search">
          <input
            ref="searchEl"
            v-model="keyword"
            class="input"
            type="search"
            placeholder="搜索视频 / 知识点，回车确认（按 / 快速聚焦）"
            @keyup.enter="submitSearch"
          />
          <button class="btn" @click="submitSearch"><Icon name="search" :size="16" /></button>
        </div>
        <span class="grow" />
        <span class="chip plain" title="今天累计学习时长">
          <Icon name="clock" :size="13" /> 今日 {{ todayText }}h
        </span>
        <button class="btn ghost sm" title="返回" @click="router.back()"><Icon name="left" :size="15" /></button>
      </header>

      <div ref="scrollEl" class="scroll">
        <RouterView v-slot="{ Component }">
          <component :is="Component" :key="`${route.fullPath}#${ui.refreshSeq}`" />
        </RouterView>
      </div>
    </main>

    <PageFloat />

    <Toasts />
    <LoginModal />
    <ConfirmModal />
  </div>
</template>
