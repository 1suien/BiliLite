<script setup>
import { ref, onMounted, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from './stores/auth'
import { useSettingsStore } from './stores/settings'
import { useLearnStore } from './stores/learn'
import { useHabitsStore } from './stores/habits'
import { useUpsStore } from './stores/ups'
import { useUiStore } from './stores/ui'
import Icon from './components/Icon.vue'
import PageFloat from './components/PageFloat.vue'
import Toasts from './components/Toasts.vue'
import LoginModal from './components/LoginModal.vue'
import ConfirmModal from './components/ConfirmModal.vue'
import MiniPlayer from './components/MiniPlayer.vue'
import BiliImage from './components/BiliImage.vue'
import { fmtHours } from './utils/format'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const settings = useSettingsStore()
const learn = useLearnStore()
const habits = useHabitsStore()
const ups = useUpsStore()
const ui = useUiStore()

const keyword = ref('')
const searchEl = ref(null)
const scrollEl = ref(null)
/** 剧场模式：收起侧栏与顶栏，把播放器放到最大（快捷键 F 切换、Esc 退出） */
const theater = ref(false)
function toggleTheater() {
  theater.value = !theater.value
}

// 切换页面（路由变了）时回到顶部：否则从拉到一半的列表点进视频页，
// 播放器会被顶到屏幕外，看起来像「没有播放器」。
watch(
  () => route.fullPath,
  () => {
    theater.value = false
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

/**
 * 侧栏分两组显示：
 *   - 主导航（首页 / 学习 / 本地 / 习惯）钉在顶部，是每天都要点的主链路
 *   - 次级入口（收藏 / UP 管理 / 设置）沉到侧栏底部、账号块上方，不再和主链路抢注意力
 * 两组仍然共用同一份 navList（7 项），所以拖拽换序的语义完全没变。
 */
const NAV_SECONDARY = ['/fav', '/ups', '/settings']

/**
 * 侧栏默认项。
 *
 * 安卓端**保留**「本地」：`src/mobile/local-files.js` 用系统文件选择器（SAF）+
 * `blob:` URL 实现了等价能力（没有自定义协议，也没有绝对路径），条目形状与
 * 桌面端一致，所以 LocalView 那一整套列表/进度/封面逻辑原样可用。
 */
const DEFAULT_NAV = [
  { to: '/', icon: 'home', label: '首页' },
  { to: '/ups', icon: 'users', label: 'UP 管理' },
  { to: '/fav', icon: 'star', label: '收藏' },
  { to: '/learn', icon: 'book', label: '学习' },
  { to: '/habit', icon: 'check', label: '习惯' },
  { to: '/local', icon: 'film', label: '本地' },
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

/*
 * DOM 顺序必须等于「navMain 全部 → navMore 全部」，因为 onNavDrop 落盘的
 * navOrder 就是这个顺序（拖拽换序的冒烟断言拿 DOM 顺序和 navOrder 逐项比对）。
 */
const navMain = computed(() => navList.value.filter((n) => !NAV_SECONDARY.includes(n.to)))
const navMore = computed(() => navList.value.filter((n) => NAV_SECONDARY.includes(n.to)))

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
  // 两组分开排：跨组拖没有意义（DOM 里两组本来就被 .side-foot 隔开），直接不响应
  if (NAV_SECONDARY.includes(dragFrom.value) !== NAV_SECONDARY.includes(n.to)) return
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
  // 同上：跨组不放行，避免「拖了但什么都没变」的错觉
  if (NAV_SECONDARY.includes(from) !== NAV_SECONDARY.includes(n.to)) return
  const list = navList.value.map((x) => x.to)
  const i = list.indexOf(from)
  const j = list.indexOf(n.to)
  if (i < 0 || j < 0) return
  // 把拖起来的那项插到目标项的位置（其余顺延），比两两交换更符合直觉
  list.splice(j, 0, list.splice(i, 1)[0])
  try {
    // 落盘的顺序 = 界面上看到的顺序（主导航在上、次级入口在下）。
    // 直接写 list 的话读回来两组会交错，DOM 顺序和 navOrder 就对不上了。
    const ordered = [
      ...list.filter((to) => !NAV_SECONDARY.includes(to)),
      ...list.filter((to) => NAV_SECONDARY.includes(to))
    ]
    await settings.patch({ navOrder: ordered })
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
  // 习惯打卡：把习惯读进内存，并开始「到点提醒」巡检（30 秒一次，主窗口 backgroundThrottling:false）
  try {
    await habits.init()
    habits.startReminders()
  } catch (err) {
    console.warn('[habit] 习惯数据初始化失败：', err && err.message)
  }
  window.addEventListener('keydown', (e) => {
    const el = document.activeElement
    const typing = !!el && (/^(INPUT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable)
    if (e.key === '/' && !typing) {
      e.preventDefault()
      searchEl.value && searchEl.value.focus()
      return
    }
    // 输入框里打字时不要抢快捷键
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault()
      toggleTheater()
    } else if (e.key === 'Escape' && theater.value) {
      theater.value = false
    }
  })
})
</script>

<template>
  <div class="app" :class="{ theater }">
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
          v-for="n in navMain"
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
        <nav class="side-nav side-more" aria-label="更多">
          <RouterLink
            v-for="n in navMore"
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

        <div class="side-account">
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
        <button
          class="btn ghost sm"
          :class="{ on: theater }"
          title="剧场模式：收起侧栏与顶栏，专注看这一段（快捷键 F，Esc 退出）"
          @click="toggleTheater"
        >
          <Icon name="monitor" :size="14" /> 剧场模式 <span class="kbd">F</span>
        </button>
        <button class="btn ghost sm" title="返回" @click="router.back()"><Icon name="left" :size="15" /></button>
      </header>

      <div ref="scrollEl" class="scroll">
        <RouterView v-slot="{ Component }">
          <component :is="Component" :key="`${route.fullPath}#${ui.refreshSeq}`" />
        </RouterView>
      </div>
    </main>

    <!-- 剧场模式把顶栏藏起来了，得留一个能点回来的出口 -->
    <button
      v-if="theater"
      class="btn sm theater-exit"
      title="退出剧场模式（Esc）"
      @click="toggleTheater"
    >
      <Icon name="monitor" :size="14" /> 退出剧场 <span class="kbd">Esc</span>
    </button>

    <PageFloat />

    <!-- 小窗播放：挂在最外层，切页也跟着（用户在卡片/视频页把它叫起来） -->
    <MiniPlayer />

    <Toasts />
    <LoginModal />
    <ConfirmModal />
  </div>
</template>
